// Withdrawal, two-step then poll (CONVENTIONS.md §1.3). Same shape as endpoint registration:
// /prepare builds an unsigned withdraw() transaction with the seller as source, the frontend has
// Privy sign it, /submit sends it and reads the amount from the contract's return value.
//
// /submit returns as soon as the ledger entry is made. The anchor flow — SEP-10/38/12/6 and the
// payment — runs in the background, because it takes minutes and involves a third party; making a
// browser wait for it would time out long before the money moved.
import type { RequestHandler } from "express";
import { HttpError, validate } from "./errors.js";
import type { DraftStore } from "./drafts.js";
import type { Repo, WithdrawalRow } from "./repo.js";
import * as schemas from "./schemas.js";
import { scv, SorobanError, type StellarClient } from "./stellar.js";
import type {
  GetWithdrawalResponse,
  PrepareWithdrawResponse,
  SubmitWithdrawResponse,
} from "./types.js";

/**
 * The floor, in stroops: 1 USDC (§1.5). A LOWER BOUND, never a cap — anything below is refused
 * with a clear message and nothing is ever silently clamped to it. We have got this wrong once.
 */
export const MIN_WITHDRAWAL_STROOPS = 10_000_000;

export interface WithdrawRouteDeps {
  repo: Repo;
  drafts: DraftStore;
  ledger: Pick<StellarClient, "contractId" | "buildUnsignedInvoke" | "transactionHash" | "submitSignedXdr">;
  /** The contract's get_balance view, shared with GET /api/balance. The chain is the truth (§1.3). */
  readBalance: (stellarAddress: string) => Promise<bigint>;
  /** Starts the anchor flow. Injected so tests can assert it ran without touching the network. */
  startAnchorFlow: (withdrawal: WithdrawalRow) => void;
  /** The anchor a new withdrawal is routed to. */
  anchorHomeDomain: string;
}

const draftGone = () =>
  new HttpError(404, "not_found", "This withdrawal draft has expired or does not exist. Start the withdrawal again.");

export function createWithdrawRoutes(deps: WithdrawRouteDeps) {
  const prepare: RequestHandler = async (req, res) => {
    validate(schemas.prepareWithdrawRequest, req.body ?? {}, "body");
    const seller = req.seller!;

    // The chain is the source of truth for balances (§1.3): read it, never sum the calls table.
    const balanceStroops = await deps.readBalance(seller.stellarAddress);
    const balance = Number(balanceStroops);

    if (balance <= 0) {
      throw new HttpError(400, "invalid_request", "There is nothing to withdraw: your balance is 0.");
    }
    if (balance < MIN_WITHDRAWAL_STROOPS) {
      // Say the real numbers. "Too small" without them sends the seller back to guess.
      throw new HttpError(
        400,
        "invalid_request",
        `The anchor's minimum withdrawal is ${format(MIN_WITHDRAWAL_STROOPS)} USDC and your balance is ` +
          `${format(balance)} USDC. Earn a little more and withdraw the full amount — we will not withdraw a partial one.`,
      );
    }

    let unsignedXdr: string;
    try {
      unsignedXdr = await deps.ledger.buildUnsignedInvoke(
        deps.ledger.contractId,
        "withdraw",
        [scv.address(seller.stellarAddress)],
        seller.stellarAddress,
      );
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Account not found")) {
        throw new HttpError(409, "invalid_request", "The seller account is not funded yet: call POST /api/sellers/bootstrap first");
      }
      throw err;
    }

    const draft_id = deps.drafts.put({
      kind: "withdraw",
      sellerId: seller.sellerId,
      txHash: deps.ledger.transactionHash(unsignedXdr),
    });
    const body: PrepareWithdrawResponse = { unsigned_xdr: unsignedXdr, draft_id };
    res.json(body);
  };

  const submit: RequestHandler = async (req, res) => {
    const { draft_id, signed_xdr } = validate(schemas.submitWithdrawRequest, req.body, "body");
    const seller = req.seller!;

    const draft = deps.drafts.get(draft_id);
    // Another seller's draft is reported exactly like a missing one: draft ids leak nothing.
    if (!draft || draft.kind !== "withdraw" || draft.sellerId !== seller.sellerId) throw draftGone();

    let signedHash: string;
    try {
      signedHash = deps.ledger.transactionHash(signed_xdr);
    } catch {
      throw new HttpError(400, "invalid_request", "signed_xdr is not a transaction envelope for this network");
    }
    if (signedHash !== draft.txHash) {
      throw new HttpError(400, "invalid_request", "signed_xdr is not the transaction that was prepared for this draft");
    }

    // Single use from here on: a draft can reach the network at most once.
    if (!deps.drafts.take(draft_id)) throw draftGone();

    let result: Awaited<ReturnType<WithdrawRouteDeps["ledger"]["submitSignedXdr"]>>;
    try {
      result = await deps.ledger.submitSignedXdr(signed_xdr);
    } catch (err) {
      if (err instanceof SorobanError && (err.stage === "send" || err.stage === "execution")) {
        throw new HttpError(400, "invalid_request", `The network rejected the withdrawal transaction: ${err.message}`);
      }
      throw err;
    }

    // withdraw() returns the amount it zeroed. Never invent it: this figure is what we pay out.
    const amount = result.returnValue;
    if (typeof amount !== "bigint" || amount < 0n) {
      throw new Error(
        `withdraw tx ${result.txHash} succeeded but its return value is not an i128 amount: ${String(amount)}`,
      );
    }
    if (amount === 0n) {
      // The contract returns 0 rather than failing (§1.2). Nothing moved, so record nothing.
      throw new HttpError(409, "invalid_request", "The balance was already withdrawn: nothing moved on chain.");
    }
    if (amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`withdraw tx ${result.txHash} returned ${amount} stroops, outside the safe integer range`);
    }

    const row = deps.repo.createWithdrawal({
      seller_id: seller.sellerId,
      amount_stroops: Number(amount),
      status: "pending",
      anchor_domain: deps.anchorHomeDomain,
    });

    // Answer now; the anchor takes minutes. Errors inside the job land on the row, not on this
    // response, which is why GET /api/withdrawals/:id exists.
    deps.startAnchorFlow(row);

    const body: SubmitWithdrawResponse = { withdrawal_id: row.id, status: "pending" };
    res.json(body);
  };

  const get: RequestHandler = async (req, res) => {
    const { id } = validate(schemas.getWithdrawalParams, req.params, "params");
    const seller = req.seller!;

    const row = deps.repo.findWithdrawal(id);
    // Another seller's withdrawal is indistinguishable from one that does not exist.
    if (!row || row.seller_id !== seller.sellerId) {
      throw new HttpError(404, "not_found", "No such withdrawal.");
    }

    res.json(toResponse(row));
  };

  return { prepare, submit, get };
}

/** Undefined rather than null for absent fields: §1.3 marks them optional, and JSON drops them. */
export function toResponse(row: WithdrawalRow): GetWithdrawalResponse {
  return {
    status: row.status,
    anchor_status: row.anchor_status ?? undefined,
    anchor_tx_id: row.anchor_tx_id ?? undefined,
    external_transaction_id: row.external_transaction_id ?? undefined,
    claimable_balance_id: row.claimable_balance_id ?? undefined,
    amount_stroops: row.amount_stroops,
    quote_buy_amount: row.quote_buy_amount ?? undefined,
    error_message: row.error_message ?? undefined,
  };
}

/** Stroops as USDC, for messages a seller reads. Display only — never for arithmetic (§1.1). */
const format = (stroops: number) => (stroops / 10_000_000).toFixed(7).replace(/0+$/, "").replace(/\.$/, "");
