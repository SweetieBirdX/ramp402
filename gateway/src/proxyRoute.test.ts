import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createAuthMiddleware } from "./auth.js";
import { createCredentialCipher } from "./credentials.js";
import { openDatabase, type DbHandle } from "./db.js";
import { createDraftStore } from "./drafts.js";
import { createFunder } from "./funding.js";
import { createProxyLedger } from "./proxyLedger.js";
import { createRepo, type Repo } from "./repo.js";
import { unusedLedger } from "./testing/ledger.js";
import { fakeContract, fakeGate } from "./testing/proxy.js";

// Public-key-shaped fixtures only; no secret keys.
const SELLER = "GCN7VANEAHQJ2BA4FEGYLD7P444UW4SE4U3AR2NQCIO4M73L66XWILI6";
const AGENT = "GBPA6I6PQAYXADRROHMGYGPRY7NVHXL5Q7QT3L6SOAUSIBWV27AJKWZG";
const AGENT_2 = "GA6UDAI55VG36CM7SQSKOVWL4AAHYYOBJSS4JPYUJME5ILMJP235JYQB";
const PRICE = 1_000_000; // 0.1 USDC
const cipher = createCredentialCipher(randomBytes(32).toString("hex"));

let dir: string;
let handle: DbHandle;
let repo: Repo;
let contract: ReturnType<typeof fakeContract>;
let x402: ReturnType<typeof fakeGate>;
let upstream: { calls: Array<{ url: string; headers: Record<string, string> }>; respond: (url: URL, signal: AbortSignal) => Promise<Response> };
let logs: string[];
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ramp402-proxy-"));
  handle = openDatabase(join(dir, "proxy.db"));
  repo = createRepo(handle);
  const seller = repo.createSeller({ privy_user_id: "did:privy:seller", stellar_address: SELLER });
  repo.createEndpoint({ endpoint_id: 7n, seller_id: seller.id, upstream_url: "https://api.fx.test/v1/latest?base=USD", proxy_slug: "fxrates1", price_stroops: PRICE });
  repo.createEndpoint({
    endpoint_id: 8n,
    seller_id: seller.id,
    upstream_url: "https://api.weather.test/v1",
    upstream_credentials_enc: cipher.encrypt({ username: "me", password: "p@ss", query: { api_key: ["sk_live_1"] } }),
    proxy_slug: "weather1",
    price_stroops: PRICE,
  });

  contract = fakeContract({ "7": BigInt(PRICE), "8": BigInt(PRICE) });
  x402 = fakeGate();
  logs = [];
  upstream = {
    calls: [],
    respond: async () => Response.json({ USD_TRY: 41.2 }),
  };
  const fetchUpstream = (async (input: URL | string, init?: RequestInit) => {
    upstream.calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) } });
    return upstream.respond(new URL(String(input)), init!.signal!);
  }) as typeof fetch;

  app = createApp(
    {
      repo,
      authenticate: createAuthMiddleware({ verifyToken: async () => "unused", repo }),
      findStellarWallet: async () => null,
      funder: createFunder({ accountExists: async () => true, friendbotUrl: undefined }),
      readBalance: async () => 0n,
      drafts: createDraftStore(),
      ledger: unusedLedger,
      credentialCipher: cipher,
      gate: x402.gate,
      proxyLedger: createProxyLedger(contract.stellar, (l) => logs.push(l)),
      fetchUpstream,
      upstreamTimeoutMs: 50,
      log: (l) => logs.push(l),
    },
    { log: false },
  );
});

afterEach(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (opts: { agent?: string; budget?: string; slug?: string; query?: string; paymentSignature?: string } = {}) => {
  let r = request(app).get(`/proxy/${opts.slug ?? "fxrates1"}${opts.query ?? ""}`);
  const sig = opts.paymentSignature ?? (opts.agent === undefined ? `agent=${AGENT}` : opts.agent ? `agent=${opts.agent}` : undefined);
  if (sig) r = r.set("PAYMENT-SIGNATURE", sig);
  if (opts.budget !== undefined) r = r.set("X-Agent-Budget", opts.budget);
  return r;
};
const callRows = () => handle.db.prepare("SELECT * FROM calls ORDER BY rowid").all() as Array<Record<string, unknown>>;

describe("x402 before anything else", () => {
  it("402 with PAYMENT-REQUIRED (for this endpoint's price) when there is no payment", async () => {
    const res = await call({ agent: "" });
    expect(res.status).toBe(402);
    expect(res.headers["payment-required"]).toBe(`fake:${PRICE}`);
    expect(contract.recordCalls).toHaveLength(0);
    expect(upstream.calls).toHaveLength(0);
  });

  it("402 for an invalid payment, and nothing else happens", async () => {
    const res = await call({ paymentSignature: "garbage", budget: "5000000" });
    expect(res.status).toBe(402);
    expect(res.body).toEqual({ error: "invalid_payment" });
    expect(contract.recordCalls).toHaveLength(0);
  });

  it("404 endpoint_not_found for an unknown slug, before any payment is looked at", async () => {
    const res = await call({ slug: "nope1234", budget: "5000000" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "endpoint_not_found", message: expect.any(String) });
    expect(x402.settled).toHaveLength(0);
  });
});

describe("budget state machine (the contract decides; the gateway must translate it exactly)", () => {
  it("first call without X-Agent-Budget → 400 missing_budget_header, payment cancelled, nothing recorded", async () => {
    const res = await call();
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "missing_budget_header", message: expect.stringMatching(/X-Agent-Budget/) });
    expect(x402.settled).toEqual([]);
    expect(x402.cancelled).toEqual([{ payer: AGENT, status: 400 }]);
    expect(contract.budgetOf(AGENT, "7")).toBeUndefined();
    expect(callRows()).toEqual([]);
    expect(upstream.calls).toHaveLength(0);
  });

  it("first call with X-Agent-Budget → 200, and the budget is frozen at exactly that value", async () => {
    const res = await call({ budget: "3000000" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ USD_TRY: 41.2 });
    expect(res.headers["payment-response"]).toBe("receipt:payment-1");
    expect(contract.budgetOf(AGENT, "7")).toEqual({ allocated: 3_000_000n, spent: 1_000_000n });
  });

  it("a later call with a BIGGER X-Agent-Budget does not raise the limit", async () => {
    await call({ budget: "2000000" });
    await call({ budget: "999999999" });
    expect(contract.budgetOf(AGENT, "7")).toEqual({ allocated: 2_000_000n, spent: 2_000_000n });

    const third = await call({ budget: "999999999" });
    expect(third.status).toBe(403);
    expect(contract.budgetOf(AGENT, "7")).toEqual({ allocated: 2_000_000n, spent: 2_000_000n });
  });

  it("later calls need no header (it is ignored when absent too)", async () => {
    await call({ budget: "3000000" });
    const second = await call();
    expect(second.status).toBe(200);
    expect(contract.budgetOf(AGENT, "7")).toEqual({ allocated: 3_000_000n, spent: 2_000_000n });
  });

  it("the demo script: budget for 3 calls → calls 1–3 are 200, call 4 is 403 budget_exceeded with the rejected tx hash", async () => {
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await call({ budget: "3000000" })).status);
    expect(statuses).toEqual([200, 200, 200]);

    const fourth = await call();
    expect(fourth.status).toBe(403);
    expect(fourth.body).toEqual({ error: "budget_exceeded", message: expect.any(String), tx_hash: expect.stringMatching(/^rejected-/) });
    expect(contract.rejections).toEqual([expect.stringContaining(`record_call:${AGENT}:${fourth.body.tx_hash}`)]);
    // Refused before the money moved: cancelled, never settled, never logged, seller not credited.
    expect(x402.settled).toHaveLength(3);
    expect(x402.cancelled).toEqual([{ payer: AGENT, status: 403 }]);
    expect(contract.settles).toHaveLength(3);
    expect(callRows()).toHaveLength(3);
    expect(upstream.calls).toHaveLength(3);
  });

  it("a first call whose budget is below the price is refused the same way", async () => {
    const res = await call({ budget: "1" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("budget_exceeded");
    expect(x402.settled).toHaveLength(0);
  });

  it("403 still refuses (tx_hash null) if recording the rejection on-chain fails", async () => {
    await call({ budget: "1000000" });
    contract.setProofFails(true);
    const res = await call();
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "budget_exceeded", message: expect.any(String), tx_hash: null });
    expect(logs.join("\n")).toMatch(/could not record the rejection on-chain/);
  });

  it("budgets are per (agent, endpoint): another agent and another endpoint each start fresh", async () => {
    await call({ budget: "1000000" });
    expect((await call()).status).toBe(403); // AGENT on 7: spent

    expect((await call({ agent: AGENT_2 })).status).toBe(400); // AGENT_2 on 7: first call, needs a budget
    expect((await call({ agent: AGENT_2, budget: "1000000" })).status).toBe(200);
    expect((await call({ slug: "weather1" })).status).toBe(400); // AGENT on 8: first call
    expect(contract.budgetOf(AGENT_2, "7")).toEqual({ allocated: 1_000_000n, spent: 1_000_000n });
  });

  it("400 invalid_request for a malformed X-Agent-Budget", async () => {
    for (const budget of ["1.5", "-5", "abc", "0"]) {
      const res = await call({ budget });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    }
    expect(contract.recordCalls).toHaveLength(0);
  });
});

describe("paid path", () => {
  it("200: settles the contract for the price, logs the call as paid with the payment tx hash", async () => {
    const res = await call({ budget: "5000000" });
    expect(res.status).toBe(200);
    expect(contract.settles).toEqual([{ endpointId: "7", amount: 1_000_000n }]);
    expect(callRows()).toEqual([
      expect.objectContaining({ endpoint_id: "7", agent_address: AGENT, amount_stroops: PRICE, status: "paid", tx_hash: "payment-1" }),
    ]);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("forwards the agent's query string, re-attaches the seller's credentials, and forwards no agent headers", async () => {
    await call({ slug: "weather1", budget: "5000000", query: "?city=istanbul&api_key=agent-tries-this&units=metric" });
    const sent = upstream.calls[0]!;
    const url = new URL(sent.url);
    expect(url.origin + url.pathname).toBe("https://api.weather.test/v1");
    expect(url.searchParams.get("city")).toBe("istanbul");
    expect(url.searchParams.get("units")).toBe("metric");
    expect(url.searchParams.getAll("api_key")).toEqual(["sk_live_1"]); // the seller's, not the agent's
    expect(sent.headers.authorization).toBe(`Basic ${Buffer.from("me:p@ss").toString("base64")}`);
    expect(Object.keys(sent.headers).map((h) => h.toLowerCase()).sort()).toEqual(["accept", "authorization"]);
  });

  it("keeps the seller's fixed query parameters and lets the agent's override them", async () => {
    await call({ budget: "5000000", query: "?symbols=TRY" });
    expect(new URL(upstream.calls[0]!.url).search).toBe("?base=USD&symbols=TRY");
  });
});

describe("upstream failure: paid, logged honestly, seller not credited", () => {
  const expectUpstreamFailed = async (reason: RegExp) => {
    const res = await call({ budget: "5000000" });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "upstream_failed", message: expect.stringMatching(reason) });
    expect(x402.settled).toEqual([AGENT]); // the payment WAS taken
    expect(res.headers["payment-response"]).toBe("receipt:payment-1"); // and the agent gets the receipt
    expect(contract.settles).toEqual([]); // but settle is NOT called
    expect(callRows()).toEqual([expect.objectContaining({ status: "upstream_failed", tx_hash: "payment-1", amount_stroops: PRICE })]);
  };

  it("non-2xx → 502", async () => {
    upstream.respond = async () => new Response("boom", { status: 500 });
    await expectUpstreamFailed(/HTTP 500/);
  });

  it("a hanging upstream is cut off by the timeout → 502", async () => {
    upstream.respond = (_url, signal) =>
      new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    await expectUpstreamFailed(/timeout/);
  });

  it("a network error → 502", async () => {
    upstream.respond = async () => {
      throw new TypeError("fetch failed");
    };
    await expectUpstreamFailed(/network error/);
  });

  it("the budget stays spent: a failed call still counts against it", async () => {
    upstream.respond = async () => new Response("boom", { status: 503 });
    await call({ budget: "1000000" });
    expect((await call()).status).toBe(403);
  });
});

describe("rarer failures", () => {
  it("payment settlement failing after record_call → the library's response, no upstream call, logged", async () => {
    x402.setSettleFails(true);
    const res = await call({ budget: "5000000" });
    expect(res.status).toBe(402);
    expect(upstream.calls).toHaveLength(0);
    expect(callRows()).toEqual([]);
    expect(logs.join("\n")).toMatch(/payment settlement failed/);
  });

  it("a contract settle failure still delivers (the agent paid) and is logged loudly", async () => {
    contract.stellar.invokeAsOperator = ((orig) => async (method: string, args: Parameters<typeof orig>[1]) => {
      if (method === "settle") throw new Error("rpc down");
      return orig(method, args);
    })(contract.stellar.invokeAsOperator);
    const res = await call({ budget: "5000000" });
    expect(res.status).toBe(200);
    expect(logs.join("\n")).toMatch(/SETTLE FAILED/);
    expect(callRows()).toEqual([expect.objectContaining({ status: "paid" })]);
  });
});
