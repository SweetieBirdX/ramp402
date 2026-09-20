import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createAuthMiddleware, createPrivyVerifier } from "./auth.js";
import { openDatabase, type DbHandle } from "./db.js";
import { createCredentialCipher } from "./credentials.js";
import { createDraftStore } from "./drafts.js";
import { createFunder } from "./funding.js";
import { redactUpstreamUrl } from "./readRoutes.js";
import { createRepo, type Repo, type SellerRow } from "./repo.js";
import { unusedLedger } from "./testing/ledger.js";
import { unusedGate, unusedProxyLedger } from "./testing/proxy.js";
import { privyTestKeys, privyToken, TEST_PRIVY_APP_ID } from "./testing/privy.js";

// Public testnet-format addresses only; no secret keys in fixtures.
const ADDRESS_A = "GCN7VANEAHQJ2BA4FEGYLD7P444UW4SE4U3AR2NQCIO4M73L66XWILI6";
const ADDRESS_B = "GBPA6I6PQAYXADRROHMGYGPRY7NVHXL5Q7QT3L6SOAUSIBWV27AJKWZG";
const AGENT = "GA6UDAI55VG36CM7SQSKOVWL4AAHYYOBJSS4JPYUJME5ILMJP235JYQB";

const keys = privyTestKeys();
const verifyToken = createPrivyVerifier({ appId: TEST_PRIVY_APP_ID, appSecret: "unused-offline", jwtVerificationKey: keys.publicKeyPem });

let dir: string;
let handle: DbHandle;
let repo: Repo;
let app: ReturnType<typeof createApp>;
let sellerA: SellerRow;
let sellerB: SellerRow;
let balances: Map<string, bigint>;
let balanceReads: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ramp402-read-"));
  handle = openDatabase(join(dir, "read.db"));
  repo = createRepo(handle);

  sellerA = repo.createSeller({ privy_user_id: "did:privy:A", stellar_address: ADDRESS_A });
  sellerB = repo.createSeller({ privy_user_id: "did:privy:B", stellar_address: ADDRESS_B });

  // A: endpoints 1 and 2. B: endpoint 3. Calls on 1 (x2) and 3 (x1).
  repo.createEndpoint({ endpoint_id: 1n, seller_id: sellerA.id, upstream_url: "https://a.example/one", proxy_slug: "aaaa0001", price_stroops: 1_000 });
  repo.createEndpoint({
    endpoint_id: 2n,
    seller_id: sellerA.id,
    upstream_url: "https://alice:hunter2@a.example/two?api_key=sk_live_123&city=ist&token=t0k",
    proxy_slug: "aaaa0002",
    price_stroops: 2_000,
  });
  repo.createEndpoint({ endpoint_id: 3n, seller_id: sellerB.id, upstream_url: "https://b.example/secret-api", proxy_slug: "bbbb0003", price_stroops: 9_000 });
  repo.insertCall({ endpoint_id: 1n, agent_address: AGENT, amount_stroops: 1_000, status: "paid", tx_hash: "aa11" });
  repo.insertCall({ endpoint_id: 1n, agent_address: AGENT, amount_stroops: 1_000, status: "upstream_failed" });
  repo.insertCall({ endpoint_id: 3n, agent_address: AGENT, amount_stroops: 9_000, status: "paid", tx_hash: "bb33" });

  balances = new Map([
    [ADDRESS_A, 4_950_000n],
    [ADDRESS_B, 123_456_789n],
  ]);
  balanceReads = [];

  app = createApp(
    {
      repo,
      // Inert: these are the dashboard's read routes, which start no anchor flow.
      startAnchorFlow: () => {},
      anchorHomeDomain: "anchor.test",
      authenticate: createAuthMiddleware({ verifyToken, repo }),
      findStellarWallet: async () => null,
      funder: createFunder({ accountExists: async () => true, friendbotUrl: undefined }),
      drafts: createDraftStore(),
      ledger: unusedLedger,
      gate: unusedGate,
      proxyLedger: unusedProxyLedger,
      credentialCipher: createCredentialCipher("00".repeat(32)),
      readBalance: async (address) => {
        balanceReads.push(address);
        return balances.get(address) ?? 0n;
      },
    },
    { log: false },
  );
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

const as = (sub: string) => ({ Authorization: `Bearer ${privyToken(keys.privateKey, { sub })}` });
const get = (path: string, sub: string) => request(app).get(path).set(as(sub));

describe("GET /api/endpoints", () => {
  it("returns only the caller's own endpoints, newest first, with call counts", async () => {
    const res = await get("/api/endpoints", "did:privy:A");
    expect(res.status).toBe(200);
    expect(res.body.endpoints.map((e: { endpoint_id: string }) => e.endpoint_id)).toEqual(["2", "1"]);
    expect(res.body.endpoints[1]).toEqual({
      endpoint_id: "1",
      proxy_slug: "aaaa0001",
      upstream_url: "https://a.example/one",
      price_stroops: 1_000,
      created_at: expect.any(String),
      call_count: 2,
    });
    expect(res.body.endpoints[0].call_count).toBe(0);
  });

  it("seller A never sees seller B's endpoints, and vice versa", async () => {
    const a = await get("/api/endpoints", "did:privy:A");
    const b = await get("/api/endpoints", "did:privy:B");
    expect(JSON.stringify(a.body)).not.toMatch(/bbbb0003|b\.example|"3"/);
    expect(b.body.endpoints).toEqual([expect.objectContaining({ endpoint_id: "3", proxy_slug: "bbbb0003", call_count: 1 })]);
    expect(JSON.stringify(b.body)).not.toMatch(/aaaa000|a\.example/);
  });

  it("strips credentials from upstream_url", async () => {
    const res = await get("/api/endpoints", "did:privy:A");
    const url = res.body.endpoints.find((e: { endpoint_id: string }) => e.endpoint_id === "2").upstream_url;
    expect(url).toBe("https://a.example/two?api_key=REDACTED&city=ist&token=REDACTED");
    expect(url).not.toMatch(/alice|hunter2|sk_live|t0k/);
  });

  it("returns an empty list, not an error, for a seller with no endpoints", async () => {
    repo.createSeller({ privy_user_id: "did:privy:C", stellar_address: ADDRESS_A });
    const res = await get("/api/endpoints", "did:privy:C");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ endpoints: [] });
  });
});

describe("GET /api/calls", () => {
  it("returns the log for the caller's own endpoint, newest first, with status and tx_hash", async () => {
    const res = await get("/api/calls?endpoint_id=1", "did:privy:A");
    expect(res.status).toBe(200);
    expect(res.body.calls).toEqual([
      { id: expect.any(String), endpoint_id: "1", agent_address: AGENT, amount_stroops: 1_000, status: "upstream_failed", tx_hash: null, created_at: expect.any(String) },
      { id: expect.any(String), endpoint_id: "1", agent_address: AGENT, amount_stroops: 1_000, status: "paid", tx_hash: "aa11", created_at: expect.any(String) },
    ]);
  });

  it("403 when seller A asks for seller B's endpoint, without leaking any of its calls", async () => {
    const res = await get("/api/calls?endpoint_id=3", "did:privy:A");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "unauthorized", message: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/bb33|9000/);

    const reverse = await get("/api/calls?endpoint_id=1", "did:privy:B");
    expect(reverse.status).toBe(403);
    expect(JSON.stringify(reverse.body)).not.toMatch(/aa11/);
  });

  it("404 endpoint_not_found for an endpoint_id nobody has", async () => {
    const res = await get("/api/calls?endpoint_id=999", "did:privy:A");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "endpoint_not_found", message: expect.any(String) });
  });

  it("caps the log at the newest 100 calls", async () => {
    for (let i = 0; i < 105; i++) {
      repo.insertCall({ endpoint_id: 2n, agent_address: AGENT, amount_stroops: 2_000, status: "paid", tx_hash: `tx${i}` });
    }
    const res = await get("/api/calls?endpoint_id=2", "did:privy:A");
    expect(res.body.calls).toHaveLength(100);
    expect(res.body.calls[0].tx_hash).toBe("tx104");
    expect(res.body.calls[99].tx_hash).toBe("tx5");
  });

  it.each([
    ["missing", "/api/calls"],
    ["non-decimal", "/api/calls?endpoint_id=abc"],
    ["above u64", "/api/calls?endpoint_id=18446744073709551616"],
  ])("400 invalid_request for a %s endpoint_id", async (_label, path) => {
    const res = await get(path, "did:privy:A");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_request", message: expect.stringMatching(/query\.endpoint_id/) });
  });
});

describe("GET /api/balance", () => {
  it("reads the contract balance for the caller's own address, never another seller's", async () => {
    const a = await get("/api/balance", "did:privy:A");
    expect(a.status).toBe(200);
    expect(a.body).toEqual({ balance_stroops: 4_950_000 });

    const b = await get("/api/balance", "did:privy:B");
    expect(b.body).toEqual({ balance_stroops: 123_456_789 });

    expect(balanceReads).toEqual([ADDRESS_A, ADDRESS_B]);
  });

  it("comes from the chain, not from the calls table", async () => {
    // A has 2_000 stroops of calls in SQLite but the chain says 0: the chain wins.
    balances.set(ADDRESS_A, 0n);
    const res = await get("/api/balance", "did:privy:A");
    expect(res.body).toEqual({ balance_stroops: 0 });
  });
});

describe("all three read routes", () => {
  it.each(["/api/endpoints", "/api/balance", "/api/calls?endpoint_id=1"])("%s: 401 without a token", async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it.each(["/api/endpoints", "/api/balance", "/api/calls?endpoint_id=1"])("%s: 403 for a valid token with no seller row", async (path) => {
    const res = await get(path, "did:privy:never-bootstrapped");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "unauthorized", message: expect.stringMatching(/bootstrap/) });
    expect(balanceReads).toEqual([]);
  });
});

describe("redactUpstreamUrl", () => {
  it.each([
    ["https://api.example.com/v1/weather?city=ist", "https://api.example.com/v1/weather?city=ist"],
    ["https://user:pw@api.example.com/x", "https://api.example.com/x"],
    ["https://api.example.com/x?apikey=1&Secret=2&access_token=3&q=4", "https://api.example.com/x?apikey=REDACTED&Secret=REDACTED&access_token=REDACTED&q=4"],
    ["https://api.example.com/x?sig=a&sig=b", "https://api.example.com/x?sig=REDACTED"],
    ["not a url", "[invalid url]"],
  ])("%s → %s", (input, expected) => {
    expect(redactUpstreamUrl(input)).toBe(expected);
  });
});
