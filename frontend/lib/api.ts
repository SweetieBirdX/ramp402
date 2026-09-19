import { getAccessToken } from "./auth";
import type {
  BootstrapSellerResponse,
  ErrorCode,
  ErrorResponse,
  GetBalanceResponse,
  GetWithdrawalResponse,
  ListCallsResponse,
  ListEndpointsResponse,
  PrepareEndpointRequest,
  PrepareEndpointResponse,
  PrepareWithdrawResponse,
  SubmitEndpointRequest,
  SubmitEndpointResponse,
  SubmitWithdrawRequest,
  SubmitWithdrawResponse,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | string;
  override readonly message: string;
  readonly extra: Record<string, unknown>;

  constructor(
    status: number,
    code: ErrorCode | string,
    message: string,
    extra: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.message = message;
    this.extra = extra;
  }
}

export interface RequestOptions {
  token?: string | null;
  signal?: AbortSignal;
}

export function getGatewayUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_GATEWAY_URL?.trim();
  if (envUrl) {
    return envUrl.replace(/\/+$/, "");
  }
  return "http://localhost:3001";
}

async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
  options?: RequestOptions
): Promise<T> {
  const baseUrl = getGatewayUrl();
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };

  const token = options?.token ?? (await getAccessToken());
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers,
      signal: options?.signal,
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : "Network error";
    throw new ApiError(0, "internal_error", errorMsg);
  }

  if (!res.ok) {
    let errorBody: Partial<ErrorResponse> & Record<string, unknown> = {};
    try {
      errorBody = await res.json();
    } catch {
      // Response was not JSON
    }

    const code =
      (errorBody.error as ErrorCode) ||
      (res.status === 501 ? "not_implemented" : "internal_error");
    const message =
      errorBody.message || res.statusText || `Request failed with status ${res.status}`;
    const extra: Record<string, unknown> = { ...errorBody };
    delete extra.error;
    delete extra.message;

    throw new ApiError(res.status, code, message, extra);
  }

  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------------------------
// CONVENTIONS.md §1.3 Routes
// ---------------------------------------------------------------------------------------------

/**
 * POST /api/sellers/bootstrap
 * On first login: creates seller row if absent and funds address automatically via Friendbot.
 */
export async function bootstrapSeller(
  options?: RequestOptions
): Promise<BootstrapSellerResponse> {
  return apiRequest<BootstrapSellerResponse>(
    "/api/sellers/bootstrap",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
    options
  );
}

/**
 * POST /api/endpoints/prepare
 * Step 1 of endpoint registration: creates unsigned Soroban register_endpoint XDR and draft.
 */
export async function prepareEndpoint(
  upstream_url: string,
  price_stroops: number,
  options?: RequestOptions
): Promise<PrepareEndpointResponse> {
  const body: PrepareEndpointRequest = { upstream_url, price_stroops };
  return apiRequest<PrepareEndpointResponse>(
    "/api/endpoints/prepare",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    options
  );
}

/**
 * POST /api/endpoints/submit
 * Step 2 of endpoint registration: submits seller-signed XDR, records endpoint in DB, and returns proxy details.
 */
export async function submitEndpoint(
  draft_id: string,
  signed_xdr: string,
  options?: RequestOptions
): Promise<SubmitEndpointResponse> {
  const body: SubmitEndpointRequest = { draft_id, signed_xdr };
  return apiRequest<SubmitEndpointResponse>(
    "/api/endpoints/submit",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    options
  );
}

/**
 * POST /api/withdraw/prepare
 * Step 1 of withdrawal: prepares unsigned Soroban withdraw() XDR for seller balance.
 */
export async function prepareWithdraw(
  options?: RequestOptions
): Promise<PrepareWithdrawResponse> {
  return apiRequest<PrepareWithdrawResponse>(
    "/api/withdraw/prepare",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
    options
  );
}

/**
 * POST /api/withdraw/submit
 * Step 2 of withdrawal: submits seller-signed withdraw XDR and initiates off-ramp pipeline.
 */
export async function submitWithdraw(
  draft_id: string,
  signed_xdr: string,
  options?: RequestOptions
): Promise<SubmitWithdrawResponse> {
  const body: SubmitWithdrawRequest = { draft_id, signed_xdr };
  return apiRequest<SubmitWithdrawResponse>(
    "/api/withdraw/submit",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    options
  );
}

/**
 * GET /api/withdrawals/:id
 * Polls the status of an ongoing anchor off-ramp withdrawal.
 */
export async function getWithdrawal(
  id: string,
  options?: RequestOptions
): Promise<GetWithdrawalResponse> {
  return apiRequest<GetWithdrawalResponse>(
    `/api/withdrawals/${encodeURIComponent(id)}`,
    { method: "GET" },
    options
  );
}

/**
 * GET /api/endpoints
 * Lists the authenticated seller's registered endpoints.
 */
export async function listEndpoints(
  options?: RequestOptions
): Promise<ListEndpointsResponse> {
  return apiRequest<ListEndpointsResponse>(
    "/api/endpoints",
    { method: "GET" },
    options
  );
}

/**
 * GET /api/balance
 * Returns the seller's on-chain balance in stroops from ramp_ledger contract view get_balance.
 */
export async function getBalance(
  options?: RequestOptions
): Promise<GetBalanceResponse> {
  return apiRequest<GetBalanceResponse>(
    "/api/balance",
    { method: "GET" },
    options
  );
}

/**
 * GET /api/calls?endpoint_id=
 * Returns the newest-first call history log for an endpoint.
 */
export async function listCalls(
  endpoint_id: string,
  options?: RequestOptions
): Promise<ListCallsResponse> {
  return apiRequest<ListCallsResponse>(
    `/api/calls?endpoint_id=${encodeURIComponent(endpoint_id)}`,
    { method: "GET" },
    options
  );
}

/**
 * GET /proxy/:proxy_slug
 * Agent-side x402 proxy call. Unauthenticated (no seller Privy token attached).
 * Returns raw fetch Response so caller can inspect 402 status, headers, and body.
 */
export async function callProxy(
  proxy_slug: string,
  headers?: HeadersInit,
  options?: { signal?: AbortSignal }
): Promise<Response> {
  const baseUrl = getGatewayUrl();
  const url = `${baseUrl}/proxy/${encodeURIComponent(proxy_slug)}`;

  try {
    return await fetch(url, {
      method: "GET",
      headers,
      signal: options?.signal,
    });
  } catch (err: unknown) {
    if (typeof window !== "undefined") {
      const fallbackUrl = `/api/proxy/${encodeURIComponent(proxy_slug)}`;
      return fetch(fallbackUrl, {
        method: "GET",
        headers,
        signal: options?.signal,
      });
    }
    throw err;
  }
}
