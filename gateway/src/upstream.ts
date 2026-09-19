// Credentials that sellers embed in an upstream URL: `user:pass@` userinfo, and the values of
// query parameters whose names look secret (api_key, token, sig, ...). One definition, used both
// to split them off at registration and to redact them for display.

/** Whole words that mark a query parameter as a credential. */
const SECRET_WORDS = new Set([
  "key", "apikey", "token", "accesstoken", "apitoken", "secret", "pass", "passwd", "password", "pwd",
  "auth", "authorization", "sig", "signature", "credential", "credentials", "session", "sessionid",
]);

/**
 * Whether a parameter name is a credential. Matches whole words only, after splitting on `_`, `-`,
 * `.` and camelCase: `api_key`, `X-Api-Key`, `accessToken`, `client_secret` and `sig` match;
 * `keyword`, `design` and `passengers` do not, so ordinary parameters are never stripped or redacted.
 */
export function isSecretParam(name: string): boolean {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => SECRET_WORDS.has(word));
}

export interface UpstreamCredentials {
  username?: string;
  password?: string;
  /** Secret-looking query parameters, name → every value it had, in order. */
  query?: Record<string, string[]>;
}

export interface SplitUpstreamUrl {
  /** The URL with every credential removed (secret query parameters dropped entirely). */
  publicUrl: string;
  /** What was removed, or null if the URL carried none. */
  credentials: UpstreamCredentials | null;
}

export function splitUpstreamCredentials(raw: string): SplitUpstreamUrl {
  const url = new URL(raw);
  const credentials: UpstreamCredentials = {};

  if (url.username) credentials.username = decodeURIComponent(url.username);
  if (url.password) credentials.password = decodeURIComponent(url.password);
  url.username = "";
  url.password = "";

  for (const name of [...new Set(url.searchParams.keys())]) {
    if (!isSecretParam(name)) continue;
    (credentials.query ??= {})[name] = url.searchParams.getAll(name);
    url.searchParams.delete(name);
  }

  return { publicUrl: url.toString(), credentials: Object.keys(credentials).length ? credentials : null };
}

export const UPSTREAM_TIMEOUT_MS = 10_000;
export const UPSTREAM_MAX_BYTES = 5 * 1024 * 1024;

export type UpstreamResult =
  | { ok: true; status: number; contentType: string | null; body: Buffer }
  | { ok: false; reason: string };

/**
 * The server-side request to the seller's API: the stored (credential-free) URL, the agent's query
 * string applied on top, then the seller's credentials re-attached last so an agent can never
 * override them. Nothing from the agent's request is forwarded except its query string and Accept —
 * least of all PAYMENT-SIGNATURE. Never throws: every failure is an `ok: false` with a reason.
 */
export async function callUpstream(input: {
  upstreamUrl: string;
  credentials: UpstreamCredentials | null;
  agentQuery: URLSearchParams;
  accept?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<UpstreamResult> {
  const url = new URL(input.upstreamUrl);
  for (const name of new Set(input.agentQuery.keys())) {
    url.searchParams.delete(name);
    for (const value of input.agentQuery.getAll(name)) url.searchParams.append(name, value);
  }

  const headers: Record<string, string> = { accept: input.accept ?? "*/*" };
  const creds = input.credentials;
  if (creds?.query) {
    for (const [name, values] of Object.entries(creds.query)) {
      url.searchParams.delete(name);
      for (const value of values) url.searchParams.append(name, value);
    }
  }
  // fetch refuses URLs with userinfo, so user:pass@ travels as HTTP Basic auth, which is what it meant.
  if (creds?.username !== undefined || creds?.password !== undefined) {
    headers.authorization = `Basic ${Buffer.from(`${creds.username ?? ""}:${creds.password ?? ""}`).toString("base64")}`;
  }

  let res: Response;
  try {
    res = await (input.fetch ?? fetch)(url, {
      method: "GET",
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(input.timeoutMs ?? UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : `network error: ${String(err)}` };
  }

  if (res.status < 200 || res.status > 299) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, reason: `upstream returned HTTP ${res.status}` };
  }

  try {
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > UPSTREAM_MAX_BYTES) return { ok: false, reason: `upstream response over ${UPSTREAM_MAX_BYTES} bytes` };
    return { ok: true, status: res.status, contentType: res.headers.get("content-type"), body };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : `reading upstream body failed: ${String(err)}` };
  }
}

/**
 * upstream_url as shown to the dashboard: userinfo removed and secret-looking query values replaced
 * with REDACTED, so a key embedded in the URL never reaches a browser.
 */
export function redactUpstreamUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "[invalid url]";
  }
  url.username = "";
  url.password = "";
  for (const name of [...new Set(url.searchParams.keys())]) {
    if (isSecretParam(name)) url.searchParams.set(name, "REDACTED");
  }
  return url.toString();
}
