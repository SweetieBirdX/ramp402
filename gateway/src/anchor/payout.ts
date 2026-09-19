// The one place USDC actually leaves the platform pool.
//
// Deliberately separate from stellar.ts, which is the Soroban client for the ledger contract: this
// uses a different key (PLATFORM_POOL_SECRET_KEY, not the operator), a different kind of operation,
// and it is the only code in the gateway that moves real money. Keeping it apart makes that
// obvious, and keeps the pool key out of a module that dozens of call sites touch.
//
// THREE THINGS THAT MUST BE EXACTLY RIGHT (§1.5). Each one loses the money silently:
//   - a CLASSIC payment operation, never a contract call
//   - memo_type `id`, never text — Memo.id(), with the anchor's exact memo
//   - the destination and asset the anchor named, not ones we inferred
import {
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
  rpc,
  type Transaction,
} from "@stellar/stellar-sdk";

export interface PayoutConfig {
  rpcUrl: string;
  networkPassphrase: string;
  /** PLATFORM_POOL_SECRET_KEY. The pool is the account the anchor is paid from. */
  poolSecret: string;
}

export interface PayoutRequest {
  destination: string;
  /** Decimal string, e.g. "10.0000000". Stroops are converted by the caller. */
  amount: string;
  assetCode: string;
  assetIssuer: string;
  /** The anchor's memo, verbatim. Must be its `id` memo. */
  memo: string;
  memoType: string;
}

export interface PayoutResult {
  hash: string;
}

export function createPayoutClient(config: PayoutConfig) {
  const server = new rpc.Server(config.rpcUrl, { allowHttp: config.rpcUrl.startsWith("http://") });

  let pool: Keypair;
  try {
    pool = Keypair.fromSecret(config.poolSecret);
  } catch {
    throw new Error("PLATFORM_POOL_SECRET_KEY is not a valid Stellar secret key"); // never echo the value
  }

  // One pool payment at a time. Each reads the account's sequence number, so two in flight collide
  // with txBadSeq — and a failed payout to an anchor is the most expensive failure in the system.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    publicKey: () => pool.publicKey(),

    /**
     * Send the payment the anchor asked for, and wait for it to land.
     *
     * Refuses a memo type other than `id` rather than sending something the anchor cannot match:
     * a text memo is accepted by the network and ignored by the anchor, which is the worst
     * possible outcome — the money is gone and nothing is credited.
     */
    async pay(request: PayoutRequest): Promise<PayoutResult> {
      if (request.memoType !== "id") {
        throw new Error(
          `anchor asked for memo_type "${request.memoType}", but only "id" can be matched ` +
            `(§1.5). Refusing to send — a mismatched memo loses the payment.`,
        );
      }
      if (!/^\d+$/.test(request.memo)) {
        throw new Error(`anchor memo "${request.memo}" is not an id memo (digits only)`);
      }

      const run = async (): Promise<PayoutResult> => {
        const account = await server.getAccount(pool.publicKey());
        const tx: Transaction = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: config.networkPassphrase,
        })
          .addOperation(
            Operation.payment({
              destination: request.destination,
              asset: new Asset(request.assetCode, request.assetIssuer),
              amount: request.amount,
            }),
          )
          .addMemo(Memo.id(request.memo))
          .setTimeout(180)
          .build();

        tx.sign(pool);

        const sent = await server.sendTransaction(tx);
        if (sent.status === "ERROR") {
          throw new Error(`pool payment rejected: ${JSON.stringify(sent.errorResult ?? sent)}`);
        }

        const result = await server.pollTransaction(sent.hash, { attempts: 30 });
        if (result.status !== "SUCCESS") {
          throw new Error(`pool payment ${sent.hash} ${result.status}`);
        }
        return { hash: sent.hash };
      };

      const next = queue.then(run, run);
      queue = next.catch(() => undefined); // a failure must not wedge the queue for the next payout
      return next;
    },
  };
}

export type PayoutClient = ReturnType<typeof createPayoutClient>;

export function payoutConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PayoutConfig {
  const missing = ["STELLAR_RPC_URL", "PLATFORM_POOL_SECRET_KEY"].filter((k) => !env[k]?.trim());
  if (missing.length) throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  return {
    rpcUrl: env.STELLAR_RPC_URL!.trim(),
    networkPassphrase: env.STELLAR_NETWORK?.trim() === "public"
      ? "Public Global Stellar Network ; September 2015"
      : "Test SDF Network ; September 2015",
    poolSecret: env.PLATFORM_POOL_SECRET_KEY!.trim(),
  };
}

/** Stroops → the decimal string the anchor expects. 1 USDC = 10,000,000 stroops (§1.1). */
export function stroopsToDecimal(stroops: number | bigint): string {
  const value = BigInt(stroops);
  const whole = value / 10_000_000n;
  const fraction = (value % 10_000_000n).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
}
