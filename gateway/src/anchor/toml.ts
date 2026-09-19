// SEP-1: everything about an anchor comes from its stellar.toml, nothing is hardcoded (§1.5).
// The mainnet USDC issuer differs from testnet's, and an anchor may move its own endpoints, so a
// hardcoded URL or issuer is a bug waiting for the worst possible moment.
import { StellarToml } from "@stellar/stellar-sdk";

export interface AnchorEndpoints {
  /** The home domain this was resolved from, e.g. `tr-mock-anchor.fly.dev`. */
  homeDomain: string;
  /** SEP-10 WEB_AUTH_ENDPOINT. */
  webAuth: string;
  /** SEP-6 TRANSFER_SERVER. */
  transfer: string;
  /** SEP-12 KYC_SERVER. Absent when the anchor asks for no KYC at all. */
  kyc?: string;
  /** SEP-38 ANCHOR_QUOTE_SERVER. Absent when the anchor does not quote. */
  quote?: string;
  /** The anchor's SEP-10 signing key, used to verify the challenge really came from it. */
  signingKey: string;
  networkPassphrase?: string;
  /** Issuer of the asset we withdraw, read from [[CURRENCIES]]. */
  assetIssuer(code: string): string;
}

/**
 * Resolved tomls, keyed by home domain. An anchor's toml changes about as often as its DNS, and a
 * withdrawal reads it several times; re-fetching per step would add a network round trip to every
 * stage of an already slow flow.
 */
const cache = new Map<string, Promise<AnchorEndpoints>>();

export async function resolveAnchor(homeDomain: string): Promise<AnchorEndpoints> {
  const domain = homeDomain.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!domain) throw new Error("ANCHOR_HOME_DOMAIN is empty");

  let pending = cache.get(domain);
  if (!pending) {
    pending = load(domain).catch((err) => {
      cache.delete(domain); // never cache a failure: the anchor may just have been restarting
      throw err;
    });
    cache.set(domain, pending);
  }
  return pending;
}

/** Testing and demo resets; the next resolve re-fetches. */
export function clearAnchorCache(): void {
  cache.clear();
}

async function load(domain: string): Promise<AnchorEndpoints> {
  const toml = await StellarToml.Resolver.resolve(domain);

  const webAuth = toml.WEB_AUTH_ENDPOINT;
  const transfer = toml.TRANSFER_SERVER;
  const signingKey = toml.SIGNING_KEY;

  // Fail here, with the domain named, rather than three steps later with a confusing 404.
  const missing = [
    !webAuth && "WEB_AUTH_ENDPOINT",
    !transfer && "TRANSFER_SERVER",
    !signingKey && "SIGNING_KEY",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`${domain} has no ${missing.join(" or ")} in its stellar.toml — it cannot serve a SEP-6 withdrawal`);
  }

  const currencies = toml.CURRENCIES ?? [];

  return {
    homeDomain: domain,
    webAuth: String(webAuth),
    transfer: stripTrailingSlash(String(transfer)),
    kyc: toml.KYC_SERVER ? stripTrailingSlash(String(toml.KYC_SERVER)) : undefined,
    quote: toml.ANCHOR_QUOTE_SERVER ? stripTrailingSlash(String(toml.ANCHOR_QUOTE_SERVER)) : undefined,
    signingKey: String(signingKey),
    networkPassphrase: toml.NETWORK_PASSPHRASE,
    assetIssuer(code: string): string {
      const entry = currencies.find((c) => c.code === code && c.issuer);
      if (!entry?.issuer) {
        const known = currencies.map((c) => c.code).filter(Boolean).join(", ") || "none";
        throw new Error(`${domain} does not issue ${code} (its stellar.toml lists: ${known})`);
      }
      return entry.issuer;
    },
  };
}

const stripTrailingSlash = (url: string) => url.replace(/\/+$/, "");

/** SEP-38 asset identifiers: `stellar:CODE:ISSUER` for on-chain, `iso4217:TRY` for fiat. */
export const sep38Asset = {
  stellar: (code: string, issuer: string) => `stellar:${code}:${issuer}`,
  fiat: (currency: string) => `iso4217:${currency}`,
};
