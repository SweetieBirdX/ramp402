// Builds the Express app without listening, so tests can mount it without opening a port.
// Routes are exactly those in docs/CONVENTIONS.md §1.3; the unimplemented ones are validated stubs.
import dotenv from "dotenv";
import express, { type RequestHandler } from "express";
import { createBootstrapHandler, type BootstrapDeps } from "./bootstrap.js";
import { allowedOriginsFromEnv, createCors } from "./cors.js";
import { createEndpointRoutes, type EndpointRouteDeps } from "./endpointRoutes.js";
import { errorHandler, HttpError, notFoundHandler, validate } from "./errors.js";
import { createProxyHandler, type ProxyDeps } from "./proxyRoute.js";
import { createReadRoutes, requireSeller, type ReadRouteDeps } from "./readRoutes.js";
import * as schemas from "./schemas.js";
import type { HealthResponse } from "./types.js";
import { createWithdrawRoutes, type WithdrawRouteDeps } from "./withdrawRoutes.js";

dotenv.config({ quiet: true });

/** Everything the routes talk to. index.ts wires the real ones; tests pass fakes. */
export interface AppDeps
  extends BootstrapDeps,
    ReadRouteDeps,
    EndpointRouteDeps,
    ProxyDeps,
    WithdrawRouteDeps {
  /** Seller auth (createAuthMiddleware): 401 or sets req.privyUserId / req.seller. */
  authenticate: RequestHandler;
  /** Browser origins allowed to call the gateway. Defaults to ALLOWED_ORIGINS from the env. */
  allowedOrigins?: string[];
}

export interface AppOptions {
  /** Log one line per request. Defaults to on; tests turn it off. */
  log?: boolean;
}

/** Method, path, status and duration only: never headers (Authorization) or bodies (signed XDR). */
const requestLogger: RequestHandler = (req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(1)}ms`);
  });
  next();
};

// The `notImplemented` helper lived here while §1.3's withdrawal routes were stubs. Every route in
// §1.3 is implemented now, so nothing emits 501 and the helper is gone. `not_implemented` stays in
// the ErrorCode union for the next stub that needs it.

export function createApp(deps: AppDeps, options: AppOptions = {}): express.Express {
  const app = express();
  app.disable("x-powered-by");

  if (options.log ?? true) app.use(requestLogger);

  // Before the body parser and before every route, so OPTIONS preflights are answered without
  // touching auth or JSON parsing. The browser sends those unauthenticated by design.
  app.use(createCors({ allowedOrigins: deps.allowedOrigins ?? allowedOriginsFromEnv() }));

  app.use(express.json());

  app.get("/health", (_req, res) => {
    const body: HealthResponse = { ok: true };
    res.json(body);
  });

  // --- Seller onboarding -------------------------------------------------------------------
  app.post("/api/sellers/bootstrap", deps.authenticate, createBootstrapHandler(deps));

  // --- Endpoint registration (two-step) -----------------------------------------------------
  const endpoints = createEndpointRoutes(deps);
  app.post("/api/endpoints/prepare", deps.authenticate, requireSeller, endpoints.prepare);
  app.post("/api/endpoints/submit", deps.authenticate, requireSeller, endpoints.submit);

  // --- Withdrawal (two-step, then poll) -----------------------------------------------------
  // /submit answers as soon as the chain entry is made; the SEP-10/38/12/6 flow and the payment
  // run in the background, which is what GET /api/withdrawals/:id is for.
  const withdraw = createWithdrawRoutes(deps);
  app.post("/api/withdraw/prepare", deps.authenticate, requireSeller, withdraw.prepare);
  app.post("/api/withdraw/submit", deps.authenticate, requireSeller, withdraw.submit);
  app.get("/api/withdrawals/:id", deps.authenticate, requireSeller, withdraw.get);

  // --- Read endpoints -----------------------------------------------------------------------
  const read = createReadRoutes(deps);
  app.get("/api/endpoints", deps.authenticate, requireSeller, read.listEndpoints);
  app.get("/api/balance", deps.authenticate, requireSeller, read.getBalance);
  app.get("/api/calls", deps.authenticate, requireSeller, read.listCalls);

  // --- Agent side (x402) --------------------------------------------------------------------
  app.get("/proxy/:proxy_slug", createProxyHandler(deps));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
