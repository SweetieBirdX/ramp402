import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuthMiddleware, createPrivyVerifier } from "./auth.js";
import { openDatabase, type DbHandle } from "./db.js";
import { errorHandler } from "./errors.js";
import { createRepo } from "./repo.js";
import { privyTestKeys, privyToken, TEST_PRIVY_APP_ID } from "./testing/privy.js";

const SELLER_ADDRESS = "GCN7VANEAHQJ2BA4FEGYLD7P444UW4SE4U3AR2NQCIO4M73L66XWILI6";

const keys = privyTestKeys();
const otherKeys = privyTestKeys();

let dir: string;
let handle: DbHandle;
let app: express.Express;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ramp402-auth-"));
  handle = openDatabase(join(dir, "auth.db"));
  const repo = createRepo(handle);
  repo.createSeller({ privy_user_id: "did:privy:seller-1", stellar_address: SELLER_ADDRESS });

  const verifyToken = createPrivyVerifier({
    appId: TEST_PRIVY_APP_ID,
    appSecret: "unused-offline",
    jwtVerificationKey: keys.publicKeyPem,
  });

  app = express();
  app.get("/whoami", createAuthMiddleware({ verifyToken, repo }), (req, res) => {
    res.json({ privyUserId: req.privyUserId, seller: req.seller });
  });
  app.use(errorHandler);
});

afterAll(() => {
  handle.close();
  rmSync(dir, { recursive: true, force: true });
});

async function expect401(authorization?: string) {
  let req = request(app).get("/whoami");
  if (authorization !== undefined) req = req.set("Authorization", authorization);
  const res = await req;
  expect(res.status).toBe(401);
  expect(res.body).toEqual({ error: "unauthorized", message: expect.any(String) });
}

describe("auth middleware", () => {
  it("attaches the seller for a valid token of a bootstrapped seller", async () => {
    const res = await request(app).get("/whoami").set("Authorization", `Bearer ${privyToken(keys.privateKey)}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      privyUserId: "did:privy:seller-1",
      seller: { sellerId: expect.any(String), privyUserId: "did:privy:seller-1", stellarAddress: SELLER_ADDRESS },
    });
  });

  it("leaves req.seller null, and creates nothing, for a valid token with no seller row", async () => {
    const token = privyToken(keys.privateKey, { sub: "did:privy:new-user" });
    const res = await request(app).get("/whoami").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ privyUserId: "did:privy:new-user", seller: null });
    expect(createRepo(handle).findSellerByPrivyId("did:privy:new-user")).toBeUndefined();
  });

  it("401 when the Authorization header is missing", () => expect401());
  it("401 when the scheme is not Bearer", () => expect401(`Basic ${privyToken(keys.privateKey)}`));
  it("401 when the token is not a JWT", () => expect401("Bearer not-a-jwt"));
  it("401 when the token is signed by a different key", () => expect401(`Bearer ${privyToken(otherKeys.privateKey)}`));
  it("401 when the token has expired", () => expect401(`Bearer ${privyToken(keys.privateKey, { iat: 1_000, exp: 2_000 })}`));
  it("401 when the token was issued for another Privy app", () =>
    expect401(`Bearer ${privyToken(keys.privateKey, { aud: "another-app" })}`));
  it("401 when the issuer is not privy.io", () => expect401(`Bearer ${privyToken(keys.privateKey, { iss: "evil.example" })}`));
});
