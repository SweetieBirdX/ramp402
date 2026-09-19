// SEP-10: prove to the anchor which Stellar account we are, and get a JWT for SEP-6/12/38.
//
// WHO AUTHENTICATES, AND WHY IT IS NOT THE SELLER
//
// The anchor flow runs in the background, long after the HTTP request that started it, and the
// seller's key lives in Privy on their device — nothing server-side can sign as them. The platform
// pool is the account that actually sends the USDC to the anchor, so the pool is the anchor's
// customer. That is a consequence of the architecture (the contract is a ledger and never holds
// tokens), not an oversight.
import { Keypair, Transaction, WebAuth } from "@stellar/stellar-sdk";
import { AnchorError, anchorFetch } from "./http.js";
import type { AnchorEndpoints } from "./toml.js";

interface ChallengeResponse {
  transaction: string;
  network_passphrase?: string;
}

interface TokenResponse {
  token: string;
}

interface CachedToken {
  token: string;
  /** Epoch ms. Refreshed early so a token cannot expire mid-flow. */
  expiresAt: number;
}

const tokens = new Map<string, CachedToken>();

/** Re-authenticate this long before the JWT actually expires, so a slow step cannot straddle it. */
const EXPIRY_MARGIN_MS = 60_000;
/** Used only if the JWT carries no `exp` claim at all. */
const FALLBACK_TTL_MS = 10 * 60_000;

const cacheKey = (anchor: AnchorEndpoints, account: string) => `${anchor.homeDomain}|${account}`;

/**
 * A JWT for `signer`, from cache when one is still good.
 *
 * `force` discards the cached token first — that is the retry path for a 401 (§1.5: "if the SEP-10
 * JWT expires, re-authenticate automatically and retry once").
 */
export async function authenticate(
  anchor: AnchorEndpoints,
  signer: Keypair,
  networkPassphrase: string,
  force = false,
): Promise<string> {
  const key = cacheKey(anchor, signer.publicKey());
  if (force) tokens.delete(key);

  const cached = tokens.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const token = await requestToken(anchor, signer, networkPassphrase);
  tokens.set(key, { token, expiresAt: expiryOf(token) });
  return token;
}

/**
 * Run `call` with a token, and if the anchor answers 401, authenticate again and retry — once.
 * Once only: a second 401 means the credentials are wrong, not stale, and retrying for ever would
 * bury the real problem.
 */
export async function withAuth<T>(
  anchor: AnchorEndpoints,
  signer: Keypair,
  networkPassphrase: string,
  call: (token: string) => Promise<T>,
): Promise<T> {
  const token = await authenticate(anchor, signer, networkPassphrase);
  try {
    return await call(token);
  } catch (err) {
    if (!(err instanceof AnchorError) || err.status !== 401) throw err;
    const fresh = await authenticate(anchor, signer, networkPassphrase, true);
    return await call(fresh);
  }
}

export function clearTokenCache(): void {
  tokens.clear();
}

async function requestToken(
  anchor: AnchorEndpoints,
  signer: Keypair,
  networkPassphrase: string,
): Promise<string> {
  const challenge = await anchorFetch<ChallengeResponse>(anchor.webAuth, {
    query: { account: signer.publicKey(), home_domain: anchor.homeDomain },
  });
  if (!challenge?.transaction) {
    throw new AnchorError(0, anchor.webAuth, "SEP-10 challenge response had no transaction");
  }

  const passphrase = challenge.network_passphrase ?? anchor.networkPassphrase ?? networkPassphrase;

  // Verify before signing. The challenge is a transaction we are about to put our signature on;
  // signing one we have not checked means signing whatever an impostor sent.
  WebAuth.readChallengeTx(
    challenge.transaction,
    anchor.signingKey,
    passphrase,
    anchor.homeDomain,
    new URL(anchor.webAuth).host,
  );

  const tx = new Transaction(challenge.transaction, passphrase);
  tx.sign(signer);

  const { token } = await anchorFetch<TokenResponse>(anchor.webAuth, {
    method: "POST",
    body: { transaction: tx.toXDR() },
  });
  if (!token) throw new AnchorError(0, anchor.webAuth, "SEP-10 returned no token");
  return token;
}

/** Read `exp` out of the JWT payload without verifying it — we only need to know when to refresh. */
function expiryOf(token: string): number {
  try {
    const payload = token.split(".")[1];
    if (!payload) return Date.now() + FALLBACK_TTL_MS;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    if (typeof claims.exp !== "number") return Date.now() + FALLBACK_TTL_MS;
    return claims.exp * 1000 - EXPIRY_MARGIN_MS;
  } catch {
    return Date.now() + FALLBACK_TTL_MS;
  }
}
