// Run the CLI and resolve to a process exit code. Kept separate from the bin
// shim so tests can call run() directly with injected deps and assert on the
// captured output and exit code without spawning a subprocess.

import { CommanderError, type Command } from "commander";
import { buildProgram, defaultDeps } from "./program.js";
import type { CliDeps } from "./io.js";
import {
  SmardApiError,
  SmardError,
  SmardValidationError,
  credentialsIn,
  redactCredentials,
} from "../client/errors.js";

/**
 * Apply exitOverride + output redirection to every command in the tree.
 * commander does not propagate these to subcommands, so a parse error on a
 * subcommand would otherwise call process.exit() and bypass our error handling.
 */
function configureTree(command: Command, deps: CliDeps): void {
  command.exitOverride();
  command.configureOutput({
    writeOut: (str) => deps.io.out(str.replace(/\n$/, "")),
    writeErr: (str) => deps.io.err(str.replace(/\n$/, "")),
  });
  for (const child of command.commands) configureTree(child, deps);
}

/**
 * Replace the userinfo of every URL in `text` with `***`, the form `redactUrl` gives
 * (`https://user:secret@host` becomes `https://***@host`). Text-based, so it also
 * covers a URL that does not parse; a backstop behind the exact-string redaction.
 */
export function redactUserinfo(text: string): string {
  return text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#']*@/gi, "$1***@");
}

/**
 * `deps` with an `io` that redacts the credentials of every argument from everything it
 * prints on stdout and stderr. Commander echoes rejected values in its errors
 * (`option '--base-url <url>' argument '…' is invalid`), and the CLI's own messages echo
 * rejected arguments (`Invalid filter "…"`): whatever path a credential takes, the exact
 * userinfo (as `credentialsIn` finds it, plus its JSON-escaped form) is replaced by `***`.
 * A pattern alone can't delimit a password with spaces, quotes, `#`, `?` or `/`; the exact
 * strings can. Without credentials the output passes through unchanged.
 */
export function withRedactedOutput(deps: CliDeps, argv: readonly string[]): CliDeps {
  // An `--option=value` token is echoed as its value alone.
  const values = argv.map((token) =>
    token.startsWith("-") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token,
  );
  const secrets = new Set<string>();
  for (const source of [...argv, ...values]) {
    for (const secret of credentialsIn(source)) {
      secrets.add(secret);
      secrets.add(JSON.stringify(secret).slice(1, -1));
    }
  }
  if (secrets.size === 0) return deps;
  const list = [...secrets];
  const redact = (text: string): string => redactUserinfo(redactCredentials(text, list));
  return {
    ...deps,
    io: { ...deps.io, out: (text) => deps.io.out(redact(text)), err: (text) => deps.io.err(redact(text)) },
  };
}

export async function run(argv: string[], deps: CliDeps = defaultDeps): Promise<number> {
  deps = withRedactedOutput(deps, argv);
  const program = buildProgram(deps);
  configureTree(program, deps);

  // A no-subcommand invocation (`smard`, `smard --compact`, `smard --timeout 5000`)
  // should print help to stdout and exit 0 — matching `smard --help` — rather than
  // commander's default of help-to-stderr + exit 1, which contradicts the
  // documented "help → exit 0" model and is a spurious failure for scripts that
  // build a possibly-empty command. Detect it by parsing only the options (which
  // correctly consumes global-option values) on a throwaway program: empty
  // `operands` with nothing left in `unknown` means no command and no help/version
  // or unknown option. `--help`/`--version`/unknown options land in `unknown` and
  // fall through to commander so it handles (and reports) them exactly as before.
  try {
    // The probe program must be exit-overridden AND silenced: parseOptions runs the
    // option value-parsers (e.g. the --timeout bound), so an invalid value would
    // otherwise trigger commander's default process.exit() from inside run(). Silence
    // its output so the error is only reported once, by the real parse below.
    const probeProgram = buildProgram(deps);
    probeProgram.exitOverride();
    probeProgram.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    const probe = probeProgram.parseOptions([...argv]);
    if (probe.operands.length === 0 && probe.unknown.length === 0) {
      deps.io.out(program.helpInformation().replace(/\n$/, ""));
      return 0;
    }
  } catch {
    // Option parsing hiccuped — fall through and let the real parse report it.
  }

  try {
    await program.parseAsync(argv, { from: "user" });
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // Help/version requests exit 0; genuine parse errors carry their own code.
      return err.exitCode;
    }
    if (err instanceof SmardValidationError) {
      // The library rejected an input before any request: a usage error, which
      // exits 1 like a value commander's parsers reject.
      deps.io.err(`Error: ${err.message}`);
      return 1;
    }
    if (err instanceof SmardApiError) {
      deps.io.err(`Error: ${err.message}`);
      // Map a few notable statuses to distinct exit codes for scripting.
      if (err.status === 404) return 4;
      return 1;
    }
    if (err instanceof SmardError) {
      // Network errors, timeouts and parse errors (all SmardError subclasses)
      // deliberately collapse to exit code 1 — only 404 (above) gets a distinct
      // code. See the README "Exit codes" note.
      deps.io.err(`Error: ${err.message}`);
      return 1;
    }
    deps.io.err(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
