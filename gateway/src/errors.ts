// Every error leaves the gateway as { error, message } (CONVENTIONS.md §1.1). Route code throws
// HttpError (or lets validate() throw it); errorHandler is the only place a response is shaped.
import type { ErrorRequestHandler, RequestHandler } from "express";
import type { z } from "zod";
import type { ErrorCode, ErrorResponse } from "./types.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    /** Extra fields merged into the body, e.g. tx_hash on budget_exceeded. */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Parses `value` with `schema`, or throws 400 invalid_request naming every offending field. */
export function validate<T>(schema: z.ZodType<T>, value: unknown, where: "body" | "query" | "params" | "headers"): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((i) => `${[where, ...i.path.map(String)].join(".")}: ${i.message}`)
    .join("; ");
  throw new HttpError(400, "invalid_request", detail);
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new HttpError(404, "not_found", `No route for ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  let status: number;
  let body: ErrorResponse & Record<string, unknown>;

  if (err instanceof HttpError) {
    status = err.status;
    body = { ...err.extra, error: err.code, message: err.message };
  } else if (isClientHttpError(err)) {
    // Raised by express.json(): malformed JSON, body too large, wrong charset, ...
    status = err.status;
    body = { error: "invalid_request", message: err.message };
  } else {
    status = 500;
    body = { error: "internal_error", message: "Internal server error" };
    console.error(err);
  }

  if (res.headersSent) return;
  res.status(status).json(body);
};

function isClientHttpError(err: unknown): err is { status: number; message: string } {
  if (typeof err !== "object" || err === null) return false;
  const { status, expose } = err as { status?: unknown; expose?: unknown };
  return typeof status === "number" && status >= 400 && status < 500 && expose === true;
}
