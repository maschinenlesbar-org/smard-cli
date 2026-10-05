// The request engine: turns logical (method, path, query) calls into HTTP
// requests via a Transport, applies retry/backoff for transient statuses
// (429, 503), and decodes responses.

import { MAX_TIMEOUT_MS, nodeHttpTransport, type HttpResponse, type Transport } from "./http.js";
import { buildQueryString, type QueryParams } from "./query.js";
import {
  SmardApiError,
  SmardError,
  SmardNetworkError,
  SmardParseError,
  credentialsIn,
  redactCredentials,
} from "./errors.js";
import { assertHeaderValue, assertValid, intRangeProblem, nonNegativeIntegerProblem } from "./validate.js";

export const DEFAULT_BASE_URL = "https://www.smard.de";
const DEFAULT_USER_AGENT = "smard-cli";

export interface RawResponse {
  data: Buffer;
  contentType: string;
  status: number;
}

export interface EngineOptions {
  /**
   * Base URL of the API. Defaults to https://www.smard.de when left `undefined`;
   * a blank or whitespace-padded value is rejected.
   */
  baseUrl?: string;
  /** Swappable transport. Defaults to the built-in node http/https transport. */
  transport?: Transport;
  /** Value of the User-Agent header; `undefined` means "smard-cli", a blank value is rejected. */
  userAgent?: string;
  /**
   * Time limit per request in milliseconds, covering the whole response body, not
   * only idle gaps: an integer from 0 (no timeout) to MAX_TIMEOUT_MS (2^31 - 1 ms).
   * Defaults to 30 s.
   */
  timeoutMs?: number;
  /**
   * Number of automatic retries for transient (429/503) responses, an integer from
   * 0 to MAX_RETRIES (10); defaults to 2. Each waits the response's `Retry-After`
   * (up to `MAX_RETRY_AFTER_MS`; a longer one is not retried), or else
   * `retryDelayMs * attempt`.
   */
  maxRetries?: number;
  /**
   * Base backoff between retries in milliseconds (grows linearly; a non-negative
   * integer, default 200); used without a Retry-After.
   */
  retryDelayMs?: number;
  /**
   * Hard cap on response body size in bytes (defends against memory exhaustion
   * from a hostile/buggy endpoint), a non-negative integer. Defaults to 100 MiB;
   * set to 0 for no limit.
   */
  maxResponseBytes?: number;
  /** Injectable sleep, primarily for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

/**
 * Longest `Retry-After` the engine waits out before retrying a 429/503. When the
 * server asks for longer, the engine does not retry at all and surfaces the error at
 * once: retrying early would only land inside the window the server asked us to wait
 * out, and a hostile value must not stall the CLI.
 */
export const MAX_RETRY_AFTER_MS = 30_000;

/**
 * The most automatic retries a client may ask for (`maxRetries`). A larger value
 * kept polling a rate-limited SMARD; the engine rejects it with a
 * SmardValidationError, and the CLI's `--max-retries` uses the same bound.
 */
export const MAX_RETRIES = 10;

/** An IMF-fixdate (RFC 9110 §5.6.7), the one HTTP-date form senders must generate. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * Parse a `Retry-After` header into a delay in milliseconds (RFC 9110 §10.2.3):
 * either delay-seconds (`"120"`) or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`,
 * turned into the time left from `now`; a date in the past gives 0).
 *
 * Returns `undefined` when the header is absent or malformed — negative (`"-1"`),
 * fractional (`"1.5"`), padded inside, any other date format — so the caller falls
 * back to its own backoff. The strict patterns matter: `Date.parse` alone would
 * read `"1.5"` as a date in 2001 and retry at once.
 */
export function parseRetryAfter(
  header: string | string[] | undefined,
  now: number = Date.now(),
): number | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  if (!IMF_FIXDATE.test(value)) return undefined;
  const when = Date.parse(value);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/**
 * Strip control characters (all C0/C1 controls, plus DEL) out of a string that
 * originates in an attacker-controlled response body — the API error `detail`.
 * `JSON.parse` decodes an escaped ESC (a "backslash-u-001b" JSON sequence) in an
 * error body into a real ESC byte, so without this a hostile or MITM'd endpoint
 * could drive ANSI/OSC escape sequences (cursor moves, title changes, misleading
 * overwrites) into the user's terminal when the message is printed raw to stderr.
 * This only covers text that flows into an error message; the CLI's JSON output is
 * escaped separately (escapeControlChars in cli/shared.ts), since `JSON.stringify`
 * alone leaves DEL and the C1 range raw.
 */
function sanitizeServerText(text: string): string {
  let out = "";
  for (const ch of text) {
    const n = ch.codePointAt(0) ?? 0;
    if (n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/**
 * The rule for a configured base URL — every rule, so the CLI's `--base-url`
 * parser keeps none of its own. Checked on the value as passed, before the
 * trailing-slash strip, in this order:
 *
 * - it parses as an absolute URL (so a blank value or a stray `notaurl` is
 *   refused with a message about the base URL, not an opaque "Invalid URL" that
 *   names a request path);
 * - its scheme is `http:` or `https:` (the default transport gates this per hop,
 *   but a custom transport may not, so a `file:`/`ftp:` base URL never reaches one);
 * - it has no query or fragment (request paths are appended to it as a string, so
 *   `http://h/?x=1` would request `/?x=1/app/...` and `http://h/#f` would request `/`);
 * - it has no surrounding whitespace (`new URL()` trims silently, but the engine
 *   appends request paths to the raw string, so a trailing space would request
 *   `/%20/app/...` on the mirror).
 *
 * Userinfo (`https://user:pw@mirror`) is allowed and sent as Basic auth. No reason
 * echoes the value, so a credential in it never reaches an error message.
 */
export function baseUrlProblem(value: unknown): string | undefined {
  if (typeof value !== "string") return "Expected an absolute http(s) URL.";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "Expected an absolute http(s) URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported scheme "${url.protocol}". Expected an http(s) URL.`;
  }
  if (/[?#]/.test(value)) return "A base URL cannot have a query (?) or fragment (#).";
  if (value !== value.trim()) return "A base URL cannot have surrounding whitespace.";
  return undefined;
}

/**
 * Check a base URL against {@link baseUrlProblem} and return it without trailing
 * slashes; throws `SmardValidationError` (`Invalid baseUrl: <reason>`). This is a
 * configuration error, not a transport failure, so it is never a SmardNetworkError.
 */
export function validateBaseUrl(raw: string): string {
  return assertValid("baseUrl", raw, baseUrlProblem).replace(/\/+$/, "");
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class RequestEngine {
  // A real private field (not TypeScript's `private`): util.inspect, console.log and
  // JSON.stringify of a client never show it, so a password in the base URL can't be
  // logged by accident.
  readonly #baseUrl: string;
  /** The base URL's userinfo, raw and percent-decoded, for scrubbing server and transport text. */
  readonly #credentials: string[];
  private readonly transport: Transport;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly maxResponseBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: EngineOptions = {}) {
    // Only `undefined` selects the default. An explicit blank or padded value is
    // rejected (SmardValidationError), as the CLI rejects it, rather than silently
    // meaning production or a different path on the mirror.
    this.#baseUrl = options.baseUrl === undefined
      ? DEFAULT_BASE_URL
      : validateBaseUrl(options.baseUrl);
    this.#credentials = credentialsIn(this.#baseUrl).flatMap((raw) => {
      try {
        return [raw, decodeURIComponent(raw)];
      } catch {
        return [raw];
      }
    });
    this.transport = options.transport ?? nodeHttpTransport;
    // Only `undefined` selects the default User-Agent (some endpoints serve an HTML
    // challenge page, not JSON, without one). Any value passed must be a valid,
    // non-blank header value (no CR/LF or other controls, nothing above U+00FF),
    // whatever the transport.
    this.userAgent = options.userAgent === undefined
      ? DEFAULT_USER_AGENT
      : assertHeaderValue("userAgent", options.userAgent);
    // The numeric options are range-checked here, not only by the CLI's parsers: a
    // negative, NaN or fractional value would otherwise silently switch off the
    // timeout or the size cap downstream, and Infinity would retry without bound.
    this.timeoutMs = options.timeoutMs === undefined
      ? 30_000
      : assertValid("timeoutMs", options.timeoutMs, intRangeProblem(0, MAX_TIMEOUT_MS));
    this.maxRetries = options.maxRetries === undefined
      ? 2
      : assertValid("maxRetries", options.maxRetries, intRangeProblem(0, MAX_RETRIES));
    this.retryDelayMs = options.retryDelayMs === undefined
      ? 200
      : assertValid("retryDelayMs", options.retryDelayMs, nonNegativeIntegerProblem);
    this.maxResponseBytes = options.maxResponseBytes === undefined
      ? DEFAULT_MAX_RESPONSE_BYTES
      : assertValid("maxResponseBytes", options.maxResponseBytes, nonNegativeIntegerProblem);
    this.sleep = options.sleep ?? realSleep;
  }

  /**
   * `text` without the base URL's credentials: server text (an error body that echoes the
   * request URL) and transport text (fetch's "Failed to fetch <url>") can carry them.
   */
  private scrub(text: string): string {
    return this.#credentials.length === 0 ? text : redactCredentials(text, this.#credentials);
  }

  /**
   * A transport failure as the `cause` of the error the engine raises: the original when its
   * text carries no credentials, otherwise a copy with them scrubbed (message, `code` and the
   * cause chain kept), so logging the error with its causes can't reveal the base URL's
   * password.
   */
  private scrubCause(cause: unknown, depth = 0): unknown {
    if (this.#credentials.length === 0 || depth > 5) return cause;
    if (typeof cause === "string") return this.scrub(cause);
    if (!(cause instanceof Error)) return cause;
    const inner = this.scrubCause(cause.cause, depth + 1);
    const message = this.scrub(cause.message);
    if (message === cause.message && inner === cause.cause && !this.scrub(cause.stack ?? "").includes("***@")) return cause;
    const copy = new Error(message, inner === undefined ? undefined : { cause: inner });
    copy.name = cause.name;
    const code = (cause as { code?: unknown }).code;
    if (code !== undefined) Object.assign(copy, { code });
    return copy;
  }

  /**
   * What the transport threw, as the error the engine raises. The default transport
   * rejects with `SmardNetworkError` only; an injected one may throw anything (a string, a
   * `TypeError` from fetch). Every failure becomes a `SmardNetworkError` — a `SmardError` a
   * caller and the CLI can rely on — with the base URL's credentials scrubbed from its
   * message and cause chain; any other `SmardError` passes through, and a clean
   * `SmardNetworkError` stays as it is.
   */
  private transportError(cause: unknown): SmardError {
    if (cause instanceof SmardError && !(cause instanceof SmardNetworkError)) return cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    const message = sanitizeServerText(this.scrub(reason));
    const scrubbed = this.scrubCause(cause);
    if (cause instanceof SmardNetworkError && message === cause.message && scrubbed === cause) return cause;
    return new SmardNetworkError(message, { cause: scrubbed });
  }

  /**
   * Build a fully-qualified URL from a path and optional query parameters.
   *
   * Throws a SmardError for a path with a "." or ".." segment. The client puts its
   * arguments into the path with `encodeURIComponent`, which leaves those two
   * unchanged, and URL parsing then resolves them (a region of ".." would request
   * `/app/chart_data/410/index_hour.json`). Neither can name a filter, region or
   * window. (Percent-encoded forms such as "%2e%2e" are safe: encodeURIComponent
   * turns their "%" into "%25".)
   */
  buildUrl(path: string, query?: QueryParams): string {
    // The base URL was validated (validateBaseUrl) in the constructor.
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const dotSegment = normalizedPath.split("/").find((s) => s === "." || s === "..");
    if (dotSegment !== undefined) {
      throw new SmardError(
        `Invalid path segment "${dotSegment}" in ${normalizedPath}: "." and ".." cannot be used as an id.`,
      );
    }
    const qs = query ? buildQueryString(query) : "";
    return `${this.#baseUrl}${normalizedPath}${qs ? `?${qs}` : ""}`;
  }

  /** Perform a request with Accept negotiation and transient-error retries. */
  async request(
    method: string,
    path: string,
    options: { query?: QueryParams; accept: string } = { accept: "application/json" },
  ): Promise<RawResponse> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": this.userAgent,
    };

    let attempt = 0;
    // attempts = initial try + maxRetries
    for (;;) {
      let response: HttpResponse;
      try {
        response = await this.transport({
          method,
          url,
          headers,
          timeoutMs: this.timeoutMs,
          ...(this.maxResponseBytes > 0 ? { maxResponseBytes: this.maxResponseBytes } : {}),
        });
      } catch (cause) {
        throw this.transportError(cause);
      }

      const status = response.status;
      const retryable = status === 429 || status === 503;
      if (retryable && attempt < this.maxRetries) {
        // Honour Retry-After; without a usable one, back off linearly. A Retry-After
        // beyond MAX_RETRY_AFTER_MS is not retried: the error below surfaces at once.
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);
        if (retryAfter === undefined || retryAfter <= MAX_RETRY_AFTER_MS) {
          attempt += 1;
          await this.sleep(retryAfter ?? this.retryDelayMs * attempt);
          continue;
        }
      }

      const contentType = String(response.headers["content-type"] ?? "");
      if (status < 200 || status >= 300) {
        throw this.toApiError(method, url, status, response.body);
      }

      return { data: response.body, contentType, status };
    }
  }

  /** Perform a GET expecting JSON and parse it into `T`. */
  async getJson<T>(path: string, query?: QueryParams): Promise<T> {
    const res = await this.request("GET", path, { query, accept: "application/json" });
    const text = res.data.toString("utf8");
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new SmardParseError(`Failed to parse JSON response from ${path}`, { cause: this.scrubCause(cause) });
    }
  }

  private toApiError(method: string, url: string, status: number, body: Buffer): SmardApiError {
    // The body is kept on the error (`body`) and may echo the request URL: scrub it.
    const text = this.scrub(body.toString("utf8"));
    let detail: string | undefined;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; message?: unknown };
      if (parsed && typeof parsed.detail === "string") detail = parsed.detail;
      else if (parsed && typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Non-JSON error body; leave detail undefined.
    }
    // `detail` came from the response body; strip control characters so a hostile
    // endpoint cannot inject terminal escape sequences via the stderr error
    // message that run.ts prints raw.
    if (detail !== undefined) detail = sanitizeServerText(detail);
    return new SmardApiError({ status, url, method, body: text, detail });
  }
}
