/**
 * reset-demo.ts — put the demo back to a clean start between rehearsals.
 *
 *     npx tsx scripts/reset-demo.ts
 *
 * Deletes the local SQLite cache, recreates it from `gateway/schema.sql`, and
 * registers a fresh demo endpoint so the next run has no leftover calls,
 * balances or withdrawals in the dashboard.
 *
 * What it deliberately does NOT do:
 *
 *   - redeploy or touch the contract. CONTRACT_ID does not change.
 *   - generate, rotate or overwrite any key. The operator, the platform pool
 *     and the treasury are left exactly as they are.
 *   - undo anything on chain. Ledger history is permanent, and the balances the
 *     previous rehearsal settled are still there. That is the point of the
 *     chain being the source of truth: this resets the cache, not the truth.
 *
 * Safe to run between demos, and safe to run twice.
 */
import { Keypair } from "@stellar/stellar-sdk";
import { CONTRACT_ID, createSteps, fatal, friendbotFund, read, short } from "./lib/chain.js";
import {
  cacheDemoEndpoint,
  databasePath,
  deleteDatabase,
  openDatabase,
  priceLabel,
  registerDemoEndpoint,
  REPO_ROOT,
  type DemoEndpoint,
} from "./lib/demo.js";

async function main(): Promise<void> {
  const demoSellerSecret = process.env.DEMO_SELLER_SECRET_KEY?.trim();
  const demoSeller = demoSellerSecret ? Keypair.fromSecret(demoSellerSecret) : Keypair.random();
  const generatedSeller = !demoSellerSecret;

  console.log("ramp402 · reset-demo");
  console.log(`  contract   ${CONTRACT_ID}  (untouched)`);
  console.log(`  database   ${databasePath().slice(REPO_ROOT.length + 1)}`);
  console.log(`  seller     ${short(demoSeller.publicKey())}${generatedSeller ? "  (new — DEMO_SELLER_SECRET_KEY was not set)" : ""}`);
  console.log();

  const steps = createSteps(4);
  let demo: DemoEndpoint | undefined;

  await steps.step("the contract is reachable and unchanged", async () => {
    // A read, not a write. If this fails, the reset would leave a database
    // pointing at an endpoint that does not exist.
    const operator = await read<string>("get_operator", [], demoSeller);
    return `operator ${short(operator)} still in place`;
  });

  await steps.step("the SQLite cache is deleted", async () => {
    const removed = deleteDatabase();
    return removed.length > 0 ? `removed ${removed.join(", ")}` : "nothing to delete";
  });

  await steps.step("the schema is recreated", async () => {
    const db = openDatabase();
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[];
      const names = tables.map((t) => t.name).filter((n) => !n.startsWith("sqlite_"));
      if (names.length === 0) throw new Error("schema.sql created no tables");
      return names.join(", ");
    } finally {
      db.close();
    }
  });

  await steps.step("a fresh demo endpoint is registered and cached", async () => {
    await friendbotFund(demoSeller.publicKey());
    const endpointId = await registerDemoEndpoint(demoSeller);
    const db = openDatabase();
    try {
      demo = cacheDemoEndpoint(db, endpointId, demoSeller.publicKey());
    } finally {
      db.close();
    }
    return `endpoint_id ${demo.endpointId} → /proxy/${demo.proxySlug} at ${priceLabel()}`;
  });

  console.log();
  if (generatedSeller) {
    console.log("A new demo seller was created because DEMO_SELLER_SECRET_KEY was not set.");
    console.log("Set it to keep the same seller — and the same dashboard — across resets:");
    console.log();
    console.log(`DEMO_SELLER_SECRET_KEY=${demoSeller.secret()}`);
    console.log();
  }
  console.log(`Demo is clean. Next call to /proxy/${demo?.proxySlug ?? "<slug>"} starts from zero.`);

  steps.finish(`demo reset — endpoint ${demo?.endpointId}, contract unchanged`);
}

main().catch(fatal);
