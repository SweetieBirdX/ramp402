import { createApp } from "./app.js";
import { createAuthMiddleware, privyServicesFromEnv } from "./auth.js";
import { getDb } from "./db.js";
import { createFunder, FRIENDBOT_URLS } from "./funding.js";
import { createRepo } from "./repo.js";
import { getStellar, scv } from "./stellar.js";

// Everything is built at startup, so a missing env var fails here and not on the first request.
const repo = createRepo(getDb());
const privy = privyServicesFromEnv();
const stellar = getStellar();

const app = createApp({
  repo,
  authenticate: createAuthMiddleware({ verifyToken: privy.verifyToken, repo }),
  findStellarWallet: privy.findStellarWallet,
  readBalance: (address) => stellar.readView<bigint>("get_balance", [scv.address(address)]),
  funder: createFunder({
    accountExists: stellar.accountExists,
    friendbotUrl: FRIENDBOT_URLS[stellar.networkPassphrase],
    log: (line) => console.log(line),
  }),
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => console.log(`ramp402 gateway listening on :${port}`));
