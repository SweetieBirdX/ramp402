import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCredentialCipher } from "./credentials.js";
import { redactUpstreamUrl, splitUpstreamCredentials } from "./upstream.js";

const key = () => randomBytes(32).toString("hex");

describe("splitUpstreamCredentials", () => {
  it("removes userinfo and secret query parameters and returns them separately", () => {
    expect(splitUpstreamCredentials("https://me:p%40ss@api.test/v1?city=ist&api_key=k1&token=t1&token=t2")).toEqual({
      publicUrl: "https://api.test/v1?city=ist",
      credentials: { username: "me", password: "p@ss", query: { api_key: ["k1"], token: ["t1", "t2"] } },
    });
  });

  it("returns null credentials for a clean URL", () => {
    expect(splitUpstreamCredentials("https://api.test/v1?city=ist")).toEqual({
      publicUrl: "https://api.test/v1?city=ist",
      credentials: null,
    });
  });

  it("redaction and splitting agree on what a credential is", () => {
    const url = "https://u:p@api.test/x?q=1&apikey=a&Secret=b&access_token=c&sig=d";
    const redacted = redactUpstreamUrl(url);
    for (const name of Object.keys(splitUpstreamCredentials(url).credentials!.query!)) {
      expect(redacted).toContain(`${name}=REDACTED`);
    }
  });
});

describe("credential cipher (AES-256-GCM)", () => {
  const creds = { username: "me", password: "p@ss", query: { api_key: ["sk_live_1"] } };

  it("round-trips, and the ciphertext contains none of the plaintext", () => {
    const cipher = createCredentialCipher(key());
    const sealed = cipher.encrypt(creds);
    expect(sealed).toMatch(/^v1:/);
    expect(sealed).not.toMatch(/sk_live|p@ss/);
    expect(cipher.decrypt(sealed)).toEqual(creds);
  });

  it("uses a fresh IV per encryption", () => {
    const cipher = createCredentialCipher(key());
    expect(cipher.encrypt(creds)).not.toBe(cipher.encrypt(creds));
  });

  it("rejects a tampered ciphertext instead of returning altered credentials", () => {
    const cipher = createCredentialCipher(key());
    const [v, iv, tag, ct] = cipher.encrypt(creds).split(":");
    const flipped = Buffer.from(ct!, "base64");
    flipped[0]! ^= 1;
    expect(() => cipher.decrypt([v, iv, tag, flipped.toString("base64")].join(":"))).toThrow();
  });

  it("cannot be decrypted with a different key", () => {
    const sealed = createCredentialCipher(key()).encrypt(creds);
    expect(() => createCredentialCipher(key()).decrypt(sealed)).toThrow();
  });

  it("refuses a key that is not 64 hex characters, without echoing it", () => {
    expect(() => createCredentialCipher("not-a-key")).toThrow(/64 hex characters/);
    try {
      createCredentialCipher("zz-secret-zz");
    } catch (err) {
      expect(String(err)).not.toContain("zz-secret-zz");
    }
  });
});
