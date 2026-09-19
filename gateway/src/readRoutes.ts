// The seller dashboard's read routes (CONVENTIONS.md §1.3 "Read endpoints"). Every query is scoped
// to req.seller, which comes from the verified Privy token — never from the request itself.
import type { RequestHandler } from "express";
import { HttpError, validate } from "./errors.js";
import type { Repo } from "./repo.js";
import * as schemas from "./schemas.js";
import type { CallSummary, EndpointSummary, GetBalanceResponse, ListCallsResponse, ListEndpointsResponse } from "./types.js";

export const CALLS_PAGE_LIMIT = 100;

export interface ReadRouteDeps {
  repo: Repo;
  /** The contract's get_balance view for a G… address, in stroops. Read-only simulation. */
  readBalance: (stellarAddress: string) => Promise<bigint>;
}

/** Query parameter names whose values are treated as credentials. */
const SECRET_PARAM = /key|token|secret|pass|auth|sig|credential|session/i;

/**
 * upstream_url as shown to the dashboard: userinfo (user:pass@) and the values of secret-looking
 * query parameters are replaced, so a key embedded in the URL never reaches a browser.
 */
export function redactUpstreamUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "[invalid url]";
  }
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
  }
  for (const name of [...new Set(url.searchParams.keys())]) {
    if (SECRET_PARAM.test(name)) url.searchParams.set(name, "REDACTED");
  }
  return url.toString();
}

/** After authenticate: 403 unless the Privy user has bootstrapped a seller row. */
export const requireSeller: RequestHandler = (req, _res, next) => {
  if (!req.seller) {
    throw new HttpError(403, "unauthorized", "No seller account yet: call POST /api/sellers/bootstrap first");
  }
  next();
};

export function createReadRoutes(deps: ReadRouteDeps) {
  const listEndpoints: RequestHandler = (req, res) => {
    const endpoints: EndpointSummary[] = deps.repo.listEndpointsWithCallCountBySeller(req.seller!.sellerId).map((e) => ({
      endpoint_id: e.id,
      proxy_slug: e.proxy_slug,
      upstream_url: redactUpstreamUrl(e.upstream_url),
      price_stroops: e.price_stroops,
      created_at: e.created_at,
      call_count: e.call_count,
    }));
    const body: ListEndpointsResponse = { endpoints };
    res.json(body);
  };

  const getBalance: RequestHandler = async (req, res) => {
    // The chain is the source of truth: never derived from the calls table.
    const stroops = await deps.readBalance(req.seller!.stellarAddress);
    if (stroops < 0n || stroops > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`get_balance returned ${stroops}, outside the safe integer range`);
    }
    const body: GetBalanceResponse = { balance_stroops: Number(stroops) };
    res.json(body);
  };

  const listCalls: RequestHandler = (req, res) => {
    const { endpoint_id } = validate(schemas.listCallsQuery, req.query, "query");
    const endpoint = deps.repo.findEndpointById(endpoint_id);
    if (!endpoint) {
      throw new HttpError(404, "endpoint_not_found", `No endpoint with endpoint_id ${endpoint_id}`);
    }
    if (endpoint.seller_id !== req.seller!.sellerId) {
      throw new HttpError(403, "unauthorized", `Endpoint ${endpoint_id} belongs to another seller`);
    }
    const calls: CallSummary[] = deps.repo.listCallsByEndpoint(endpoint_id, CALLS_PAGE_LIMIT).map((c) => ({
      id: c.id,
      endpoint_id: c.endpoint_id,
      agent_address: c.agent_address,
      amount_stroops: c.amount_stroops,
      status: c.status,
      tx_hash: c.tx_hash,
      created_at: c.created_at,
    }));
    const body: ListCallsResponse = { calls };
    res.json(body);
  };

  return { listEndpoints, getBalance, listCalls };
}
