// Shared HTTP for the SEP clients: one place that knows how an anchor reports an error, so every
// SEP module fails the same way and a failed withdrawal says something a human can act on.

/** An anchor responded, but not with success. Carries the status so SEP-10 re-auth can spot a 401. */
export class AnchorError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    message: string,
  ) {
    super(message);
    this.name = "AnchorError";
  }
}

/** Anchors are slow but not that slow; a hung request must not hold a withdrawal open for ever. */
const DEFAULT_TIMEOUT_MS = 20_000;

export interface AnchorRequest {
  method?: "GET" | "POST" | "PUT";
  /** SEP-10 JWT, for the endpoints that need one. */
  token?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  timeoutMs?: number;
}

export async function anchorFetch<T>(url: string, options: AnchorRequest = {}): Promise<T> {
  const { method = "GET", token, query, body, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const target = new URL(url);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) target.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(target, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : String(err);
    throw new AnchorError(0, target.toString(), `${method} ${target.pathname} failed: ${reason}`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new AnchorError(response.status, target.toString(), `${method} ${target.pathname} → ${response.status}: ${summarise(text)}`);
  }

  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AnchorError(response.status, target.toString(), `${method} ${target.pathname} returned ${response.status} but not JSON: ${summarise(text)}`);
  }
}

/**
 * Anchors return errors as `{ error: "..." }`, as plain text, or occasionally as an HTML page.
 * Pull out whatever is readable and keep it short — this string ends up in `withdrawals.error_message`
 * and in front of a seller.
 */
function summarise(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "(empty response)";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const message = parsed.error ?? parsed.message ?? parsed.detail;
    if (typeof message === "string" && message) return message.slice(0, 300);
  } catch {
    // not JSON; fall through to the raw text
  }
  return trimmed.replace(/\s+/g, " ").slice(0, 300);
}
