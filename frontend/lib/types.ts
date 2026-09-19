// Request and response shapes for every route in docs/CONVENTIONS.md §1.3.
// Mirrored field-for-field from gateway/src/types.ts.
//
// Unit rules (§1.1): every amount is an integer number of stroops; addresses are classic G… strings;
// endpoint_id is the decimal string form of the contract's u64 ("1", "2", …).

// ---------------------------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------------------------

/**
 * Machine error codes (§1.1). `invalid_request`, `not_found` and `internal_error` are pending
 * addition to CONVENTIONS.md §1.1 — see the commit that introduced them.
 */
export type ErrorCode =
  | "missing_budget_header"
  | "budget_exceeded"
  | "endpoint_not_found"
  | "upstream_failed"
  | "unauthorized"
  | "anchor_error"
  | "not_implemented"
  | "invalid_request"
  | "not_found"
  | "internal_error";

/** Every non-2xx response body (§1.1). */
export interface ErrorResponse {
  error: ErrorCode;
  message: string;
}

export type CallStatus = "paid" | "upstream_failed" | "refunded";
export type WithdrawalStatus = "pending" | "completed" | "failed";

/** An empty JSON body (or no body at all). */
export type EmptyRequest = Record<string, never>;

// ---------------------------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------------------------

export interface HealthResponse {
  ok: true;
}

// ---------------------------------------------------------------------------------------------
// Seller onboarding — POST /api/sellers/bootstrap (auth header only, no body)
// ---------------------------------------------------------------------------------------------

export type BootstrapSellerRequest = EmptyRequest;

export interface BootstrapSellerResponse {
  seller_id: string;
  stellar_address: string;
  funded: true;
}

// ---------------------------------------------------------------------------------------------
// Endpoint registration — two-step
// ---------------------------------------------------------------------------------------------

/** POST /api/endpoints/prepare */
export interface PrepareEndpointRequest {
  upstream_url: string;
  price_stroops: number;
}

export interface PrepareEndpointResponse {
  unsigned_xdr: string;
  draft_id: string;
}

/** POST /api/endpoints/submit */
export interface SubmitEndpointRequest {
  draft_id: string;
  signed_xdr: string;
}

export interface SubmitEndpointResponse {
  endpoint_id: string;
  proxy_slug: string;
  upstream_url: string;
  price_stroops: number;
}

// ---------------------------------------------------------------------------------------------
// Withdrawal — two-step, then poll
// ---------------------------------------------------------------------------------------------

/** POST /api/withdraw/prepare — no body: the contract's withdraw() always takes the whole balance. */
export type PrepareWithdrawRequest = EmptyRequest;

export interface PrepareWithdrawResponse {
  unsigned_xdr: string;
  draft_id: string;
}

/** POST /api/withdraw/submit */
export interface SubmitWithdrawRequest {
  draft_id: string;
  signed_xdr: string;
}

export interface SubmitWithdrawResponse {
  withdrawal_id: string;
  status: "pending";
}

/**
 * Standard SEP-6 Anchor Transaction Statuses (SEP-0006).
 */
export type Sep6Status =
  | "pending_user_transfer_start"
  | "pending_user_transfer_complete"
  | "pending_external"
  | "pending_anchor"
  | "pending_stellar"
  | "pending_trust"
  | "pending_user"
  | "completed"
  | "refunded"
  | "expired"
  | "no_market"
  | "too_small"
  | "too_large"
  | "error"
  | "failed";

/** GET /api/withdrawals/:id */
export interface GetWithdrawalParams {
  id: string;
}

export interface GetWithdrawalResponse {
  status: WithdrawalStatus | Sep6Status;
  anchor_status?: Sep6Status;
  anchor_tx_id?: string;
  external_transaction_id?: string;
  amount_stroops?: number;
  message?: string;
  error_message?: string;
  claimable_balance_id?: string;
}

// ---------------------------------------------------------------------------------------------
// Read endpoints
// ---------------------------------------------------------------------------------------------

/** One row of GET /api/endpoints — the submit response plus its creation time and call count. */
export interface EndpointSummary extends SubmitEndpointResponse {
  created_at: string;
  call_count: number;
}

/** GET /api/endpoints — only the authenticated seller's own endpoints. */
export interface ListEndpointsResponse {
  endpoints: EndpointSummary[];
}

/** GET /api/balance — read from the contract's get_balance view, never summed from `calls`. */
export interface GetBalanceResponse {
  balance_stroops: number;
}

/** GET /api/calls?endpoint_id= */
export interface ListCallsQuery {
  endpoint_id: string;
}

export interface CallSummary {
  id: string;
  endpoint_id: string;
  agent_address: string;
  amount_stroops: number;
  status: CallStatus;
  tx_hash: string | null;
  created_at: string;
}

/** Newest first. */
export interface ListCallsResponse {
  calls: CallSummary[];
}

// ---------------------------------------------------------------------------------------------
// Agent side — GET /proxy/:proxy_slug (x402; no seller auth)
// ---------------------------------------------------------------------------------------------

export interface ProxyParams {
  proxy_slug: string;
}

/** Mandatory on an agent's first call to an endpoint, ignored afterwards. Integer stroops. */
export const AGENT_BUDGET_HEADER = "X-Agent-Budget";

/** 400 — first call for an (agent, endpoint) pair without X-Agent-Budget. */
export interface MissingBudgetHeaderResponse extends ErrorResponse {
  error: "missing_budget_header";
}

/**
 * 403 — budget exceeded. tx_hash is the record_call transaction the contract rejected ON-CHAIN;
 * null only if recording that rejection itself failed — the call is refused either way.
 */
export interface BudgetExceededResponse extends ErrorResponse {
  error: "budget_exceeded";
  tx_hash: string | null;
}

/** 502 — upstream non-2xx or timeout. The call is logged as upstream_failed and not settled. */
export interface UpstreamFailedResponse extends ErrorResponse {
  error: "upstream_failed";
}
