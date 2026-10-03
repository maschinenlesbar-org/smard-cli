import { test } from "node:test";
import assert from "node:assert/strict";
import { assertHeaderValue, headerValueProblem } from "../src/client/validate.js";
import * as lib from "../src/index.js";
import { SmardClient } from "../src/client/client.js";
import { RequestEngine } from "../src/client/engine.js";
import { nodeHttpTransport } from "../src/client/http.js";
import { SmardNetworkError, SmardValidationError } from "../src/client/errors.js";
import { jsonResponse, makeMockTransport, parity } from "./helpers.js";

const CRLF = String.fromCharCode(13, 10);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(0x7f);

test("headerValueProblem: blank, control characters and code points above U+00FF", () => {
  assert.equal(headerValueProblem("ok-agent/1.0"), undefined);
  assert.equal(headerValueProblem("tüv\t1"), undefined); // Latin-1 and tab are fine
  assert.equal(headerValueProblem(""), "Expected a non-empty value.");
  assert.equal(headerValueProblem("  "), "Expected a non-empty value.");
  for (const bad of [`a${CRLF}X-Injected: 1`, `a${NUL}b`, `a${DEL}`]) {
    assert.equal(headerValueProblem(bad), "Value contains control characters.", JSON.stringify(bad));
  }
  for (const bad of ["app☃", "€agent", "smard \u{1F642}"]) {
    assert.equal(headerValueProblem(bad), "Value contains characters outside Latin-1 (above U+00FF).", bad);
  }
});

test("assertHeaderValue throws SmardValidationError naming the header", () => {
  assert.equal(assertHeaderValue("userAgent", "ua/1"), "ua/1");
  assert.throws(
    () => assertHeaderValue("userAgent", `a${CRLF}b`),
    (e: unknown) => e instanceof SmardValidationError && e.message === "Invalid userAgent: Value contains control characters.",
  );
  assert.equal(lib.assertHeaderValue, assertHeaderValue);
});

test("the engine rejects a control-character or non-Latin-1 userAgent at construction", () => {
  for (const ua of [`a${CRLF}X-Injected: 1`, `a${DEL}`, "app☃", "€agent"]) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(() => new RequestEngine({ transport: mt.transport, userAgent: ua }), SmardValidationError, ua);
    assert.equal(mt.calls.length, 0);
  }
});

test("the default transport turns Node's synchronous header error into a SmardNetworkError", async () => {
  await assert.rejects(
    () => nodeHttpTransport({ method: "GET", url: "http://127.0.0.1:1/x", headers: { "User-Agent": `a${CRLF}b` } }),
    (e: unknown) => e instanceof SmardNetworkError && /^Invalid request: /.test(e.message),
  );
});

test("parity: a bad --user-agent / userAgent is rejected on both sides with no request", async () => {
  for (const ua of [`a${CRLF}X-Injected: 1`, "app☃"]) {
    const { cli, lib: l } = await parity(
      ["--compact", "--user-agent", ua, "timestamps", "410", "DE", "hour"],
      (transport) => new SmardClient({ transport, userAgent: ua }).timestamps(410, "DE", "hour"),
      () => jsonResponse({ timestamps: [1700000000000] }),
    );
    assert.equal(cli.code, 1, ua);
    assert.equal(cli.requests.length, 0, ua);
    assert.ok(!l.ok && l.error instanceof SmardValidationError, ua);
    assert.equal(l.requests.length, 0, ua);
    // Same reason on both sides: the CLI says it for the flag, the library for the option.
    const reason = (l as { error: Error }).error.message.replace(/^Invalid userAgent: /, "");
    assert.ok(cli.err.includes(reason), cli.err);
  }
  const { cli, lib: l } = await parity(
    ["--compact", "--user-agent", "ok-agent/1.0", "timestamps", "410", "DE", "hour"],
    (transport) => new SmardClient({ transport, userAgent: "ok-agent/1.0" }).timestamps(410, "DE", "hour"),
    () => jsonResponse({ timestamps: [1700000000000] }),
  );
  assert.equal(cli.code, 0);
  assert.ok(l.ok);
  assert.equal(cli.requests[0]!.headers?.["User-Agent"], "ok-agent/1.0");
  assert.equal(l.requests[0]!.headers?.["User-Agent"], "ok-agent/1.0");
});
