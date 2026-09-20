// CORS is browser-only behaviour, so nothing else in this suite exercises it — and a server-to-
// server test like verify-e2e.ts passes whether it works or not. These are the assertions that
// would have caught the browser being unable to call the gateway at all.
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowedOriginsFromEnv, DEFAULT_ALLOWED_ORIGIN } from "./cors.js";
import { createTestGateway, type TestGateway } from "./testing/gateway.js";

describe("allowedOriginsFromEnv", () => {
  it("defaults to the local frontend when ALLOWED_ORIGINS is unset", () => {
    expect(allowedOriginsFromEnv({})).toEqual([DEFAULT_ALLOWED_ORIGIN]);
  });

  it("splits a comma-separated list and trims trailing slashes", () => {
    // An Origin header never carries a trailing slash, so "https://x/" would match nothing.
    expect(
      allowedOriginsFromEnv({ ALLOWED_ORIGINS: "https://a.example/, https://b.example ,, " }),
    ).toEqual(["https://a.example", "https://b.example"]);
  });
});

describe("CORS on the gateway", () => {
  let gw: TestGateway;
  const ORIGIN = "http://localhost:3000";

  beforeEach(() => {
    gw = createTestGateway();
  });
  afterEach(() => gw.close());

  it("answers an OPTIONS preflight with 204 and no body", async () => {
    const res = await request(gw.app)
      .options("/proxy/aaaa0007")
      .set("Origin", ORIGIN)
      .set("Access-Control-Request-Method", "GET");

    expect(res.status).toBe(204);
    expect(res.text).toBeFalsy();
  });

  it("allows every request header the client actually sends", async () => {
    const res = await request(gw.app)
      .options("/proxy/aaaa0007")
      .set("Origin", ORIGIN)
      .set("Access-Control-Request-Method", "GET");

    const allowed = (res.headers["access-control-allow-headers"] ?? "").toLowerCase();
    // frontend/lib/api.ts and frontend/lib/agent.ts — read from the client, not guessed.
    for (const header of ["authorization", "content-type", "accept", "x-agent-budget", "payment-signature"]) {
      expect(allowed, `preflight must allow ${header}`).toContain(header);
    }
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("exposes the x402 response headers the client reads", async () => {
    // THE one that fails silently: without this the browser hides PAYMENT-REQUIRED from JavaScript
    // and the challenge parse fails as though the gateway had never sent it.
    const res = await request(gw.app).get("/health").set("Origin", ORIGIN);

    const exposed = (res.headers["access-control-expose-headers"] ?? "").toLowerCase();
    expect(exposed).toContain("payment-required");
    expect(exposed).toContain("payment-response");
  });

  it("reflects an allowed origin, never a wildcard, and varies on Origin", async () => {
    const res = await request(gw.app).get("/health").set("Origin", ORIGIN);

    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    // A wildcard with credentials is refused by browsers and wrong in principle: it would invite
    // any page on the internet to spend a seller's session.
    expect(res.headers["access-control-allow-origin"]).not.toBe("*");
    expect(res.headers["vary"]).toContain("Origin");
  });

  it("sends no CORS headers at all to an origin that is not allowed", async () => {
    const res = await request(gw.app).get("/health").set("Origin", "https://evil.example");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("keeps a 402 a 402 for a browser, with the challenge header exposed", async () => {
    // The whole point: the x402 exchange starts with a 402 the client must read. If CORS strips
    // the header or the status is rewritten, the protocol stops before it begins.
    const res = await request(gw.app)
      .get("/proxy/aaaa0007")
      .set("Origin", ORIGIN)
      .set("X-Agent-Budget", "5000000");

    expect(res.status).toBe(402);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect((res.headers["access-control-expose-headers"] ?? "").toLowerCase()).toContain("payment-required");
  });

  it("answers a preflight without touching auth — the browser sends it unauthenticated", async () => {
    const res = await request(gw.app)
      .options("/api/balance")
      .set("Origin", ORIGIN)
      .set("Access-Control-Request-Method", "GET")
      .set("Access-Control-Request-Headers", "authorization");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-headers"].toLowerCase()).toContain("authorization");
  });
});
