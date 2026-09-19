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
