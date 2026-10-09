// Error types raised by the client. Kept free of any I/O so they are trivial to
// construct in tests and to `instanceof`-check by consumers.

/**
 * Replace the userinfo of a URL (`https://user:secret@host/...`) with `***`, so a
 * credential in a base URL never reaches an error message, a log or CI output.
 * A value that does not parse is redacted by text (`credentialsIn`); a URL without
 * userinfo is returned unchanged.
 */
export function redactUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A value that doesn't parse (a port typo, an unencoded "#" in the password) can still
    // carry credentials: cut them out by text.
    return redactCredentials(url, credentialsIn(url));
  }
  // `user:pw@host` without a scheme parses as a URL with the scheme "user:": no userinfo.
  if (parsed.username === "" && parsed.password === "") return redactCredentials(url, credentialsIn(url));
  parsed.username = "***";
  parsed.password = "";
  return parsed.href;
}

/**
 * The userinfo a URL-like value carries, exactly as written — `["alice:pa#ss"]` for
 * `https://alice:pa#ss@host` — or `[]` when it carries none. It works on values that don't
 * parse as a URL too, and on values with a prefix (`--base-url=https://u:p@h`): the userinfo
 * is everything between `://` and the last `@` before the host. A value without a scheme
 * counts when it reads `user:password@host`. Used to redact those exact strings from text
 * that echoes the value (usage errors, help), whatever characters the password contains.
 */
export function credentialsIn(value: string): string[] {
  const schemeAt = value.indexOf("://");
  const rest = schemeAt >= 0 ? value.slice(schemeAt + 3) : value;
  // Without a scheme only the unmistakable `user:password@host` form counts.
  if (schemeAt < 0 && !/^[^\s/@:]+:[^@]*@[^@\s/]/.test(rest)) return [];
  // The URL itself starts at its scheme (`--base-url=https://…` has a prefix).
  const scheme = schemeAt >= 0 ? /[a-z][a-z0-9+.-]*$/i.exec(value.slice(0, schemeAt)) : null;
  let parses = false;
  try {
    new URL(schemeAt >= 0 ? value.slice(scheme?.index ?? schemeAt) : `http://${rest}`);
    parses = true;
  } catch {
    // Doesn't parse: the password may hold "/", "?", "#" or spaces.
  }
  // In a URL that parses, the userinfo ends at the last "@" of the authority (before the
  // first "/", "?" or "#"); in one that doesn't, at the last "@" of the value.
  const authority = parses ? rest.slice(0, rest.search(/[/?#]|$/)) : rest;
  const end = authority.lastIndexOf("@");
  return end > 0 ? [rest.slice(0, end)] : [];
}

/**
 * `text` with every occurrence of each credential (as `credentialsIn` returns them) that is
 * followed by `@` replaced by `***`. Matching the exact strings, not a pattern, covers
 * passwords with spaces, quotes, `#`, `?` or `/` that no URL pattern can delimit. The CLI also
 * passes the JSON-escaped form of each credential.
 */
export function redactCredentials(text: string, credentials: readonly string[]): string {
  let out = text;
  for (const secret of credentials) {
    if (secret === "") continue;
    out = out.split(`${secret}@`).join("***@");
  }
  return out;
}

/**
 * Longest echoed value or server text (in characters) an error message shows. A
 * 20 000-character argument would otherwise put the whole input on one stderr line, and
 * a server `detail` could flood a CI log. Properties such as `SmardApiError.body` keep the
 * full value.
 */
export const MAX_MESSAGE_VALUE_LENGTH = 500;

/**
 * `text` cut to at most `max` UTF-16 units, never inside a surrogate pair: when the cut
 * would land after a high surrogate it is made one unit earlier, so a message that holds
 * the cut text is well-formed (a lone `\ud83d` makes jq reject a whole JSON stream).
 * Text no longer than `max` is returned as it is; the caller marks a cut.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = max > 0 && isHighSurrogate(text.charCodeAt(max - 1)) ? max - 1 : max;
  return text.slice(0, end);
}

function isHighSurrogate(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

/**
 * `text` with every lone surrogate (half of a character) replaced by U+FFFD, like
 * `String.prototype.toWellFormed` (ES2024, so not in this package's `lib`).
 */
export function toWellFormed(text: string): string {
  return text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd");
}

/**
 * `text` cut to MAX_MESSAGE_VALUE_LENGTH characters (never inside a surrogate pair,
 * `cutText`), ending in "…" when cut.
 */
export function cutForMessage(text: string): string {
  return text.length > MAX_MESSAGE_VALUE_LENGTH ? `${cutText(text, MAX_MESSAGE_VALUE_LENGTH)}…` : text;
}

/** Base class for every error originating from this client. */
export class SmardError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The API responded with a non-2xx status code. `detail` holds a human-readable
 * message extracted from the response body when one is present.
 */
export class SmardApiError extends SmardError {
  readonly status: number;
  readonly detail: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly body: string;
  /** How many times the engine retried the request before giving up (0 when it did not). */
  readonly retries: number;
  /**
   * The wait the server asked for in `Retry-After` (milliseconds) when it was longer than
   * the engine waits (`MAX_RETRY_AFTER_MS`), so the request was not retried; else undefined.
   */
  readonly retryAfterMs: number | undefined;

  constructor(args: {
    status: number;
    url: string;
    method: string;
    body: string;
    detail?: string;
    retries?: number;
    retryAfterMs?: number;
    maxRetryAfterMs?: number;
  }) {
    // The URL is shown without userinfo: a credential in --base-url must not leak.
    const url = redactUrl(args.url);
    const parts: string[] = [];
    if (args.detail) parts.push(args.detail);
    if (args.retryAfterMs !== undefined) {
      // Say why the retries the caller asked for never ran: the server asked for a wait
      // longer than the engine sleeps, and retrying earlier would land inside that window.
      const wait = Math.ceil(args.retryAfterMs / 1000);
      const cap = args.maxRetryAfterMs === undefined ? "" : `, longer than the ${args.maxRetryAfterMs / 1000} s the client waits`;
      parts.push(`the server asked to retry after ${wait} s${cap}; not retried — try again after that`);
    }
    const detailPart = parts.length > 0 ? `: ${parts.join("; ")}` : "";
    const retries = args.retries ?? 0;
    // Say that the status persisted through retries, so a user knows whether raising
    // --max-retries could help.
    const retryPart = retries > 0 ? ` (after ${retries} ${retries === 1 ? "retry" : "retries"})` : "";
    super(`HTTP ${args.status} for ${args.method} ${cutForMessage(url)}${detailPart}${retryPart}`);
    this.status = args.status;
    this.url = url;
    this.method = args.method;
    this.body = args.body;
    this.detail = args.detail;
    this.retries = retries;
    this.retryAfterMs = args.retryAfterMs;
  }

  /** True for statuses the API documents as transient and retry-able. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503;
  }
}

/** A transport-level failure (DNS, connection reset, timeout, ...). */
export class SmardNetworkError extends SmardError {}

/**
 * The response body exceeded the configured `maxResponseBytes` cap and the
 * request was aborted. A subclass of `SmardNetworkError` so it still collapses to
 * the documented exit code 1, but a distinct type so library callers can tell a
 * size-cap breach apart from a genuine connection failure.
 */
export class SmardResponseTooLargeError extends SmardNetworkError {}

/** The response body could not be parsed as the expected JSON shape. */
export class SmardParseError extends SmardError {}

/**
 * A rejected input — a client option or a method argument that breaks one of the
 * library's rules (see validate.ts). Thrown before any request is made; the CLI
 * maps it to its usage exit code (1), like every other SmardError.
 */
export class SmardValidationError extends SmardError {}
