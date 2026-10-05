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

import { SmardValidationError, cutForMessage } from "./errors.js";
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
 * string where the CLI parsed it into another type); it defaults to the value, and is
 * cut at MAX_MESSAGE_VALUE_LENGTH characters.
 */
export function assertArgument<T>(
  name: string,
  value: unknown,
  problem: Problem<unknown>,
  shown: string = String(value),
): T {
  const reason = problem(value);
  // The echoed value is cut: a 20 000-character argument must not fill a stderr line.
  if (reason !== undefined) throw new SmardValidationError(`Invalid ${name} "${cutForMessage(shown)}". ${reason}`);
  return value as T;
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
 * `SmardValidationError` (`Invalid filter "-1". Expected a non-negative integer.`).
 */
export function assertId(name: string, value: unknown): number {
  return assertArgument<number>(name, value, nonNegativeIntegerProblem);
}

/** Check a region and return it; throws `SmardValidationError` naming the valid regions. */
export function assertRegion(value: unknown): Region {
  return assertArgument<Region>("region", value, regionProblem);
}

/** Check a resolution and return it; throws `SmardValidationError` naming the valid resolutions. */
export function assertResolution(value: unknown): Resolution {
  return assertArgument<Resolution>("resolution", value, resolutionProblem);
}
