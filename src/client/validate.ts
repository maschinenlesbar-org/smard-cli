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
