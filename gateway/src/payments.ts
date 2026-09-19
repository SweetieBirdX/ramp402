// x402 v2 for /proxy (CONVENTIONS.md §1.3), built on @x402/express 2.26.0. The library reads
// PAYMENT-SIGNATURE and writes PAYMENT-REQUIRED / PAYMENT-RESPONSE; nothing here hand-builds a header.
//
// The stock paymentMiddleware settles only after the handler has run. /proxy needs one more step in
// between — the on-chain budget check, which may refuse the call — so the phases are driven by hand:
// verify → (caller enforces the budget) → settle, or cancel if the caller refused.
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExpressAdapter, x402HTTPResourceServer, x402ResourceServer, type PaymentPayload, type PaymentRequirements } from "@x402/express";
import { getUsdcAddress } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import type { Request } from "express";

type Network = `${string}:${string}`;

/** What the route must send back as-is (402s, and the library's own error responses). */
export interface PaymentResponseInstructions {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export type PaymentSettlement =
  | { ok: true; headers: Record<string, string>; txHash: string }
  | { ok: false; response: PaymentResponseInstructions; reason: string };

export interface VerifiedPayment {
  /** The paying agent's classic G… address, as reported by the facilitator's /verify. */
  payer: string;
  /** Takes the money: the facilitator submits the agent's signed USDC transfer. */
  settle(): Promise<PaymentSettlement>;
  /** Releases a verified payment that will not be settled (the call was refused before settlement). */
  cancel(responseStatus: number): Promise<void>;
}

export type GateResult = { kind: "respond"; response: PaymentResponseInstructions } | { kind: "verified"; payment: VerifiedPayment };

export interface PaymentGate {
  /** No or invalid PAYMENT-SIGNATURE → a 402 to send back; valid → a verified payment to act on. */
  process(req: Request, priceStroops: number): Promise<GateResult>;
}

export interface PaymentGateConfig {
  facilitatorUrl: string;
  /** CAIP-2, e.g. "stellar:testnet". */
  network: Network;
  /** The platform pool's G… address: agents pay the pool, the contract keeps the books (§1.2). */
  payTo: string;
}

/** STELLAR_NETWORK ("testnet" | "pubnet" | CAIP-2) → the CAIP-2 id x402 expects. */
export function caip2Network(network: string): Network {
  const n = network.trim().toLowerCase();
  if (n === "testnet" || n === "stellar:testnet") return "stellar:testnet";
  if (n === "pubnet" || n === "mainnet" || n === "public" || n === "stellar:pubnet") return "stellar:pubnet";
  throw new Error(`Unknown STELLAR_NETWORK "${network}"`);
}

/** The route pattern the payment server matches; the price comes from the endpoint being called. */
const PROXY_ROUTE = "GET /proxy/*";

export function createPaymentGate(config: PaymentGateConfig): PaymentGate {
  const asset = getUsdcAddress(config.network);
  const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: config.facilitatorUrl })).register(
    config.network,
    new ExactStellarScheme(),
  );

  // The price of THIS request, keyed by its adapter (one per request, passed through by reference).
  const priceFor = new WeakMap<object, number>();
  // The facilitator's verdict on who paid, captured in the verify hook and keyed the same way.
  const payerFor = new WeakMap<object, string>();

  resourceServer.onAfterVerify(async (ctx) => {
    const adapter = (ctx.transportContext as { request?: { adapter?: object } } | undefined)?.request?.adapter;
    if (adapter && ctx.result.isValid && ctx.result.payer) payerFor.set(adapter, ctx.result.payer);
  });

  const httpServer = new x402HTTPResourceServer(resourceServer, {
    [PROXY_ROUTE]: {
      accepts: {
        scheme: "exact",
        network: config.network,
        payTo: config.payTo,
        // Stroops are USDC's 7-decimal base unit, so the endpoint price is the x402 amount unchanged:
        // no decimal conversion anywhere (CONVENTIONS.md §1.1).
        price: (ctx) => {
          const stroops = priceFor.get(ctx.adapter);
          if (stroops === undefined) throw new Error("no price registered for this request");
          return { amount: String(stroops), asset };
        },
      },
      description: "Ramp402 pay-per-call API",
      mimeType: "application/json",
    },
  });

  // /supported is fetched once; a failure is retried on the next request instead of wedging the gateway.
  let ready: Promise<void> | undefined;
  const initialize = () => {
    ready ??= httpServer.initialize().catch((err) => {
      ready = undefined;
      throw err;
    });
    return ready;
  };

  return {
    async process(req, priceStroops) {
      await initialize();
      const adapter = new ExpressAdapter(req);
      priceFor.set(adapter, priceStroops);

      const result = await httpServer.processHTTPRequest({
        adapter,
        path: req.path,
        method: req.method,
        paymentHeader: adapter.getHeader("payment-signature"),
      });

      if (result.type === "payment-error") {
        return { kind: "respond", response: { status: result.response.status, headers: result.response.headers, body: result.response.body ?? {} } };
      }
      if (result.type === "no-payment-required") {
        throw new Error(`${PROXY_ROUTE} unexpectedly required no payment`);
      }

      const payer = payerFor.get(adapter);
      if (!payer) throw new Error("facilitator verified the payment but reported no payer");
      const payload: PaymentPayload = result.paymentPayload;
      const requirements: PaymentRequirements = result.paymentRequirements;
      const transportContext = { request: { adapter, path: req.path, method: req.method } };

      return {
        kind: "verified",
        payment: {
          payer,
          async settle() {
            const settled = await httpServer.processSettlement(payload, requirements, result.declaredExtensions, transportContext);
            if (settled.success) return { ok: true, headers: settled.headers, txHash: settled.transaction };
            return {
              ok: false,
              reason: settled.errorMessage ?? settled.errorReason,
              response: { status: settled.response.status, headers: settled.response.headers, body: settled.response.body ?? {} },
            };
          },
          async cancel(responseStatus) {
            await result.cancellationDispatcher.cancel({ reason: "handler_failed", responseStatus });
          },
        },
      };
    },
  };
}
