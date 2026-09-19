/**
 * Shared plumbing for the scripts in `scripts/`.
 *
 * Soroban invocation, Friendbot funding, classic operations, and the PASS/FAIL
 * output format. Kept in one place so `setup.ts`, `reset-demo.ts` and
 * `smoke-contract.ts` fail the same way and read the same way — at 3am the
 * difference between two scripts that report differently and two that report
 * identically is the difference between finding the problem and not.
 *
 * Nothing here ever prints a secret key.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv, parse as parseEnv } from "dotenv";
import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TimeoutInfinite,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A root .env is optional and gitignored; real environment variables win.
loadEnv({ path: resolve(ROOT, ".env"), quiet: true });

// gateway/.env is where the running system actually keeps its keys, and it is where setup.ts tells
// you to paste them. Read it as a fallback — for variables that are unset OR empty, since a copied
// .env.example leaves `PLATFORM_POOL_SECRET_KEY=` behind — so that a re-run reuses those keys
// instead of minting a second platform pool.
const gatewayEnvPath = resolve(ROOT, "gateway", ".env");
if (existsSync(gatewayEnvPath)) {
  for (const [name, value] of Object.entries(parseEnv(readFileSync(gatewayEnvPath)))) {
    if (!process.env[name]?.trim() && value.trim()) process.env[name] = value;
  }
}

// --------------------------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------------------------

/** The contract deployed by P3-E5. Override with CONTRACT_ID to point at a redeploy. */
export const DEFAULT_CONTRACT_ID = "CC73BWETYN2PWAO6YPDLX4H75XUUMH4HDQQJMJYQPY2SW3PE2TEP4CVJ";

export const CONTRACT_ID = process.env.CONTRACT_ID?.trim() || DEFAULT_CONTRACT_ID;
export const RPC_URL = process.env.STELLAR_RPC_URL?.trim() || "https://soroban-testnet.stellar.org";
export const HORIZON_URL = process.env.STELLAR_HORIZON_URL?.trim() || "https://horizon-testnet.stellar.org";
export const FRIENDBOT_URL = "https://friendbot.stellar.org";
export const NETWORK_PASSPHRASE = Networks.TESTNET;

/** 1 USDC in stroops. Every amount on chain is an integer count of these (§1.1). */
export const STROOPS_PER_UNIT = 10_000_000n;

export const server = new rpc.Server(RPC_URL);
export const horizon = new Horizon.Server(HORIZON_URL);
export const contract = new Contract(CONTRACT_ID);

/** Contract error codes, from the #[contracterror] enum in contract/src/lib.rs. */
export const ERROR_NAMES: Record<number, string> = {
  1: "SpendingLimitExceeded",
  2: "EndpointNotFound",
  3: "InvalidPrice",
  4: "InvalidAmount",
  5: "NotOperator",
};

// --------------------------------------------------------------------------------------------
// Soroban
// --------------------------------------------------------------------------------------------

export const scv = {
  u64: (v: bigint) => nativeToScVal(v, { type: "u64" }),
  i128: (v: bigint) => nativeToScVal(v, { type: "i128" }),
  address: (g: string) => Address.fromString(g).toScVal(),
};

/** A contract error raised during simulation or execution, with its numeric code. */
export class ContractError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ContractError";
  }
}

/** Pull `#N` out of a host error string like `Error(Contract, #1)`. */
export function contractErrorCode(text: string): number | undefined {
  const match = /Error\(Contract,\s*#(\d+)\)/.exec(text);
  return match ? Number(match[1]) : undefined;
}

export function describeError(err: unknown): string {
  if (err instanceof ContractError && err.code !== undefined) {
    return `${ERROR_NAMES[err.code] ?? "unknown"} (contract error #${err.code})`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function buildInvocation(
  source: Keypair,
  method: string,
  args: xdr.ScVal[],
): Promise<Transaction> {
  const account = await server.getAccount(source.publicKey());
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(contract.call(method, ...args))
    .setTimeout(TimeoutInfinite)
    .build();
}

/** Simulate only — for views. Never signs, never submits, costs nothing. */
export async function read<T>(method: string, args: xdr.ScVal[], source: Keypair): Promise<T> {
  const sim = await server.simulateTransaction(await buildInvocation(source, method, args));
  if (rpc.Api.isSimulationError(sim)) {
    throw new ContractError(contractErrorCode(sim.error), sim.error);
  }
  if (!sim.result) throw new Error(`${method}: simulation returned no result`);
  return scValToNative(sim.result.retval) as T;
}

/** Simulate, sign, submit, wait for the result. Returns the contract's return value. */
export async function invoke<T>(method: string, args: xdr.ScVal[], signer: Keypair): Promise<T> {
  let prepared: Transaction;
  try {
    prepared = await server.prepareTransaction(await buildInvocation(signer, method, args));
  } catch (err) {
    // A contract panic surfaces here: simulation fails before anything is sent.
    const text = err instanceof Error ? err.message : String(err);
    throw new ContractError(contractErrorCode(text), text);
  }

  prepared.sign(signer);
  return await submit(prepared, method);
}

/** Send an already-signed transaction and wait for it to land. */
export async function submit<T>(signed: Transaction, label: string): Promise<T> {
  const sent = await server.sendTransaction(signed);
  if (sent.status === "ERROR") {
    const text = JSON.stringify(sent.errorResult ?? sent);
    throw new ContractError(contractErrorCode(text), `${label}: submission rejected — ${text}`);
  }

  const result = await server.pollTransaction(sent.hash, { attempts: 30 });
  if (result.status !== "SUCCESS") {
    const text = JSON.stringify(result);
    throw new ContractError(contractErrorCode(text), `${label}: ${result.status} — tx ${sent.hash}`);
  }
  return (result.returnValue ? scValToNative(result.returnValue) : undefined) as T;
}

// --------------------------------------------------------------------------------------------
// Classic Stellar
// --------------------------------------------------------------------------------------------

export async function accountExists(publicKey: string): Promise<boolean> {
  try {
    await server.getAccount(publicKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fund an account from Friendbot. Idempotent: an account that is already funded
 * is success, not an error — Friendbot says so with `op_already_exists`.
 */
export async function friendbotFund(publicKey: string): Promise<"funded" | "already funded"> {
  if (await accountExists(publicKey)) return "already funded";

  const response = await fetch(`${FRIENDBOT_URL}/?addr=${publicKey}`);
  if (response.ok) return "funded";

  const body = await response.text();
  if (body.includes("op_already_exists") || body.includes("already funded")) return "already funded";
  throw new Error(`Friendbot refused to fund ${publicKey}: ${response.status} ${body.slice(0, 200)}`);
}

/** Does this account already trust `asset`? */
export async function hasTrustline(publicKey: string, asset: Asset): Promise<boolean> {
  const account = await horizon.loadAccount(publicKey);
  return account.balances.some(
    (b) =>
      "asset_code" in b &&
      b.asset_code === asset.getCode() &&
      "asset_issuer" in b &&
      b.asset_issuer === asset.getIssuer(),
  );
}

/** Add a trustline, unless it is already there. Returns what it actually did. */
export async function ensureTrustline(
  keypair: Keypair,
  asset: Asset,
): Promise<"added" | "already present"> {
  if (await hasTrustline(keypair.publicKey(), asset)) return "already present";

  const account = await server.getAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account as Account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(TimeoutInfinite)
    .build();

  tx.sign(keypair);
  await submit(tx, `changeTrust ${asset.getCode()}`);
  return "added";
}

// --------------------------------------------------------------------------------------------
// Output
// --------------------------------------------------------------------------------------------

export const short = (g: string) => `${g.slice(0, 6)}…${g.slice(-4)}`;
export const usdc = (stroops: bigint) => `${(Number(stroops) / Number(STROOPS_PER_UNIT)).toFixed(7)} USDC`;

export interface StepRunner {
  /** Run a named step. Its return value is the detail shown after the dash. */
  step(name: string, run: () => Promise<string>): Promise<void>;
  /** Print the tally and exit non-zero if anything failed. */
  finish(successLine: string): never;
}

/**
 * A PASS/FAIL sequence. Once a step fails the rest are SKIPped rather than run:
 * these scripts are pipelines, and a cascade of errors buries the one that
 * actually matters.
 */
export function createSteps(total: number): StepRunner {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let index = 0;
  const startedAt = Date.now();

  return {
    async step(name, run) {
      index += 1;
      const label = `${index}/${total}`;

      if (failed > 0) {
        skipped += 1;
        console.log(`[SKIP] ${label}  ${name}`);
        return;
      }

      const stepStartedAt = Date.now();
      try {
        const detail = await run();
        const seconds = ((Date.now() - stepStartedAt) / 1000).toFixed(1);
        passed += 1;
        console.log(`[PASS] ${label}  ${name} — ${detail}  (${seconds}s)`);
      } catch (err) {
        failed += 1;
        console.log(`[FAIL] ${label}  ${name}`);
        console.log(`         ${describeError(err)}`);
      }
    },

    finish(successLine) {
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log();
      if (failed > 0) {
        console.log(`FAIL — ${passed} passed, ${failed} failed, ${skipped} skipped in ${seconds}s`);
        process.exit(1);
      }
      console.log(`PASS — ${passed}/${total} steps in ${seconds}s`);
      console.log(`       ${successLine}`);
      process.exit(0);
    },
  };
}

/** Wire up the last line of defence so a thrown error still reads as a failure. */
export function fatal(err: unknown): never {
  console.error();
  console.error(`[FAIL] the script itself blew up: ${describeError(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exit(1);
}
