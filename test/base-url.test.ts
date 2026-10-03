import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, baseUrlProblem, validateBaseUrl } from "../src/client/engine.js";
import * as lib from "../src/index.js";
import { SmardClient } from "../src/client/client.js";
import { SmardNetworkError, SmardValidationError } from "../src/client/errors.js";
import { jsonResponse, makeMockTransport, parity } from "./helpers.js";

const ok = () => jsonResponse({ timestamps: [1700000000000] });

test("baseUrlProblem holds every base-URL rule, in the CLI's order", () => {
  const cases: [string, string | undefined][] = [
    ["https://www.smard.de", undefined],
    ["http://user:pw@127.0.0.1:1/prefix/", undefined], // userinfo is kept (sent as Basic auth)
    ["", "Expected an absolute http(s) URL."],
    ["notaurl", "Expected an absolute http(s) URL."],
    ["ftp://h.example", 'Unsupported scheme "ftp:". Expected an http(s) URL.'],
    ["file:///etc/passwd", 'Unsupported scheme "file:". Expected an http(s) URL.'],
    ["https://h.example/?x=1", "A base URL cannot have a query (?) or fragment (#)."],
    ["https://h.example/#f", "A base URL cannot have a query (?) or fragment (#)."],
    ["https://h.example/ ", "A base URL cannot have surrounding whitespace."],
  ];
  for (const [value, reason] of cases) assert.equal(baseUrlProblem(value), reason, value);
});

test("validateBaseUrl returns the value without trailing slashes, or throws SmardValidationError", () => {
  assert.equal(validateBaseUrl("https://mirror.example/smard//"), "https://mirror.example/smard");
  assert.equal(lib.validateBaseUrl, validateBaseUrl);
  for (const bad of ["ftp://h.example", "notaurl", "https://u:secret@h.example/?x"]) {
    assert.throws(
      () => validateBaseUrl(bad),
      (e: unknown) =>
        e instanceof SmardValidationError &&
        !(e instanceof SmardNetworkError) &&
        e.message === `Invalid baseUrl: ${baseUrlProblem(bad)}` &&
        !e.message.includes("secret"),
      bad,
    );
  }
});

test("the engine rejects a bad base URL as SmardValidationError, not SmardNetworkError, before any request", () => {
  for (const bad of ["notaurl", "file:///etc/passwd", "ftp://example.org/", "https://www.smard.de/?x=1"]) {
    const mt = makeMockTransport(ok);
    assert.throws(
      () => new RequestEngine({ baseUrl: bad, transport: mt.transport }),
      (e: unknown) => e instanceof SmardValidationError && !(e instanceof SmardNetworkError),
      bad,
    );
    assert.equal(mt.calls.length, 0);
  }
});

test("parity: a bad --base-url / baseUrl gives the same reason on both sides, with no request", async () => {
  for (const base of ["ftp://h.example", "notaurl", "https://u:secret@h.example/?x", "https://h.example/#f"]) {
    const { cli, lib: l } = await parity(
      ["--compact", "--base-url", base, "timestamps", "410", "DE", "hour"],
      (transport) => new SmardClient({ transport, baseUrl: base }).timestamps(410, "DE", "hour"),
      ok,
    );
    assert.equal(cli.code, 1, base);
    assert.equal(cli.requests.length, 0, base);
    assert.ok(!l.ok && l.error instanceof SmardValidationError && !(l.error instanceof SmardNetworkError), base);
    assert.equal(l.requests.length, 0, base);
    const reason = (l as { error: Error }).error.message.replace(/^Invalid baseUrl: /, "");
    assert.equal(reason, baseUrlProblem(base), base);
    assert.ok(cli.err.includes(`is invalid. ${reason}`), `${base}: ${cli.err}`);
  }
});
