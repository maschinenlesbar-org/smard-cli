import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RETRIES, RequestEngine } from "../src/client/engine.js";
import { MAX_TIMEOUT_MS } from "../src/client/http.js";
import { intRangeProblem } from "../src/client/validate.js";
import * as lib from "../src/index.js";
import { SmardClient } from "../src/client/client.js";
import { SmardApiError, SmardValidationError } from "../src/client/errors.js";
import { jsonResponse, makeMockTransport, noWait, parity } from "./helpers.js";

test("intRangeProblem accepts integers in range only", () => {
  const p = intRangeProblem(0, 10);
  for (const ok of [0, 5, 10]) assert.equal(p(ok), undefined);
  for (const bad of [-1, 11, 1.5, NaN, Infinity, "3", undefined]) {
    assert.equal(p(bad), "Expected an integer from 0 to 10.", String(bad));
  }
});

test("MAX_RETRIES is 10 and exported from the package root", () => {
  assert.equal(MAX_RETRIES, 10);
  assert.equal(lib.MAX_RETRIES, 10);
});

test("the engine rejects out-of-range numeric options at construction", () => {
  const cases: [string, unknown, string][] = [
    ["maxRetries", 11, "Expected an integer from 0 to 10."],
    ["maxRetries", 50, "Expected an integer from 0 to 10."],
    ["maxRetries", -1, "Expected an integer from 0 to 10."],
    ["maxRetries", 1.5, "Expected an integer from 0 to 10."],
    ["maxRetries", NaN, "Expected an integer from 0 to 10."],
    ["maxRetries", Infinity, "Expected an integer from 0 to 10."],
    ["timeoutMs", -1, `Expected an integer from 0 to ${MAX_TIMEOUT_MS}.`],
    ["timeoutMs", NaN, `Expected an integer from 0 to ${MAX_TIMEOUT_MS}.`],
    ["timeoutMs", 1.5, `Expected an integer from 0 to ${MAX_TIMEOUT_MS}.`],
    ["timeoutMs", MAX_TIMEOUT_MS + 1, `Expected an integer from 0 to ${MAX_TIMEOUT_MS}.`],
    ["maxResponseBytes", -1, "Expected a non-negative integer."],
    ["maxResponseBytes", NaN, "Expected a non-negative integer."],
    ["maxResponseBytes", 1.5, "Expected a non-negative integer."],
    ["maxResponseBytes", 1e20, "Expected a non-negative integer."],
    ["retryDelayMs", -1, "Expected an integer from 0 to 30000."],
    ["retryDelayMs", Infinity, "Expected an integer from 0 to 30000."],
    ["retryDelayMs", 30_001, "Expected an integer from 0 to 30000."],
  ];
  for (const [name, value, reason] of cases) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new RequestEngine({ transport: mt.transport, [name]: value }),
      (e: unknown) => e instanceof SmardValidationError && e.message === `Invalid ${name}: ${reason}`,
      `${name}=${String(value)}`,
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("the engine accepts the bounds and undefined keeps the defaults", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  new RequestEngine({ transport: mt.transport, maxRetries: 0, timeoutMs: 0, maxResponseBytes: 0, retryDelayMs: 0 });
  new RequestEngine({ transport: mt.transport, maxRetries: MAX_RETRIES, timeoutMs: MAX_TIMEOUT_MS });
  const e = new RequestEngine({ transport: mt.transport, maxRetries: undefined, timeoutMs: undefined });
  await e.getJson("/x");
  assert.equal(mt.last().timeoutMs, 30_000);
  assert.equal(mt.last().maxResponseBytes, 100 * 1024 * 1024);
});

const busy = () => ({
  status: 503,
  headers: { "content-type": "application/json", "retry-after": "0" },
  body: Buffer.from(JSON.stringify({ detail: "busy" })),
});

test("parity: out-of-range engine options are rejected by the CLI and the library, with no request", async () => {
  const cases: [string[], Record<string, number>][] = [
    [["--max-retries", "11"], { maxRetries: 11 }],
    [["--max-retries", "50"], { maxRetries: 50 }],
    [["--timeout", "2147483648"], { timeoutMs: 2147483648 }],
  ];
  for (const [flags, opts] of cases) {
    const { cli, lib: l } = await parity(
      ["--compact", ...flags, "timestamps", "410", "DE", "hour"],
      (transport) => new SmardClient({ transport, ...opts }).timestamps(410, "DE", "hour"),
      busy,
    );
    assert.equal(cli.code, 1, flags.join(" "));
    assert.equal(cli.requests.length, 0, flags.join(" "));
    assert.ok(!l.ok && l.error instanceof SmardValidationError, flags.join(" "));
    assert.equal(l.requests.length, 0, flags.join(" "));
  }
});

test("parity: maxRetries at the bound sends the same number of requests", async () => {
  const { cli, lib: l } = await parity(
    ["--compact", "--max-retries", String(MAX_RETRIES), "timestamps", "410", "DE", "hour"],
    (transport) => new SmardClient({ transport, maxRetries: MAX_RETRIES, sleep: noWait }).timestamps(410, "DE", "hour"),
    busy,
  );
  assert.equal(cli.code, 1);
  assert.ok(!l.ok && l.error instanceof SmardApiError);
  assert.equal(cli.requests.length, MAX_RETRIES + 1);
  assert.equal(l.requests.length, MAX_RETRIES + 1);
});
