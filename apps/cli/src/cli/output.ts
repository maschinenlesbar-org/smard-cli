// The output sink: everything the CLI writes as data, to stdout (smard writes no files, so
// there is no -o). One place for the rules the maschinenlesbar.org CLIs learned one bug at a
// time: terminal controls escaped, a deep or huge answer printed (or refused) cleanly.

import { SmardError } from "@maschinenlesbar.org/smard-client/internal/errors";
import type { CliDeps } from "./io.js";

/**
 * Printing the output failed: an answer too deeply nested to print. An ERROR record of
 * `smard.output`, exit 1.
 */
export class OutputError extends SmardError {}

/** The global options that decide how a result is written. */
export interface OutputOptions {
  compact?: boolean | undefined;
}

/** Write a JSON result to stdout: pretty by default, compact with `--compact`. */
export function renderJson(deps: CliDeps, options: OutputOptions, value: unknown): void {
  deps.io.out(escapeControlChars(stringifyJson(value, options.compact === true)));
}

/**
 * JSON.stringify, pretty or compact. An answer nested too deeply (hostile or broken) overflows
 * the stack: an OutputError rather than "Unexpected error: Maximum call stack size exceeded".
 *
 * Compact output takes V8's fast path (no gap) unless the answer holds a huge string: on Node 26
 * the fast path aborts the process ("Zone Allocation failed", exit 134, a native dump on stderr)
 * on a string of some 250 MB that JSON.parse made, while the gap path (an empty gap, the same
 * text) prints it. The fast path stays the default because on Node 26 only it is iterative and
 * prints nesting the gap path refuses (~7,000 levels).
 */
function stringifyJson(value: unknown, compact: boolean): string {
  try {
    if (!compact) return JSON.stringify(value, null, 2);
    return holdsHugeString(value) ? JSON.stringify(value, null, "") : JSON.stringify(value);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    throw new OutputError(
      compact ? "The answer is nested too deeply to print." : "The answer is nested too deeply to pretty-print; try --compact.",
      { cause: err },
    );
  }
}

/** A string or key this long sends --compact through the gap path: a quarter of where Node 26's fast path aborts. */
const HUGE_STRING_LENGTH = 64 * 1024 * 1024;

/** Whether `value` holds a string or key of HUGE_STRING_LENGTH or more. Iterative, so nesting costs no stack. */
function holdsHugeString(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === "string") {
      if (item.length >= HUGE_STRING_LENGTH) return true;
    } else if (typeof item === "object" && item !== null) {
      for (const [key, element] of Object.entries(item)) {
        if (key.length >= HUGE_STRING_LENGTH) return true;
        if (typeof element === "string" || (typeof element === "object" && element !== null)) stack.push(element);
      }
    }
  }
  return false;
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
