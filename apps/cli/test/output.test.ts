// The output sink (src/cli/output.ts): rendering JSON to stdout. smard writes no files
// (there is no -o), so only the rendering cases of the kit's output test apply.

import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { renderJson } from "../src/cli/output.js";
import type { CliDeps } from "../src/cli/io.js";
import { SmardClient } from "@maschinenlesbar.org/smard-client/internal/client";
import type { HttpRequest, HttpResponse } from "@maschinenlesbar.org/smard-client/internal/http";
import { jsonResponse, makeMockTransport, untimed } from "./helpers.js";

const SERIES = { meta_data: { version: 1, created: 2 }, series: [[1577836800000, 12.5], [1577840400000, null]] };

function makeCli(responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse> = () => jsonResponse(SERIES)) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(untimed(s)) },
    createClient: (opts) => new SmardClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

test("pretty-printing an answer nested too deeply is a clean error that suggests --compact", async () => {
  // A hostile or broken answer: JSON.parse reads it, the pretty printer's recursion can't.
  // SMARD's meta_data object is passed through as it came, so the nesting reaches the printer.
  const depth = 200_000;
  const cli = makeCli(() => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(`{"meta_data":{"x":${"[".repeat(depth)}${"]".repeat(depth)}},"series":[[1577836800000,12.5]]}`),
  }));
  assert.equal(await run(["series", "410", "DE", "hour", "1577836800000"], cli.deps), 1);
  assert.deepEqual(cli.out, []);
  assert.deepEqual(cli.err, ["ERROR [smard.output] The answer is nested too deeply to pretty-print; try --compact."]);
});

test("--compact takes the gap path only for an answer holding a huge string, the fast path otherwise", (t) => {
  // On Node 26 V8's fast stringifier (no gap) aborts the process on a ~250 MB string that
  // JSON.parse made ("Zone Allocation failed", exit 134); the gap path prints it. Only the fast
  // path is iterative there, though, and prints nesting the gap path refuses at ~7,000 levels.
  // So the path is chosen per answer. Too big a body for this suite: this pins the calls.
  const { deps, out } = makeCli();
  const stringify = t.mock.method(JSON, "stringify", () => '"stub"');
  const huge = "x".repeat(64 * 1024 * 1024);
  renderJson(deps, { compact: true }, { id: "a1", text: huge });
  renderJson(deps, { compact: true }, { id: "a1", x: [[["Rede"]]], text: huge.slice(1) });
  renderJson(deps, { compact: true }, { [huge]: 1 });
  renderJson(deps, { compact: true }, [[huge]]);
  renderJson(deps, {}, { id: "a1" });
  const calls = stringify.mock.calls.map((call) => call.arguments);
  stringify.mock.restore();
  assert.deepEqual(calls.map((args) => (args.length >= 3 ? args[2] : "none")), ["", "none", "", "", 2]);
  assert.deepEqual(out, ['"stub"', '"stub"', '"stub"', '"stub"', '"stub"']);
});

test("--compact prints a deeply nested answer on one line", async () => {
  const depth = 5_000;
  const cli = makeCli(() => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from(`{"meta_data":{"x":${"[".repeat(depth)}${"]".repeat(depth)}},"series":[[1577836800000,12.5]]}`),
  }));
  assert.equal(await run(["--compact", "series", "410", "DE", "hour", "1577836800000"], cli.deps), 0);
  assert.equal(cli.out.length, 1);
  assert.ok(cli.out[0]!.startsWith('{"meta_data":{"x":[[['));
});
