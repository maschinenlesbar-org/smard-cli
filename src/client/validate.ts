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

import { SmardValidationError } from "./errors.js";
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
 * string where the CLI parsed it into another type); it defaults to the value.
 */
export function assertArgument<T>(
  name: string,
  value: unknown,
  problem: Problem<unknown>,
  shown: string = String(value),
): T {
  const reason = problem(value);
  if (reason !== undefined) throw new SmardValidationError(`Invalid ${name} "${shown}". ${reason}`);
  return value as T;
}

/** A rule that accepts only an integer from `min` to `max` (inclusive). */
export function intRangeProblem(min: number, max: number): Problem<unknown> {
  return (value) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
      ? undefined
      : `Expected an integer from ${min} to ${max}.`;
}

// ---- The chart-data path arguments --------------------------------------------

/**
 * The rule for a filter id or a window timestamp: a non-negative safe integer.
 * Anything else — a string, `-1`, `1.5`, `NaN`, `Infinity`, an integer beyond
 * `Number.MAX_SAFE_INTEGER` (which would be rounded to another file) — would put
 * a malformed or different path into the request.
 */
export const nonNegativeIntegerProblem: Problem<unknown> = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? undefined
    : "Expected a non-negative integer.";

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
