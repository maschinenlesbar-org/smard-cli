import { test } from "node:test";
import assert from "node:assert/strict";
import { SmardClient } from "../src/client/client.js";
import {
  assertId,
  assertRegion,
  assertResolution,
  nonNegativeIntegerProblem,
  regionProblem,
  resolutionProblem,
} from "../src/client/validate.js";
import * as lib from "../src/index.js";
import { SmardValidationError } from "../src/client/errors.js";
import { constantJson, jsonResponse, makeMockTransport, parity } from "./helpers.js";
import { run } from "../src/cli/run.js";
import type { HttpRequest } from "../src/client/http.js";

const responder = (req: HttpRequest) =>
  req.url.includes("index_")
    ? jsonResponse({ timestamps: [1700000000000, 1700604800000] })
    : jsonResponse({ meta_data: { version: 1, created: 2 }, series: [] });

test("nonNegativeIntegerProblem accepts only non-negative safe integers", () => {
  for (const ok of [0, 1, 410, 1700000000000, Number.MAX_SAFE_INTEGER]) {
    assert.equal(nonNegativeIntegerProblem(ok), undefined, String(ok));
  }
  for (const bad of [-1, 1.5, NaN, Infinity, -Infinity, 2 ** 53, 1e21, null, undefined]) {
    assert.equal(nonNegativeIntegerProblem(bad), "Expected a non-negative integer.", String(bad));
  }
  // A numeric string or a bigint looks like a valid id: the reason says what is wrong.
  for (const [bad, type] of [["410", "string"], ["", "string"], [410n, "bigint"]] as const) {
    assert.equal(
      nonNegativeIntegerProblem(bad),
      `Expected a non-negative integer as a number, not a ${type} (convert it with Number()).`,
      String(bad),
    );
  }
});

test("the library names a string id as the problem, not the value (05#2)", async () => {
  const client = new SmardClient({ transport: makeMockTransport(responder).transport });
  await assert.rejects(
    client.timestamps("4169" as unknown as number, "DE-LU", "hour"),
    (e: unknown) =>
      e instanceof SmardValidationError &&
      e.message === 'Invalid filter "4169". Expected a non-negative integer as a number, not a string (convert it with Number()).',
  );
});

test("a repeated single-value option is a usage error, never last-one-wins", async () => {
  const argvs = [
    ["--timeout", "5000", "--timeout", "0", "timestamps", "410", "DE", "hour"],
    ["--base-url", "http://127.0.0.1:1", "--base-url", "http://127.0.0.1:2", "timestamps", "410", "DE", "hour"],
    ["--max-retries", "1", "--max-retries=2", "timestamps", "410", "DE", "hour"],
    ["--user-agent", "a", "--user-agent", "b", "timestamps", "410", "DE", "hour"],
    ["--max-response-bytes", "1", "--max-response-bytes", "2", "timestamps", "410", "DE", "hour"],
    ["filters", "--group", "price", "--group", "generation"],
  ];
  for (const argv of argvs) {
    const mt = makeMockTransport(responder);
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, {
      io: { out: (s) => out.push(s), err: (s) => err.push(s) },
      createClient: (opts) => new SmardClient({ ...opts, transport: mt.transport }),
    });
    assert.equal(code, 1, argv.join(" "));
    assert.equal(mt.calls.length, 0);
    assert.deepEqual(out, []);
    assert.match(err.join("\n"), /was given more than once; give it once/, argv.join(" "));
  }
});

test("regionProblem / resolutionProblem check membership in the exported value lists", () => {
  assert.equal(regionProblem("DE-LU"), undefined);
  assert.equal(resolutionProblem("quarterhour"), undefined);
  for (const bad of ["de", " DE", "XX", "", "constructor"]) assert.ok(regionProblem(bad), bad);
  for (const bad of ["Hour", "hour ", "quarter-hour", "", "toString"]) assert.ok(resolutionProblem(bad), bad);
});

test("assertId / assertRegion / assertResolution throw the CLI's messages as SmardValidationError", () => {
  assert.equal(assertId("filter", 410), 410);
  assert.equal(assertRegion("DE"), "DE");
  assert.equal(assertResolution("hour"), "hour");
  assert.throws(
    () => assertId("filter", -1),
    (e: unknown) => e instanceof SmardValidationError && e.message === 'Invalid filter "-1". Expected a non-negative integer.',
  );
  assert.throws(
    () => assertRegion("de"),
    (e: unknown) =>
      e instanceof SmardValidationError &&
      e.message ===
        'Invalid region "de". Expected one of: DE, AT, LU, DE-LU, DE-AT-LU, 50Hertz, Amprion, TenneT, TransnetBW, APG, Creos.',
  );
  assert.throws(
    () => assertResolution("Hour"),
    (e: unknown) =>
      e instanceof SmardValidationError &&
      e.message === 'Invalid resolution "Hour". Expected one of: hour, quarterhour, day, week, month, year.',
  );
  assert.equal(lib.assertRegion, assertRegion);
});

test("SmardClient rejects bad path arguments before any request", async () => {
  const mt = constantJson({ timestamps: [1] });
  const c = new SmardClient({ transport: mt.transport }) as unknown as {
    timestamps(f: unknown, r: unknown, res: unknown): Promise<unknown>;
    series(f: unknown, r: unknown, res: unknown, ts: unknown): Promise<unknown>;
    latest(f: unknown, r: unknown, res: unknown): Promise<unknown>;
    tableData(f: unknown, r: unknown, ts: unknown): Promise<unknown>;
  };
  const calls: [string, () => Promise<unknown>][] = [
    ["filter", () => c.timestamps("", "DE", "hour")],
    ["filter", () => c.timestamps(-1, "DE", "hour")],
    ["filter", () => c.latest(Infinity, "DE", "hour")],
    ["filter", () => c.series(NaN, "DE", "hour", 1)],
    ["filter", () => c.tableData(1.5, "DE", 1)],
    ["filter", () => c.timestamps("410/../../other", "DE", "hour")],
    ["region", () => c.timestamps(410, " DE", "hour")],
    ["region", () => c.timestamps(410, "..", "hour")],
    ["region", () => c.tableData(410, "XX", 1)],
    ["resolution", () => c.latest(410, "DE", "hour ")],
    ["resolution", () => c.series(410, "DE", "hour/../../secret#", 1)],
    ["timestamp", () => c.series(410, "DE", "hour", 9007199254740993)],
    ["timestamp", () => c.series(410, "DE", "hour", 1e21)],
    ["timestamp", () => c.tableData(410, "DE", "")],
    ["timestamp", () => c.tableData(410, "DE", "1/../../../x")],
  ];
  for (const [name, call] of calls) {
    let sync = false;
    let p: Promise<unknown>;
    try {
      p = call();
    } catch {
      sync = true;
      p = Promise.resolve();
    }
    assert.equal(sync, false, "must reject, not throw synchronously");
    await assert.rejects(p, (e: unknown) => e instanceof SmardValidationError && e.message.startsWith(`Invalid ${name} "`));
  }
  assert.equal(mt.calls.length, 0);
});

test("parity: bad chart arguments are rejected by the CLI and the library alike, with no request", async () => {
  const cases: [string[], (c: SmardClient) => Promise<unknown>][] = [
    [["timestamps", "-1", "DE", "hour"], (c) => c.timestamps(-1, "DE", "hour")],
    [["timestamps", "410", " DE", "hour"], (c) => c.timestamps(410, " DE" as never, "hour")],
    [["timestamps", "410", "de", "hour"], (c) => c.timestamps(410, "de" as never, "hour")],
    [["latest", "410", "DE", "hour "], (c) => c.latest(410, "DE", "hour " as never)],
    [["series", "410", "DE", "Hour", "1"], (c) => c.series(410, "DE", "Hour" as never, 1)],
    [["series", "410", "DE", "hour", "-5"], (c) => c.series(410, "DE", "hour", -5)],
    [["table", "410", "XX", "1"], (c) => c.tableData(410, "XX" as never, 1)],
  ];
  for (const [argv, call] of cases) {
    const { cli, lib: l } = await parity(["--compact", ...argv], (transport) => call(new SmardClient({ transport })), responder);
    assert.equal(cli.code, 1, argv.join(" "));
    assert.equal(cli.requests.length, 0, argv.join(" "));
    assert.equal(l.ok, false, argv.join(" "));
    assert.ok(!l.ok && l.error instanceof SmardValidationError, argv.join(" "));
    assert.equal(l.requests.length, 0, argv.join(" "));
    assert.equal(cli.err, `Error: ${(l as { error: Error }).error.message}`, argv.join(" "));
  }
});

test("parity: valid chart arguments send the identical request", async () => {
  const cases: [string[], (c: SmardClient) => Promise<unknown>][] = [
    [["timestamps", "410", "DE", "hour"], (c) => c.timestamps(410, "DE", "hour")],
    [["series", "0", "50Hertz", "year", "1700000000000"], (c) => c.series(0, "50Hertz", "year", 1700000000000)],
    [["latest", "4068", "DE-LU", "week"], (c) => c.latest(4068, "DE-LU", "week")],
    [["table", "122", "AT", "1577836800000"], (c) => c.tableData(122, "AT", 1577836800000)],
  ];
  for (const [argv, call] of cases) {
    const { cli, lib: l } = await parity(["--compact", ...argv], (transport) => call(new SmardClient({ transport })), responder);
    assert.equal(cli.code, 0, argv.join(" "));
    assert.ok(l.ok, argv.join(" "));
    assert.deepEqual(cli.requests.map((r) => r.url), l.requests.map((r) => r.url));
    assert.deepEqual(JSON.parse(cli.out), l.ok ? l.value : undefined);
  }
});
