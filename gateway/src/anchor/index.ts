// The anchor off-ramp, start to finish: SEP-1 → SEP-10 → SEP-38 → SEP-12 → SEP-6 → payment → poll.
//
// Every step reports back through `onProgress` so the caller can write it to the withdrawals row as
// it happens. A seller polling GET /api/withdrawals/:id sees the flow advance rather than a silent
// `pending` that either turns into money or does not.
import { Keypair } from "@stellar/stellar-sdk";
import { createPayoutClient, stroopsToDecimal, type PayoutClient, type PayoutConfig } from "./payout.js";
import { authenticate, withAuth } from "./sep10.js";
import { ensureCustomerAccepted } from "./sep12.js";
import { quoteIsUsable, requestQuote, resolvePayoutAsset, type Sep38Quote } from "./sep38.js";
import {
  fetchTransaction,
  initiateWithdraw,
  isTerminal,
  toWithdrawalStatus,
  withdrawMinimum,
  withdrawTypes,
} from "./sep6.js";
import { resolveAnchor, type AnchorEndpoints } from "./toml.js";

export { resolveAnchor, clearAnchorCache } from "./toml.js";
export { withdrawMinimum, toWithdrawalStatus } from "./sep6.js";
export { AnchorError } from "./http.js";
export { stroopsToDecimal } from "./payout.js";

/** What the caller persists after each step. Every field is optional but `anchorStatus`. */
export interface AnchorProgress {
  anchorStatus: string;
  anchorTxId?: string;
  externalTransactionId?: string;
  claimableBalanceId?: string;
  quoteBuyAmount?: string;
  message?: string;
}

export interface WithdrawalFlowOptions {
  homeDomain: string;
  assetCode: string;
  amountStroops: number;
  /** ISO 4217 code the seller wants paid out, e.g. "TRY". Falls back to whatever the anchor offers. */
  preferredCurrency?: string;
  /** KYC values, when the anchor asks for any. Never invented — see sep12.ts. */
  kycValues?: Record<string, string>;
  payout: PayoutConfig;
  networkPassphrase: string;
  onProgress?: (progress: AnchorProgress) => void;
  /** Overridable so tests do not wait minutes. */
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export interface WithdrawalFlowResult {
  status: "completed" | "failed" | "pending";
  anchorStatus: string;
  anchorTxId?: string;
  externalTransactionId?: string;
  claimableBalanceId?: string;
  quoteBuyAmount?: string;
  message?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60_000;

/**
 * Run the whole off-ramp. Resolves when the anchor reaches a terminal state, or when polling gives
 * up — a timeout leaves the withdrawal `pending`, which is honest: the anchor may still finish, and
 * the resume pass will pick it up.
 */
export async function runWithdrawalFlow(options: WithdrawalFlowOptions): Promise<WithdrawalFlowResult> {
  const {
    homeDomain,
    assetCode,
    amountStroops,
    preferredCurrency = "TRY",
    kycValues = {},
    payout,
    networkPassphrase,
    onProgress,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  } = options;

  const report = (progress: AnchorProgress) => onProgress?.(progress);

  // (a) SEP-1 — every URL and the issuer come from here.
  const anchor = await resolveAnchor(homeDomain);
  const issuer = anchor.assetIssuer(assetCode);
  const amount = stroopsToDecimal(amountStroops);

  const payoutClient = createPayoutClient(payout);
  const pool = Keypair.fromSecret(payout.poolSecret);
  const account = pool.publicKey();

  report({ anchorStatus: "pending_anchor", message: `authenticating with ${anchor.homeDomain}` });

  // (b) SEP-10 — as the pool, for the reason documented in sep10.ts.
  await authenticate(anchor, pool, networkPassphrase);

  // (c) SEP-38 — lock a rate, so the seller is told what they will actually receive.
  let quote: Sep38Quote | undefined;
  if (anchor.quote) {
    const buyAsset = await resolvePayoutAsset(anchor, preferredCurrency);
    quote = await withAuth(anchor, pool, networkPassphrase, (token) =>
      requestQuote(anchor, token, { assetCode, sellAmount: amount, buyAsset }),
    );
    report({
      anchorStatus: "pending_anchor",
      quoteBuyAmount: quote.buyAmount,
      message: `rate locked: ${amount} ${assetCode} → ${quote.buyAmount} ${buyAsset.replace("iso4217:", "")}`,
    });
  }

  // (d) SEP-12 — only if the anchor has a KYC server; fields come from its own answer.
  if (anchor.kyc) {
    const customer = await withAuth(anchor, pool, networkPassphrase, (token) =>
      ensureCustomerAccepted(anchor, token, account, kycValues),
    );
    if (customer.status === "REJECTED") {
      return fail(report, "error", `anchor rejected KYC: ${customer.message ?? "no reason given"}`);
    }
  }

  // (e) SEP-6 — get the account, memo and memo type to pay.
  const types = await withAuth(anchor, pool, networkPassphrase, () => withdrawTypes(anchor, assetCode));
  const type = types.includes("bank_account") ? "bank_account" : (types[0] as string | undefined);
  if (!type) return fail(report, "error", `${anchor.homeDomain} offers no withdrawal method for ${assetCode}`);

  // The quote may have aged while KYC was running. Spending an expired one is refused by the
  // anchor, so replace it rather than find out at the withdraw call.
  if (quote && !quoteIsUsable(quote)) {
    const buyAsset = quote.buyAsset;
    quote = await withAuth(anchor, pool, networkPassphrase, (token) =>
      requestQuote(anchor, token, { assetCode, sellAmount: amount, buyAsset }),
    );
    report({ anchorStatus: "pending_anchor", quoteBuyAmount: quote.buyAmount, message: "quote refreshed before payment" });
  }

  const instructions = await withAuth(anchor, pool, networkPassphrase, (token) =>
    initiateWithdraw(anchor, token, { assetCode, type, amount, quoteId: quote?.id, account }),
  );

  report({
    anchorStatus: "pending_user_transfer_start",
    anchorTxId: instructions.id,
    quoteBuyAmount: quote?.buyAmount,
    message: `anchor is waiting for ${amount} ${assetCode}`,
  });

  // (f) The payment itself — classic operation, memo_type id, exactly what the anchor asked for.
  try {
    await payoutClient.pay({
      destination: instructions.accountId,
      amount,
      assetCode,
      assetIssuer: issuer,
      memo: instructions.memo,
      memoType: instructions.memoType,
    });
  } catch (err) {
    return fail(report, "error", `paying the anchor failed: ${err instanceof Error ? err.message : String(err)}`, instructions.id);
  }

  report({ anchorStatus: "pending_anchor", anchorTxId: instructions.id, message: "payment sent, waiting for the anchor" });

  // (g) Poll until the anchor is done.
  return await pollUntilTerminal(anchor, pool, networkPassphrase, instructions.id, {
    quoteBuyAmount: quote?.buyAmount,
    intervalMs: pollIntervalMs,
    timeoutMs: pollTimeoutMs,
    report,
  });
}

async function pollUntilTerminal(
  anchor: AnchorEndpoints,
  pool: Keypair,
  networkPassphrase: string,
  anchorTxId: string,
  opts: {
    quoteBuyAmount?: string;
    intervalMs: number;
    timeoutMs: number;
    report: (p: AnchorProgress) => void;
  },
): Promise<WithdrawalFlowResult> {
  const deadline = Date.now() + opts.timeoutMs;
  let last: WithdrawalFlowResult = {
    status: "pending",
    anchorStatus: "pending_anchor",
    anchorTxId,
    quoteBuyAmount: opts.quoteBuyAmount,
  };

  while (Date.now() < deadline) {
    const tx = await withAuth(anchor, pool, networkPassphrase, (token) =>
      fetchTransaction(anchor, token, anchorTxId),
    );

    last = {
      status: toWithdrawalStatus(tx.status),
      anchorStatus: tx.status,
      anchorTxId,
      externalTransactionId: tx.externalTransactionId,
      claimableBalanceId: tx.claimableBalanceId,
      quoteBuyAmount: opts.quoteBuyAmount,
      message: tx.message,
    };

    opts.report({
      anchorStatus: tx.status,
      anchorTxId,
      externalTransactionId: tx.externalTransactionId,
      claimableBalanceId: tx.claimableBalanceId,
      quoteBuyAmount: opts.quoteBuyAmount,
      message: tx.message,
    });

    if (isTerminal(tx.status)) return last;
    await sleep(opts.intervalMs);
  }

  // Not a failure: the anchor is still working, and the resume pass will keep watching.
  return { ...last, status: "pending", message: last.message ?? "still pending when polling gave up" };
}

/** Resume watching a withdrawal whose flow was interrupted — a gateway restart, usually. */
export async function resumePolling(options: {
  homeDomain: string;
  anchorTxId: string;
  payout: PayoutConfig;
  networkPassphrase: string;
  onProgress?: (progress: AnchorProgress) => void;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}): Promise<WithdrawalFlowResult> {
  const anchor = await resolveAnchor(options.homeDomain);
  const pool = Keypair.fromSecret(options.payout.poolSecret);
  return await pollUntilTerminal(anchor, pool, options.networkPassphrase, options.anchorTxId, {
    intervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
    report: (p) => options.onProgress?.(p),
  });
}

function fail(
  report: (p: AnchorProgress) => void,
  anchorStatus: string,
  message: string,
  anchorTxId?: string,
): WithdrawalFlowResult {
  report({ anchorStatus, anchorTxId, message });
  return { status: "failed", anchorStatus, anchorTxId, message };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
