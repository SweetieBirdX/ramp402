// Encryption at rest for seller upstream credentials (checklist §C), with UPSTREAM_CRED_ENCRYPTION_KEY.
// AES-256-GCM: a fresh 96-bit IV per value and an auth tag, so tampering with the stored ciphertext
// fails decryption instead of yielding altered credentials.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { UpstreamCredentials } from "./upstream.js";

const VERSION = "v1";

export interface CredentialCipher {
  encrypt(credentials: UpstreamCredentials): string;
  decrypt(sealed: string): UpstreamCredentials;
}

/** `keyHex` is 64 hex characters (32 bytes). The key itself never appears in an error message. */
export function createCredentialCipher(keyHex: string): CredentialCipher {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error("UPSTREAM_CRED_ENCRYPTION_KEY must be 64 hex characters (a 256-bit key)");
  }
  const key = Buffer.from(keyHex, "hex");

  return {
    encrypt(credentials) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
    },

    decrypt(sealed) {
      const [version, iv, tag, ciphertext] = sealed.split(":");
      if (version !== VERSION || !iv || !tag || !ciphertext) throw new Error("Unrecognised credential ciphertext format");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
      return JSON.parse(plaintext.toString("utf8")) as UpstreamCredentials;
    },
  };
}

export function credentialCipherFromEnv(env: NodeJS.ProcessEnv = process.env): CredentialCipher {
  const key = env.UPSTREAM_CRED_ENCRYPTION_KEY?.trim();
  if (!key) throw new Error("Missing required environment variable(s): UPSTREAM_CRED_ENCRYPTION_KEY");
  return createCredentialCipher(key);
}
