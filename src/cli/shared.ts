// Shared helpers used across CLI command groups: option parsers, the global
// option resolver, and the JSON result renderer.

import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { SmardError } from "../client/errors.js";
import type { EngineOptions } from "../client/engine.js";

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

/** commander value-parser: a non-negative integer. */
export function parseIntArg(value: string): number {
  const n = parseNonNegativeInt(value);
  if (n === null) {
    throw new InvalidArgumentError("Expected a non-negative integer.");
  }
  return n;
}

/**
 * Parse a positional argument as a non-negative integer (commander does not run
 * value-parsers on positional args). Throws a SmardError so run() prints a clear
 * message and exits 1.
 */
export function requireInt(value: string, argName: string): number {
  const n = parseNonNegativeInt(value);
  if (n === null) {
    throw new SmardError(`Invalid ${argName} "${value}". Expected a non-negative integer.`);
  }
  return n;
}

/**
 * Validate a positional argument against an allowed set (commander does not
 * support .choices() on positional args). Throws a SmardError so run() prints a
 * clear message and exits 1.
 */
export function assertEnum<T extends string>(
  value: string,
  allowed: readonly T[],
  argName: string,
): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new SmardError(`Invalid ${argName} "${value}". Expected one of: ${allowed.join(", ")}.`);
  }
  return value as T;
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

/** Render a JSON value to stdout, pretty by default, compact with --compact. */
export function renderJson(deps: CliDeps, global: GlobalOptions, value: unknown): void {
  const text = global.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
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
