import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, baseUrlProblem, validateBaseUrl } from "@maschinenlesbar.org/smard-client/internal/engine";
import * as lib from "../src/index.js";
import { SmardClient } from "@maschinenlesbar.org/smard-client/internal/client";
import { SmardNetworkError, SmardValidationError } from "@maschinenlesbar.org/smard-client/internal/errors";
import { jsonResponse, makeMockTransport, parity } from "./helpers.js";

const ok = () => jsonResponse({ timestamps: [1700000000000] });
const BACKSLASH = 'A base URL cannot contain a backslash (\\); write "/" instead.';
const REPAIRED = 'Expected an absolute http(s) URL ("https://" and the host).';
const CONTROL = "A base URL cannot contain a control character (a tab, a line break, ESC, DEL); write one it needs percent-encoded, e.g. %09.";

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
    // The URL parser drops an inner TAB, LF or CR silently (another path) and escapes the rest.
    ["https://h.example/p\n2026-10-09T00:00:00.000Z\tINFO\t[smard.cli]\tforged", CONTROL],
    ["https://h.example/p\rX", CONTROL],
    ["https://h.example/p\u001b]0;pwned\u0007\u001b[2J", CONTROL],
    ["https://u:p\tw@h.example", CONTROL],
    ["https://h.example/p\u007f", CONTROL],
    ["https://h.example/p\u0085", CONTROL],
    // WHATWG ends an http(s) host at a backslash; text-based code reads on.
    ["https://u:pw@api.example\\@evil.example", BACKSLASH],
    ["https://h.example/p\\q", BACKSLASH],
    ["https:\\\\h.example", BACKSLASH],
    // WHATWG skips any slashes after "http:" and repairs the URL silently.
    ["http:h.example", REPAIRED],
    ["http:/h.example", REPAIRED],
    ["http:///h.example", REPAIRED],
    ["HTTPS:h.example/p", REPAIRED],
    ["HTTPS://H.example/p", undefined],
  ];
  for (const [value, reason] of cases) assert.equal(baseUrlProblem(value), reason, value);
});

test("validateBaseUrl returns the value without trailing slashes, or throws SmardValidationError", () => {
  assert.equal(validateBaseUrl("https://mirror.example/smard//"), "https://mirror.example/smard");
  // As the URL parser reads it: the host lower-cased, a default port dropped.
  assert.equal(validateBaseUrl("https://Mirror.Example:443/smard/"), "https://mirror.example/smard");
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
  for (const base of ["ftp://h.example", "notaurl", "https://u:secret@h.example/?x", "https://h.example/#f", "https://h.example/p\nx", "https://u:sec\tret@h.example"]) {
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

test("a backslash or a repaired scheme in --base-url is refused on both sides, never echoing the password", async () => {
  const pw = "s3cret-Pw";
  for (const base of [
    `https://alice:${pw}@api.example\\@evil.example`,
    `http://alice:${pw}@127.0.0.1\\@evil.example`,
    `http:alice:${pw}@127.0.0.1:9`,
    `http:/alice:${pw}@127.0.0.1:9`,
    `http:///alice:${pw}@127.0.0.1:9`,
    `HTTPS:alice:${pw}@mirror.example`,
    `https:\\\\alice:${pw}@mirror.example`,
    `http:///alice:${pw}@mirror.example/?q=1`,
  ]) {
    const { cli, lib: l } = await parity(
      ["--compact", "--base-url", base, "timestamps", "410", "DE", "hour"],
      (transport) => new SmardClient({ transport, baseUrl: base }).timestamps(410, "DE", "hour"),
      ok,
    );
    assert.equal(cli.code, 1, `${base}: ${cli.err}`);
    assert.equal(cli.requests.length + l.requests.length, 0, base);
    assert.ok(!l.ok && l.error instanceof SmardValidationError, base);
    assert.ok(!(l.error as Error).message.includes(pw), (l.error as Error).message);
    assert.ok(!cli.err.includes(pw) && !cli.out.includes(pw), cli.err);
  }
});

test("requests go to the host of the parsed base URL, spelled as it parses, an @ in its path included", async () => {
  for (const base of ["https://alice:pw@api.example/v1/@evil.example", "https://API.Example:443/v1"]) {
    const parsed = new URL(base);
    const { cli, lib: l } = await parity(
      ["--compact", "--base-url", base, "timestamps", "410", "DE", "hour"],
      (transport) => new SmardClient({ transport, baseUrl: base }).timestamps(410, "DE", "hour"),
      ok,
    );
    assert.equal(cli.requests.length, 1, cli.err);
    assert.ok(l.ok);
    for (const req of [...cli.requests, ...l.requests]) {
      assert.equal(new URL(req.url).origin, parsed.origin, `${base}: ${req.url}`);
      // The URL as sent names that host in the text too, so a transport that reads the string
      // (not the parsed URL) reaches the same host.
      const authority = req.url.slice(req.url.indexOf("//") + 2).split("/")[0] ?? "";
      assert.ok(authority === parsed.host || authority.endsWith(`@${parsed.host}`), `${base}: ${req.url}`);
    }
  }
});
