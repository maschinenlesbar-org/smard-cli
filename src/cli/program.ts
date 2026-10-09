// Assemble the full commander program. The program is built around an injectable
// CliDeps so the entire CLI can be driven in tests with a mocked client and
// captured output.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import type { CliDeps } from "./io.js";
import { defaultIO } from "./io.js";
import { SmardClient } from "../client/client.js";
import { MAX_TIMEOUT_MS } from "../client/http.js";
import { MAX_RETRIES } from "../client/engine.js";
import { once, parseBaseUrl, parseBoundedInt, parseHeaderValue, parseIntArg } from "./shared.js";
import { registerChartCommands } from "./commands/chart.js";
import { registerCatalogueCommands } from "./commands/catalogue.js";
import { DEFAULT_LOG_FORMAT, logFormatProblem } from "./log.js";

/**
 * Single source of truth for the version: read from package.json at runtime
 * rather than duplicating a literal that can silently drift after a release bump.
 * From the compiled location (dist/src/cli/program.js) package.json is three
 * directories up; the same offset holds for the source under src/cli.
 */
function readVersion(): string {
  try {
    const pkgUrl = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION = readVersion();

/** Default dependencies: real client + real stdout/stderr/filesystem. */
export const defaultDeps: CliDeps = {
  io: defaultIO,
  createClient: (options) => new SmardClient(options),
};

/** commander value-parser for `--log-format`. */
function parseLogFormat(value: string): string {
  const problem = logFormatProblem(value);
  if (problem !== undefined) throw new InvalidArgumentError(problem);
  return value;
}

export function buildProgram(deps: CliDeps = defaultDeps): Command {
  const program = new Command();

  program
    .name("smard")
    .description(
      "CLI for the open SMARD electricity-market chart-data API (https://www.smard.de) — " +
        "generation, consumption, residual load and wholesale prices.",
    )
    .version(VERSION)
    .option("--base-url <url>", "API base URL", once("--base-url", parseBaseUrl), "https://www.smard.de")
    .option(
      "--timeout <ms>",
      "time limit per request in milliseconds, whole response included (0 = no timeout)",
      once("--timeout", parseBoundedInt(0, MAX_TIMEOUT_MS)),
      30_000,
    )
    .option("--user-agent <ua>", "User-Agent header value", once("--user-agent", parseHeaderValue))
    .option(
      "--max-retries <n>",
      `retries for transient 429/503 responses and reset connections (0..${MAX_RETRIES}; each backs off linearly, or waits the server's Retry-After when longer, up to 30 s)`,
      once("--max-retries", parseBoundedInt(0, MAX_RETRIES)),
      2,
    )
    .option(
      "--max-response-bytes <n>",
      "cap response body size in bytes (0 = unlimited; default 100 MiB)",
      once("--max-response-bytes", parseIntArg),
    )
    .option(
      "--log-format <format>",
      `how errors, warnings and notes are written to stderr: text (log4j style: time, level, [topic], message) or jsonl (one JSON object per line: ts, level, topic, msg); default ${DEFAULT_LOG_FORMAT}`,
      once("--log-format", parseLogFormat),
    )
    .option("--compact", "print JSON on a single line instead of pretty-printed")
    .showHelpAfterError();

  registerChartCommands(program, deps);
  registerCatalogueCommands(program, deps);

  return program;
}
