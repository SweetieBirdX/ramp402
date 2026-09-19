// The gateway's side of docs/CONVENTIONS.md, checked route by route: every §1.3 route exists, refuses
// malformed input, refuses a bad token, and every error leaves in the §1.1 shape. The route list and
// the error codes are read from CONVENTIONS.md itself, so a change to the document that the gateway
// does not follow — or the reverse — fails here instead of at integration.
//
// Feature behaviour lives in the per-module files: proxyRoute.test.ts (the budget state machine,
// upstream failure), readRoutes.test.ts and endpointRoutes.test.ts (seller isolation), and so on.
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import { rpc } from "@stellar/stellar-sdk";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blockedHosts, OFFLINE_GUARD } from "./testing/offline.js";
import { AGENT, createTestGateway, ENDPOINT_A, ENDPOINT_B, SELLER_A, type TestGateway } from "./testing/gateway.js";

// --- CONVENTIONS.md, parsed ----------------------------------------------------------------------

// Normalised: the file is committed with CRLF line endings on some checkouts and LF on others.
const CONVENTIONS = readFileSync(new URL("../../docs/CONVENTIONS.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function section(number: string): string {
  const start = CONVENTIONS.indexOf(`\n## ${number} `);
  if (start === -1) throw new Error(`CONVENTIONS.md has no section ${number}`);
  const end = CONVENTIONS.indexOf("\n## ", start + 1);
  return CONVENTIONS.slice(start, end === -1 ? undefined : end);
}

/** Every route §1.3 defines, as "METHOD /path" with the query string dropped. */
const DOC_ROUTES = [...section("1.3").matchAll(/^- `(GET|POST) (\/[^`?\s]*)/gm)].map((m) => `${m[1]} ${m[2]}`);

/** The machine codes §1.1 lists. */
const DOC_ERROR_CODES = new Set(
  [...(section("1.1").match(/Machine codes used across components:([\s\S]*?)(?:\n- |\n\n)/)?.[1] ?? "").matchAll(/`([a-z_]+)`/g)].map(
    (m) => m[1]!,
  ),
);

/**
 * Codes the gateway already returns that §1.1 does not list yet. Raised with the team; Efe adds them
 * to CONVENTIONS.md. This is exactly these three — any other code outside §1.1 still fails the suite.
 */
const AWAITING_CONVENTIONS = new Set(["invalid_request", "not_found", "internal_error"]);
const ALLOWED_ERROR_CODES = new Set([...DOC_ERROR_CODES, ...AWAITING_CONVENTIONS]);

/** Fields an error body may carry besides { error, message }, per code (§1.3). */
const EXTRA_ERROR_FIELDS: Record<string, string[]> = { budget_exceeded: ["tx_hash"] };

// --- The route table -----------------------------------------------------------------------------

const VALID_XDR = "AAAAAgAAAAA="; // base64-shaped; passes validation, is not a real transaction

interface Malformed {
  label: string;
  path?: string;
  body?: object;
  headers?: Record<string, string>;
  /** Must appear in the error message: validation names the offending field. */
  names: RegExp;
}

interface Route {
  id: string;
  method: "get" | "post";
  /** A request that passes validation. */
  path: string;
  body?: object;
  seller: boolean;
  /** Empty for routes that take no input at all. */
  malformed: Malformed[];
}

const ROUTES: Route[] = [
  { id: "GET /health", method: "get", path: "/health", seller: false, malformed: [] },
  {
    id: "POST /api/sellers/bootstrap",
    method: "post",
    path: "/api/sellers/bootstrap",
    seller: true,
    malformed: [{ label: "a body (§1.3: none)", body: { stellar_address: SELLER_A }, names: /stellar_address/ }],
  },
  {
    id: "POST /api/endpoints/prepare",
    method: "post",
    path: "/api/endpoints/prepare",
    body: { upstream_url: "https://api.test/x", price_stroops: 1_000 },
    seller: true,
    malformed: [
      { label: "an empty body", body: {}, names: /body\.upstream_url/ },
      { label: "a decimal price", body: { upstream_url: "https://api.test/x", price_stroops: 0.5 }, names: /body\.price_stroops/ },
      { label: "a price sent as a string", body: { upstream_url: "https://api.test/x", price_stroops: "1000" }, names: /body\.price_stroops/ },
      { label: "a misspelt field", body: { upstream_url: "https://api.test/x", price: 1_000 }, names: /price/ },
      { label: "a non-http URL", body: { upstream_url: "ftp://api.test/x", price_stroops: 1_000 }, names: /body\.upstream_url/ },
    ],
  },
  {
    id: "POST /api/endpoints/submit",
    method: "post",
    path: "/api/endpoints/submit",
    body: { draft_id: "draft-1", signed_xdr: VALID_XDR },
    seller: true,
    malformed: [
      { label: "a non-base64 signed_xdr", body: { draft_id: "d1", signed_xdr: "not xdr!" }, names: /body\.signed_xdr/ },
      { label: "a missing draft_id", body: { signed_xdr: VALID_XDR }, names: /body\.draft_id/ },
    ],
  },
  {
    id: "POST /api/withdraw/prepare",
    method: "post",
    path: "/api/withdraw/prepare",
    seller: true,
    malformed: [{ label: "an amount (withdraw takes the whole balance)", body: { amount_stroops: 1 }, names: /amount_stroops/ }],
  },
  {
    id: "POST /api/withdraw/submit",
    method: "post",
    path: "/api/withdraw/submit",
    body: { draft_id: "draft-1", signed_xdr: VALID_XDR },
    seller: true,
    malformed: [
      { label: "a non-base64 signed_xdr", body: { draft_id: "d1", signed_xdr: "not xdr!" }, names: /body\.signed_xdr/ },
      { label: "a missing draft_id", body: { signed_xdr: VALID_XDR }, names: /body\.draft_id/ },
    ],
  },
  {
    id: "GET /api/withdrawals/:id",
    method: "get",
    path: "/api/withdrawals/w123",
    seller: true,
    malformed: [{ label: "an over-long id", path: `/api/withdrawals/${"x".repeat(65)}`, names: /params\.id/ }],
  },
  { id: "GET /api/endpoints", method: "get", path: "/api/endpoints", seller: true, malformed: [] },
  { id: "GET /api/balance", method: "get", path: "/api/balance", seller: true, malformed: [] },
  {
    id: "GET /api/calls",
    method: "get",
    path: `/api/calls?endpoint_id=${ENDPOINT_A.id}`,
    seller: true,
    malformed: [
      { label: "a missing endpoint_id", path: "/api/calls", names: /query\.endpoint_id/ },
      { label: "a non-decimal endpoint_id", path: "/api/calls?endpoint_id=7a", names: /query\.endpoint_id/ },
      { label: "an endpoint_id above u64", path: "/api/calls?endpoint_id=18446744073709551616", names: /query\.endpoint_id/ },
    ],
  },
  {
    id: "GET /proxy/:proxy_slug",
    method: "get",
    path: `/proxy/${ENDPOINT_A.slug}`,
    seller: false,
    malformed: [
      { label: "a slug with illegal characters", path: "/proxy/bad.slug", names: /params\.proxy_slug/ },
      { label: "a decimal X-Agent-Budget", headers: { "X-Agent-Budget": "1.5" }, names: /headers/ },
      { label: "a negative X-Agent-Budget", headers: { "X-Agent-Budget": "-5" }, names: /headers/ },
    ],
  },
];

/** Keys of TestGateway.badAuthorizations — needed before any gateway exists, to name the cases. */
const BAD_AUTH_LABELS = [
  "no Authorization header",
  "a non-JWT bearer token",
  "the Basic scheme",
  "a token signed by another key",
  "an expired token",
];

const SELLER_ROUTES = ROUTES.filter((r) => r.seller);
const POST_ROUTES = ROUTES.filter((r) => r.method === "post");
const MALFORMED = ROUTES.flatMap((r) => r.malformed.map((m) => ({ ...m, route: r })));

// --- Harness -------------------------------------------------------------------------------------

let gw: TestGateway;
beforeEach(() => {
  gw = createTestGateway();
});
afterEach(() => {
  gw.close();
  vi.restoreAllMocks();
});

function send(
  route: Pick<Route, "method" | "path" | "body">,
  opts: { authorization?: string; path?: string; body?: object; headers?: Record<string, string> } = {},
) {
  let r = request(gw.app)[route.method](opts.path ?? route.path);
  if (opts.authorization) r = r.set("Authorization", opts.authorization);
  if (opts.headers) r = r.set(opts.headers);
  const body = opts.body ?? route.body;
  if (body !== undefined) r = r.send(body);
  return r;
}

/** Nothing reached the contract, the facilitator or an upstream. */
function expectNoSideEffects() {
  expect(gw.ledger.built).toEqual([]);
  expect(gw.ledger.submitted).toEqual([]);
  expect(gw.contract.recordCalls).toEqual([]);
  expect(gw.contract.settles).toEqual([]);
  expect(gw.x402.settled).toEqual([]);
}

// --- Tests ---------------------------------------------------------------------------------------

describe("the route table mirrors CONVENTIONS.md §1.3", () => {
  it("lists exactly the routes §1.3 defines — no more, no fewer", () => {
    expect(DOC_ROUTES.length).toBeGreaterThan(5); // the parser found the section at all
    expect(ROUTES.map((r) => r.id).sort()).toEqual([...DOC_ROUTES].sort());
  });

  it("§1.1 lists the error codes this suite checks against", () => {
    expect([...DOC_ERROR_CODES].sort()).toEqual(
      expect.arrayContaining(["budget_exceeded", "endpoint_not_found", "missing_budget_header", "unauthorized", "upstream_failed"]),
    );
  });
});

describe("every §1.3 route is registered", () => {
  it.each(ROUTES)("$id is served by its handler, not the 404 fallback", async (route) => {
    const res = await send(route, { authorization: route.seller ? gw.bearer() : undefined });
    expect(res.body?.message ?? "").not.toMatch(/^No route for/);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
  });

  it("GET /health → 200 { ok: true }", async () => {
    const res = await request(gw.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("POST /api/withdraw/prepare builds an unsigned transaction for a sufficient balance", async () => {
    gw.behaviour.readBalance = async () => 50_000_000n; // 5 USDC
    const res = await send({ method: "post", path: "/api/withdraw/prepare" }, { authorization: gw.bearer() });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unsigned_xdr: expect.any(String), draft_id: expect.any(String) });
  });

  it("POST /api/withdraw/submit refuses a draft that was never issued", async () => {
    const res = await send(
      { method: "post", path: "/api/withdraw/submit", body: { draft_id: "draft-1", signed_xdr: VALID_XDR } },
      { authorization: gw.bearer() },
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found", message: expect.any(String) });
  });

  it("GET /api/withdrawals/:id is a 404 in the §1.1 shape for an unknown id", async () => {
    const res = await send({ method: "get", path: "/api/withdrawals/w123" }, { authorization: gw.bearer() });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found", message: expect.any(String) });
  });

  it("an unknown route is a JSON 404 in the §1.1 shape", async () => {
    const res = await request(gw.app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found", message: expect.any(String) });
  });

  it("the right path with the wrong method is not matched", async () => {
    const res = await request(gw.app).get("/api/endpoints/prepare").set("Authorization", gw.bearer());
    expect(res.status).toBe(404);
  });
});

describe("malformed input → 400 invalid_request naming the field, before anything else happens", () => {
  it.each(MALFORMED)("$route.id with $label", async ({ route, path, body, headers, names }) => {
    const res = await send(route, {
      authorization: route.seller ? gw.bearer() : undefined,
      path,
      body,
      headers: { ...(route.id.startsWith("GET /proxy") ? { "PAYMENT-SIGNATURE": `agent=${AGENT}` } : {}), ...headers },
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_request", message: expect.stringMatching(names) });
    expectNoSideEffects();
  });

  it.each(POST_ROUTES)("$id with syntactically broken JSON", async (route) => {
    const res = await request(gw.app)
      .post(route.path)
      .set("Authorization", gw.bearer())
      .set("Content-Type", "application/json")
      .send('{"draft_id": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_request", message: expect.any(String) });
    expectNoSideEffects();
  });

  it("every route that takes input has at least one malformed case above", () => {
    const noInput = new Set(["GET /health", "GET /api/endpoints", "GET /api/balance"]);
    for (const route of ROUTES) {
      if (!noInput.has(route.id)) expect(route.malformed.length, route.id).toBeGreaterThan(0);
    }
  });
});

describe("seller auth: every seller route refuses a missing or invalid Privy token with 401", () => {
  const cases = SELLER_ROUTES.flatMap((route) => BAD_AUTH_LABELS.map((label) => ({ route, label })));

  it.each(cases)("$route.id with $label", async ({ route, label }) => {
    const res = await send(route, { authorization: gw.badAuthorizations[label] });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthorized", message: expect.any(String) });
    expectNoSideEffects();
  });

  it.each(SELLER_ROUTES)("$id checks the token before the body: a malformed request without a token is still 401", async (route) => {
    const res = await send(route, { body: { unexpected: true }, path: route.malformed[0]?.path });
    expect(res.status).toBe(401);
  });

  it.each(SELLER_ROUTES.filter((r) => r.id !== "POST /api/sellers/bootstrap"))(
    "$id → 403 for a valid token whose Privy user never bootstrapped",
    async (route) => {
      const res = await send(route, { authorization: gw.bearer("did:privy:never-bootstrapped") });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "unauthorized", message: expect.stringMatching(/bootstrap/) });
      expectNoSideEffects();
    },
  );

  it("the covered bad tokens are exactly the ones the harness mints", () => {
    expect(Object.keys(gw.badAuthorizations).sort()).toEqual([...BAD_AUTH_LABELS].sort());
  });
});

describe("cross-seller isolation", () => {
  it("GET /api/endpoints: each seller sees only their own endpoints", async () => {
    const a = await send({ method: "get", path: "/api/endpoints" }, { authorization: gw.bearer("did:privy:A") });
    const b = await send({ method: "get", path: "/api/endpoints" }, { authorization: gw.bearer("did:privy:B") });
    expect(a.body.endpoints.map((e: { endpoint_id: string }) => e.endpoint_id)).toEqual([ENDPOINT_A.id]);
    expect(b.body.endpoints.map((e: { endpoint_id: string }) => e.endpoint_id)).toEqual([ENDPOINT_B.id]);
    expect(JSON.stringify(a.body)).not.toContain(ENDPOINT_B.slug);
  });

  it("GET /api/calls: another seller's endpoint is 403, and none of its calls leak", async () => {
    gw.repo.insertCall({ endpoint_id: 9n, agent_address: AGENT, amount_stroops: 1_000_000, status: "paid", tx_hash: "b-secret-tx" });
    const res = await send({ method: "get", path: `/api/calls?endpoint_id=${ENDPOINT_B.id}` }, { authorization: gw.bearer("did:privy:A") });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "unauthorized", message: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toContain("b-secret-tx");
  });

  it("GET /api/balance: reads the caller's own address only", async () => {
    const res = await send({ method: "get", path: "/api/balance" }, { authorization: gw.bearer("did:privy:A") });
    expect(res.body).toEqual({ balance_stroops: 4_000_000 });
  });

  it("GET /api/withdrawals/:id: another seller's withdrawal is refused and nothing about it leaks", async () => {
    const theirs = gw.repo.createWithdrawal({
      seller_id: gw.sellerB.id,
      amount_stroops: 50_000_000,
      anchor_domain: "anchor.test",
    });
    gw.repo.updateWithdrawalProgress(theirs.id, "pending", {
      anchor_status: "pending_external",
      anchor_tx_id: "b-secret-anchor-tx",
      external_transaction_id: "b-secret-bank-ref",
    });

    const res = await send({ method: "get", path: `/api/withdrawals/${theirs.id}` }, { authorization: gw.bearer("did:privy:A") });

    // Indistinguishable from an id that never existed: 404, not 403 — a different status would
    // itself confirm the withdrawal is real.
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found", message: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toContain("b-secret-anchor-tx");
    expect(JSON.stringify(res.body)).not.toContain("b-secret-bank-ref");
  });

  it("POST /api/withdraw/submit: another seller's draft_id is refused (reported as not found)", async () => {
    gw.behaviour.readBalance = async () => 50_000_000n;
    const prepared = await send({ method: "post", path: "/api/withdraw/prepare" }, { authorization: gw.bearer("did:privy:B") });
    expect(prepared.status).toBe(200);

    const res = await send(
      { method: "post", path: "/api/withdraw/submit", body: { draft_id: prepared.body.draft_id, signed_xdr: prepared.body.unsigned_xdr } },
      { authorization: gw.bearer("did:privy:A") },
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found", message: expect.any(String) });
    // Nothing was submitted and no anchor flow was started on B's behalf.
    expect(gw.ledger.submitted).toHaveLength(0);
    expect(gw.startedAnchorFlows).toHaveLength(0);
  });
});

describe("withdrawal minimum (§1.5: 1 USDC is a lower bound, not a cap)", () => {
  const prepare = () => request(gw.app).post("/api/withdraw/prepare").set("Authorization", gw.bearer()).send();

  it.each([
    ["nothing at all", 0n],
    ["one stroop", 1n],
    ["0.4 USDC", 4_000_000n],
    ["a stroop under the minimum", 9_999_999n],
  ])("rejects %s, and builds nothing", async (_label, balance) => {
    gw.behaviour.readBalance = async () => balance;
    const res = await prepare();

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    // A seller has to be able to act on this, so it must name the minimum.
    if (balance > 0n) expect(res.body.message).toMatch(/1 USDC|minimum/i);
    expect(res.body.unsigned_xdr).toBeUndefined();
    expect(gw.ledger.built).toHaveLength(0);
  });

  it("accepts a balance of exactly 10_000_000 stroops — the boundary is inclusive", async () => {
    gw.behaviour.readBalance = async () => 10_000_000n;
    const res = await prepare();

    expect(res.status).toBe(200);
    expect(res.body.unsigned_xdr).toEqual(expect.any(String));
  });

  it("withdraws a larger balance IN FULL — never clamped to the 1 USDC minimum", async () => {
    // The failure this guards: treating the lower bound as a cap and paying out 1 USDC of 25.
    const balance = 250_000_000n; // 25 USDC
    gw.behaviour.readBalance = async () => balance;

    const prepared = await prepare();
    expect(prepared.status).toBe(200);

    // withdraw() zeroes the whole balance and returns it; that return value is the figure that
    // reaches the row. The unsigned XDR round-trips as the signed one: a signature does not change
    // the transaction hash the draft is matched on.
    gw.ledger.nextResult = () => ({ txHash: "a".repeat(64), returnValue: balance });
    const submitted = await request(gw.app)
      .post("/api/withdraw/submit")
      .set("Authorization", gw.bearer())
      .send({ draft_id: prepared.body.draft_id, signed_xdr: prepared.body.unsigned_xdr });

    expect(submitted.status).toBe(200);
    expect(submitted.body).toEqual({ withdrawal_id: expect.any(String), status: "pending" });

    const row = gw.repo.findWithdrawal(submitted.body.withdrawal_id);
    expect(row?.amount_stroops).toBe(Number(balance));
    expect(row?.amount_stroops).not.toBe(10_000_000);

    // And the anchor flow was handed the full amount, not a clamped one.
    expect(gw.startedAnchorFlows).toHaveLength(1);
    expect(gw.startedAnchorFlows[0]?.amount_stroops).toBe(Number(balance));
  });

  it("records nothing when the contract says the balance was already taken", async () => {
    gw.behaviour.readBalance = async () => 50_000_000n;
    const prepared = await prepare();

    // withdraw() returns 0 rather than failing (§1.2) when there is nothing left.
    gw.ledger.nextResult = () => ({ txHash: "b".repeat(64), returnValue: 0n });
    const submitted = await request(gw.app)
      .post("/api/withdraw/submit")
      .set("Authorization", gw.bearer())
      .send({ draft_id: prepared.body.draft_id, signed_xdr: prepared.body.unsigned_xdr });

    expect(submitted.status).toBe(409);
    expect(submitted.body.error).toBe("invalid_request");
    // No row, and above all no payout: the anchor must not be asked to send money that did not move.
    expect(gw.startedAnchorFlows).toHaveLength(0);
  });
});

describe("every error response has the §1.1 shape and a §1.1 machine code", () => {
  // One request per error the gateway can produce offline. 402s are absent on purpose: their body
  // belongs to the x402 protocol (built by @x402/express), not to §1.1.
  const SWEEP: Array<{ produces: string; status: number; run: (gw: TestGateway) => Promise<request.Response> }> = [
    { produces: "invalid_request", status: 400, run: (g) => request(g.app).get("/api/calls?endpoint_id=abc").set("Authorization", g.bearer()) },
    {
      produces: "missing_budget_header",
      status: 400,
      run: (g) => request(g.app).get(`/proxy/${ENDPOINT_A.slug}`).set("PAYMENT-SIGNATURE", `agent=${AGENT}`),
    },
    { produces: "unauthorized", status: 401, run: (g) => request(g.app).get("/api/balance") },
    {
      produces: "unauthorized",
      status: 403,
      run: (g) => request(g.app).get(`/api/calls?endpoint_id=${ENDPOINT_B.id}`).set("Authorization", g.bearer()),
    },
    {
      produces: "budget_exceeded",
      status: 403,
      run: (g) =>
        request(g.app).get(`/proxy/${ENDPOINT_A.slug}`).set("PAYMENT-SIGNATURE", `agent=${AGENT}`).set("X-Agent-Budget", "1"),
    },
    { produces: "not_found", status: 404, run: (g) => request(g.app).get("/api/nope") },
    {
      produces: "not_found",
      status: 404,
      run: (g) => request(g.app).post("/api/endpoints/submit").set("Authorization", g.bearer()).send({ draft_id: "gone", signed_xdr: VALID_XDR }),
    },
    { produces: "endpoint_not_found", status: 404, run: (g) => request(g.app).get("/proxy/zzzz9999").set("X-Agent-Budget", "5000000") },
    {
      produces: "invalid_request",
      status: 409,
      run: (g) => {
        g.ledger.unfundedSources.add(SELLER_A);
        return request(g.app).post("/api/endpoints/prepare").set("Authorization", g.bearer()).send({ upstream_url: "https://api.test/x", price_stroops: 1_000 });
      },
    },
    // `not_implemented` has no producer left: every route in §1.3 is implemented. The code stays in
    // the ErrorCode union for the next stub, but nothing in the gateway can emit it today.
    {
      produces: "upstream_failed",
      status: 502,
      run: (g) => {
        g.behaviour.upstream = async () => new Response("boom", { status: 500 });
        return request(g.app).get(`/proxy/${ENDPOINT_A.slug}`).set("PAYMENT-SIGNATURE", `agent=${AGENT}`).set("X-Agent-Budget", "5000000");
      },
    },
    {
      produces: "internal_error",
      status: 500,
      run: (g) => {
        g.behaviour.readBalance = async () => {
          throw new Error("rpc exploded at https://internal.rpc/secret-path");
        };
        return request(g.app).get("/api/balance").set("Authorization", g.bearer());
      },
    },
  ];

  it.each(SWEEP)("$status $produces", async ({ produces, status, run }) => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // the 500 case logs its cause, as it should
    const res = await run(gw);

    expect(res.status).toBe(status);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toBe(produces);
    expect(ALLOWED_ERROR_CODES).toContain(res.body.error);
    expect(res.body.message).toEqual(expect.any(String));
    expect(res.body.message.length).toBeGreaterThan(0);
    expect(Object.keys(res.body).sort()).toEqual(["error", "message", ...(EXTRA_ERROR_FIELDS[produces] ?? [])].sort());
  });

  it("a 500 never leaks the underlying error to the client", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const internal = SWEEP.find((s) => s.produces === "internal_error")!;
    const res = await internal.run(gw);
    expect(res.body).toEqual({ error: "internal_error", message: "Internal server error" });
    expect(JSON.stringify(res.body)).not.toMatch(/rpc exploded|secret-path/);
  });

  it("every machine code in the gateway's source is a §1.1 code, and every one of them is exercised above", () => {
    const srcDir = new URL(".", import.meta.url);
    const sources = readdirSync(srcDir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => readFileSync(new URL(f, srcDir), "utf8"))
      .join("\n");
    const emitted = new Set([
      ...[...sources.matchAll(/new HttpError\(\s*\d{3},\s*"([a-z_]+)"/g)].map((m) => m[1]!),
      ...[...sources.matchAll(/\berror: "([a-z_]+)"/g)].map((m) => m[1]!),
    ]);

    expect(emitted.size).toBeGreaterThan(5); // the scan found the throw sites at all
    for (const code of emitted) expect(ALLOWED_ERROR_CODES, `"${code}" is not in CONVENTIONS.md §1.1`).toContain(code);
    const swept = new Set(SWEEP.map((s) => s.produces));
    for (const code of emitted) expect(swept, `no request in the sweep produces "${code}"`).toContain(code);
  });
});

/** An error's message plus every cause beneath it: fetch and the SDK wrap the socket error. */
function errorChain(e: unknown): string {
  const parts: string[] = [];
  for (let cur = e as { message?: string; cause?: unknown } | undefined; cur; cur = cur.cause as typeof cur) {
    parts.push(String(cur.message ?? cur));
    if (parts.length > 10) break;
  }
  return parts.join(" <- ");
}

describe("the unit suite is offline and never touches ramp402.db", () => {
  it("fetch to the internet fails with the offline guard", async () => {
    const err = await fetch("https://example.com/").then(() => "connected", (e: unknown) => e);
    expect(errorChain(err)).toContain(OFFLINE_GUARD);
  });

  it("node:http to the internet fails with the offline guard", async () => {
    const message = await new Promise<string>((resolve) => {
      http.get("http://example.com/", () => resolve("connected")).on("error", (e) => resolve(e.message));
    });
    expect(message).toContain(OFFLINE_GUARD);
  });

  it("the Stellar SDK's RPC client cannot reach testnet", async () => {
    // The SDK reports a bare "fetch failed" and drops the cause, so check the guard's own record.
    const result = await new rpc.Server("https://soroban-testnet.stellar.org").getHealth().then(() => "connected", () => "refused");
    expect(result).toBe("refused");
    expect(blockedHosts).toContain("soroban-testnet.stellar.org");
  });

  it("DB_PATH points at a throwaway file, not the demo database", () => {
    expect(process.env.DB_PATH).toMatch(/ramp402-unit-/);
    expect(process.env.DB_PATH).not.toMatch(/ramp402\.db$/);
  });
});
