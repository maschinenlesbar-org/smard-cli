import { test } from "node:test";
import assert from "node:assert/strict";
import { InvalidArgumentError } from "commander";
import { requireInt, parseIntArg, toEngineOptions } from "../src/cli/shared.js";
import { SmardError } from "../src/client/errors.js";

test("requireInt accepts a plain non-negative decimal integer", () => {
  assert.equal(requireInt("0", "x"), 0);
  assert.equal(requireInt("410", "x"), 410);
  assert.equal(requireInt("1577836800000", "timestamp"), 1577836800000);
});

test("requireInt rejects empty, hex, whitespace, decimal, negative and exponent", () => {
  for (const bad of ["", " ", "  5  ", "0x10", "1.0", "-1", "1e21", "+5", "abc", "5n"]) {
    assert.throws(() => requireInt(bad, "timestamp"), SmardError, `should reject ${JSON.stringify(bad)}`);
  }
});

test("requireInt does not turn a huge value into exponent form", () => {
  // "1e21" must be rejected outright, not coerced into the URL as "1e+21".
  assert.throws(() => requireInt("1e21", "timestamp"), SmardError);
  // A value beyond MAX_SAFE_INTEGER is rejected rather than silently rounded.
  assert.throws(() => requireInt("9999999999999999999999", "timestamp"), /too large|non-negative integer/);
});

test("parseIntArg mirrors requireInt but throws InvalidArgumentError", () => {
  assert.equal(parseIntArg("100"), 100);
  for (const bad of ["", "0x10", "1e21", "1.0", "-1", "  5  "]) {
    assert.throws(() => parseIntArg(bad), InvalidArgumentError, `should reject ${JSON.stringify(bad)}`);
  }
});

test("toEngineOptions propagates only the set global options", () => {
  assert.deepEqual(toEngineOptions({}), {});
  assert.deepEqual(
    toEngineOptions({
      baseUrl: "https://example.test",
      timeout: 5000,
      userAgent: "ua/1.0",
      maxRetries: 3,
      maxResponseBytes: 0,
      compact: true,
    }),
    {
      baseUrl: "https://example.test",
      timeoutMs: 5000,
      userAgent: "ua/1.0",
      maxRetries: 3,
      maxResponseBytes: 0,
    },
  );
});
