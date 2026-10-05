// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON result renderer.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { assertArgument, headerValueProblem, nonNegativeIntegerProblem } from "../client/validate.js";
import { baseUrlProblem, type EngineOptions } from "../client/engine.js";

/**
 * Parse a plain non-negative decimal integer string. Validates the *raw string*
 * (only ASCII digits) rather than coercing with Number(), which would otherwise
 * accept "" (→0), surrounding whitespace, hex ("0x10"), decimals ("1.0") and
 * exponent notation ("1e21" → 1e+21). The exponent case is especially harmful
 * because it string-interpolates into the request URL as literal "1e+21".
 *
 * Returns null when the value is not a valid non-negative integer, or is too
 * large to represent exactly (SMARD epoch-millis timestamps are ~13 digits,
 * comfortably inside Number.MAX_SAFE_INTEGER).
 */
function parseNonNegativeInt(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

/**
 * Wrap a value-parser so its option may be given only once: commander keeps the last of a
 * repeated option and drops the others without a word (`--timeout 5000 --timeout 0` ran
 * without a timeout). A repeat is a usage error naming the flag. A fresh program is built
 * per `run()`, so the state lives as long as one parse.
 */
export function once<T>(flag: string, parse: (value: string) => T): (value: string) => T {
  let seen = false;
  return (value: string) => {
    if (seen) throw new InvalidArgumentError(`${flag} was given more than once; give it once.`);
    seen = true;
    return parse(value);
  };
}

/** commander value-parser: a non-negative integer. */
export function parseIntArg(value: string): number {
  const n = parseNonNegativeInt(value);
  if (n === null) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/** Build a commander value-parser for a non-negative integer constrained to [min, max]. */
export function parseBoundedInt(min: number, max: number): (value: string) => number {
  return (value: string) => {
    const n = parseIntArg(value);
    if (n < min) throw new InvalidArgumentError(`Must be >= ${min}.`);
    if (n > max) throw new InvalidArgumentError(`Must be <= ${max}.`);
    return n;
  };
}

/** commander value-parser: a non-empty (after trimming) string. */
export function parseNonEmpty(value: string): string {
  if (value.trim() === "") {
    throw new InvalidArgumentError("Expected a non-empty value.");
  }
  return value;
}

/**
 * commander value-parser for a value that ends up in an HTTP header (`--user-agent`).
 * The rule is the library's `headerValueProblem` (blank, control characters, code
 * points above U+00FF), which the engine enforces too; its reason becomes a usage
 * error here.
 */
export function parseHeaderValue(value: string): string {
  const reason = headerValueProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * commander value-parser for `--base-url`. The rules (absolute http(s) URL, no
 * query or fragment, no surrounding whitespace) are the library's
 * `baseUrlProblem`, which the engine enforces too; its reason becomes a usage
 * error here, at parse time, before any client is built.
 */
export function parseBaseUrl(value: string): string {
  const reason = baseUrlProblem(value);
  if (reason !== undefined) throw new InvalidArgumentError(reason);
  return value;
}

/**
 * Parse a positional argument (a filter id or a timestamp) into a number
 * (commander does not run value-parsers on positional args). Turning the argv
 * string into a number is the CLI's job — only plain ASCII digits count, so "",
 * " 5", "0x10", "1.0" and "1e21" are not numbers here — but the rule the number
 * must meet is the library's (`nonNegativeIntegerProblem`), and so is the error:
 * a SmardValidationError echoing the raw value, which run() prints and exits 1 on.
 */
export function requireInt(value: string, argName: string): number {
  const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return assertArgument<number>(argName, n, nonNegativeIntegerProblem, value);
}

export interface GlobalOptions {
  baseUrl?: string;
  timeout?: number;
  userAgent?: string;
  maxRetries?: number;
  maxResponseBytes?: number;
  compact?: boolean;
}

/** Translate resolved global CLI options into client EngineOptions. */
export function toEngineOptions(global: GlobalOptions): EngineOptions {
  const options: EngineOptions = {};
  if (global.baseUrl !== undefined) options.baseUrl = global.baseUrl;
  if (global.timeout !== undefined) options.timeoutMs = global.timeout;
  if (global.userAgent !== undefined) options.userAgent = global.userAgent;
  if (global.maxRetries !== undefined) options.maxRetries = global.maxRetries;
  if (global.maxResponseBytes !== undefined) options.maxResponseBytes = global.maxResponseBytes;
  return options;
}

/**
 * Escape the control characters JSON.stringify leaves raw. It escapes C0 (including
 * ESC) but not DEL or the C1 range U+0080–U+009F, and terminals may act on those —
 * U+009B is the 8-bit form of CSI. The output is server data, so escape them; the
 * result is equivalent, valid JSON (these characters only occur inside strings).
 * Checked by char code so the source stays free of control bytes.
 */
export function escapeControlChars(json: string): string {
  let result = "";
  let from = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c >= 0x7f && c <= 0x9f) {
      result += json.slice(from, i) + "\\u" + c.toString(16).padStart(4, "0");
      from = i + 1;
    }
  }
  return from === 0 ? json : result + json.slice(from);
}

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = escapeControlChars(global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2));
  deps.io.out(text);
}

export interface ActionContext {
  client: ReturnType<CliDeps["createClient"]>;
  global: GlobalOptions;
  /** This command's own parsed options. */
  opts: Record<string, unknown>;
}

/**
 * Wrap an async command action with consistent global-option resolution and
 * client construction. The callback receives a context (client + resolved global
 * options + this command's options) and the command's positional arguments.
 *
 * Commander invokes actions as (arg1, ..., argN, options, command); we slice off
 * the trailing options object and command instance to recover the positionals.
 */
export function action(
  deps: CliDeps,
  fn: (ctx: ActionContext, positionals: string[]) => Promise<void>,
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const positionals = args.slice(0, Math.max(0, args.length - 2)) as string[];
    const global = command.optsWithGlobals() as GlobalOptions;
    const client = deps.createClient(toEngineOptions(global));
    await fn({ client, global, opts: command.opts() }, positionals);
  };
}
