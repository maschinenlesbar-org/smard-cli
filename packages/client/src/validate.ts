// Input validation shared by the library and the CLI. Every rule about what a
// request may contain lives here (or next to the option it guards) as a pure,
// exported function, so the CLI calls the very same rule instead of keeping a copy.
//
// - A `Problem` returns the reason a value is invalid ("Expected a non-empty
//   value."), or `undefined` when it is valid. The CLI's commander parsers turn
//   that reason into an `InvalidArgumentError` (a usage error, exit 1).
// - `assertValid` runs a `Problem` in the library and throws a
//   `SmardValidationError` ("Invalid <name>: <reason>") before any request is
//   made. Methods that return a promise call it inside the async body, so they
//   reject rather than throw synchronously; constructors throw.

import { SmardValidationError, quoteValue } from "./errors.js";
import { RegionValues, ResolutionValues, type Region, type Resolution } from "./enums.js";

/** A validation rule: the reason `value` is invalid, or `undefined` when it is valid. */
export type Problem<T = unknown> = (value: T) => string | undefined;

/**
 * Check `value` against `problem` and return it unchanged when it is valid.
 * Otherwise throw a {@link SmardValidationError} with the message
 * `Invalid <name>: <reason>`.
 */
export function assertValid<T>(name: string, value: T, problem: Problem<T>): T {
  const reason = problem(value);
  if (reason !== undefined) throw new SmardValidationError(`Invalid ${name}: ${reason}`);
  return value;
}

/**
 * A rule that accepts only one of `allowed` (compared with `includes`, never a
 * keyed lookup, so inherited names such as "constructor" are not members).
 */
export function oneOfProblem(allowed: readonly string[]): Problem<unknown> {
  return (value) =>
    typeof value === "string" && allowed.includes(value)
      ? undefined
      : `Expected one of: ${allowed.join(", ")}.`;
}

/**
 * Like {@link assertValid}, but with the message the CLI has always printed for
 * a rejected argument value, which echoes the value:
 * `Invalid <name> "<value>". <reason>`. `shown` is what to echo (the raw argv
 * string where the CLI parsed it into another type); it defaults to the value. It is
 * quoted visibly (`quoteValue`: an invisible or control character is shown escaped,
 * `\u200b`) and cut at MAX_MESSAGE_VALUE_LENGTH characters, the "…" after the quote.
 */
export function assertArgument<T>(
  name: string,
  value: unknown,
  problem: Problem<unknown>,
  shown: string = String(value),
): T {
  const reason = problem(value);
  // The echoed value is cut: a 20 000-character argument must not fill a stderr line.
  if (reason !== undefined) throw new SmardValidationError(`Invalid ${name} ${quoteValue(shown)}. ${reason}`);
  return value as T;
}

// ---- Tokens, text and lists (the kit's request-value rules, D8) ---------------------

/** Characters that never make a value non-blank: whitespace, controls, format characters, combining marks. */
const INVISIBLE = /[\s\p{Cc}\p{Cf}\p{M}]/gu;

/** A lone surrogate: half of a character, which URL encoding would send as U+FFFD (or throw on). */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * True when nothing in `value` would match anything: it holds only whitespace, control and
 * format characters (a zero-width space, a soft hyphen) and combining marks. Such a value reads
 * as "no filter" upstream, or matches nothing, so it is refused as blank.
 */
function isBlank(value: string): boolean {
  return value.replace(INVISIBLE, "") === "";
}

/** `U+200B` for the first character of `text` that `pattern` matches. */
function codePointOf(text: string, pattern: RegExp): string {
  const ch = pattern.exec(text)?.[0] ?? "";
  return `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
}

/** A control character inside a text filter: C0 and C1, but not TAB, LF or CR (whitespace in a pasted phrase). */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

/** A format character inside a text filter, but not ZWNJ/ZWJ (U+200C/U+200D), which some scripts and emoji need. */
const TEXT_FORMAT = /(?![\u200c\u200d])\p{Cf}/u;

/**
 * Why `value` cannot be sent as a text filter, or undefined when it can (the kit's rule; SMARD
 * takes no free text, so no method uses it). Refused: a value that is blank once trimmed or
 * holds only invisible characters and combining marks; a lone surrogate; a control character
 * (but TAB, LF and CR) or a format character (but ZWNJ and ZWJ). The reason quotes the value
 * visibly (`quoteValue`).
 */
export function textProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  if (LONE_SURROGATE.test(value)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TEXT_CONTROL.test(value)) return `${quoteValue(value)} contains a control character (${codePointOf(value, TEXT_CONTROL)}).`;
  if (TEXT_FORMAT.test(value)) return `${quoteValue(value)} contains an invisible character (${codePointOf(value, TEXT_FORMAT)}).`;
  return undefined;
}

/** A text filter as an API matches it: without surrounding whitespace and in composed Unicode (NFC). */
export function normalizeText(value: string): string {
  return value.trim().normalize("NFC");
}

/** A control or format character in a token (after trimming): every Cc and every Cf. */
const TOKEN_INVISIBLE = /[\p{Cc}\p{Cf}]/u;

/**
 * Why `value` cannot be sent as a token, or undefined when it can. A token is an id, a code or an
 * enum value: a value the API compares exactly (SMARD's region, resolution, filter group, and the
 * digits of a filter id or a timestamp). The rules apply to the value with surrounding whitespace
 * trimmed, as it is sent ({@link normalizeToken}): not blank (and not only invisible characters or
 * combining marks), no lone surrogate, and no control or format character at all (a zero-width
 * space, ZWJ, a soft hyphen, a bidi control), since an invisible character in a code only ever
 * makes it match nothing. The reason quotes the value visibly.
 */
export function tokenProblem(value: string): string | undefined {
  if (typeof value !== "string") return "Expected a string.";
  if (isBlank(value)) return "Expected a non-empty value.";
  const token = value.trim();
  if (LONE_SURROGATE.test(token)) return `${quoteValue(value)} contains half of a character (a lone surrogate).`;
  if (TOKEN_INVISIBLE.test(token)) {
    return `${quoteValue(value)} contains an invisible or control character (${codePointOf(token, TOKEN_INVISIBLE)}).`;
  }
  return undefined;
}

/** A token as it is sent: trimmed and in composed Unicode (NFC). Check it with {@link tokenProblem} first. */
export function normalizeToken(value: string): string {
  return value.trim().normalize("NFC");
}

/**
 * The items of a comma-separated list option, as typed: each item is checked (`listProblem`)
 * and canonicalised (`normalizeToken`) on its own (the kit's rule; SMARD takes no list).
 */
export function splitList(value: string): string[] {
  return value.split(",");
}

/**
 * Why `items` cannot be sent as a list, or undefined when it can: not an array of strings, no
 * item at all, or an item that `itemProblem` refuses (by default {@link tokenProblem}: a blank
 * item is refused, never dropped). The reason names the item.
 */
export function listProblem(items: readonly string[], itemProblem: Problem<string> = tokenProblem): string | undefined {
  if (!Array.isArray(items)) return "Expected a list of strings.";
  if (items.length === 0) return "Expected at least one value.";
  for (let i = 0; i < items.length; i++) {
    const problem = itemProblem(items[i] as string);
    if (problem !== undefined) return items.length === 1 ? problem : `item ${i + 1} of ${items.length}: ${problem}`;
  }
  return undefined;
}

/**
 * A string `value` checked as a token ({@link tokenProblem}, a `SmardValidationError`
 * `Invalid <name>: <reason>`) and returned canonical ({@link normalizeToken}); any other value is
 * returned as it is, for the caller's own rule to refuse with its own reason.
 */
export function canonicalToken(name: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  return normalizeToken(assertValid(name, value, tokenProblem));
}

/** A rule that accepts only an integer from `min` to `max` (inclusive). */
export function intRangeProblem(min: number, max: number): Problem<unknown> {
  return (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
      ? undefined
      : `Expected an integer from ${min} to ${max}.`;
}

// ---- Header values ---------------------------------------------------------------

/**
 * The rule for a value that goes into an HTTP header (the User-Agent): not blank,
 * no C0 control character other than tab (so no CR/LF header injection), no DEL,
 * and nothing above U+00FF. Node's HTTP layer would otherwise throw an opaque
 * "Invalid character in header content" at request time, and a custom transport
 * would receive the raw value. Checked by char code so the source stays free of
 * control bytes.
 */
export const headerValueProblem: Problem<unknown> = (value) => {
  if (typeof value !== "string" || value.trim() === "") return "Expected a non-empty value.";
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return "Value contains control characters.";
    if (c > 0xff) return "Value contains characters outside Latin-1 (above U+00FF).";
  }
  return undefined;
};

/**
 * Check a header value and return it; throws `SmardValidationError`
 * (`Invalid <name>: <reason>`).
 */
export function assertHeaderValue(name: string, value: unknown): string {
  return assertValid(name, value, headerValueProblem) as string;
}

// ---- The chart-data path arguments --------------------------------------------

/**
 * The rule for a filter id or a window timestamp: a non-negative safe integer.
 * Anything else — a string, `-1`, `1.5`, `NaN`, `Infinity`, an integer beyond
 * `Number.MAX_SAFE_INTEGER` (which would be rounded to another file) — would put
 * a malformed or different path into the request. A string or a bigint gets its own
 * reason: `Invalid filter "4169". Expected a non-negative integer.` read as a
 * contradiction to a caller who took the id from argv, an env var or a JSON config.
 */
export const nonNegativeIntegerProblem: Problem<unknown> = (value) => {
  if (typeof value === "string" || typeof value === "bigint") {
    return `Expected a non-negative integer as a number, not a ${typeof value} (convert it with Number()).`;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? undefined
    : "Expected a non-negative integer.";
};

/** The rule for a region: one of `RegionValues` (case-sensitive, no padding). */
export const regionProblem = oneOfProblem(RegionValues);

/** The rule for a resolution: one of `ResolutionValues` (case-sensitive, no padding). */
export const resolutionProblem = oneOfProblem(ResolutionValues);

/**
 * Check a filter id or timestamp (`name` says which) and return it; throws
 * `SmardValidationError` (`Invalid filter "-1". Expected a non-negative integer.`). A string
 * (a caller without types) is refused either way, an invisible or control character in it
 * named first (`tokenProblem`).
 */
export function assertId(name: string, value: unknown): number {
  if (typeof value === "string") assertValid(name, value, tokenProblem);
  return assertArgument<number>(name, value, nonNegativeIntegerProblem);
}

/**
 * Check a region and return it as it is sent: a token (`canonicalToken`: trimmed and NFC, an
 * invisible or control character refused), then one of `RegionValues`, case kept; throws
 * `SmardValidationError` naming the valid regions.
 */
export function assertRegion(value: unknown): Region {
  return assertArgument<Region>("region", canonicalToken("region", value), regionProblem, String(value));
}

/** Check a resolution and return it as it is sent, like {@link assertRegion}; throws naming the valid resolutions. */
export function assertResolution(value: unknown): Resolution {
  return assertArgument<Resolution>("resolution", canonicalToken("resolution", value), resolutionProblem, String(value));
}
