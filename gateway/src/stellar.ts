// Soroban RPC client for the ramp_ledger contract. The only place a G… string becomes a Soroban
// Address (CONVENTIONS.md §1.1). OPERATOR_SECRET_KEY is read here and never logged or returned.
import {
  Account,
  Address,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk";

/** Seconds an operator-signed transaction stays valid: it is signed and sent immediately. */
export const TX_TIMEOUT_SECONDS = 300;

/**
 * Seconds an unsigned /prepare transaction stays valid while it waits for the seller to sign it.
 * The draft store keeps its draft exactly this long; a draft must never outlive its transaction.
 */
export const SIGNING_TIMEOUT_SECONDS = 600;

export interface StellarConfig {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
  /** Only invokeAsOperator needs it; reads and unsigned builds work without. */
  operatorSecret?: string;
}

/** A Soroban call that did not produce a successful result. */
export class SorobanError extends Error {
  constructor(
    readonly stage: "simulation" | "send" | "execution" | "timeout",
    message: string,
    /** Present once the transaction reached the network (send/execution/timeout). */
    readonly txHash?: string,
    /** The contract's #[contracterror] code, e.g. 1 = SpendingLimitExceeded, 2 = EndpointNotFound. */
    readonly contractErrorCode?: number,
  ) {
    super(message);
    this.name = "SorobanError";
  }
}

export interface InvokeResult<T = unknown> {
  txHash: string;
  /** The contract's return value converted with scValToNative (u64/i128 → bigint). */
  returnValue: T;
}

/** Soroban argument builders — the call sites never touch xdr directly. */
export const scv = {
  u64: (v: bigint | string | number): xdr.ScVal => nativeToScVal(BigInt(v), { type: "u64" }),
  i128: (v: bigint | string | number): xdr.ScVal => nativeToScVal(BigInt(v), { type: "i128" }),
  address: (g: string): xdr.ScVal => {
    if (!StrKey.isValidEd25519PublicKey(g)) throw new TypeError(`not a classic G… address: ${g}`);
    return Address.fromString(g).toScVal();
  },
};

/** Accepts the forms we use in env files: "testnet", "stellar:testnet", "pubnet", "mainnet", "stellar:pubnet". */
export function networkPassphraseFor(network: string): string {
  switch (network.trim().toLowerCase()) {
    case "testnet":
    case "stellar:testnet":
      return Networks.TESTNET;
    case "pubnet":
    case "mainnet":
    case "public":
    case "stellar:pubnet":
      return Networks.PUBLIC;
    default:
      throw new Error(`Unknown STELLAR_NETWORK "${network}" (expected testnet or pubnet)`);
  }
}

/** Reads STELLAR_RPC_URL, STELLAR_NETWORK, CONTRACT_ID and OPERATOR_SECRET_KEY; fails fast if any required one is empty. */
export function stellarConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StellarConfig {
  const missing = ["STELLAR_RPC_URL", "STELLAR_NETWORK", "CONTRACT_ID"].filter((k) => !env[k]?.trim());
  if (missing.length) throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  return {
    rpcUrl: env.STELLAR_RPC_URL!.trim(),
    networkPassphrase: networkPassphraseFor(env.STELLAR_NETWORK!),
    contractId: env.CONTRACT_ID!.trim(),
    operatorSecret: env.OPERATOR_SECRET_KEY?.trim() || undefined,
  };
}

/** Best-effort text for one diagnostic event; never throws. */
function describeEvent(e: xdr.DiagnosticEvent): string {
  try {
    return JSON.stringify(e.event.toJSON());
  } catch {
    return "";
  }
}

/** Pulls "Error(Contract, #N)" out of a host error string. */
function contractErrorCode(text: string): number | undefined {
  const m = /Error\(Contract, #(\d+)\)/.exec(text);
  return m ? Number(m[1]) : undefined;
}

export function createStellarClient(config: StellarConfig) {
  if (!StrKey.isValidContract(config.contractId)) {
    throw new Error(`CONTRACT_ID is not a valid C… contract address: ${config.contractId}`);
  }
  const server = new rpc.Server(config.rpcUrl, { allowHttp: config.rpcUrl.startsWith("http://") });
  const { networkPassphrase } = config;

  // Parsed once; the Keypair object is never exposed outside this closure.
  let operator: Keypair | undefined;
  if (config.operatorSecret) {
    try {
      operator = Keypair.fromSecret(config.operatorSecret);
    } catch {
      throw new Error("OPERATOR_SECRET_KEY is not a valid Stellar secret key"); // never echo the value
    }
  }

  function buildTx(
    source: Account,
    contractId: string,
    method: string,
    args: xdr.ScVal[],
    timeoutSeconds = TX_TIMEOUT_SECONDS,
  ): Transaction {
    return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
      .addOperation(Operation.invokeContractFunction({ contract: contractId, function: method, args }))
      .setTimeout(timeoutSeconds)
      .build();
  }

  /** Simulates and attaches footprint, auth and resource fees; converts a failed simulation to SorobanError. */
  async function prepare(tx: Transaction): Promise<Transaction> {
    try {
      return await server.prepareTransaction(tx);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      throw new SorobanError("simulation", text, undefined, contractErrorCode(text));
    }
  }

  async function submit(tx: Transaction): Promise<InvokeResult> {
    const hash = Buffer.from(tx.hash()).toString("hex");
    const sent = await server.sendTransaction(tx);
    if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
      const detail = sent.errorResult?.result.type ?? sent.status;
      throw new SorobanError("send", `sendTransaction ${sent.status}: ${detail}`, hash);
    }

    // DUPLICATE means an identical transaction is already in flight: its outcome is ours.
    const final = await server.pollTransaction(hash, {
      attempts: 30,
      sleepStrategy: () => 1_000,
    });
    if (final.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { txHash: hash, returnValue: final.returnValue ? scValToNative(final.returnValue) : undefined };
    }
    if (final.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
      throw new SorobanError("timeout", `transaction ${hash} not found after polling`, hash);
    }
    const result = final.resultXdr?.result.type ?? "FAILED";
    const events = (final.diagnosticEventsXdr ?? []).map(describeEvent).join(" ");
    throw new SorobanError("execution", `transaction ${hash} ${result} ${events}`.trim(), hash, contractErrorCode(events));
  }

  return {
    networkPassphrase,
    contractId: config.contractId,

    /** The operator's public G… address, or undefined if no operator key is configured. */
    get operatorAddress(): string | undefined {
      return operator?.publicKey();
    },

    /**
     * Builds, simulates and assembles a contract call for `sourceAccount` to sign, and returns it as
     * base64 XDR. With the signer as the transaction source, its require_auth() is satisfied by the
     * envelope signature alone — no separate auth-entry signing (what the /prepare routes need).
     */
    async buildUnsignedInvoke(contractId: string, method: string, args: xdr.ScVal[], sourceAccount: string): Promise<string> {
      const source = await server.getAccount(sourceAccount);
      const prepared = await prepare(buildTx(source, contractId, method, args, SIGNING_TIMEOUT_SECONDS));
      return prepared.toXDR();
    },

    /** Whether a classic G… account exists on the ledger (i.e. has been funded). */
    async accountExists(address: string): Promise<boolean> {
      try {
        await server.getAccount(address);
        return true;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Account not found")) return false;
        throw err;
      }
    },

    /**
     * Hex hash of an envelope. Signatures are not part of it, so a prepared transaction and the same
     * transaction after signing hash identically: that is how /submit proves it got back what it built.
     * Throws on anything that is not a transaction envelope for this network.
     */
    transactionHash(envelopeXdr: string): string {
      return Buffer.from(TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase).hash()).toString("hex");
    },

    /** Parses a signed envelope, submits it and waits for the result. */
    async submitSignedXdr(signedXdr: string): Promise<InvokeResult> {
      const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
      if (!("operations" in tx) || !tx.signatures.length) {
        throw new SorobanError("send", "expected a signed (non fee-bump) transaction envelope");
      }
      return submit(tx as Transaction);
    },

    /** Builds, signs with the operator keypair and submits: record_call and settle. */
    async invokeAsOperator(method: string, args: xdr.ScVal[]): Promise<InvokeResult> {
      if (!operator) throw new Error("OPERATOR_SECRET_KEY is not configured");
      const source = await server.getAccount(operator.publicKey());
      const prepared = await prepare(buildTx(source, config.contractId, method, args));
      prepared.sign(operator);
      return submit(prepared);
    },

    /**
     * Simulates a read-only call and returns its native value without submitting (get_balance,
     * get_endpoint). Simulation needs no signature and no funded account, so a throwaway source is used.
     */
    async readView<T = unknown>(method: string, args: xdr.ScVal[]): Promise<T> {
      const source = new Account(operator?.publicKey() ?? Keypair.random().publicKey(), "0");
      const sim = await server.simulateTransaction(buildTx(source, config.contractId, method, args));
      if (rpc.Api.isSimulationError(sim)) {
        throw new SorobanError("simulation", sim.error, undefined, contractErrorCode(sim.error));
      }
      if (!sim.result) throw new SorobanError("simulation", `${method} returned no result`);
      return scValToNative(sim.result.retval) as T;
    },
  };
}

export type StellarClient = ReturnType<typeof createStellarClient>;

let shared: StellarClient | undefined;

/** Process-wide client built from env, created on first use. */
export function getStellar(): StellarClient {
  shared ??= createStellarClient(stellarConfigFromEnv());
  return shared;
}
