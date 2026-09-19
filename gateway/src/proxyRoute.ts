// GET /proxy/:proxy_slug — the pay-per-call core (CONVENTIONS.md §1.3). Order matters and is the
// whole design:
//
//   1. endpoint lookup                → 404 endpoint_not_found
//   2. x402: verify PAYMENT-SIGNATURE → 402 PAYMENT-REQUIRED when absent or invalid (nothing charged)
//   3. record_call on-chain           → 400 missing_budget_header / 403 budget_exceeded (nothing charged:
//                                       the verified payment is cancelled, never settled)
//   4. x402: settle the payment       → the agent's USDC moves to the platform pool
//   5. upstream request, 10 s timeout → failure: 502 upstream_failed, call logged, NO contract settle
//   6. contract settle, log the call  → 200 with the upstream body and PAYMENT-RESPONSE
//
// Budget enforcement (3) runs before the money moves (4), so a refused agent is never charged.
import type { Request, RequestHandler, Response } from "express";
import type { CredentialCipher } from "./credentials.js";
import { HttpError, validate } from "./errors.js";
import type { PaymentGate, PaymentResponseInstructions } from "./payments.js";
import type { ProxyLedger } from "./proxyLedger.js";
import type { Repo } from "./repo.js";
import * as schemas from "./schemas.js";
import { AGENT_BUDGET_HEADER, type BudgetExceededResponse, type MissingBudgetHeaderResponse, type UpstreamFailedResponse } from "./types.js";
import { callUpstream } from "./upstream.js";

export interface ProxyDeps {
  repo: Repo;
  gate: PaymentGate;
  proxyLedger: ProxyLedger;
  credentialCipher: CredentialCipher;
  /** Upstream fetch; the global fetch unless a test injects one. */
  fetchUpstream?: typeof fetch;
  upstreamTimeoutMs?: number;
  log?: (line: string) => void;
}

function send(res: Response, r: PaymentResponseInstructions): void {
  for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
  res.status(r.status).json(r.body);
}

export function createProxyHandler(deps: ProxyDeps): RequestHandler {
  const log = deps.log ?? ((line: string) => console.log(line));

  return async (req: Request, res: Response) => {
    const { proxy_slug } = validate(schemas.proxyParams, req.params, "params");
    const budgetHeader = validate(schemas.agentBudgetHeader, req.get(AGENT_BUDGET_HEADER), "headers");

    // 1. Which endpoint, at what price. The slug is the URL identity; the id is the on-chain one (§1.1).
    const endpoint = deps.repo.findEndpointBySlug(proxy_slug);
    if (!endpoint) throw new HttpError(404, "endpoint_not_found", `No endpoint behind /proxy/${proxy_slug}`);

    // 2. x402: no payment or a bad one ends here with the library's 402.
    const gate = await deps.gate.process(req, endpoint.price_stroops);
    if (gate.kind === "respond") return send(res, gate.response);
    const payment = gate.payment;
    const agent = payment.payer;

    // 3. The budget, decided by the contract. Missing header → budget 0, which the contract accepts on
    //    later calls (the parameter is ignored) and rejects on the pair's first call.
    const budget = budgetHeader ? BigInt(budgetHeader) : 0n;
    let recorded;
    try {
      recorded = await deps.proxyLedger.recordCall(agent, endpoint.id, budget, endpoint.price_stroops);
    } catch (err) {
      await payment.cancel(500).catch(() => {});
      throw err;
    }

    if (recorded.kind === "missing_budget") {
      await payment.cancel(400);
      const body: MissingBudgetHeaderResponse = {
        error: "missing_budget_header",
        message: `First call from ${agent} to this endpoint: send ${AGENT_BUDGET_HEADER}: <stroops> to set your spending limit. Nothing was charged.`,
      };
      res.status(400).json(body);
      return;
    }
    if (recorded.kind === "budget_exceeded") {
      await payment.cancel(403);
      const body: BudgetExceededResponse = {
        error: "budget_exceeded",
        message: `This call would take ${agent} past the budget frozen on its first call to this endpoint. Nothing was charged.`,
        tx_hash: recorded.rejectedTxHash,
      };
      log(`proxy ${proxy_slug}: budget_exceeded for ${agent}, rejected on-chain in tx ${recorded.rejectedTxHash}`);
      res.status(403).json(body);
      return;
    }
    if (recorded.kind === "endpoint_not_found") {
      await payment.cancel(404);
      log(`proxy ${proxy_slug}: endpoint ${endpoint.id} is cached but unknown to the contract (stale CONTRACT_ID?)`);
      throw new HttpError(404, "endpoint_not_found", `Endpoint ${endpoint.id} is not registered on the contract`);
    }

    // 4. Take the money.
    const settlement = await payment.settle();
    if (!settlement.ok) {
      // The budget was already charged on-chain for a payment that did not go through. Rare (the
      // payment verified moments ago); logged so it can be reconciled by hand.
      log(`proxy ${proxy_slug}: payment settlement failed for ${agent} after record_call ${recorded.txHash}: ${settlement.reason}`);
      return send(res, settlement.response);
    }
    for (const [k, v] of Object.entries(settlement.headers)) res.setHeader(k, v);

    // 5. The seller's API. Credentials are decrypted only here, only for this request.
    const credentials = endpoint.upstream_credentials_enc ? deps.credentialCipher.decrypt(endpoint.upstream_credentials_enc) : null;
    const upstream = await callUpstream({
      upstreamUrl: endpoint.upstream_url,
      credentials,
      agentQuery: new URL(req.originalUrl, "http://proxy.local").searchParams,
      accept: req.get("accept"),
      fetch: deps.fetchUpstream,
      timeoutMs: deps.upstreamTimeoutMs,
    });

    if (!upstream.ok) {
      // Paid, but the seller did not deliver: logged honestly, and the seller earns nothing (no settle).
      // TODO(refunds): the agent's payment stays in the platform pool. A refund path would send it back
      // and move this row to `refunded` — the status exists so the UI can already show it. Not built.
      deps.repo.insertCall({
        endpoint_id: endpoint.id,
        agent_address: agent,
        amount_stroops: endpoint.price_stroops,
        status: "upstream_failed",
        tx_hash: settlement.txHash,
      });
      log(`proxy ${proxy_slug}: upstream failed (${upstream.reason}) — payment ${settlement.txHash} taken, not settled to the seller`);
      const body: UpstreamFailedResponse = { error: "upstream_failed", message: `The seller's API did not answer successfully: ${upstream.reason}` };
      res.status(502).json(body);
      return;
    }

    // 6. Credit the seller on the ledger, log the call, deliver.
    try {
      const settleTx = await deps.proxyLedger.settle(endpoint.id, endpoint.price_stroops);
      log(`proxy ${proxy_slug}: paid by ${agent} — payment ${settlement.txHash}, record_call ${recorded.txHash}, settle ${settleTx}`);
    } catch (err) {
      // The agent paid and gets the data; the seller's credit is what failed. Loud, so it gets re-settled.
      log(`proxy ${proxy_slug}: SETTLE FAILED for endpoint ${endpoint.id}, ${endpoint.price_stroops} stroops, payment ${settlement.txHash}: ${String(err)}`);
    }
    deps.repo.insertCall({
      endpoint_id: endpoint.id,
      agent_address: agent,
      amount_stroops: endpoint.price_stroops,
      status: "paid",
      tx_hash: settlement.txHash,
    });

    if (upstream.contentType) res.setHeader("content-type", upstream.contentType);
    res.status(200).send(upstream.body);
  };
}
