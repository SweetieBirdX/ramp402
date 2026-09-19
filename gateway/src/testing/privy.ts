// Test-only: mint Privy-shaped ES256 access tokens offline, verified by the real Privy SDK through
// jwtVerificationKey — exactly as it would otherwise verify Privy's key fetched from JWKS.
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

export const TEST_PRIVY_APP_ID = "test-app-id";

export function privyTestKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

export function privyToken(privateKey: KeyObject, claims: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "privy.io",
      aud: TEST_PRIVY_APP_ID,
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
