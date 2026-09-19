// The off-ramp against a real anchor. Run with `npm run test:integration`.
//
// This is the test that proves the "Anchor / Local Payments" requirement: it authenticates over
// SEP-10, locks a SEP-38 rate, satisfies whatever SEP-12 asks for, starts a SEP-6 withdrawal, sends
// the USDC as a classic payment with the anchor's `id` memo, and polls until the anchor is done.
//
// It moves REAL testnet USDC out of the platform pool — a small amount, once per run. It is in the
// integration lane for exactly that reason, and skips itself when the environment is not set up.
import dotenv from "dotenv";
import { describe, expect, it } from "vitest";
import { runWithdrawalFlow, type AnchorProgress } from "./index.js";
import { payoutConfigFromEnv } from "./payout.js";
import { resolveAnchor } from "./toml.js";
import { withdrawTypes } from "./sep6.js";

dotenv.config({ quiet: true });

const anchorDomain = process.env.ANCHOR_HOME_DOMAIN?.trim();
const poolSecret = process.env.PLATFORM_POOL_SECRET_KEY?.trim();
const rpcUrl = process.env.STELLAR_RPC_URL?.trim();
const ready = Boolean(anchorDomain && poolSecret && rpcUrl);

/** 1 USDC — the anchor's minimum (§1.5), and no more than the proof needs. */
const AMOUNT_STROOPS = 10_000_000;

describe.skipIf(!ready)(`anchor off-ramp (network, ${anchorDomain ?? "unconfigured"})`, () => {
  it("reads every endpoint it needs from the anchor's stellar.toml", async () => {
    const anchor = await resolveAnchor(anchorDomain!);

    expect(anchor.webAuth).toMatch(/^https:\/\//);
    expect(anchor.transfer).toMatch(/^https:\/\//);
    expect(anchor.signingKey).toMatch(/^G[A-Z2-7]{55}$/);
    // The issuer is read, never hardcoded: the mainnet one differs (§1.5).
    expect(anchor.assetIssuer("USDC")).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it("offers a withdrawal method for USDC", async () => {
    const anchor = await resolveAnchor(anchorDomain!);
    const types = await withdrawTypes(anchor, "USDC");
    expect(types.length).toBeGreaterThan(0);
  });

  it(
    "completes a real withdrawal: SEP-10 → SEP-38 → SEP-12 → SEP-6 → payment → completed",
    { timeout: 300_000 },
    async () => {
      const progress: AnchorProgress[] = [];

      const result = await runWithdrawalFlow({
        homeDomain: anchorDomain!,
        assetCode: "USDC",
        amountStroops: AMOUNT_STROOPS,
        preferredCurrency: process.env.ANCHOR_PAYOUT_CURRENCY?.trim() || "TRY",
        payout: payoutConfigFromEnv(),
        networkPassphrase: "Test SDF Network ; September 2015",
        pollIntervalMs: 2_000,
        pollTimeoutMs: 240_000,
        onProgress: (p) => {
          progress.push(p);
          // `anchorStatus` is absent until the anchor answers; our own stage fills the gap so the
          // log reads as a sequence without either being mistaken for the other.
          const label = p.anchorStatus ? `anchor:${p.anchorStatus}` : `ours:${p.stage}`;
          console.log(`  [${label}] ${p.message ?? ""}`.trimEnd());
        },
      });

      console.log("\n  result:", JSON.stringify(result, null, 2).replace(/\n/g, "\n  "));

      expect(result.status).toBe("completed");
      expect(result.anchorStatus).toBe("completed");
      expect(result.anchorTxId).toEqual(expect.any(String));

      // The rate was locked before the money moved, and it is what the dashboard shows.
      expect(result.quoteBuyAmount).toEqual(expect.any(String));
      expect(Number(result.quoteBuyAmount)).toBeGreaterThan(0);

      // The proof the fiat leg actually happened, not just the Stellar one.
      expect(result.externalTransactionId).toEqual(expect.any(String));

      // The flow reported its way through, rather than jumping from nothing to done.
      const seen = progress.map((p) => p.anchorStatus);
      expect(seen).toContain("pending_user_transfer_start");
    },
  );
});
