import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const app = createApp({ log: false });

const VALID_XDR = "AAAAAgAAAAA="; // shape-valid base64; not a real transaction

// Every route in docs/CONVENTIONS.md §1.3, each with a request that passes validation.
const ROUTES: Array<{
  method: "get" | "post";
  path: string;
  name: string;
  body?: object;
  headers?: Record<string, string>;
}> = [
  { method: "post", path: "/api/sellers/bootstrap", name: "POST /api/sellers/bootstrap" },
  {
    method: "post",
    path: "/api/endpoints/prepare",
    name: "POST /api/endpoints/prepare",
    body: { upstream_url: "https://api.example.com/weather", price_stroops: 5_000_000 },
  },
  {
    method: "post",
    path: "/api/endpoints/submit",
    name: "POST /api/endpoints/submit",
    body: { draft_id: "draft123", signed_xdr: VALID_XDR },
  },
  { method: "post", path: "/api/withdraw/prepare", name: "POST /api/withdraw/prepare" },
  {
    method: "post",
    path: "/api/withdraw/submit",
    name: "POST /api/withdraw/submit",
    body: { draft_id: "draft123", signed_xdr: VALID_XDR },
  },
  { method: "get", path: "/api/withdrawals/w123", name: "GET /api/withdrawals/:id" },
  { method: "get", path: "/api/endpoints", name: "GET /api/endpoints" },
  { method: "get", path: "/api/balance", name: "GET /api/balance" },
  { method: "get", path: "/api/calls?endpoint_id=1", name: "GET /api/calls" },
  {
    method: "get",
    path: "/proxy/wthr1234",
    name: "GET /proxy/:proxy_slug",
    headers: { "X-Agent-Budget": "10000000" },
  },
];

function send(method: "get" | "post", path: string, body?: object, headers: Record<string, string> = {}) {
  let req = request(app)[method](path).set(headers);
  if (body !== undefined) req = req.send(body);
  return req;
}

describe("GET /health", () => {
  it("returns 200 { ok: true }", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

describe("§1.3 routes are all registered", () => {
  it.each(ROUTES)("$name returns 501 not_implemented, not 404", async ({ method, path, name, body, headers }) => {
    const res = await send(method, path, body, headers);
    expect(res.status).toBe(501);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: "not_implemented", message: name });
  });

  it("an unknown route is a JSON 404 in the §1.1 shape", async () => {
    const res = await request(app).get("/api/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found", message: expect.any(String) });
  });

  it("the right path with the wrong method is not matched", async () => {
    const res = await request(app).get("/api/endpoints/prepare");
    expect(res.status).toBe(404);
  });
});

describe("zod validation rejects malformed requests with { error, message }", () => {
  const rejects: Array<[string, "get" | "post", string, object | undefined, RegExp]> = [
    ["missing price_stroops", "post", "/api/endpoints/prepare", { upstream_url: "https://x.test" }, /body\.price_stroops/],
    ["decimal price_stroops", "post", "/api/endpoints/prepare", { upstream_url: "https://x.test", price_stroops: 0.5 }, /body\.price_stroops/],
    ["price_stroops as a string", "post", "/api/endpoints/prepare", { upstream_url: "https://x.test", price_stroops: "500" }, /body\.price_stroops/],
    ["non-http upstream_url", "post", "/api/endpoints/prepare", { upstream_url: "ftp://x.test", price_stroops: 1 }, /body\.upstream_url/],
    ["renamed field (price instead of price_stroops)", "post", "/api/endpoints/prepare", { upstream_url: "https://x.test", price_stroops: 1, price: 1 }, /price/],
    ["missing signed_xdr", "post", "/api/endpoints/submit", { draft_id: "d1" }, /body\.signed_xdr/],
    ["non-base64 signed_xdr", "post", "/api/withdraw/submit", { draft_id: "d1", signed_xdr: "not xdr!" }, /body\.signed_xdr/],
    ["unexpected body on bootstrap", "post", "/api/sellers/bootstrap", { anything: 1 }, /anything/],
    ["unexpected body on withdraw/prepare", "post", "/api/withdraw/prepare", { amount_stroops: 1 }, /amount_stroops/],
    ["missing endpoint_id query", "get", "/api/calls", undefined, /query\.endpoint_id/],
    ["non-decimal endpoint_id query", "get", "/api/calls?endpoint_id=abc", undefined, /query\.endpoint_id/],
    ["endpoint_id above u64", "get", "/api/calls?endpoint_id=18446744073709551616", undefined, /query\.endpoint_id/],
  ];

  it.each(rejects)("%s → 400 invalid_request", async (_label, method, path, body, messagePattern) => {
    const res = await send(method, path, body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_request", message: expect.stringMatching(messagePattern) });
  });

  it("a non-integer X-Agent-Budget on /proxy is rejected", async () => {
    const res = await request(app).get("/proxy/wthr1234").set("X-Agent-Budget", "1.5");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_request", message: expect.stringMatching(/headers/) });
  });

  it("syntactically broken JSON gets the same error shape", async () => {
    const res = await request(app)
      .post("/api/endpoints/prepare")
      .set("Content-Type", "application/json")
      .send('{"upstream_url": ');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_request", message: expect.any(String) });
  });
});
