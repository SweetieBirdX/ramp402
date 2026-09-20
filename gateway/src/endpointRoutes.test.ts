import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, Networks, scValToNative, TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createAuthMiddleware, createPrivyVerifier } from "./auth.js";
import { openDatabase, type DbHandle } from "./db.js";
import { createCredentialCipher } from "./credentials.js";
import { createDraftStore } from "./drafts.js";
import { createFunder } from "./funding.js";
import { createRepo, type Repo } from "./repo.js";
import { SorobanError } from "./stellar.js";
import { fakeLedger, TEST_CONTRACT_ID, type FakeLedger } from "./testing/ledger.js";
import { unusedGate, unusedProxyLedger } from "./testing/proxy.js";
import { privyTestKeys, privyToken, TEST_PRIVY_APP_ID } from "./testing/privy.js";

// Local keypairs stand in for the sellers' Privy wallets: generated per run, never persisted.
const sellerKey = Keypair.random();
const otherKey = Keypair.random();
const keys = privyTestKeys();
const verifyToken = createPrivyVerifier({ appId: TEST_PRIVY_APP_ID, appSecret: "unused-offline", jwtVerificationKey: keys.publicKeyPem });

const U64_MAX = (1n << 64n) - 1n;
const cipher = createCredentialCipher(randomBytes(32).toString("hex"));
const DRAFT_TTL_MS = 10 * 60 * 1000;

let dir: string;
let handle: DbHandle;
let repo: Repo;
let ledger: FakeLedger;
let clock: { t: number };
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ramp402-endpoints-"));
  handle = openDatabase(join(dir, "endpoints.db"));
  repo = createRepo(handle);
  repo.createSeller({ privy_user_id: "did:privy:seller", stellar_address: sellerKey.publicKey() });
  repo.createSeller({ privy_user_id: "did:privy:other", stellar_address: otherKey.publicKey() });
  ledger = fakeLedger();
  clock = { t: 1_000_000 };

  app = createApp(
    {
      repo,
      // Inert: this suite registers endpoints, it never withdraws (see withdrawRoutes' own suite).
      startAnchorFlow: () => {},
      anchorHomeDomain: "anchor.test",
      authenticate: createAuthMiddleware({ verifyToken, repo }),
      findStellarWallet: async () => null,
      funder: createFunder({ accountExists: async () => true, friendbotUrl: undefined }),
      readBalance: async () => 0n,
      drafts: createDraftStore({ ttlMs: DRAFT_TTL_MS, now: () => clock.t }),
      ledger: ledger.ledger,
      gate: unusedGate,
      proxyLedger: unusedProxyLedger,
      credentialCipher: cipher,
    },
    { log: false },
  );
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

const auth = (sub = "did:privy:seller") => ({ Authorization: `Bearer ${privyToken(keys.privateKey, { sub })}` });
const prepare = (body: object, sub?: string) => request(app).post("/api/endpoints/prepare").set(auth(sub)).send(body);
const submit = (body: object, sub?: string) => request(app).post("/api/endpoints/submit").set(auth(sub)).send(body);

/** What Privy does on the frontend: sign the prepared envelope with the seller's key. */
function sign(unsignedXdr: string, key = sellerKey): string {
  const tx = TransactionBuilder.fromXDR(unsignedXdr, Networks.TESTNET) as Transaction;
  tx.sign(key);
  return tx.toXDR();
}

const VALID = { upstream_url: "https://api.weather.test/v1/forecast?city=istanbul", price_stroops: 5_000_000 };

describe("POST /api/endpoints/prepare", () => {
  it("returns an unsigned register_endpoint(seller, price) transaction with the seller as source", async () => {
    const res = await prepare(VALID);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unsigned_xdr: expect.any(String), draft_id: expect.any(String) });

    const tx = TransactionBuilder.fromXDR(res.body.unsigned_xdr, Networks.TESTNET) as Transaction;
    expect(tx.source).toBe(sellerKey.publicKey());
    expect(tx.signatures).toHaveLength(0);
    expect(ledger.built).toHaveLength(1);
    const call = ledger.built[0]!;
    expect(call.method).toBe("register_endpoint");
    expect(call.source).toBe(sellerKey.publicKey());
    expect(call.args.map((a) => scValToNative(a))).toEqual([sellerKey.publicKey(), 5_000_000n]);
    expect(call.args[1]!.type).toBe("scvI128"); // i128 on the contract, never a u64 or a decimal
  });

  it.each([
    ["a decimal price", 0.5],
    ["a decimal price above 1", 1.5],
    ["a price in exponent notation", 1e-7],
    ["zero", 0],
    ["a negative price", -100],
    ["a string price", "5000000"],
    ["an unsafe integer", 2 ** 53 + 2],
  ])("rejects %s with 400 invalid_request and builds nothing", async (_label, price_stroops) => {
    const res = await prepare({ ...VALID, price_stroops });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_request", message: expect.stringMatching(/body\.price_stroops/) });
    expect(ledger.built).toHaveLength(0);
  });

  it.each([["ftp://x.test/a"], ["javascript:alert(1)"], ["not a url"]])("rejects the non-http(s) URL %s", async (upstream_url) => {
    const res = await prepare({ ...VALID, upstream_url });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("keeps no plaintext credentials in the draft store (they are encrypted at /prepare)", async () => {
    const res = await prepare({ ...VALID, upstream_url: "https://me:pw@api.test/x?api_key=sk_live_1" });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/sk_live_1|me:pw/);
  });

  it("409 when the seller's account is not funded yet", async () => {
    ledger.unfundedSources.add(sellerKey.publicKey());
    const res = await prepare(VALID);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "invalid_request", message: expect.stringMatching(/bootstrap/) });
  });
});

describe("POST /api/endpoints/submit", () => {
  it("stores id as the decimal string of the contract's u64 return value — even the largest u64", async () => {
    const prepared = await prepare(VALID);
    ledger.nextResult = () => ({ txHash: "a".repeat(64), returnValue: U64_MAX });

    const res = await submit({ draft_id: prepared.body.draft_id, signed_xdr: sign(prepared.body.unsigned_xdr) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      endpoint_id: "18446744073709551615",
      proxy_slug: expect.stringMatching(/^[A-Za-z0-9_-]{8}$/),
      upstream_url: VALID.upstream_url,
      price_stroops: 5_000_000,
    });

    const row = repo.findEndpointById("18446744073709551615");
    expect(row).toMatchObject({ id: "18446744073709551615", proxy_slug: res.body.proxy_slug, price_stroops: 5_000_000 });
    expect(repo.findEndpointBySlug(res.body.proxy_slug)?.id).toBe("18446744073709551615");
  });

  it("stores seller credentials only encrypted: clean upstream_url, v1 ciphertext, nothing in any response", async () => {
    const withCreds = "https://me:p%40ss@api.weather.test/v1/forecast?city=istanbul&api_key=sk_live_123&keyword=rain";
    const prepared = await prepare({ ...VALID, upstream_url: withCreds });
    ledger.nextResult = () => ({ txHash: "e".repeat(64), returnValue: 7n });
    const res = await submit({ draft_id: prepared.body.draft_id, signed_xdr: sign(prepared.body.unsigned_xdr) });

    expect(res.status).toBe(200);
    expect(res.body.upstream_url).toBe("https://api.weather.test/v1/forecast?city=istanbul&keyword=rain");
    expect(JSON.stringify(res.body)).not.toMatch(/sk_live_123|p%40ss|p@ss|upstream_credentials_enc/);

    const row = repo.findEndpointById("7")!;
    expect(row.upstream_url).toBe("https://api.weather.test/v1/forecast?city=istanbul&keyword=rain");
    expect(row.upstream_credentials_enc).toMatch(/^v1:[^:]+:[^:]+:[^:]+$/);
    expect(row.upstream_credentials_enc).not.toMatch(/sk_live_123|p@ss/);
    expect(cipher.decrypt(row.upstream_credentials_enc!)).toEqual({
      username: "me",
      password: "p@ss",
      query: { api_key: ["sk_live_123"] },
    });

    // ...and the dashboard list never carries the ciphertext either.
    const list = await request(app).get("/api/endpoints").set(auth());
    expect(JSON.stringify(list.body)).not.toMatch(/upstream_credentials_enc|v1:|sk_live_123/);
  });

  it("stores NULL credentials for a URL without any", async () => {
    const prepared = await prepare(VALID);
    ledger.nextResult = () => ({ txHash: "e".repeat(64), returnValue: 8n });
    await submit({ draft_id: prepared.body.draft_id, signed_xdr: sign(prepared.body.unsigned_xdr) });
    expect(repo.findEndpointById("8")).toMatchObject({ upstream_url: VALID.upstream_url, upstream_credentials_enc: null });
  });

  it("takes the id from the contract, not from a row count", async () => {
    // Nothing in SQLite yet, yet the contract says 42: 42 it is.
    const prepared = await prepare(VALID);
    ledger.nextResult = () => ({ txHash: "b".repeat(64), returnValue: 42n });
    const res = await submit({ draft_id: prepared.body.draft_id, signed_xdr: sign(prepared.body.unsigned_xdr) });
    expect(res.body.endpoint_id).toBe("42");
    expect(repo.listEndpointsBySeller(repo.findSellerByPrivyId("did:privy:seller")!.id).map((e) => e.id)).toEqual(["42"]);
  });

  it("404 not_found with a retry message when the draft has expired", async () => {
    const prepared = await prepare(VALID);
    clock.t += DRAFT_TTL_MS; // exactly 10 minutes later

    const res = await submit({ draft_id: prepared.body.draft_id, signed_xdr: sign(prepared.body.unsigned_xdr) });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found", message: expect.stringMatching(/expired.*again/i) });
    expect(ledger.submitted).toHaveLength(0);
  });

  it("still accepts a draft just inside its 10-minute TTL", async () => {
    const prepared = await prepare(VALID);
    clock.t += DRAFT_TTL_MS - 1;
    const res = await submit({ draft_id: prepared.body.draft_id, signed_xdr: sign(prepared.body.unsigned_xdr) });
    expect(res.status).toBe(200);
  });

  it("a draft can be submitted only once", async () => {
    const prepared = await prepare(VALID);
    const body = { draft_id: prepared.body.draft_id, signed_xdr: sign(prepared.body.unsigned_xdr) };
    expect((await submit(body)).status).toBe(200);
    const again = await submit(body);
    expect(again.status).toBe(404);
    expect(ledger.submitted).toHaveLength(1);
  });

  it("another seller cannot submit someone else's draft (reported as not found)", async () => {
    const prepared = await prepare(VALID);
    const res = await submit({ draft_id: prepared.body.draft_id, signed_xdr: sign(prepared.body.unsigned_xdr) }, "did:privy:other");
    expect(res.status).toBe(404);
    expect(ledger.submitted).toHaveLength(0);
  });

  it("400 when the signed XDR is not the transaction prepared for this draft", async () => {
    const mine = await prepare(VALID);
    const different = await prepare({ ...VALID, price_stroops: 1 }); // a cheaper registration
    const res = await submit({ draft_id: mine.body.draft_id, signed_xdr: sign(different.body.unsigned_xdr) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_request", message: expect.stringMatching(/not the transaction that was prepared/) });
    expect(ledger.submitted).toHaveLength(0);
  });

  it("400 when signed_xdr is not a transaction envelope", async () => {
    const prepared = await prepare(VALID);
    const res = await submit({ draft_id: prepared.body.draft_id, signed_xdr: "AAAAAgAAAAA=" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("400 when the network rejects the transaction (e.g. a bad signature)", async () => {
    const prepared = await prepare(VALID);
    ledger.nextResult = () => {
      throw new SorobanError("send", "sendTransaction ERROR: txBadAuth", "c".repeat(64));
    };
    const res = await submit({ draft_id: prepared.body.draft_id, signed_xdr: sign(prepared.body.unsigned_xdr, otherKey) });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_request", message: expect.stringMatching(/txBadAuth/) });
    expect(repo.findEndpointById("1")).toBeUndefined();
  });

  it.each([
    ["no return value", undefined],
    ["a number instead of a u64 bigint", 7],
    ["a string", "7"],
    ["zero", 0n],
    ["a value above u64", U64_MAX + 1n],
  ])("refuses to invent an id when the contract returned %s: 500, nothing stored", async (_label, returnValue) => {
    const prepared = await prepare(VALID);
    ledger.nextResult = () => ({ txHash: "d".repeat(64), returnValue });
    const res = await submit({ draft_id: prepared.body.draft_id, signed_xdr: sign(prepared.body.unsigned_xdr) });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("internal_error");
    expect(handle.db.prepare("SELECT COUNT(*) AS n FROM endpoints").get()).toEqual({ n: 0 });
  });

  it("prepare and submit both require a bootstrapped seller", async () => {
    for (const path of ["/api/endpoints/prepare", "/api/endpoints/submit"]) {
      const res = await request(app).post(path).set(auth("did:privy:nobody")).send({});
      expect(res.status).toBe(403);
    }
    expect(TEST_CONTRACT_ID).toMatch(/^C/);
  });
});
