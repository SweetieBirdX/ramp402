// Runs the anchor off-ramp behind POST /api/withdraw/submit and writes every transition to the
// withdrawals row, so GET /api/withdrawals/:id always reflects where the money actually is.
//
// Nothing here throws into a request: by the time this runs the HTTP response is long gone. A
// failure becomes `status: "failed"` with an `error_message` the seller can read.
import { runWithdrawalFlow, resumePolling, type AnchorProgress } from "./anchor/index.js";
import type { PayoutConfig } from "./anchor/payout.js";
import type { Repo, WithdrawalRow } from "./repo.js";

export interface WithdrawalJobDeps {
  repo: Repo;
  payout: PayoutConfig;
  networkPassphrase: string;
  /** Used when a row predates anchor_domain, or one was never recorded. */
  defaultAnchorDomain: string;
  assetCode?: string;
  preferredCurrency?: string;
  /** KYC values, when the anchor asks. Empty is fine for a sandbox anchor that asks for nothing. */
  kycValues?: Record<string, string>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export function createWithdrawalJobs(deps: WithdrawalJobDeps) {
  const assetCode = deps.assetCode ?? "USDC";

  /** Persist one progress report. Swallows write errors: losing a status line must not kill the flow. */
  const record = (id: string, status: "pending" | "completed" | "failed", progress: AnchorProgress) => {
    try {
      deps.repo.updateWithdrawalProgress(id, status, {
        anchor_status: progress.anchorStatus,
        anchor_tx_id: progress.anchorTxId,
        external_transaction_id: progress.externalTransactionId,
        claimable_balance_id: progress.claimableBalanceId,
        quote_buy_amount: progress.quoteBuyAmount,
        error_message: status === "failed" ? progress.message : undefined,
      });
    } catch (err) {
      console.error(`withdrawal ${id}: could not record progress`, err);
    }
  };

  async function run(row: WithdrawalRow): Promise<void> {
    const homeDomain = row.anchor_domain ?? deps.defaultAnchorDomain;
    try {
      const result = await runWithdrawalFlow({
        homeDomain,
        assetCode,
        amountStroops: row.amount_stroops,
        preferredCurrency: deps.preferredCurrency,
        kycValues: deps.kycValues,
        payout: deps.payout,
        networkPassphrase: deps.networkPassphrase,
        pollIntervalMs: deps.pollIntervalMs,
        pollTimeoutMs: deps.pollTimeoutMs,
        // Mid-flight updates keep the poll endpoint honest while the anchor works.
        onProgress: (progress) => record(row.id, "pending", progress),
      });

      deps.repo.updateWithdrawalProgress(row.id, result.status, {
        anchor_status: result.anchorStatus,
        anchor_tx_id: result.anchorTxId,
        external_transaction_id: result.externalTransactionId,
        claimable_balance_id: result.claimableBalanceId,
        quote_buy_amount: result.quoteBuyAmount,
        error_message: result.status === "failed" ? result.message : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`withdrawal ${row.id} failed against ${homeDomain}:`, err);
      deps.repo.updateWithdrawalProgress(row.id, "failed", { error_message: message });
    }
  }

  return {
    /** Fire and forget — the caller has already answered the request. */
    start(row: WithdrawalRow): void {
      void run(row);
    },

    /** Awaitable, for tests and for the resume pass. */
    run,

    /**
     * Pick up withdrawals left `pending` by a restart.
     *
     * Only rows that already reached the anchor can be resumed: without an `anchor_tx_id` there is
     * nothing to poll, and re-running the flow would pay the anchor a second time. Those are left
     * alone and reported, which is the honest outcome — a human decides.
     */
    async resumeInterrupted(): Promise<{ resumed: number; stranded: string[] }> {
      const pending = deps.repo.listPendingWithdrawals();
      const stranded: string[] = [];
      let resumed = 0;

      for (const row of pending) {
        if (!row.anchor_tx_id) {
          stranded.push(row.id);
          continue;
        }
        resumed += 1;
        void resumePolling({
          homeDomain: row.anchor_domain ?? deps.defaultAnchorDomain,
          anchorTxId: row.anchor_tx_id,
          payout: deps.payout,
          networkPassphrase: deps.networkPassphrase,
          pollIntervalMs: deps.pollIntervalMs,
          pollTimeoutMs: deps.pollTimeoutMs,
          onProgress: (progress) => record(row.id, "pending", progress),
        })
          .then((result) =>
            deps.repo.updateWithdrawalProgress(row.id, result.status, {
              anchor_status: result.anchorStatus,
              external_transaction_id: result.externalTransactionId,
              claimable_balance_id: result.claimableBalanceId,
              error_message: result.status === "failed" ? result.message : undefined,
            }),
          )
          .catch((err) => console.error(`withdrawal ${row.id}: resume failed`, err));
      }

      if (stranded.length) {
        console.warn(
          `${stranded.length} withdrawal(s) were interrupted before reaching the anchor and cannot be ` +
            `resumed automatically: ${stranded.join(", ")}. The seller's balance is already zeroed on chain.`,
        );
      }
      return { resumed, stranded };
    },
  };
}

export type WithdrawalJobs = ReturnType<typeof createWithdrawalJobs>;
