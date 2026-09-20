/**
 * verify-e2e.ts — the whole product in one run, against a running gateway.
 *
 *     cd gateway && npm run dev          # in one terminal
 *     npx tsx scripts/verify-e2e.ts      # in another
 *
 * An agent with no account and no API key pays for a call; the seller's on-chain balance rises by
 * the 99% share; the budget it was given holds; and — when a seller token is available — the money
 * comes back out as Turkish Lira through the anchor.
 *
 * This is the integration check CLAUDE.md Rule 5 points at. It spends real testnet USDC: the agent
 * funds itself from the testnet DEX, and the calls it pays for are settled by the public x402
 * facilitator.
 *
 * `PRIVY_ACCESS_TOKEN` is optional. A script cannot mint a Privy token, so without one the
 * seller-authenticated steps are SKIPPED and said so — never quietly passed. Take one from the
 * dashboard's network tab to run the full path.
 */
import Database from "better-sqlite3";
import { Keypair, StellarToml } from "@stellar/stellar-sdk";
import { CONTRACT_ID, createSteps, fatal, read, scv, short, usdc } from "./lib/chain.js";
import { databasePath, DEMO_SELLER_ID } from "./lib/demo.js";
import { fundAgent, newAgent, payForCall, usdcBalance } from "./lib/agent.js";

const GATEWAY_URL = process.env.GATEWAY_URL?.trim() || `http://localhost:${process.env.PORT ?? "3001"}`;
const ANCHOR_HOME_DOMAIN = process.env.ANCHOR_HOME_DOMAIN?.trim();
const PRIVY_ACCESS_TOKEN = process.env.PRIVY_ACCESS_TOKEN?.trim();

/** Three calls' worth, so the fourth is refused — the demo's budget moment. */
const CALLS_WITHIN_BUDGET = 3;

/**
 * The documented agent budget, 1.75 USDC. At the demo price of 0.50 it buys exactly three calls
 * and refuses the fourth at 2.00. Stated rather than derived from the price, because it is one of
 * the two figures the demo economics fix; the guard below catches the two going out of step.
 */
const AGENT_BUDGET_STROOPS = 17_500_000n;

interface DemoEndpointRow {
  id: string;
  proxy_slug: string;
  price_stroops: number;
  stellar_address: string;
}

async function main(): Promise<void> {
  if (!ANCHOR_HOME_DOMAIN) {
    console.error("[FAIL] ANCHOR_HOME_DOMAIN is not set — copy .env.example to .env");
    process.exit(1);
  }

  // The endpoint the demo runs on, as setup.ts left it. Using the real cached row rather than
  // registering a new one keeps this runnable without a seller login.
  const db = new Database(databasePath(), { readonly: true, fileMustExist: true });
  let endpoint: DemoEndpointRow | undefined;
  try {
    endpoint = db
      .prepare(
        `SELECT e.id, e.proxy_slug, e.price_stroops, s.stellar_address
         FROM endpoints e JOIN sellers s ON s.id = e.seller_id
         WHERE e.seller_id = ? AND e.proxy_slug NOT LIKE '%-retired-%'
         ORDER BY CAST(e.id AS INTEGER) DESC LIMIT 1`,
      )
      .get(DEMO_SELLER_ID) as DemoEndpointRow | undefined;
  } finally {
    db.close();
  }
  if (!endpoint) {
    console.error("[FAIL] no demo endpoint in the cache — run: npx tsx scripts/setup.ts");
    process.exit(1);
  }

  const agent = newAgent();
  const price = BigInt(endpoint.price_stroops);
  const budget = AGENT_BUDGET_STROOPS;

  // Fail loudly rather than quietly testing something else. If the endpoint's price and the
  // documented budget disagree, the run would exercise a different number of calls than the demo
  // and its "the fourth is refused" assertion would mean nothing.
  const callsAffordable = Number(budget / price);
  if (callsAffordable !== CALLS_WITHIN_BUDGET) {
    console.error(
      `[FAIL] a ${usdc(budget)} budget buys ${callsAffordable} calls at ${usdc(price)}, not ` +
        `${CALLS_WITHIN_BUDGET}. The demo economics and the registered endpoint price are out of ` +
        `step — re-run scripts/reset-demo.ts, or reconcile DEMO_PRICE_STROOPS with AGENT_BUDGET_STROOPS.`,
    );
    process.exit(1);
  }

  console.log("ramp402 · verify-e2e");
  console.log(`  gateway    ${GATEWAY_URL}`);
  console.log(`  contract   ${CONTRACT_ID}`);
  console.log(`  anchor     ${ANCHOR_HOME_DOMAIN}`);
  console.log(`  endpoint   ${endpoint.id} → /proxy/${endpoint.proxy_slug} at ${usdc(price)} a call`);
  console.log(`  seller     ${short(endpoint.stellar_address)}`);
  console.log(`  agent      ${short(agent.publicKey)}  (throwaway)`);
  console.log(`  seller token ${PRIVY_ACCESS_TOKEN ? "provided — the withdrawal will run" : "absent — the withdrawal will be SKIPPED"}`);
  console.log();

  const steps = createSteps(PRIVY_ACCESS_TOKEN ? 8 : 7);
  let usdcIssuer = "";
  let balanceBefore = 0n;

  await steps.step("the gateway is up", async () => {
    const res = await fetch(`${GATEWAY_URL}/health`, { signal: AbortSignal.timeout(5_000) });
    const body = (await res.json()) as { ok?: boolean };
    if (!body.ok) throw new Error(`/health returned ${JSON.stringify(body)}`);
    return `${GATEWAY_URL} healthy`;
  });

  await steps.step("the agent funds itself — no account, no API key", async () => {
    // The issuer comes from the anchor's stellar.toml, never a constant (§1.5).
    const toml = await StellarToml.Resolver.resolve(ANCHOR_HOME_DOMAIN);
    const issuer = toml.CURRENCIES?.find((c) => c.code === "USDC")?.issuer;
    if (!issuer) throw new Error(`${ANCHOR_HOME_DOMAIN} lists no USDC issuer`);
    usdcIssuer = issuer;

    const balance = await fundAgent(agent, usdcIssuer);
    if (Number(balance) <= 0) throw new Error("the agent ended up with no USDC");
    return `${balance} USDC via Friendbot and the testnet DEX`;
  });

  await steps.step("a first call without X-Agent-Budget is refused, and charges nothing", async () => {
    // The 400 lands on the PAID attempt, not the probe. The gateway learns which agent is calling
    // from the payment signature, so until one arrives it cannot know whether this is a first call
    // for the pair — it answers 402 like any unpaid request. The budget check then refuses, and the
    // verified payment is cancelled rather than settled (proxyRoute.ts:1-10).
    const before = await usdcBalance(agent.publicKey, usdcIssuer);
    const result = await payForCall({ gatewayUrl: GATEWAY_URL, slug: endpoint.proxy_slug, agent, omitBudget: true });

    if (result.probeStatus !== 402) throw new Error(`expected a 402 probe, got ${result.probeStatus}`);
    if (result.status !== 400) {
      throw new Error(`expected 400 after paying without a budget, got ${result.status} ${JSON.stringify(result.body)}`);
    }
    const body = result.body as { error?: string };
    if (body?.error !== "missing_budget_header") throw new Error(`expected missing_budget_header, got ${body?.error}`);

    const after = await usdcBalance(agent.publicKey, usdcIssuer);
    if (after !== before) throw new Error(`the refused call still moved money: ${before} → ${after} USDC`);
    return "400 missing_budget_header, nothing charged — there is no default budget (§1.3)";
  });

  await steps.step("the seller's balance before any calls", async () => {
    balanceBefore = await read<bigint>("get_balance", [scv.address(endpoint.stellar_address)], agent.keypair);
    return `${usdc(balanceBefore)}`;
  });

  await steps.step(`${CALLS_WITHIN_BUDGET} paid calls: 402 → pay → 200`, async () => {
    for (let call = 1; call <= CALLS_WITHIN_BUDGET; call += 1) {
      const result = await payForCall({
        gatewayUrl: GATEWAY_URL,
        slug: endpoint.proxy_slug,
        agent,
        budgetStroops: Number(budget),
      });
      if (result.probeStatus !== 402) throw new Error(`call ${call}: expected a 402 probe, got ${result.probeStatus}`);
      if (result.status !== 200) {
        throw new Error(`call ${call}: expected 200 after paying, got ${result.status} ${JSON.stringify(result.body)}`);
      }
      if (!result.body) throw new Error(`call ${call}: paid but the upstream body was empty`);
    }
    return `${CALLS_WITHIN_BUDGET} × ${usdc(price)} against a ${usdc(budget)} budget, upstream data returned`;
  });

  await steps.step("the seller was credited 99% of what the agent paid", async () => {
    const after = await read<bigint>("get_balance", [scv.address(endpoint.stellar_address)], agent.keypair);
    const gained = after - balanceBefore;

    // The gateway settles once per successful call, so the split applies per call: the treasury
    // takes `price / 100` truncated and the seller gets the rest (§1.2).
    const sellerPerCall = price - price / 100n;
    const expected = sellerPerCall * BigInt(CALLS_WITHIN_BUDGET);

    if (gained !== expected) {
      throw new Error(
        `balance rose by ${gained} stroops, expected exactly ${expected} ` +
          `(${sellerPerCall} × ${CALLS_WITHIN_BUDGET})`,
      );
    }
    return `+${usdc(gained)} on chain — the chain is the source of truth, not our database`;
  });

  await steps.step("the frozen budget refuses the next call", async () => {
    // Ask for a far larger budget: it must be ignored, because the ceiling was frozen on the first
    // call and is never read again. This is the security property, not a convenience.
    const result = await payForCall({
      gatewayUrl: GATEWAY_URL,
      slug: endpoint.proxy_slug,
      agent,
      budgetStroops: Number(budget * 1000n),
    });
    const body = result.body as { error?: string };
    if (result.status !== 403 || body?.error !== "budget_exceeded") {
      throw new Error(`expected 403 budget_exceeded, got ${result.status} ${JSON.stringify(result.body)}`);
    }
    return "403 budget_exceeded — a larger budget did not raise the ceiling";
  });

  if (PRIVY_ACCESS_TOKEN) {
    await steps.step("the seller withdraws to Turkish Lira through the anchor", async () => {
      const auth = { authorization: `Bearer ${PRIVY_ACCESS_TOKEN}`, "content-type": "application/json" };

      const prepared = await fetch(`${GATEWAY_URL}/api/withdraw/prepare`, { method: "POST", headers: auth, body: "{}" });
      const preparedBody = (await prepared.json()) as { unsigned_xdr?: string; draft_id?: string; message?: string };
      if (!prepared.ok) throw new Error(`/api/withdraw/prepare → ${prepared.status}: ${preparedBody.message}`);

      // The seller signs. In the browser this is Privy's signRawHash; here the demo seller's key is
      // in the environment, which is why this step needs no wallet.
      const sellerSecret = process.env.DEMO_SELLER_SECRET_KEY?.trim();
      if (!sellerSecret) throw new Error("DEMO_SELLER_SECRET_KEY is not set, so the draft cannot be signed");
      const { TransactionBuilder, Networks } = await import("@stellar/stellar-sdk");
      const tx = TransactionBuilder.fromXDR(preparedBody.unsigned_xdr!, Networks.TESTNET);
      tx.sign(Keypair.fromSecret(sellerSecret));

      const submitted = await fetch(`${GATEWAY_URL}/api/withdraw/submit`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ draft_id: preparedBody.draft_id, signed_xdr: tx.toXDR() }),
      });
      const submittedBody = (await submitted.json()) as { withdrawal_id?: string; message?: string };
      if (!submitted.ok) throw new Error(`/api/withdraw/submit → ${submitted.status}: ${submittedBody.message}`);

      // The anchor takes a little while; poll the way the dashboard does.
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        const poll = await fetch(`${GATEWAY_URL}/api/withdrawals/${submittedBody.withdrawal_id}`, { headers: auth });
        const row = (await poll.json()) as {
          status?: string;
          anchor_status?: string;
          external_transaction_id?: string;
          quote_buy_amount?: string;
          error_message?: string;
        };
        if (row.status === "completed") {
          return `${row.quote_buy_amount} TRY paid, external_transaction_id ${row.external_transaction_id}`;
        }
        if (row.status === "failed") throw new Error(`the anchor failed: ${row.error_message}`);
        await sleep(3_000);
      }
      throw new Error("the withdrawal was still pending after three minutes");
    });
  }

  console.log();
  console.log(`  agent spent   ${await usdcBalance(agent.publicKey, usdcIssuer)} USDC left of what it swapped for`);
  if (!PRIVY_ACCESS_TOKEN) {
    console.log();
    console.log("  SKIPPED: the withdrawal, which needs a seller's Privy token. Either set");
    console.log("  PRIVY_ACCESS_TOKEN and re-run, or note that the off-ramp is covered for real by");
    console.log("  `cd gateway && npm run test:integration`, which moves 1 USDC through the anchor.");
  }

  steps.finish(`the product works end to end on ${CONTRACT_ID}`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

main().catch(fatal);
