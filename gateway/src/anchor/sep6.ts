// SEP-6: start the withdrawal, then watch it until the anchor is done.
//
// The anchor answers with a Stellar account, a memo, and a memo type. Those three together are the
// only way it can match an incoming payment to this withdrawal — get any of them wrong and the USDC
// arrives at a real account attached to nothing, and no amount of asking gets it back (§1.5).
import { anchorFetch } from "./http.js";
import type { AnchorEndpoints } from "./toml.js";

export interface WithdrawInstructions {
  /** The anchor's transaction id, for polling and for `withdrawals.anchor_tx_id`. */
  id: string;
  /** Where to send the USDC. */
  accountId: string;
  memo: string;
  /** Expected to be `id`; anything else is refused by the caller. */
  memoType: string;
  /** The anchor's own minimum, when it states one. */
  minAmount?: number;
  etaSeconds?: number;
}

interface WithdrawResponse {
  id: string;
  account_id: string;
  memo?: string;
  memo_type?: string;
  min_amount?: number;
  eta?: number;
}

export interface AnchorTransaction {
  id: string;
  /** SEP-6 status, verbatim: pending_user_transfer_start, pending_trust, completed, error, … */
  status: string;
  statusEta?: number;
  externalTransactionId?: string;
  stellarTransactionId?: string;
  claimableBalanceId?: string;
  message?: string;
  amountOut?: string;
}

interface TransactionResponse {
  transaction?: {
    id: string;
    status: string;
    status_eta?: number;
    external_transaction_id?: string;
    stellar_transaction_id?: string;
    claimable_balance_id?: string;
    message?: string;
    amount_out?: string;
  };
}

interface Sep6InfoResponse {
  withdraw?: Record<string, { enabled?: boolean; types?: Record<string, { min_amount?: number; max_amount?: number }> }>;
}

/** The anchor's stated minimum for this asset and method, when it publishes one. */
export async function withdrawMinimum(
  anchor: AnchorEndpoints,
  assetCode: string,
  type: string,
): Promise<number | undefined> {
  const info = await anchorFetch<Sep6InfoResponse>(`${anchor.transfer}/info`);
  return info.withdraw?.[assetCode]?.types?.[type]?.min_amount;
}

/** The withdrawal methods this anchor offers for the asset, e.g. ["bank_account"]. */
export async function withdrawTypes(anchor: AnchorEndpoints, assetCode: string): Promise<string[]> {
  const info = await anchorFetch<Sep6InfoResponse>(`${anchor.transfer}/info`);
  const asset = info.withdraw?.[assetCode];
  if (!asset?.enabled) throw new Error(`${anchor.homeDomain} does not withdraw ${assetCode}`);
  return Object.keys(asset.types ?? {});
}

export async function initiateWithdraw(
  anchor: AnchorEndpoints,
  token: string,
  params: { assetCode: string; type: string; amount: string; quoteId?: string; account: string },
): Promise<WithdrawInstructions> {
  const response = await anchorFetch<WithdrawResponse>(`${anchor.transfer}/withdraw`, {
    token,
    query: {
      asset_code: params.assetCode,
      type: params.type,
      amount: params.amount,
      quote_id: params.quoteId,
      account: params.account,
    },
  });

  if (!response.account_id) {
    throw new Error(`${anchor.homeDomain} started a withdrawal without giving an account to pay`);
  }
  if (!response.memo) {
    throw new Error(`${anchor.homeDomain} started a withdrawal without a memo — the payment could not be matched to it`);
  }

  return {
    id: response.id,
    accountId: response.account_id,
    memo: response.memo,
    memoType: response.memo_type ?? "id",
    minAmount: response.min_amount,
    etaSeconds: response.eta,
  };
}

export async function fetchTransaction(
  anchor: AnchorEndpoints,
  token: string,
  id: string,
): Promise<AnchorTransaction> {
  const response = await anchorFetch<TransactionResponse>(`${anchor.transfer}/transaction`, {
    token,
    query: { id },
  });
  const tx = response.transaction;
  if (!tx) throw new Error(`${anchor.homeDomain} has no transaction ${id}`);

  return {
    id: tx.id,
    status: tx.status,
    statusEta: tx.status_eta,
    externalTransactionId: tx.external_transaction_id,
    stellarTransactionId: tx.stellar_transaction_id,
    claimableBalanceId: tx.claimable_balance_id,
    message: tx.message,
    amountOut: tx.amount_out,
  };
}

/**
 * The statuses this anchor can actually emit for a WITHDRAWAL, from the reference implementation's
 * `sepStatusOf` (tr-mock-anchor `src/core/sepstatus.ts`):
 *
 *     if (!b.offramp)                              return 'incomplete';
 *     if (b.offramp.status === 'awaiting_deposit') return 'pending_user_transfer_start';
 *     if (b.offramp.status === 'completed')        return 'completed';
 *     return 'error';
 *
 * Four, not eleven. `failed`, `refunded`, `expired`, `no_market`, `too_small` and `too_large` were
 * handled here previously; the anchor never returns any of them on this branch, and carrying dead
 * branches made the client look like it understood more than it did. `pending_trust` is likewise
 * deposit-only (`onramp.pending_reason === 'awaiting_trust'`) and unreachable for a withdrawal.
 *
 * Kept deliberately open at the edges: an unrecognised status is treated as "still going" rather
 * than guessed at, because a different anchor may say something we have never seen.
 */
export const TERMINAL_SUCCESS = "completed";
export const TERMINAL_FAILURES = new Set(["error"]);
/** Returned before an off-ramp row exists. Not terminal, and not a failure — the flow is early. */
export const STATUS_INCOMPLETE = "incomplete";

export function isTerminal(status: string): boolean {
  return status === TERMINAL_SUCCESS || TERMINAL_FAILURES.has(status);
}

/**
 * Map the anchor's vocabulary onto ours (§1.1): three lifecycle values, nothing more.
 *
 * `incomplete` maps to `pending` explicitly rather than by falling through the default. The anchor
 * returns it when the off-ramp row does not exist yet, which is an early stage of a live
 * withdrawal, not an error — reading it as a failure would abandon a withdrawal that is fine.
 */
export function toWithdrawalStatus(anchorStatus: string): "pending" | "completed" | "failed" {
  if (anchorStatus === TERMINAL_SUCCESS) return "completed";
  if (TERMINAL_FAILURES.has(anchorStatus)) return "failed";
  if (anchorStatus === STATUS_INCOMPLETE) return "pending";
  return "pending";
}
