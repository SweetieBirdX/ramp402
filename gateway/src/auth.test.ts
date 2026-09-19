import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
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

// Real Privy SDK verification, offline: tokens are signed with a local ES256 key and the verifier is
// given the matching public key, exactly as it would otherwise receive Privy's key from JWKS.
const APP_ID = "test-app-id";
const SELLER_ADDRESS = "GCN7VANEAHQJ2BA4FEGYLD7P444UW4SE4U3AR2NQCIO4M73L66XWILI6";

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

function privyToken(privateKey: KeyObject, claims: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "privy.io",
      aud: APP_ID,
      sub: "did:privy:seller-1",
      sid: "session-1",
      iat: now,
      exp: now + 3600,
      ...claims,
    }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${b64url(signature)}`;
}

const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const otherKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });

let dir: string;
let handle: DbHandle;
let app: express.Express;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ramp402-auth-"));
  handle = openDatabase(join(dir, "auth.db"));
  const repo = createRepo(handle);
  repo.createSeller({ privy_user_id: "did:privy:seller-1", stellar_address: SELLER_ADDRESS });

  const verifyToken = createPrivyVerifier({
    appId: APP_ID,
    appSecret: "unused-offline",
    jwtVerificationKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
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
