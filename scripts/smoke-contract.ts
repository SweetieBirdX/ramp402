/**
 * smoke-contract.ts — does the DEPLOYED ramp_ledger actually work?
 *
 *     OPERATOR_SECRET_KEY=S... npx tsx scripts/smoke-contract.ts
 *
 * This runs against testnet, not the unit-test environment: real transactions,
 * real fees, real latency. `cargo test` proves the logic; this proves the thing
 * we deployed is the thing we tested, that its operator is the one the gateway
 * holds, and that a seller can get paid end to end.
 *
 * It walks the demo path — register, three paid calls, a fourth that is refused,
 * settle, withdraw — and prints one PASS/FAIL line per step. Exits non-zero if
 * any step fails, so CI and a half-awake human read it the same way.
 *
 * Configuration, all optional except the operator:
 *
 *   CONTRACT_ID          defaults to the deployed contract (see scripts/lib/chain.ts)
 *   STELLAR_RPC_URL      defaults to https://soroban-testnet.stellar.org
 *   OPERATOR_SECRET_KEY  REQUIRED — must be the key baked into the contract at
 *                        deploy time. A throwaway will not do: the contract
 *                        checks the caller IS its stored operator, so this is
 *                        the one account the script cannot invent.
 *   SELLER_SECRET_KEY    a throwaway seller is created and funded if absent
 *   AGENT_SECRET_KEY     a throwaway agent is created if absent
 *
 * Read from the environment or from a root `.env` (gitignored). Secrets are
 * never printed: only public G… addresses ever reach stdout.
 */
import { Keypair } from "@stellar/stellar-sdk";
import {
  CONTRACT_ID,
  ContractError,
  RPC_URL,
  createSteps,
  fatal,
  friendbotFund,
  invoke,
  read,
  scv,
  server,
  short,
  usdc,
} from "./lib/chain.js";

/** Price of one call, in stroops. 1 USDC = 10_000_000 stroops, so this is 0.1 USDC. */
const PRICE = 1_000_000n;
/** Budget for exactly three calls — the fourth must be refused. */
const BUDGET = PRICE * 3n;
/** What the three successful calls earned, settled in one go. */
const SETTLE_AMOUNT = PRICE * 3n;
/** The 1%/99% split of SETTLE_AMOUNT, per CONVENTIONS.md §1.2. */
const EXPECTED_TREASURY = SETTLE_AMOUNT / 100n;
const EXPECTED_SELLER = SETTLE_AMOUNT - EXPECTED_TREASURY;

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const operatorSecret = process.env.OPERATOR_SECRET_KEY?.trim();
  if (!operatorSecret) {
    console.error("[FAIL] OPERATOR_SECRET_KEY is not set.");
    console.error();
    console.error("  The contract stores its operator and checks that record_call and settle come");
    console.error("  from that exact address, so this one account cannot be a throwaway. Use the");
    console.error("  key the gateway runs with:");
    console.error();
    console.error("      OPERATOR_SECRET_KEY=S... npx tsx scripts/smoke-contract.ts");
    console.error();
    console.error("  Or put it in a root .env (gitignored). Never commit it.");
    process.exit(1);
  }

  const operator = Keypair.fromSecret(operatorSecret);
  const seller = process.env.SELLER_SECRET_KEY
    ? Keypair.fromSecret(process.env.SELLER_SECRET_KEY.trim())
    : Keypair.random();
  // The agent never signs anything — record_call is signed by the operator on its
  // behalf (CONVENTIONS.md §1.2). So it needs no funding, and this script proves
  // it by never funding one.
  const agent = process.env.AGENT_SECRET_KEY
    ? Keypair.fromSecret(process.env.AGENT_SECRET_KEY.trim())
    : Keypair.random();

  console.log("ramp402 · smoke-contract");
  console.log(`  network    testnet`);
  console.log(`  rpc        ${RPC_URL}`);
  console.log(`  contract   ${CONTRACT_ID}`);
  console.log(`  operator   ${short(operator.publicKey())}`);
  console.log(`  seller     ${short(seller.publicKey())}${process.env.SELLER_SECRET_KEY ? "" : "  (throwaway)"}`);
  console.log(`  agent      ${short(agent.publicKey())}${process.env.AGENT_SECRET_KEY ? "" : "  (throwaway, never funded — it never signs)"}`);
  console.log();

  const steps = createSteps(8);
  let endpointId = 0n;

  await steps.step("RPC reachable and the contract has the right operator", async () => {
    const health = await server.getHealth();
    assert(health.status === "healthy", `RPC is ${health.status}`);

    const stored = await read<string>("get_operator", [], operator);
    assert(
      stored === operator.publicKey(),
      `the contract's operator is ${stored}, but OPERATOR_SECRET_KEY is ${operator.publicKey()} — ` +
        `every record_call and settle would fail with NotOperator`,
    );
    return `operator matches on-chain`;
  });

  await steps.step("Friendbot funds the seller", async () => {
    await friendbotFund(seller.publicKey());
    await server.getAccount(seller.publicKey());
    return `${short(seller.publicKey())} exists on ledger`;
  });

  await steps.step("register_endpoint returns a contract-assigned id", async () => {
    const id = await invoke<bigint>(
      "register_endpoint",
      [scv.address(seller.publicKey()), scv.i128(PRICE)],
      seller,
    );
    assert(typeof id === "bigint", `expected a numeric endpoint_id, got ${typeof id}`);
    assert(id > 0n, `expected a positive endpoint_id, got ${id}`);
    endpointId = id;

    const info = await read<{ seller: string; price: bigint }>(
      "get_endpoint",
      [scv.u64(endpointId)],
      seller,
    );
    assert(info.seller === seller.publicKey(), `endpoint belongs to ${info.seller}`);
    assert(info.price === PRICE, `price is ${info.price}, expected ${PRICE}`);
    return `endpoint_id ${endpointId} at ${usdc(PRICE)} a call`;
  });

  await steps.step("three calls inside the budget are recorded", async () => {
    for (let i = 1; i <= 3; i += 1) {
      await invoke(
        "record_call",
        [
          scv.address(operator.publicKey()),
          scv.address(agent.publicKey()),
          scv.u64(endpointId),
          scv.i128(BUDGET),
        ],
        operator,
      );
    }
    return `3 × ${usdc(PRICE)} against a ${usdc(BUDGET)} budget`;
  });

  await steps.step("the fourth call is refused with SpendingLimitExceeded", async () => {
    try {
      await invoke(
        "record_call",
        [
          scv.address(operator.publicKey()),
          scv.address(agent.publicKey()),
          scv.u64(endpointId),
          // Ask for a far larger budget: it must be ignored. The budget was
          // frozen by the first call and is never read again.
          scv.i128(BUDGET * 1000n),
        ],
        operator,
      );
      throw new Error("the fourth call SUCCEEDED — the budget ceiling is not being enforced");
    } catch (err) {
      if (err instanceof ContractError && err.code === 1) {
        return "budget ceiling held, and a larger budget did not raise it";
      }
      throw err;
    }
  });

  await steps.step("settle credits the seller 99% and the treasury 1%", async () => {
    await invoke(
      "settle",
      [scv.address(operator.publicKey()), scv.u64(endpointId), scv.i128(SETTLE_AMOUNT)],
      operator,
    );
    const balance = await read<bigint>("get_balance", [scv.address(seller.publicKey())], operator);
    assert(
      balance === EXPECTED_SELLER,
      `balance is ${balance} stroops, expected exactly ${EXPECTED_SELLER}`,
    );
    return `${usdc(SETTLE_AMOUNT)} settled → seller ${usdc(EXPECTED_SELLER)}, treasury ${usdc(EXPECTED_TREASURY)}`;
  });

  await steps.step("withdraw returns the balance to the seller", async () => {
    const withdrawn = await invoke<bigint>("withdraw", [scv.address(seller.publicKey())], seller);
    assert(
      withdrawn === EXPECTED_SELLER,
      `withdraw returned ${withdrawn}, expected ${EXPECTED_SELLER}`,
    );
    return `${usdc(withdrawn)} released for off-chain payout`;
  });

  await steps.step("the balance is zero afterwards", async () => {
    const balance = await read<bigint>("get_balance", [scv.address(seller.publicKey())], operator);
    assert(balance === 0n, `balance is ${balance} stroops after withdraw, expected 0`);
    return "0.0000000 USDC";
  });

  steps.finish(`the deployed contract works: ${CONTRACT_ID}`);
}

main().catch(fatal);
