/**
 * setup.ts — bring Ramp402 up from nothing, on a machine that has nothing.
 *
 *     OPERATOR_SECRET_KEY=S... npx tsx scripts/setup.ts
 *
 * The hackathon sandbox can be reset at any time and we cannot rebuild by hand
 * under time pressure. This creates and funds every account the system needs,
 * puts the USDC trustline on the platform pool, registers a demo endpoint, and
 * prints the environment block to paste into `gateway/.env`.
 *
 * Two rules it will not break:
 *
 *   1. It NEVER generates an operator. The operator address is baked into the
 *      deployed contract; minting a new one would make every record_call and
 *      settle fail with NotOperator. It reads OPERATOR_SECRET_KEY and verifies
 *      it against the chain before doing anything else.
 *   2. It NEVER writes a secret to a file in the repo. Secrets go to stdout,
 *      once, for a human to place.
 *
 * Idempotent: every account it would create is reused if the matching secret is
 * already in the environment (the root .env, or gateway/.env as a fallback), and
 * Friendbot funding and the trustline are both no-ops when they are already done.
 * The demo endpoint is reused too, as long as it is cached in SQLite and still on
 * chain with the same seller and price; otherwise a fresh one is registered.
 * Re-running it is safe.
 */
import { randomBytes } from "node:crypto";
import { Asset, Keypair, StellarToml } from "@stellar/stellar-sdk";
import {
  CONTRACT_ID,
  RPC_URL,
  createSteps,
  ensureTrustline,
  fatal,
  friendbotFund,
  read,
  short,
} from "./lib/chain.js";
import {
  DEMO_UPSTREAM_URL,
  cacheDemoEndpoint,
  findLiveDemoEndpoint,
  openDatabase,
  priceLabel,
  registerDemoEndpoint,
  type DemoEndpoint,
} from "./lib/demo.js";

// No default. A silent fallback would put the pool's trustline on whatever issuer some other anchor
// lists, and the gateway would then off-ramp against a different anchor than the one configured.
const ANCHOR_HOME_DOMAIN = process.env.ANCHOR_HOME_DOMAIN?.trim();

/** A key taken from the environment, or minted here — the summary says which. */
interface ResolvedKey {
  keypair: Keypair;
  generated: boolean;
}

function resolveKey(variable: string): ResolvedKey {
  const existing = process.env[variable]?.trim();
  if (existing) return { keypair: Keypair.fromSecret(existing), generated: false };
  return { keypair: Keypair.random(), generated: true };
}

/**
 * An account we only ever need the ADDRESS of.
 *
 * The treasury is one: `TreasuryTotal` is a counter inside the contract and no
 * function takes a treasury address, so the treasury never signs anything. The
 * gateway therefore carries `TREASURY_ADDRESS`, a public key, and there may be
 * no secret for it anywhere. Honour that address when it is set — minting a new
 * treasury on every run would make this script anything but idempotent.
 */
interface ResolvedAccount {
  publicKey: string;
  secret?: string;
  origin: "reused from env" | "generated";
}

function resolveTreasury(): ResolvedAccount {
  const secret = process.env.TREASURY_SECRET_KEY?.trim();
  if (secret) {
    return {
      publicKey: Keypair.fromSecret(secret).publicKey(),
      secret,
      origin: "reused from env",
    };
  }

  const address = process.env.TREASURY_ADDRESS?.trim();
  if (address) return { publicKey: address, origin: "reused from env" };

  const keypair = Keypair.random();
  return { publicKey: keypair.publicKey(), secret: keypair.secret(), origin: "generated" };
}

const origin = (key: ResolvedKey) => (key.generated ? "generated" : "reused from env");

async function main(): Promise<void> {
  const operatorSecret = process.env.OPERATOR_SECRET_KEY?.trim();
  if (!operatorSecret) {
    console.error("[FAIL] OPERATOR_SECRET_KEY is not set.");
    console.error();
    console.error("  This script will not invent one. The deployed contract stores its operator");
    console.error("  and refuses record_call and settle from anyone else, so a fresh key would");
    console.error("  produce a system that looks configured and fails on every paid call.");
    console.error();
    console.error("      OPERATOR_SECRET_KEY=S... npx tsx scripts/setup.ts");
    console.error();
    console.error("  If the key is genuinely lost, rotate the contract instead:");
    console.error("      stellar contract invoke --id <CONTRACT_ID> --network testnet \\");
    console.error("        --source-account ramp402-operator -- set_operator --new_operator G...");
    process.exit(1);
  }
  if (!ANCHOR_HOME_DOMAIN) {
    console.error("[FAIL] ANCHOR_HOME_DOMAIN is not set.");
    console.error();
    console.error("  The USDC issuer for the pool's trustline is read from this anchor's stellar.toml,");
    console.error("  and there is deliberately no default. For the testnet demo:");
    console.error();
    console.error("      ANCHOR_HOME_DOMAIN=testanchor.stellar.org");
    process.exit(1);
  }

  const operator = Keypair.fromSecret(operatorSecret);
  const pool = resolveKey("PLATFORM_POOL_SECRET_KEY");
  const treasury = resolveTreasury();
  const demoSeller = resolveKey("DEMO_SELLER_SECRET_KEY");

  console.log("ramp402 · setup");
  console.log(`  network    testnet`);
  console.log(`  rpc        ${RPC_URL}`);
  console.log(`  contract   ${CONTRACT_ID}`);
  console.log(`  anchor     ${ANCHOR_HOME_DOMAIN}`);
  console.log();

  const steps = createSteps(8);
  let usdc: Asset | undefined;
  let demo: DemoEndpoint | undefined;

  // Funded, never created: the operator is whoever the contract was deployed with. On a fresh
  // testnet this is also what makes the check below possible — it needs the account to exist.
  await steps.step("operator account funded", async () => {
    const state = await friendbotFund(operator.publicKey());
    return `${short(operator.publicKey())} ${state}`;
  });

  await steps.step("the operator key matches the deployed contract", async () => {
    const stored = await read<string>("get_operator", [], operator);
    if (stored !== operator.publicKey()) {
      throw new Error(
        `the contract's operator is ${stored}, but OPERATOR_SECRET_KEY is ${operator.publicKey()} — ` +
          `every record_call and settle would fail with NotOperator`,
      );
    }
    return `${short(operator.publicKey())} confirmed on chain`;
  });

  await steps.step("platform pool account funded", async () => {
    const state = await friendbotFund(pool.keypair.publicKey());
    return `${short(pool.keypair.publicKey())} ${state} (${origin(pool)})`;
  });

  await steps.step("USDC issuer read from the anchor's stellar.toml", async () => {
    // Hardcode nothing the toml can tell us (§1.5): the mainnet issuer differs,
    // and an anchor may rotate its own.
    const toml = await StellarToml.Resolver.resolve(ANCHOR_HOME_DOMAIN);
    const entry = toml.CURRENCIES?.find((c) => c.code === "USDC" && c.issuer);
    if (!entry?.issuer) {
      throw new Error(`${ANCHOR_HOME_DOMAIN} lists no USDC issuer in its stellar.toml`);
    }
    usdc = new Asset("USDC", entry.issuer);
    return `USDC issued by ${short(entry.issuer)}`;
  });

  await steps.step("USDC trustline on the platform pool", async () => {
    if (!usdc) throw new Error("no USDC asset resolved");
    const state = await ensureTrustline(pool.keypair, usdc);
    return `trustline ${state}`;
  });

  await steps.step("treasury account funded", async () => {
    const state = await friendbotFund(treasury.publicKey);
    return `${short(treasury.publicKey)} ${state} (${treasury.origin})`;
  });

  await steps.step("demo seller funded", async () => {
    const state = await friendbotFund(demoSeller.keypair.publicKey());
    return `${short(demoSeller.keypair.publicKey())} ${state} (${origin(demoSeller)})`;
  });

  await steps.step("demo endpoint registered and cached", async () => {
    const db = openDatabase();
    try {
      const live = await findLiveDemoEndpoint(db, demoSeller.keypair);
      const endpointId = live?.endpointId ?? (await registerDemoEndpoint(demoSeller.keypair));
      demo = cacheDemoEndpoint(db, endpointId, demoSeller.keypair.publicKey(), live?.proxySlug);
      const state = live ? "already registered" : "registered";
      return `endpoint_id ${demo.endpointId} ${state} → /proxy/${demo.proxySlug} at ${priceLabel()}`;
    } finally {
      db.close();
    }
  });

  // ------------------------------------------------------------------------------------------
  // The handoff block. Secrets reach stdout and nothing else — never a file in
  // the repo, never a log, never a commit.
  // ------------------------------------------------------------------------------------------
  console.log();
  console.log("─".repeat(92));
  console.log("Paste into gateway/.env — these are testnet keys, and they are still secrets.");
  console.log("─".repeat(92));
  console.log();
  const encryptionKey = process.env.UPSTREAM_CRED_ENCRYPTION_KEY?.trim();
  const port = process.env.PORT?.trim() || "3001";

  console.log(`PORT=${port}`);
  console.log(`STELLAR_NETWORK=testnet`);
  console.log(`STELLAR_RPC_URL=${RPC_URL}`);
  console.log(`CONTRACT_ID=${CONTRACT_ID}`);
  console.log(`ANCHOR_HOME_DOMAIN=${ANCHOR_HOME_DOMAIN}`);
  console.log(`X402_FACILITATOR_URL=${process.env.X402_FACILITATOR_URL?.trim() || "https://x402.org/facilitator"}`);
  console.log(`DB_PATH=${process.env.DB_PATH?.trim() || "ramp402.db"}`);
  console.log(`# OPERATOR_SECRET_KEY — unchanged, the one you passed in. Not reprinted.`);
  if (pool.generated) {
    console.log(`PLATFORM_POOL_SECRET_KEY=${pool.keypair.secret()}`);
  } else {
    console.log(`# PLATFORM_POOL_SECRET_KEY — unchanged (${short(pool.keypair.publicKey())})`);
  }
  if (treasury.origin === "generated") {
    console.log(`TREASURY_ADDRESS=${treasury.publicKey}`);
    console.log(`# TREASURY_SECRET_KEY is not read by the gateway — the treasury never signs,`);
    console.log(`# because TreasuryTotal is a counter in the contract. Keep it anyway, or the`);
    console.log(`# account is unrecoverable:`);
    console.log(`# TREASURY_SECRET_KEY=${treasury.secret}`);
  } else {
    console.log(`# TREASURY_ADDRESS — unchanged (${short(treasury.publicKey)})`);
  }
  if (encryptionKey) {
    console.log(`# UPSTREAM_CRED_ENCRYPTION_KEY — unchanged. Rotating it makes every stored credential unreadable.`);
  } else {
    // 256-bit AES-GCM key, hex (credentials.ts). Printed once like every other secret.
    console.log(`UPSTREAM_CRED_ENCRYPTION_KEY=${randomBytes(32).toString("hex")}`);
  }
  if (!process.env.PRIVY_APP_ID?.trim() || !process.env.PRIVY_APP_SECRET?.trim()) {
    console.log(`# PRIVY_APP_ID and PRIVY_APP_SECRET come from the Privy dashboard — no script can make them.`);
  }
  console.log();
  console.log(`# Demo fixtures — not read by the gateway, used by scripts/reset-demo.ts.`);
  console.log(`# Keep them to get the same demo endpoint back after a reset.`);
  if (demoSeller.generated) {
    console.log(`DEMO_SELLER_SECRET_KEY=${demoSeller.keypair.secret()}`);
  }
  if (demo) {
    console.log(`DEMO_PROXY_SLUG=${demo.proxySlug}`);
    console.log(`DEMO_UPSTREAM_URL=${DEMO_UPSTREAM_URL}`);
  }
  console.log();
  console.log(`Try it once the gateway is running:`);
  console.log(`  curl -i http://localhost:${port}/proxy/${demo?.proxySlug ?? "<slug>"}`);
  console.log(`  → 402, because the agent has not paid yet. That is the product working.`);

  steps.finish(`ready — demo endpoint ${demo?.endpointId} on ${CONTRACT_ID}`);
}

main().catch(fatal);
