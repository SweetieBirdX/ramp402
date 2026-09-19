// The external services the demo depends on, as they are right now. Run with `npm run test:integration`.
// These test the environment, not our code: when one fails, the sandbox changed under us and the
// demo will break for a reason no unit test can see. Skipped when the variables they need are unset.
import { StellarToml } from "@stellar/stellar-sdk";
import dotenv from "dotenv";
import { describe, expect, it } from "vitest";
import { caip2Network } from "./payments.js";

dotenv.config({ quiet: true });

const anchorDomain = process.env.ANCHOR_HOME_DOMAIN?.trim();
const facilitatorUrl = process.env.X402_FACILITATOR_URL?.trim();
const network = process.env.STELLAR_NETWORK?.trim();

describe.skipIf(!facilitatorUrl || !network)("x402 facilitator (network)", () => {
  it("still supports the exact scheme over x402 v2 on our Stellar network", async () => {
    const res = await fetch(`${facilitatorUrl!.replace(/\/$/, "")}/supported`);
    expect(res.ok).toBe(true);
    const { kinds } = (await res.json()) as { kinds: Array<{ x402Version: number; scheme: string; network: string }> };
    expect(kinds).toContainEqual(expect.objectContaining({ x402Version: 2, scheme: "exact", network: caip2Network(network!) }));
  });
});

describe.skipIf(!anchorDomain)("anchor stellar.toml (network)", () => {
  // §1.5: everything the off-ramp needs is read from here. If a field disappears, the withdrawal
  // flow has nothing to read it from.
  it("publishes every endpoint the SEP-10/12/38/6 withdrawal flow reads", async () => {
    const toml = await StellarToml.Resolver.resolve(anchorDomain!);
    for (const key of ["WEB_AUTH_ENDPOINT", "KYC_SERVER", "ANCHOR_QUOTE_SERVER", "TRANSFER_SERVER", "SIGNING_KEY"] as const) {
      expect(toml[key], key).toEqual(expect.any(String));
    }
    expect(toml.SIGNING_KEY).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it("lists a USDC issuer, the one the platform pool's trustline is built from", async () => {
    const toml = await StellarToml.Resolver.resolve(anchorDomain!);
    const usdc = toml.CURRENCIES?.find((c) => c.code === "USDC");
    expect(usdc?.issuer).toMatch(/^G[A-Z2-7]{55}$/);
  });
});
