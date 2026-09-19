/**
 * smoke-contract.ts — does the DEPLOYED ramp_ledger actually work?
 *
 *     npx tsx scripts/smoke-contract.ts
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
 *   CONTRACT_ID          defaults to the deployed contract below
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
import { config as loadEnv } from "dotenv";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";

// A root .env is optional and gitignored; real environment variables win.
loadEnv({ quiet: true });

// --------------------------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------------------------

/** The contract deployed by P3-E5. Override with CONTRACT_ID when testing a redeploy. */
const DEFAULT_CONTRACT_ID = "CC73BWETYN2PWAO6YPDLX4H75XUUMH4HDQQJMJYQPY2SW3PE2TEP4CVJ";

const CONTRACT_ID = process.env.CONTRACT_ID?.trim() || DEFAULT_CONTRACT_ID;
const RPC_URL = process.env.STELLAR_RPC_URL?.trim() || "https://soroban-testnet.stellar.org";
const FRIENDBOT_URL = "https://friendbot.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;

/** Price of one call, in stroops. 1 USDC = 10_000_000 stroops, so this is 0.1 USDC. */
const PRICE = 1_000_000n;
/** Budget for exactly three calls — the fourth must be refused. */
const BUDGET = PRICE * 3n;
/** What the three successful calls earned, settled in one go. */
const SETTLE_AMOUNT = PRICE * 3n;
/** The 1%/99% split of SETTLE_AMOUNT, per CONVENTIONS.md §1.2. */
const EXPECTED_TREASURY = SETTLE_AMOUNT / 100n;
const EXPECTED_SELLER = SETTLE_AMOUNT - EXPECTED_TREASURY;

/** Contract error codes, from the #[contracterror] enum in contract/src/lib.rs. */
const ERROR_NAMES: Record<number, string> = {
  1: "SpendingLimitExceeded",
  2: "EndpointNotFound",
  3: "InvalidPrice",
  4: "InvalidAmount",
  5: "NotOperator",
};

const server = new rpc.Server(RPC_URL);
const contract = new Contract(CONTRACT_ID);

// --------------------------------------------------------------------------------------------
// Soroban plumbing
// --------------------------------------------------------------------------------------------

const scv = {
  u64: (v: bigint) => nativeToScVal(v, { type: "u64" }),
  i128: (v: bigint) => nativeToScVal(v, { type: "i128" }),
  address: (g: string) => Address.fromString(g).toScVal(),
};

/** A contract error raised during simulation or execution, with its numeric code. */
class ContractError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ContractError";
  }
}

/** Pull `#N` out of a host error string like `Error(Contract, #1)`. */
function contractErrorCode(text: string): number | undefined {
  const match = /Error\(Contract,\s*#(\d+)\)/.exec(text);
  return match ? Number(match[1]) : undefined;
}

function describeError(err: unknown): string {
  if (err instanceof ContractError && err.code !== undefined) {
    return `${ERROR_NAMES[err.code] ?? "unknown"} (contract error #${err.code})`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function build(source: Keypair, method: string, args: xdr.ScVal[]): Promise<Transaction> {
  const account = await server.getAccount(source.publicKey());
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();
}

/** Simulate only — for views. Never signs, never submits, costs nothing. */
async function read<T>(method: string, args: xdr.ScVal[], source: Keypair): Promise<T> {
  const sim = await server.simulateTransaction(await build(source, method, args));
  if (rpc.Api.isSimulationError(sim)) {
    throw new ContractError(contractErrorCode(sim.error), sim.error);
  }
  if (!sim.result) throw new Error(`${method}: simulation returned no result`);
  return scValToNative(sim.result.retval) as T;
}

/** Simulate, sign, submit, wait for the result. Returns the contract's return value. */
async function invoke<T>(method: string, args: xdr.ScVal[], signer: Keypair): Promise<T> {
  let prepared: Transaction;
  try {
    prepared = await server.prepareTransaction(await build(signer, method, args));
  } catch (err) {
    // A contract panic surfaces here: simulation fails before anything is sent.
    const text = err instanceof Error ? err.message : String(err);
    throw new ContractError(contractErrorCode(text), text);
  }

  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    const text = JSON.stringify(sent.errorResult ?? sent);
    throw new ContractError(contractErrorCode(text), `${method}: submission rejected — ${text}`);
  }

  const result = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (result.status !== "SUCCESS") {
    const text = JSON.stringify(result);
    throw new ContractError(contractErrorCode(text), `${method}: ${result.status} — tx ${sent.hash}`);
  }
  return (result.returnValue ? scValToNative(result.returnValue) : undefined) as T;
}

async function friendbotFund(publicKey: string): Promise<void> {
  const response = await fetch(`${FRIENDBOT_URL}/?addr=${publicKey}`);
  if (response.ok) return;
  // "op_already_exists" means the account is already funded, which is success for us.
  const body = await response.text();
  if (body.includes("op_already_exists") || body.includes("already funded")) return;
  throw new Error(`Friendbot refused to fund ${publicKey}: ${response.status} ${body.slice(0, 200)}`);
}

// --------------------------------------------------------------------------------------------
// Output
// --------------------------------------------------------------------------------------------

const short = (g: string) => `${g.slice(0, 6)}…${g.slice(-4)}`;
const usdc = (stroops: bigint) => `${(Number(stroops) / 1e7).toFixed(7)} USDC`;

let passed = 0;
let failed = 0;
let skipped = 0;
let stepNumber = 0;
const TOTAL_STEPS = 8;

/**
 * Run one named step. A failure is reported and aborts the rest: once
 * `register_endpoint` fails there is no endpoint for the later steps to use,
 * and cascading errors hide the one that matters.
 */
async function step(name: string, run: () => Promise<string>): Promise<void> {
  stepNumber += 1;
  const label = `${String(stepNumber).padStart(1)}/${TOTAL_STEPS}`;

  if (failed > 0) {
    skipped += 1;
    console.log(`[SKIP] ${label}  ${name}`);
    return;
  }

  const startedAt = Date.now();
  try {
    const detail = await run();
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    passed += 1;
    console.log(`[PASS] ${label}  ${name} — ${detail}  (${seconds}s)`);
  } catch (err) {
    failed += 1;
    console.log(`[FAIL] ${label}  ${name}`);
    console.log(`         ${describeError(err)}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

// --------------------------------------------------------------------------------------------
// The run
// --------------------------------------------------------------------------------------------

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

  const startedAt = Date.now();
  let endpointId = 0n;

  await step("RPC reachable and the contract has the right operator", async () => {
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

  await step("Friendbot funds the seller", async () => {
    await friendbotFund(seller.publicKey());
    await server.getAccount(seller.publicKey());
    return `${short(seller.publicKey())} exists on ledger`;
  });

  await step("register_endpoint returns a contract-assigned id", async () => {
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

  await step("three calls inside the budget are recorded", async () => {
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

  await step("the fourth call is refused with SpendingLimitExceeded", async () => {
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

  await step("settle credits the seller 99% and the treasury 1%", async () => {
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

  await step("withdraw returns the balance to the seller", async () => {
    const withdrawn = await invoke<bigint>(
      "withdraw",
      [scv.address(seller.publicKey())],
      seller,
    );
    assert(
      withdrawn === EXPECTED_SELLER,
      `withdraw returned ${withdrawn}, expected ${EXPECTED_SELLER}`,
    );
    return `${usdc(withdrawn)} released for off-chain payout`;
  });

  await step("the balance is zero afterwards", async () => {
    const balance = await read<bigint>("get_balance", [scv.address(seller.publicKey())], operator);
    assert(balance === 0n, `balance is ${balance} stroops after withdraw, expected 0`);
    return "0.0000000 USDC";
  });

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log();
  if (failed > 0) {
    console.log(`FAIL — ${passed} passed, ${failed} failed, ${skipped} skipped in ${seconds}s`);
    console.log(`       contract ${CONTRACT_ID}`);
    process.exit(1);
  }
  console.log(`PASS — ${passed}/${TOTAL_STEPS} steps in ${seconds}s`);
  console.log(`       the deployed contract works: ${CONTRACT_ID}`);
}

main().catch((err) => {
  console.error();
  console.error(`[FAIL] the script itself blew up: ${describeError(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
});
