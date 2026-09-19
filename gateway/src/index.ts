import { createApp } from "./app.js";
import { createAuthMiddleware, privyServicesFromEnv } from "./auth.js";
import { credentialCipherFromEnv } from "./credentials.js";
import { getDb } from "./db.js";
import { createDraftStore } from "./drafts.js";
import { createFunder, FRIENDBOT_URLS } from "./funding.js";
import { createRepo } from "./repo.js";
import { caip2Network, createPaymentGate } from "./payments.js";
import { createProxyLedger } from "./proxyLedger.js";
import { getStellar, scv } from "./stellar.js";
import { payoutConfigFromEnv } from "./anchor/payout.js";
import { resolveAnchor, withdrawMinimum } from "./anchor/index.js";
import { createWithdrawalJobs } from "./withdrawalJob.js";
import { Keypair } from "@stellar/stellar-sdk";

// Everything is built at startup, so a missing env var fails here and not on the first request.
const repo = createRepo(getDb());
const privy = privyServicesFromEnv();
const stellar = getStellar();

const facilitatorUrl = process.env.X402_FACILITATOR_URL?.trim();
const poolSecret = process.env.PLATFORM_POOL_SECRET_KEY?.trim();
if (!facilitatorUrl || !poolSecret) {
  throw new Error("Missing required environment variable(s): X402_FACILITATOR_URL, PLATFORM_POOL_SECRET_KEY");
}
// Agents pay the platform pool (§1.2: the contract holds no tokens). Only the public key is kept.
const poolAddress = Keypair.fromSecret(poolSecret).publicKey();

const anchorHomeDomain = process.env.ANCHOR_HOME_DOMAIN?.trim();
if (!anchorHomeDomain) {
  throw new Error("Missing required environment variable(s): ANCHOR_HOME_DOMAIN");
}

// The off-ramp. Built here so a bad PLATFORM_POOL_SECRET_KEY fails at startup rather than on the
// first withdrawal, which would be minutes after the seller thought it had worked.
const withdrawalJobs = createWithdrawalJobs({
  repo,
  payout: payoutConfigFromEnv(),
  networkPassphrase: stellar.networkPassphrase,
  defaultAnchorDomain: anchorHomeDomain,
  preferredCurrency: process.env.ANCHOR_PAYOUT_CURRENCY?.trim() || "TRY",
});

const app = createApp({
  repo,
  authenticate: createAuthMiddleware({ verifyToken: privy.verifyToken, repo }),
  findStellarWallet: privy.findStellarWallet,
  drafts: createDraftStore(),
  credentialCipher: credentialCipherFromEnv(),
  gate: createPaymentGate({ facilitatorUrl, network: caip2Network(process.env.STELLAR_NETWORK ?? ""), payTo: poolAddress }),
  proxyLedger: createProxyLedger(stellar),
  ledger: stellar,
  readBalance: (address) => stellar.readView<bigint>("get_balance", [scv.address(address)]),
  funder: createFunder({
    accountExists: stellar.accountExists,
    friendbotUrl: FRIENDBOT_URLS[stellar.networkPassphrase],
    log: (line) => console.log(line),
  }),
  startAnchorFlow: (row) => withdrawalJobs.start(row),
  anchorHomeDomain,
  // §1.5: read the anchor's own limit rather than assuming ours. It publishes none today, so the
  // 1 USDC floor stands — but an anchor that raises it is honoured without a code change.
  anchorMinimumStroops: async () => {
    const anchor = await resolveAnchor(anchorHomeDomain);
    const units = await withdrawMinimum(anchor, "USDC", "bank_account");
    return units === undefined ? undefined : Math.round(units * 10_000_000);
  },
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, async () => {
  console.log(`ramp402 gateway listening on :${port}`);
  console.log(`anchor: ${anchorHomeDomain}`);

  // A restart must not strand a withdrawal in `pending` for ever: pick up anything that already
  // reached the anchor and keep polling it.
  try {
    const { resumed, stranded } = await withdrawalJobs.resumeInterrupted();
    if (resumed) console.log(`resumed ${resumed} interrupted withdrawal(s)`);
    if (stranded.length) console.warn(`${stranded.length} withdrawal(s) need a human: ${stranded.join(", ")}`);
  } catch (err) {
    console.error("could not resume interrupted withdrawals:", err);
  }
});
