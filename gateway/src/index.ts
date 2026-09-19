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
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => console.log(`ramp402 gateway listening on :${port}`));
