// CORS for browser clients. Middleware, mounted once, rather than per-route headers — a route that
// forgets them fails in a way that looks like a network error and takes an hour to find.
//
// The header lists below are NOT guesses. They were read out of the client:
//
//   requests  frontend/lib/api.ts:68   Authorization
//             frontend/lib/api.ts:121  Content-Type
//             frontend/lib/agent.ts:285 Accept
//             frontend/lib/agent.ts:288 X-Agent-Budget
//             frontend/lib/agent.ts:418 PAYMENT-SIGNATURE
//   responses frontend/lib/agent.ts:301 PAYMENT-REQUIRED
//             frontend/lib/agent.ts:434 PAYMENT-RESPONSE
//
// `X-PAYMENT` is deliberately absent: that is the x402 **v1** name, and Stellar's facilitator
// serves v2 only (`/supported` advertises x402Version 2 alone). Our client sends
// PAYMENT-SIGNATURE. Listing a header nothing sends would be padding.
import type { RequestHandler } from "express";

/**
 * Exposing these is the part that is easy to miss and hard to debug. Without
 * Access-Control-Expose-Headers the browser hands JavaScript a response whose x402 headers are
 * simply absent — no error, no warning — and the challenge parse fails as though the gateway had
 * never sent them. It looks exactly like a server bug.
 */
const EXPOSED_RESPONSE_HEADERS = ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"];

/** Everything the client actually puts on a request. */
const ALLOWED_REQUEST_HEADERS = [
  "Authorization",
  "Content-Type",
  "Accept",
  "X-Agent-Budget",
  "PAYMENT-SIGNATURE",
];

const ALLOWED_METHODS = ["GET", "POST", "OPTIONS"];

/** Browsers cache the preflight for this long, so the OPTIONS round trip is paid once. */
const MAX_AGE_SECONDS = 86_400;

export const DEFAULT_ALLOWED_ORIGIN = "http://localhost:3000";

/**
 * Origins allowed to call the gateway, from ALLOWED_ORIGINS (comma-separated).
 *
 * Deploying is then an env change, not a code change. Trailing slashes are trimmed because an
 * Origin header never carries one and `http://x/` would silently match nothing.
 */
export function allowedOriginsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.ALLOWED_ORIGINS?.trim();
  if (!raw) return [DEFAULT_ALLOWED_ORIGIN];
  return raw
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export interface CorsOptions {
  allowedOrigins: string[];
}

/**
 * Reflects the request's Origin when it is on the list, and never otherwise.
 *
 * `Access-Control-Allow-Origin: *` is never sent. The seller routes are authenticated, and a
 * wildcard combined with credentials is both rejected by browsers and wrong in principle — it
 * would invite any page on the internet to spend a seller's session.
 */
export function createCors({ allowedOrigins }: CorsOptions): RequestHandler {
  const allowed = new Set(allowedOrigins);

  return (req, res, next) => {
    const origin = req.headers.origin;

    if (origin && allowed.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      // Caches must not serve one origin's response to another.
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Expose-Headers", EXPOSED_RESPONSE_HEADERS.join(", "));
    }

    if (req.method === "OPTIONS") {
      // A preflight from an origin we do not allow gets 204 with no CORS headers: the browser then
      // blocks the real request, which is the correct outcome and needs no error body.
      if (origin && allowed.has(origin)) {
        res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS.join(", "));
        res.setHeader("Access-Control-Allow-Headers", ALLOWED_REQUEST_HEADERS.join(", "));
        res.setHeader("Access-Control-Max-Age", String(MAX_AGE_SECONDS));
      }
      res.status(204).end();
      return;
    }

    next();
  };
}

export const CORS_EXPOSED_HEADERS = EXPOSED_RESPONSE_HEADERS;
export const CORS_ALLOWED_HEADERS = ALLOWED_REQUEST_HEADERS;
