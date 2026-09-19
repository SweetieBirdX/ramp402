/**
 * preflight.ts — run this five minutes before the demo.
 *
 *     npx tsx scripts/preflight.ts
 *
 * Read-only and fast: it checks that every moving part is alive and that they agree with each
 * other. It moves no money, signs nothing, and changes nothing. A green run is the statement that
 * the demo can proceed; a red one names what to fix, in a sentence you can act on.
 *
 * Every check here exists because something like it has actually gone wrong: a CONTRACT_ID pointing
 * at a stale deployment, an operator key that does not match the contract, a pool with a trustline
 * but no balance, an anchor that stopped quoting the currency we sell.
 */
import { Keypair, StellarToml } from "@stellar/stellar-sdk";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import {
  CONTRACT_ID,
  RPC_URL,
  createSteps,
  fatal,
  horizon,
  read,
  server,
  short,
  usdc,
} from "./lib/chain.js";
import { databasePath, DEMO_SELLER_ID } from "./lib/demo.js";

/** One withdrawal's worth: below this the off-ramp cannot be demonstrated (§1.5). */
const MIN_POOL_USDC_STROOPS = 10_000_000n;

const ANCHOR_HOME_DOMAIN = process.env.ANCHOR_HOME_DOMAIN?.trim();
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL?.trim() || "https://x402.org/facilitator";
const STELLAR_NETWORK = process.env.STELLAR_NETWORK?.trim() || "testnet";
const PAYOUT_CURRENCY = process.env.ANCHOR_PAYOUT_CURRENCY?.trim() || "TRY";
const GATEWAY_URL = process.env.GATEWAY_URL?.trim() || `http://localhost:${process.env.PORT ?? "3001"}`;

/** CAIP-2, matching gateway/src/payments.ts — the facilitator answers per network. */
function caip2Network(network: string): string {
  const n = network.toLowerCase();
  if (n === "testnet" || n === "stellar:testnet") return "stellar:testnet";
  if (["pubnet", "mainnet", "public", "stellar:pubnet"].includes(n)) return "stellar:pubnet";
  throw new Error(`Unknown STELLAR_NETWORK "${network}"`);
}

async function main(): Promise<void> {
  const operatorSecret = process.env.OPERATOR_SECRET_KEY?.trim();
  const poolSecret = process.env.PLATFORM_POOL_SECRET_KEY?.trim();

  console.log("ramp402 · preflight");
  console.log(`  network    ${STELLAR_NETWORK}`);
  console.log(`  contract   ${CONTRACT_ID}`);
  console.log(`  anchor     ${ANCHOR_HOME_DOMAIN ?? "(unset)"}`);
  console.log(`  gateway    ${GATEWAY_URL}`);
  console.log();

  const steps = createSteps(8);
  let poolAddress: string | undefined;
  let usdcIssuer: string | undefined;

  await steps.step("every required setting is present", async () => {
    // Names only. A preflight that echoes a secret is a worse problem than the one it solves.
    const required = {
      OPERATOR_SECRET_KEY: operatorSecret,
      PLATFORM_POOL_SECRET_KEY: poolSecret,
      ANCHOR_HOME_DOMAIN: ANCHOR_HOME_DOMAIN,
      CONTRACT_ID,
    };
    const missing = Object.entries(required)
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length) {
      throw new Error(`not set: ${missing.join(", ")} — copy .env.example to .env and fill them in`);
    }
    return `${Object.keys(required).length} settings`;
  });

  await steps.step("Soroban RPC is reachable", async () => {
    const health = await server.getHealth();
    if (health.status !== "healthy") throw new Error(`RPC reports ${health.status}`);
    return `${RPC_URL} healthy`;
  });

  await steps.step("the contract is live and its operator matches our key", async () => {
    const operator = Keypair.fromSecret(operatorSecret!);
    const stored = await read<string>("get_operator", [], operator);
    if (stored !== operator.publicKey()) {
      throw new Error(
        `the contract's operator is ${stored}, but OPERATOR_SECRET_KEY is ${operator.publicKey()}. ` +
          `Every record_call and settle would fail with NotOperator. Either fix the key or rotate ` +
          `the contract with set_operator.`,
      );
    }
    return `operator ${short(stored)} confirmed on chain`;
  });

  await steps.step("the platform pool can pay an anchor", async () => {
    poolAddress = Keypair.fromSecret(poolSecret!).publicKey();

    let account: Awaited<ReturnType<typeof horizon.loadAccount>>;
    try {
      account = await horizon.loadAccount(poolAddress);
    } catch {
      throw new Error(`${short(poolAddress)} does not exist on this network — run scripts/setup.ts`);
    }

    const usdcBalance = account.balances.find(
      (b) => "asset_code" in b && b.asset_code === "USDC",
    ) as { balance: string; asset_issuer?: string } | undefined;

    if (!usdcBalance) {
      throw new Error(`${short(poolAddress)} has no USDC trustline — run scripts/setup.ts`);
    }
    usdcIssuer = usdcBalance.asset_issuer;

    const stroops = BigInt(Math.round(Number(usdcBalance.balance) * 10_000_000));
    if (stroops < MIN_POOL_USDC_STROOPS) {
      throw new Error(
        `${short(poolAddress)} holds only ${usdcBalance.balance} USDC, below the ${usdc(MIN_POOL_USDC_STROOPS)} ` +
          `a single withdrawal needs. The off-ramp cannot be demonstrated until it is topped up.`,
      );
    }
    return `${short(poolAddress)} holds ${usdcBalance.balance} USDC`;
  });

  await steps.step("the anchor is up and still sells what we withdraw", async () => {
    const toml = await StellarToml.Resolver.resolve(ANCHOR_HOME_DOMAIN!);

    const endpoints = {
      WEB_AUTH_ENDPOINT: toml.WEB_AUTH_ENDPOINT,
      TRANSFER_SERVER: toml.TRANSFER_SERVER,
      KYC_SERVER: toml.KYC_SERVER,
      ANCHOR_QUOTE_SERVER: toml.ANCHOR_QUOTE_SERVER,
    };
    const absent = Object.entries(endpoints).filter(([, v]) => !v).map(([k]) => k);
    if (absent.length) throw new Error(`${ANCHOR_HOME_DOMAIN} no longer publishes ${absent.join(", ")}`);

    // The issuer the anchor names must be the one the pool actually holds, or the payment is
    // refused at the trustline — after SEP-10, SEP-38 and SEP-12 have already run.
    const anchorIssuer = toml.CURRENCIES?.find((c) => c.code === "USDC")?.issuer;
    if (!anchorIssuer) throw new Error(`${ANCHOR_HOME_DOMAIN} does not list a USDC issuer`);
    if (usdcIssuer && anchorIssuer !== usdcIssuer) {
      throw new Error(
        `the anchor issues USDC from ${short(anchorIssuer)} but the pool holds ${short(usdcIssuer)} — ` +
          `the payout would be rejected for want of a trustline`,
      );
    }

    const sep6 = (await (await fetch(`${String(toml.TRANSFER_SERVER).replace(/\/+$/, "")}/info`)).json()) as {
      withdraw?: Record<string, { enabled?: boolean; types?: Record<string, unknown> }>;
    };
    if (!sep6.withdraw?.USDC?.enabled) throw new Error(`${ANCHOR_HOME_DOMAIN} is not withdrawing USDC right now`);

    const sep38 = (await (await fetch(`${String(toml.ANCHOR_QUOTE_SERVER).replace(/\/+$/, "")}/info`)).json()) as {
      assets?: { asset: string }[];
    };
    const sells = (sep38.assets ?? []).map((a) => a.asset);
    if (!sells.includes(`iso4217:${PAYOUT_CURRENCY}`)) {
      throw new Error(
        `${ANCHOR_HOME_DOMAIN} no longer quotes ${PAYOUT_CURRENCY} (it offers ${sells.filter((s) => s.startsWith("iso4217:")).join(", ") || "no fiat"})`,
      );
    }
    return `USDC → ${PAYOUT_CURRENCY}, issuer ${short(anchorIssuer)}`;
  });

  await steps.step("the x402 facilitator still supports our network", async () => {
    const network = caip2Network(STELLAR_NETWORK);
    const res = await fetch(`${FACILITATOR_URL.replace(/\/+$/, "")}/supported`);
    if (!res.ok) throw new Error(`${FACILITATOR_URL}/supported → ${res.status}`);
    const { kinds } = (await res.json()) as { kinds: { x402Version: number; scheme: string; network: string }[] };

    const supported = kinds.some((k) => k.x402Version === 2 && k.scheme === "exact" && k.network === network);
    if (!supported) {
      throw new Error(`the facilitator does not advertise x402 v2 "exact" on ${network} — the proxy cannot take payment`);
    }
    return `x402 v2 exact on ${network}`;
  });

  await steps.step("the local cache matches CONVENTIONS.md §1.4 and has the demo endpoint", async () => {
    const db = new Database(databasePath(), { readonly: true, fileMustExist: true });
    try {
      // Compare column by column against §1.4's copy, applied to a scratch database. A text diff
      // trips over the comments; this compares what SQLite actually built.
      const expected = new Database(":memory:");
      const conventions = readFileSync(
        new URL("../docs/CONVENTIONS.md", import.meta.url),
        "utf8",
      );
      for (const match of conventions.matchAll(/CREATE TABLE IF NOT EXISTS[\s\S]*?\n\);/g)) {
        expected.exec(match[0]);
      }

      const columnsOf = (handle: Database.Database, table: string) =>
        (handle.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

      const tables = (expected.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .map((t) => t.name);

      for (const table of tables) {
        const want = columnsOf(expected, table);
        const have = columnsOf(db, table);
        const missing = want.filter((c) => !have.includes(c));
        if (missing.length) {
          throw new Error(
            `${table} is missing ${missing.join(", ")} — the schema changed. Run: npx tsx scripts/reset-demo.ts`,
          );
        }
      }

      const demo = db
        .prepare(
          `SELECT proxy_slug, price_stroops FROM endpoints
           WHERE seller_id = ? AND proxy_slug NOT LIKE '%-retired-%'
           ORDER BY CAST(id AS INTEGER) DESC LIMIT 1`,
        )
        .get(DEMO_SELLER_ID) as { proxy_slug: string; price_stroops: number } | undefined;

      if (!demo) throw new Error("no demo endpoint in the cache — run: npx tsx scripts/setup.ts");
      return `${tables.length} tables, demo at /proxy/${demo.proxy_slug}`;
    } finally {
      db.close();
    }
  });

  await steps.step("the gateway answers", async () => {
    try {
      const res = await fetch(`${GATEWAY_URL}/health`, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) throw new Error(`/health → ${res.status}`);
      const body = (await res.json()) as { ok?: boolean };
      if (!body.ok) throw new Error(`/health returned ${JSON.stringify(body)}`);
      return `${GATEWAY_URL} ok`;
    } catch (err) {
      // Not running is normal when preflighting before starting it; say so rather than fail.
      const reason = err instanceof Error ? err.message : String(err);
      return `not running (${reason}) — start it with: cd gateway && npm run dev`;
    }
  });

  steps.finish(`ready to demo — contract ${CONTRACT_ID}, anchor ${ANCHOR_HOME_DOMAIN}`);
}

main().catch(fatal);
