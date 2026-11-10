import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { TextDecoder, inspect } from "node:util";
import assert from "node:assert/strict";
import {
  MAX_RETRY_AFTER_MS,
  RequestEngine,
  bigIntegerKeysOption,
  firstInexactNumber,
  parseRetryAfter,
  sanitizeServerText,
  scanNumbers,
} from "../src/engine.js";
import {
  SmardApiError,
  SmardError,
  SmardNetworkError,
  SmardParseError,
  SmardResponseTooLargeError,
  SmardValidationError,
  TextBuilder,
  cutText,
  redactUrlUserinfo,
  toWellFormed,
} from "../src/errors.js";
import { makeMockTransport, jsonResponse, rawResponse } from "./helpers.js";
import type { HttpResponse } from "../src/http.js";

// Control characters built via char codes so no raw control bytes ever appear in
// this source file.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b); // a C1 control

/** True if the string contains any C0/C1 control char (plus DEL). */
function hasControlChars(s: string): boolean {
  return [...s].some((c) => {
    const n = c.charCodeAt(0);
    return n <= 8 || (n >= 0x0b && n <= 0x1f) || (n >= 0x7f && n <= 0x9f);
  });
}

test("buildUrl normalises the path and appends the query", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test/" });
  assert.equal(e.buildUrl("app/"), "https://example.test/app/");
  assert.equal(
    e.buildUrl("/x", { a: "1", b: ["2", "3"] }),
    "https://example.test/x?a=1&b=2&b=3",
  );
});

test("buildUrl refuses a . or .. path segment (defence in depth for direct engine use)", () => {
  const e = new RequestEngine({ baseUrl: "https://example.test" });
  for (const path of ["/app/chart_data/410/../index_hour.json", "/app/./x", "/../x"]) {
    assert.throws(
      () => e.buildUrl(path),
      (err: unknown) => err instanceof SmardError && /^Invalid path segment "\.{1,2}" in \//.test(err.message),
      path,
    );
  }
});

test("a malformed base URL is rejected at construction with a clear, base-only message", () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  assert.throws(
    () => new RequestEngine({ baseUrl: "notaurl", transport: mt.transport }),
    (err: unknown) =>
      err instanceof SmardValidationError &&
      err.message === "Invalid baseUrl: Expected an absolute http(s) URL." &&
      // the diagnostic must NOT carry a request path (which read as if it were at fault)
      !/chart_data/.test(err.message),
  );
  assert.equal(mt.calls.length, 0);
});

test("a non-http(s) base URL is rejected at construction, even with a custom transport", () => {
  for (const bad of ["file:///etc/passwd", "ftp://example.org/"]) {
    const mt = makeMockTransport(() => jsonResponse({}));
    assert.throws(
      () => new RequestEngine({ baseUrl: bad, transport: mt.transport }),
      (err: unknown) =>
        err instanceof SmardValidationError && /Unsupported scheme/.test(err.message),
      bad,
    );
    assert.equal(mt.calls.length, 0, `${bad} must not reach the transport`);
  }
});

test("getJson parses a JSON body", async () => {
  const mt = makeMockTransport(() => jsonResponse({ ok: true }));
  const e = new RequestEngine({ transport: mt.transport });
  assert.deepEqual(await e.getJson("/x"), { ok: true });
});

test("getJson throws SmardParseError on invalid JSON", async () => {
  const mt = makeMockTransport(() => rawResponse("not json", "application/json"));
  const e = new RequestEngine({ transport: mt.transport });
  await assert.rejects(() => e.getJson("/x"), SmardParseError);
});

test("a number the JSON cannot carry exactly is a parse error, never a changed value", async () => {
  // JSON.parse rounds 12345678901234567890 (in any form: .0, e0, E-1) and 9007199254740992.5 to the
  // nearest double, turns 1e400 into Infinity (printed as null) and 1e-400 into 0, silently.
  const body = (n: string) => `{"id":"a","n":${n},"text":"12345678901234567890 in a string"}`;
  for (const n of [
    "12345678901234567890", "-9007199254740993", "1e400", "-1E400", "12345678901234567890.0", "9007199254740993e0",
    "90071992547409930E-1", "9007199254740992.5", "-9007199254740992.5", "1e-400", "-0.0001e-399",
    "123456789012345678901234567890",
    // Below the smallest normal double a subnormal has fewer digits: 3e-324 became 5e-324.
    "3e-324", "4e-324", "-4.9e-324", "1.2345678901234567e-310", "2.225073858507201e-309", "1.234567890123e-318",
  ]) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    await assert.rejects(e.getJson("/app/chart_data/410/DE/index_hour.json"), (err: unknown) => {
      assert.ok(err instanceof SmardParseError, n);
      assert.equal(err.message, `GET https://www.smard.de/app/chart_data/410/DE/index_hour.json: the number ${n} cannot be represented exactly.`);
      return true;
    });
  }
  // What a double carries exactly, or as JSON means it (a decimal fraction below 2^53), passes.
  const exact: Array<[string, number]> = [
    ["9007199254740991", 9007199254740991], ["9007199254740992.0", 2 ** 53], ["9007199254740992e0", 2 ** 53],
    ["90071992547409920E-1", 2 ** 53], ["1e21", 1e21], ["1.2e21", 1.2e21], ["0", 0], ["-0", -0], ["0.0e-500", 0],
    ["1.10", 1.1], ["0.1", 0.1], ["1.00000000000000001", 1], ["5e-324", 5e-324],
    // A double a server printed in its shortest form reads back as that double and prints as the
    // same number: not a changed value, though the decimal is not the double's exact binary value.
    ["1e23", 1e23], ["100000000000000000000000", 1e23], ["1E23", 1e23], ["1.7976931348623157E308", Number.MAX_VALUE], ["-1.7976931348623157e308", -Number.MAX_VALUE],
    ["4.35e30", 4.35e30],
    // A subnormal or the smallest normal double that prints as written.
    ["-5e-324", -5e-324], ["1e-310", 1e-310], ["2.2250738585072014e-308", 2.2250738585072014e-308],
  ];
  for (const [n, value] of exact) {
    const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(body(n), "application/json")).transport });
    assert.equal((await e.getJson<{ n: number }>("/x")).n, value, n);
  }
});

test("the number check skips strings and costs one pass over the text", async () => {
  // Escaped quotes and backslashes must not end a string early and expose its digits.
  const tricky = `{"id":"a","s":"\\\\\\"12345678901234567890\\\\","t":"1e400","n":[1,2.5,-3e2]}`;
  const e = new RequestEngine({ transport: makeMockTransport(() => rawResponse(tricky, "application/json")).transport });
  assert.deepEqual(await e.getJson("/x"), JSON.parse(tricky));
  // 1 MB of numbers: the scan is linear.
  const big = `[${Array.from({ length: 200_000 }, (_, i) => i * 7).join(",")}]`;
  const f = new RequestEngine({ transport: makeMockTransport(() => rawResponse(big, "application/json")).transport });
  assert.equal((await f.getJson<number[]>("/x")).length, 200_000);
});

test("getJson decodes a body by its declared charset, drops a BOM, rejects an unknown label", async () => {
  const text = "Großhandel µ";
  const latin1 = makeMockTransport(() =>
    rawResponse(Buffer.from(JSON.stringify({ name: text }), "latin1"), "application/json; charset=ISO-8859-1"),
  );
  assert.deepEqual(await new RequestEngine({ transport: latin1.transport }).getJson("/x"), { name: text });
  const bom = makeMockTransport(() =>
    rawResponse(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]), "application/json"),
  );
  assert.deepEqual(await new RequestEngine({ transport: bom.transport }).getJson("/x"), { a: 1 });
  const unknown = makeMockTransport(() => rawResponse('{"a":1}', "application/json; charset=x-nonsense"));
  await assert.rejects(
    () => new RequestEngine({ transport: unknown.transport }).getJson("/x"),
    (e: unknown) => e instanceof SmardParseError && e.message === 'GET https://www.smard.de/x: unsupported response charset "x-nonsense".',
  );
});

test("a timeout, the size cap, a refused connection and a DNS failure name the request", async () => {
  const url = "https://www.smard.de/app/chart_data/410/DE/index_hour.json";
  const path = "/app/chart_data/410/DE/index_hour.json";
  const coded = (message: string, code: string) => Object.assign(new Error(message), { code });
  const cases: Array<[string, () => Promise<never> | never, string]> = [
    ["refused", () => { throw new SmardNetworkError("connect ECONNREFUSED 127.0.0.1:1", { cause: coded("connect ECONNREFUSED 127.0.0.1:1", "ECONNREFUSED") }); }, "connect ECONNREFUSED 127.0.0.1:1"],
    ["dns", () => { throw coded("getaddrinfo ENOTFOUND smard.invalid", "ENOTFOUND"); }, "getaddrinfo ENOTFOUND smard.invalid"],
    ["string", () => { throw "plain string"; }, "plain string"],
  ];
  for (const [name, thrower, reason] of cases) {
    const e = new RequestEngine({ transport: makeMockTransport(thrower).transport, maxRetries: 0 });
    await assert.rejects(e.getJson(path), (err: unknown) => {
      assert.ok(err instanceof SmardNetworkError, name);
      assert.equal(err.message, `GET ${url} failed: ${reason}`, name);
      assert.ok(err.cause !== undefined, name);
      return true;
    });
  }
  // the engine's own deadline
  const slow = new RequestEngine({ transport: () => new Promise(() => {}), timeoutMs: 5 });
  await assert.rejects(slow.getJson(path), (err: unknown) =>
    err instanceof SmardNetworkError && err.message === `GET ${url} failed: Request timed out after 5ms` && err.cause instanceof SmardNetworkError);
  // the size cap, checked by the engine on a custom transport's body: still a SmardResponseTooLargeError
  const big = new RequestEngine({ transport: makeMockTransport(() => rawResponse("x".repeat(20), "application/json")).transport, maxResponseBytes: 10 });
  await assert.rejects(big.getJson(path), (err: unknown) =>
    err instanceof SmardResponseTooLargeError &&
    err.message === `GET ${url} failed: Response exceeded the size limit of 10 bytes (maxResponseBytes; --max-response-bytes on the CLI)`);
  // the default transport's own size-cap error keeps its class too
  const capped = new RequestEngine({ transport: () => Promise.reject(new SmardResponseTooLargeError("Response exceeded the size limit of 10 bytes")) });
  await assert.rejects(capped.getJson(path), (err: unknown) =>
    err instanceof SmardResponseTooLargeError && err.message === `GET ${url} failed: Response exceeded the size limit of 10 bytes`);
  // userinfo is redacted in the named URL
  const mirror = new RequestEngine({
    baseUrl: "https://user:s3cret-pw@mirror.example",
    transport: makeMockTransport(() => { throw coded("connect ECONNREFUSED 10.0.0.1:443", "ECONNREFUSED"); }).transport,
  });
  await assert.rejects(mirror.getJson(path), (err: unknown) =>
    err instanceof SmardNetworkError &&
    err.message === `GET https://***@mirror.example${path} failed: connect ECONNREFUSED 10.0.0.1:443` && !err.message.includes("s3cret"));
});

test("a 503 is retried up to maxRetries then surfaces as SmardApiError", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return jsonResponse({ detail: "busy" }, 503);
  });
  const e = new RequestEngine({
    transport: mt.transport,
    maxRetries: 2,
    sleep: async () => {},
  });
  await assert.rejects(
    () => e.getJson("/x"),
    (err) => err instanceof SmardApiError && err.status === 503,
  );
  assert.equal(calls, 3); // initial + 2 retries
});

test("a retried request that then succeeds resolves", async () => {
  let calls = 0;
  const mt = makeMockTransport(() => {
    calls += 1;
    return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: 1 });
  });
  const e = new RequestEngine({ transport: mt.transport, sleep: async () => {} });
  assert.deepEqual(await e.getJson("/x"), { ok: 1 });
  assert.equal(calls, 2);
});

// ---- Retry-After ----

function retryingEngine(retryAfter: string | undefined, maxRetries = 2) {
  const delays: number[] = [];
  const mt = makeMockTransport(() => ({
    status: 429,
    headers: {
      "content-type": "application/json",
      ...(retryAfter === undefined ? {} : { "retry-after": retryAfter }),
    },
    body: Buffer.from(JSON.stringify({ detail: "slow down" })),
  }));
  const engine = new RequestEngine({
    transport: mt.transport,
    maxRetries,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  return { engine, mt, delays };
}

test("a 429 with Retry-After in seconds waits that long before each retry", async () => {
  const { engine, mt, delays } = retryingEngine("1");
  await assert.rejects(() => engine.getJson("/x"), (e: unknown) => e instanceof SmardApiError && e.status === 429);
  assert.equal(mt.calls.length, 3);
  assert.deepEqual(delays, [1000, 1000]);
});

test("without a usable Retry-After the retries back off linearly", async () => {
  for (const header of [undefined, "", "-1", "1.5", "soon", "1e3", "2026-09-26T10:00:00Z"]) {
    const { engine, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getJson("/x"));
    assert.deepEqual(delays, [200, 400], String(header));
  }
});

test("a Retry-After above MAX_RETRY_AFTER_MS is not retried: the error surfaces at once", async () => {
  for (const header of ["31", "99999999", "99999999999999999999", "Fri, 31 Dec 9999 23:59:59 GMT"]) {
    const { engine, mt, delays } = retryingEngine(header);
    await assert.rejects(() => engine.getJson("/x"), (e: unknown) => e instanceof SmardApiError && e.status === 429);
    assert.equal(mt.calls.length, 1, header);
    assert.deepEqual(delays, [], header);
  }
});

test("parseRetryAfter reads delay-seconds and IMF-fixdate HTTP-dates", () => {
  const now = Date.parse("Sat, 26 Sep 2026 10:00:00 GMT");
  assert.equal(parseRetryAfter("0", now), 0);
  assert.equal(parseRetryAfter(" 30 ", now), 30_000);
  assert.equal(parseRetryAfter(["2", "9"], now), 2000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 10:00:05 GMT", now), 5000);
  assert.equal(parseRetryAfter("Sat, 26 Sep 2026 09:00:00 GMT", now), 0); // past date: retry now
  for (const bad of [undefined, "", "-1", "+5", "1.5", "1e3", "0x10", "Saturday, 26-Sep-26 10:00:05 GMT"]) {
    assert.equal(parseRetryAfter(bad, now), undefined, String(bad));
  }
  assert.equal(MAX_RETRY_AFTER_MS, 30_000);
});

test("error detail is stripped of terminal control characters", async () => {
  // A hostile/MITM'd endpoint returns an error body whose `detail` interleaves
  // ANSI/OSC escape sequences with printable text. JSON.parse decodes the
  // escaped controls into real bytes; run.ts would otherwise print them raw to
  // the terminal via SmardApiError.message.
  const evil = `boom${ESC}[31mred${BEL}${CSI}2J`;
  const mt = makeMockTransport(() => jsonResponse({ detail: evil }, 500));
  const e = new RequestEngine({ transport: mt.transport, maxRetries: 0 });

  await assert.rejects(
    () => e.getJson("/x"),
    (err: unknown) => {
      assert.ok(err instanceof SmardApiError);
      // Control bytes are gone from both the structured detail and the
      // human-readable message run.ts prints to stderr...
      assert.ok(!hasControlChars(err.detail ?? ""));
      assert.ok(!hasControlChars(err.message));
      // ...while the printable characters are preserved.
      // ...while the printable characters are preserved; whole escape sequences go.
      assert.equal(err.detail, "boomred");
      return true;
    },
  );
});

test("the User-Agent and Accept headers are sent", async () => {
  const mt = makeMockTransport(() => jsonResponse({}));
  const e = new RequestEngine({ transport: mt.transport, userAgent: "ua/1" });
  await e.getJson("/x");
  assert.equal(mt.last().headers?.["User-Agent"], "ua/1");
  assert.equal(mt.last().headers?.["Accept"], "application/json");
});

test("cutText never cuts inside a surrogate pair; toWellFormed replaces half a character", () => {
  assert.equal(cutText("ab\u{1f600}cd", 3), "ab");
  assert.equal(cutText("ab\u{1f600}cd", 4), "ab\u{1f600}");
  assert.equal(cutText("short", 10), "short");
  assert.equal(toWellFormed("a\ud83d b\ude00 \u{1f600}"), "a\ufffd b\ufffd \u{1f600}");
});

test("a server detail and a charset label cut to their limits keep the message well-formed", async () => {
  for (const detail of ["\u{1f600}".repeat(400), "a" + "\u{1f600}".repeat(400)]) {
    const engine = new RequestEngine({ transport: async () => jsonResponse({ detail }, 500) });
    await assert.rejects(engine.getJson("/app/x.json"), (err: Error) => {
      assert.equal(toWellFormed(err.message), err.message);
      assert.match(err.message, /…/);
      return true;
    });
  }
  // A custom transport can hand over any header text: a label of 99 units and an emoji.
  const label = "a".repeat(99) + "\u{1f600}";
  const engine = new RequestEngine({ transport: async () => rawResponse("{}", `application/json; charset=${label}`) });
  await assert.rejects(engine.getJson("/app/x.json"), (err: Error) => {
    assert.ok(err instanceof SmardParseError);
    assert.equal(toWellFormed(err.message), err.message);
    return true;
  });
});

test("credentials a server echoes are scrubbed from the error: Basic, user:password, password (L13)", async () => {
  // Node sends the pair UTF-8 encoded, so that is the form a server echoes.
  const basic = Buffer.from("alice:pä ss-pw", "utf8").toString("base64");
  const body = JSON.stringify({ message: `no: Basic ${basic} / alice:pä ss-pw / pä ss-pw` });
  const engine = new RequestEngine({
    baseUrl: "https://alice:p%C3%A4%20ss-pw@127.0.0.1",
    maxRetries: 0,
    transport: async () => ({ status: 401, headers: { "content-type": "application/json" }, body: Buffer.from(body) }),
  });
  await assert.rejects(engine.getJson("/x"), (err: unknown) => {
    assert.ok(err instanceof SmardApiError);
    for (const form of [basic, "alice:pä ss-pw", "pä ss-pw"]) assert.ok(!err.message.includes(form), err.message);
    assert.match(err.message, /no: Basic \*\*\* \/ \*\*\* \/ \*\*\*/);
    return true;
  });
});

test("a header named __proto__ is an ordinary header, never the prototype of the headers read (T12)", async () => {
  // A JavaScript transport may return any object; JSON.parse makes "__proto__" an own key.
  const headers = JSON.parse('{"__proto__":{"content-type":"application/json; charset=x-bogus"}}') as Record<string, string>;
  const e = new RequestEngine({ transport: async () => ({ status: 200, headers, body: Buffer.from('{"a":1}') }) });
  // With the prototype set, its "content-type" was read as the answer's, and the charset refused.
  assert.deepEqual(await e.getJson("/x"), { a: 1 });
  const fetchLike = new Headers([["__proto__", "x"], ["content-type", "application/json"]]);
  const f = new RequestEngine({ transport: async () => ({ status: 200, headers: fetchLike as unknown as Record<string, string>, body: Buffer.from('{"a":1}') }) });
  assert.deepEqual(await f.getJson("/x"), { a: 1 });
});

test("bigIntegerKeys: a declared member's number is its exact literal as a string; others keep the rule (D3)", async () => {
  const body = '{"_version_":1858054135406919680,"small":{"_version_":5},"neg":{"\\u005fversion_":-12345678901234567890},' +
    '"s":{"_version_":"text"},"n":{"_version_":null},"arr":{"_version_":[1]},"t":"\\"_version_\\":1","n2":42}';
  const e = new RequestEngine({
    bigIntegerKeys: new Set(["_version_"]),
    transport: makeMockTransport(() => rawResponse(body, "application/json")).transport,
  });
  assert.deepEqual(await e.getJson("/x"), {
    _version_: "1858054135406919680", small: { _version_: "5" }, neg: { _version_: "-12345678901234567890" },
    s: { _version_: "text" }, n: { _version_: null }, arr: { _version_: [1] }, t: '"_version_":1', n2: 42,
  });
  assert.deepEqual([...e.bigIntegerKeys], ["_version_"]);
  // An undeclared big number is still refused; a declared member doesn't make others exact.
  const other = new RequestEngine({
    bigIntegerKeys: ["_version_"] as unknown as ReadonlySet<string>,
    transport: makeMockTransport(() => rawResponse('{"_version_":1858054135406919680,"id":12345678901234567890}', "application/json")).transport,
  });
  await assert.rejects(other.getJson("/x"), /the number 12345678901234567890 cannot be represented exactly/);
  // Malformed stays malformed: a declared member with a leading zero still fails JSON.parse.
  const malformed = new RequestEngine({ bigIntegerKeys: new Set(["_version_"]), transport: makeMockTransport(() => rawResponse('{"_version_":01}', "application/json")).transport });
  await assert.rejects(malformed.getJson("/x"), /: the answer is not valid JSON\./);
  for (const bad of [new Set([""]), new Set([1]), "x", 5, null]) {
    assert.throws(() => new RequestEngine({ bigIntegerKeys: bad as unknown as ReadonlySet<string> }),
      (err: unknown) => err instanceof SmardValidationError && err.message === "Invalid option bigIntegerKeys: expected a set of non-empty member names.");
  }
  // The option reader copies a set or a list; undefined is none.
  const names = new Set(["a"]);
  const copy = bigIntegerKeysOption(names);
  names.add("b");
  assert.deepEqual([...copy], ["a"]);
  assert.deepEqual([...bigIntegerKeysOption(["x", "y"] as unknown as ReadonlySet<string>)], ["x", "y"]);
  assert.equal(bigIntegerKeysOption(undefined).size, 0);
  // Without declarations the scan is the plain number check.
  assert.equal(firstInexactNumber('{"a":"1e400","b":3e-324}'), "3e-324");
  assert.deepEqual(scanNumbers('{"a":1}'), { json: '{"a":1}', inexact: undefined });
});

test("a malformed response from a custom transport is a SmardNetworkError naming the request, not a TypeError", async () => {
  for (const [response, problem] of [
    [{}, "status is not an HTTP status code"],
    [null, "not an object"],
    [42, "not an object"],
    [{ status: 200 }, "headers is not an object"],
    [{ status: "200", headers: {}, body: Buffer.alloc(0) }, "status is not an HTTP status code"],
    [{ status: 200, headers: {}, body: '{"timestamps":[]}' }, "body is not a Buffer, Uint8Array, other ArrayBuffer view or ArrayBuffer"],
  ] as const) {
    const e = new RequestEngine({
      baseUrl: "https://alice:s3cret@mirror.test",
      transport: async () => response as unknown as HttpResponse,
    });
    await assert.rejects(
      () => e.getJson("/app/chart_data/410/DE/index_hour.json"),
      (err: unknown) =>
        err instanceof SmardNetworkError &&
        err.message ===
          `GET https://***@mirror.test/app/chart_data/410/DE/index_hour.json failed: the transport returned an invalid response (${problem}).`,
      problem,
    );
  }
});

test("an answer error names the request: method and URL, userinfo redacted (D9)", async () => {
  const answers: Array<[string, () => HttpResponse]> = [
    ["not valid JSON", () => rawResponse("<html>", "text/html")],
    ["empty response body", () => rawResponse(" ", "application/json")],
    ["cannot be represented exactly", () => rawResponse('{"n":1e400}', "application/json")],
    ["unsupported response charset", () => rawResponse("{}", "application/json; charset=x-bogus")],
  ];
  for (const [what, respond] of answers) {
    const e = new RequestEngine({ baseUrl: "https://alice:s3cret@mirror.test/smard", transport: makeMockTransport(respond).transport });
    await assert.rejects(e.getJson("/app/x.json", { q: "x" }), (err: unknown) => {
      assert.ok(err instanceof SmardParseError, what);
      assert.ok(err.message.startsWith("GET https://***@mirror.test/smard/app/x.json?q=x: "), err.message);
      assert.ok(err.message.includes(what), err.message);
      assert.ok(!err.message.includes("s3cret"), err.message);
      return true;
    });
  }
  // A proxy's HTML page says what it was.
  const html = new RequestEngine({ transport: makeMockTransport(() => rawResponse("<html>", "text/html; charset=utf-8")).transport });
  await assert.rejects(html.getJson("/x"), {
    message: 'GET https://www.smard.de/x: the answer is not valid JSON (expected JSON, got Content-Type "text/html").',
  });
});

test("text that is not valid is replaced with U+FFFD and reported through onWarning, never silently (D2)", async () => {
  const cases: Array<[string, Buffer, string, unknown, number]> = [
    // A lone surrogate written as an escape (high alone, low alone); a real pair and an escaped backslash stay.
    ["lone escapes", Buffer.from('{"a":"x\\ud800y","b":"\\udc00","c":"\\ud83d\\ude00","d":"\\\\ud800"}'), "application/json", { a: "x\ufffdy", b: "\ufffd", c: "\u{1f600}", d: "\\ud800" }, 2],
    // A lone surrogate in a member name.
    ["lone in a key", Buffer.from('{"\\udbff":1}'), "application/json", { "\ufffd": 1 }, 1],
    // Invalid UTF-8 bytes; a U+FFFD the server sent is not counted.
    ["invalid bytes", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff, 0xc3]), Buffer.from('","b":"\ufffd"}')]), "application/json", { a: "\ufffd\ufffd", b: "\ufffd" }, 2],
    // A byte undefined in a single-byte charset.
    ["iso-8859-3", Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xa5]), Buffer.from('"}')]), "application/json; charset=iso-8859-3", { a: "\ufffd" }, 1],
  ];
  for (const [label, body, type, expected, count] of cases) {
    const warnings: string[] = [];
    const e = new RequestEngine({ onWarning: (m) => warnings.push(m), transport: makeMockTransport(() => rawResponse(body, type)).transport });
    const value = await e.getJson("/app/x.json", { q: "x" });
    assert.deepEqual(value, expected, label);
    assert.ok(!/[\ud800-\udfff]/u.test(JSON.stringify(value)), `${label}: well-formed`);
    assert.deepEqual(warnings, [
      `GET https://www.smard.de/app/x.json?q=x: ${count} ${count === 1 ? "character" : "characters"} of the answer ${count === 1 ? "was" : "were"} not valid text (invalid bytes or a lone surrogate) and replaced with U+FFFD.`,
    ], label);
  }
  // Valid text: no warning; a throwing hook never fails the request.
  const quiet: string[] = [];
  const ok = new RequestEngine({ onWarning: (m) => quiet.push(m), transport: makeMockTransport(() => rawResponse('{"a":"\\u00fc\ufffd"}', "application/json")).transport });
  assert.deepEqual(await ok.getJson("/x"), { a: "ü\ufffd" });
  assert.deepEqual(quiet, []);
  const throwing = new RequestEngine({ onWarning: () => { throw new Error("hook"); }, transport: makeMockTransport(() => rawResponse('"\\ud800"', "application/json")).transport });
  assert.equal(await throwing.getJson("/x"), "\ufffd");
  assert.throws(() => new RequestEngine({ onWarning: "log" as unknown as () => void }), SmardValidationError);
});

test("an answer longer than V8's longest string is a SmardParseError naming the request, not a plain Error (T14)", async (t) => {
  // A real one needs a body of 512 MB and more (possible with maxResponseBytes 0): V8's own
  // error is stood in for, for the body marked by its length.
  const huge = Buffer.from('{"timestamps":[1577836800000]}   ');
  const tooLong = Object.assign(new Error("Cannot create a string longer than 0x1fffffe8 characters"), { code: "ERR_STRING_TOO_LONG" });
  const decode = TextDecoder.prototype.decode;
  t.mock.method(TextDecoder.prototype, "decode", function (this: InstanceType<typeof TextDecoder>, input?: Uint8Array, options?: { stream?: boolean }) {
    if (input !== undefined && input.byteLength === huge.length) throw tooLong;
    return decode.call(this, input, options);
  });
  const toString = Buffer.prototype.toString;
  t.mock.method(Buffer.prototype, "toString", function (this: Buffer, ...args: Parameters<Buffer["toString"]>) {
    if (this.length === huge.length && args[0] === "utf8") throw tooLong;
    return toString.apply(this, args);
  });
  const e = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "application/json")).transport });
  await assert.rejects(e.getJson("/app/chart_data/410/DE/index_hour.json"), (err: unknown) => {
    assert.ok(err instanceof SmardParseError, String(err));
    assert.equal(
      err.message,
      `GET https://www.smard.de/app/chart_data/410/DE/index_hour.json: the answer is too large to read as text (${huge.length} bytes; the longest string is 536870888 characters).`,
    );
    return true;
  });
  // An error status with such a body is still the API error, without the unreadable body.
  const failing = new RequestEngine({ maxResponseBytes: 0, transport: makeMockTransport(() => rawResponse(huge, "text/plain", 500)).transport });
  await assert.rejects(failing.getJson("/x"), (err: unknown) => err instanceof SmardApiError && err.status === 500 && err.body === "");
});

// ---- security audit 2026-10-27 ----

/** The wall time of `run`, in milliseconds. */
async function elapsedMs(run: () => unknown): Promise<number> {
  const start = performance.now();
  await run();
  return performance.now() - start;
}

test("a number with a long run of zeros is refused in linear time (class A)", async () => {
  // 1.<100 000 zeros>1e300 and 1.<…>1e-400 took about 15 s with the trailing-zero regex `/0+$/`,
  // after the answer had arrived, so --timeout did not bound it.
  for (const literal of [`1.${"0".repeat(100_000)}1e300`, `1.${"0".repeat(100_000)}1e-400`]) {
    const engine = new RequestEngine({ transport: async () => rawResponse(`{"meta_data":{"v":${literal}},"series":[]}`, "application/json") });
    let err: unknown;
    const ms = await elapsedMs(async () => (err = await engine.getJson("/x").catch((caught: unknown) => caught)));
    assert.ok(ms < 1000, `${Math.round(ms)} ms`);
    assert.ok(err instanceof SmardParseError && /cannot be represented exactly/.test(err.message), String(err));
    assert.ok(err.message.length < 1000, "the message quotes the literal cut");
  }
  // The same digits and exponent as before: trailing zeros count into the exponent.
  assert.equal(scanNumbers("[1.2300e2, 0.000, 12300]").inexact, undefined);
  assert.equal(scanNumbers("[1.000e-400]").inexact, "1.000e-400");
  assert.equal(scanNumbers("[0.0e-400]").inexact, undefined);
  assert.equal(scanNumbers("[1.2300e30, 1000000000000000000000000]").inexact, undefined);
  assert.equal(scanNumbers("[90071992547409930]").inexact, "90071992547409930");
});

test("redactUrlUserinfo hides every URL's userinfo in one linear pass, however many URLs (class B)", async () => {
  // The URL regex this replaces (a scheme tried at every word start) takes seconds on this.
  assert.ok((await elapsedMs(() => redactUrlUserinfo("a.".repeat(30_000)))) < 1000);
  assert.equal(redactUrlUserinfo("a -https://u:p@h/x and x-ftp://v@w?q, mail@example.org"), "a -https://***@h/x and x-ftp://***@w?q, mail@example.org");
  assert.equal(
    redactUrlUserinfo("argument 'ftp://user:s3cret@h.example' is invalid; also http://a@b@c.example/x?y=u@v"),
    "argument 'ftp://***@h.example' is invalid; also http://***@c.example/x?y=u@v",
  );
  assert.equal(redactUrlUserinfo("1://u:p@h ://u:p@h"), "1://u:p@h ://u:p@h");
  assert.equal(redactUrlUserinfo("https://h/p?u=a@b"), "https://h/p?u=a@b");
  for (const text of ["a".repeat(1_000_000), "a.".repeat(500_000), "://".repeat(100_000), `https://${"u".repeat(1_000_000)}`]) {
    assert.equal(redactUrlUserinfo(text), text);
  }
  const many = redactUrlUserinfo("https://u:p@h ".repeat(100_000));
  assert.equal(many, "https://***@h ".repeat(100_000));
});

function elapsed(work: () => unknown): number {
  const start = performance.now();
  work();
  return performance.now() - start;
}

test("redactUrlUserinfo hides the userinfo of a URL glued onto the one before it, still linear (B2)", () => {
  // The authority read for the first `://` ends at the `/` of the second; the second URL starts
  // inside it (its scheme is the first one's host, or follows a redacted `@`), so the search goes
  // on after each `://`, not after the authority. The regex this replaces redacted both; the
  // first linear pass missed them.
  assert.equal(redactUrlUserinfo("https://host://u:p@h"), "https://host://***@h");
  assert.equal(redactUrlUserinfo("https://u:p@x://v:q@w"), "https://***@x://***@w");
  assert.equal(redactUrlUserinfo("see https://h.example:/x://u:p@h"), "see https://h.example:/x://***@h");
  assert.equal(redactUrlUserinfo("https://u:p@1://v:q@w"), "https://***@1://v:q@w");
  // Many glued URLs, unredacted and redacted, and long scheme-character runs: one pass each.
  const n = 100_000;
  for (const [text, want] of [
    [`${"a://".repeat(n)}u:p@h`, `${"a://".repeat(n)}***@h`],
    ["x://u:p@".repeat(n), "x://***@".repeat(n)],
    [`${"a.".repeat(500_000)}://u:p@h`, `${"a.".repeat(500_000)}://***@h`],
    [`https://${"a.".repeat(500_000)}://u:p@h`, `https://${"a.".repeat(500_000)}://***@h`],
    ["a:".repeat(500_000), "a:".repeat(500_000)],
  ] as const) {
    let got = "";
    const ms = elapsed(() => (got = redactUrlUserinfo(text)));
    assert.ok(got === want, `${text.slice(0, 40)}…`);
    assert.ok(ms < 1000, `${Math.round(ms)} ms on ${text.slice(0, 40)}…`);
  }
});

test("a TextBuilder joins its pieces in order across batches", () => {
  const b = new TextBuilder();
  const expected: string[] = [];
  for (let i = 0; i < 40_000; i++) {
    b.push(String(i), ",");
    expected.push(String(i), ",");
  }
  assert.equal(b.toString(), expected.join(""));
  assert.equal(new TextBuilder().toString(), "");
});

// ---- class C: server text cleaned in linear time and memory ----

test("sanitizeServerText drops whole escape sequences, not just their control bytes", () => {
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  for (const [input, expected] of [
    [`line1 ${ESC}]0;title${BEL}rest`, "line1 rest"],
    [`${ESC}]8;;https://evil.example${ESC}\\click${ESC}]8;;${ESC}\\`, "click"],
    [`${ESC}[31mred${ESC}[0m plain`, "red plain"],
    [`${ESC}[1;31;4mbold`, "bold"],
    [`${CSI}2Jcleared`, "cleared"],
    [`${OSC8}0;t${ST8}ok`, "ok"],
    [`a${ESC}7b${ESC}(Bc`, "abc"],
    // Unterminated: only ESC and its introducer go, the text stays.
    [`keep ${ESC}]0;no terminator here`, "keep 0;no terminator here"],
  ] as const) {
    assert.equal(sanitizeServerText(input), expected, JSON.stringify(input));
  }
});

test("sanitizeServerText drops invisible format characters (zero-width, soft hyphen, BOM)", () => {
  const text = "real\u200b error\u2028Error: forged\u2066x\u2069 \ufeffend\u00ad\u200d\u2060!";
  assert.equal(sanitizeServerText(text), "real error Error: forgedx end!");
});

test("sanitizeServerText keeps ordinary text, umlauts and single spaces", () => {
  assert.equal(sanitizeServerText("  Cannot GET  /app/chart_data/  Größe  "), "Cannot GET /app/chart_data/ Größe");
});

test("sanitizeServerText reads a bounded prefix and drops what the per-character filter dropped", () => {
  // The filter it replaces, one character at a time: C0 but TAB to CR, DEL, C1 and Cf go.
  const perCharacter = (text: string): string =>
    [...text]
      .filter((ch) => {
        const n = ch.codePointAt(0) ?? 0;
        return (n >= 0x09 && n <= 0x0d) || !(n <= 0x1f || (n >= 0x7f && n <= 0x9f) || /\p{Cf}/u.test(ch));
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim();
  const every = Array.from({ length: 0x3000 }, (_, i) => String.fromCharCode(i)).join("") + "\u{1f600}\u{e0001}\ud800x";
  for (let at = 0; at < every.length; at += 512) {
    const piece = every.slice(at, at + 512).replace(/[\u001b\u0090\u0098\u009b-\u009f]/g, "");
    assert.equal(sanitizeServerText(piece), perCharacter(piece), `from U+${at.toString(16)}`);
  }
  // At most 16 384 units of the text are read, never half a surrogate pair.
  assert.equal(sanitizeServerText("x".repeat(100_000)).length, 16_384);
  assert.equal(sanitizeServerText(`${"x".repeat(16_383)}\u{1f600}`), "x".repeat(16_383));
  // A control string ends at another introducer: the first is dropped by the filter, the second
  // string as a whole.
  const OSC8 = String.fromCharCode(0x9d);
  const ST8 = String.fromCharCode(0x9c);
  assert.equal(sanitizeServerText(`a${OSC8}0;x${OSC8}0;t${ST8}b`), "a0;xb");
  assert.equal(sanitizeServerText(`a${ESC}]0;x${ESC}]0;t${BEL}b`), "a0;xb");
});

test("an error detail of unterminated control-string introducers is cleaned in linear time", async () => {
  // The control-string body admitted the introducers that start it: an unterminated run of them
  // was matched from each one to the end (100 000 x U+009D took 16 s).
  for (const intro of ["\u009d", "\u0090", "\u0098", "\u009e", "\u009f", `${ESC}]`]) {
    const engine = new RequestEngine({ transport: async () => jsonResponse({ detail: intro.repeat(100_000) }, 500) });
    const start = performance.now();
    await assert.rejects(engine.getJson("/x"), SmardApiError);
    const ms = performance.now() - start;
    assert.ok(ms < 1000, `${Math.round(ms)} ms for ${JSON.stringify(intro)}`);
  }
});

// These tests start a process with a small heap: 30 s instead of the suite's 5 s.
const STARTS_A_PROCESS = { timeout: 30_000 };

test("scanNumbers quotes millions of declared members within a small heap", STARTS_A_PROCESS, () => {
  // One `+=` per quoted member made a rope node each: 3 million of them exhausted a 128 MB heap.
  const engine = new URL("../src/engine.js", import.meta.url).href;
  const n = 3_000_000;
  const script =
    `const { scanNumbers } = await import(${JSON.stringify(engine)});` +
    `const json = "[" + '{"k":1},'.repeat(${n - 1}) + '{"k":1}]';` +
    `process.stdout.write(String(scanNumbers(json, new Set(["k"])).json.length));`;
  const out = execFileSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(out, String(n * 10 + 1));
});

test("an answer of millions of lone surrogate escapes is repaired within a small heap", STARTS_A_PROCESS, () => {
  // One `+=` per repair made a rope node each: 6 million repairs exhausted a 128 MB heap.
  const engine = new URL("../src/engine.js", import.meta.url).href;
  const n = 6_000_000;
  const script =
    `const { RequestEngine } = await import(${JSON.stringify(engine)});` +
    `const body = Buffer.from('"' + "\\\\ud800".repeat(${n}) + '"');` +
    `const e = new RequestEngine({ transport: async () => ({ status: 200, headers: { "content-type": "application/json" }, body }) });` +
    `const got = await e.getJson("/x");` +
    `process.stdout.write(String(got.length));`;
  const out = execFileSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(out, String(n));
});

// ---- class D: a credential scrubbed from decoded server text ----

// A password with characters a JSON writer escapes (a quote) or may write as \u00XX (an umlaut),
// and one a URL's query percent-encodes but encodeURIComponent doesn't (an apostrophe).
const D_PW = "pä\"s's-W0rd";
const D_BASE = `https://alice:${encodeURIComponent(D_PW)}@mirror.example`;
const D_BASIC = Buffer.from(`alice:${D_PW}`, "utf8").toString("base64");
/** The forms of the credential an error must not carry: decoded, and as a quoted value spells them (`\"`). */
const D_SECRETS = [D_PW, `alice:${D_PW}`, D_BASIC].flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]);

/** Everything a library user may log of an error: inspect, message, detail, and the decoded body. */
function everything(err: unknown): string {
  let text = inspect(err, { depth: 10, showHidden: true });
  const e = err as { message?: unknown; detail?: unknown; body?: unknown };
  text += [e.message, e.detail, e.body].map(String).join("\n");
  let decoded: unknown;
  try {
    decoded = typeof e.body === "string" ? JSON.parse(e.body) : undefined;
  } catch {
    // not JSON: the body as sent is all a caller reads
  }
  const walk = (v: unknown): void => {
    if (typeof v === "string") text += `\n${v}`;
    else if (v !== null && typeof v === "object") {
      for (const [k, w] of Object.entries(v)) {
        text += `\n${k}`;
        walk(w);
      }
    }
  };
  walk(decoded);
  return text;
}

/** `text` as a JSON writer that escapes every non-ASCII character writes it (Python's json.dumps). */
const asciiJson = (text: string): string =>
  JSON.stringify(text).replace(/[\u0080-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
/** `text` with every character written as a \uXXXX escape: no spelling of it as sent matches. */
const escapedJson = (text: string): string => `"${[...text].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")}"`;

test("a credential echoed with JSON escapes is scrubbed from the message, the detail and the decoded body (class D)", async () => {
  const echoes: Array<[string, string]> = [
    ["the password, ASCII-only JSON", asciiJson(`wrong password ${D_PW}`)],
    ["the user:password, minimal JSON", JSON.stringify(`bad login alice:${D_PW}`)],
    ["the password, every character escaped", escapedJson(D_PW)],
    ["the Basic value, PHP-style \\/", JSON.stringify(`bad header Basic ${D_BASIC}`).replaceAll("/", "\\/")],
    ["the request URL as the server decoded it", JSON.stringify(`no access to https://alice:${D_PW}@mirror.example/x`)],
  ];
  for (const status of [401, 500]) {
    for (const key of ["detail", "message"]) {
      for (const [label, json] of echoes) {
        const engine = new RequestEngine({ baseUrl: D_BASE, maxRetries: 0, transport: async () => rawResponse(`{"${key}":${json}}`, "application/json", status) });
        const err = await engine.getJson("/x").catch((caught: unknown) => caught);
        assert.ok(err instanceof SmardApiError && err.message.startsWith(`HTTP ${status} `), `${label}: ${String(err)}`);
        const seen = everything(err);
        for (const secret of D_SECRETS) assert.ok(!seen.includes(secret), `${status} ${key} ${label}: ${seen.slice(0, 2000)}`);
      }
    }
  }
});

test("a password with a TAB or a control character, echoed escaped, is scrubbed before the detail is cleaned", async () => {
  for (const pw of ["dummy\tpass-1234", "dummy\u0001pass-1234", "dummy   pass-1234"]) {
    const engine = new RequestEngine({
      baseUrl: `https://js:${encodeURIComponent(pw)}@mirror.example`,
      maxRetries: 0,
      transport: async () => rawResponse(JSON.stringify({ detail: `wrong password ${pw}` }), "application/json", 401),
    });
    const err = await engine.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof SmardApiError, String(err));
    assert.equal(err.detail, "wrong password ***");
    for (const text of [err.message, err.body]) assert.ok(!/dummy|pass-1234/.test(text), text);
  }
});

test("an error body keeps its spelling unless a credential hides behind an escape", async () => {
  const base = "https://alice:s3cret-pw@mirror.example";
  const bodyOf = async (body: string): Promise<string> => {
    const e = new RequestEngine({ baseUrl: base, maxRetries: 0, transport: async () => rawResponse(body, "application/json", 500) });
    const err = await e.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof SmardApiError, String(err));
    return err.body;
  };
  // No credential, or one spelled as sent: the body as sent (scrubbed), escapes kept.
  assert.equal(await bodyOf('{"m":"caf\\u00e9 \\"x\\""}'), '{"m":"caf\\u00e9 \\"x\\""}');
  assert.equal(await bodyOf('{"m":"pw s3cret-pw \\u00e9"}'), '{"m":"pw *** \\u00e9"}');
  // Escaped: written again decoded, scrubbed in that spelling.
  assert.equal(await bodyOf('{"m":"pw s3cret\\u002dpw \\u00e9"}'), '{"m":"pw *** é"}');
  // Not JSON: nobody decodes it, it stays as sent.
  assert.equal(await bodyOf("pw s3cret\\u002dpw"), "pw s3cret\\u002dpw");
  // Without credentials in the base URL the body is never rewritten.
  const plain = new RequestEngine({ maxRetries: 0, transport: async () => rawResponse('{"m":"x\\u002dy"}', "application/json", 500) });
  const plainErr = await plain.getJson("/x").catch((caught: unknown) => caught);
  assert.ok(plainErr instanceof SmardApiError);
  assert.equal(plainErr.body, '{"m":"x\\u002dy"}');
  // Deeply nested: written again where this runtime can, else left out (probed, not assumed:
  // whether JSON.stringify recurses depends on the Node version).
  const deep = `${"[".repeat(200_000)}"s3cret\\u002dpw"${"]".repeat(200_000)}`;
  let parses = true;
  let writes = true;
  try {
    const value: unknown = JSON.parse(deep);
    try {
      JSON.stringify(value);
    } catch {
      writes = false;
    }
  } catch {
    parses = false;
  }
  if (parses) {
    const body = await bodyOf(deep);
    assert.ok(!body.includes("s3cret"), body.slice(199_990, 200_030));
    assert.equal(body === "", !writes);
  }
});

test("an echo of the request URL as sent is scrubbed, a short password too", async () => {
  // Typed raw; the default transport parses the URL (WHATWG), which spells it `p%22%C3%A4`, and a
  // server echoes it in that spelling.
  const e = new RequestEngine({
    baseUrl: 'https://alice:p"ä@mirror.example',
    maxRetries: 0,
    transport: async (req) => rawResponse(JSON.stringify({ message: `no access: ${new URL(req.url).href}` }), "application/json", 403),
  });
  const err = await e.getJson("/x").catch((caught: unknown) => caught);
  assert.ok(err instanceof SmardApiError, String(err));
  for (const text of [err.message, err.detail ?? "", err.body]) {
    assert.ok(!text.includes("p%22%C3%A4@") && !text.includes('p"ä@'), text);
  }
});

test("a credential a server percent-encodes itself is scrubbed (the user:password, the Basic value)", async () => {
  const encodedForms = [encodeURIComponent(`alice:${D_PW}`), encodeURIComponent(D_BASIC)];
  for (const form of encodedForms) {
    const engine = new RequestEngine({
      baseUrl: D_BASE,
      maxRetries: 0,
      transport: async () => rawResponse(JSON.stringify({ detail: `see https://login.example/?auth=${form}` }), "application/json", 401),
    });
    const err = await engine.getJson("/x").catch((caught: unknown) => caught);
    assert.ok(err instanceof SmardApiError, String(err));
    for (const text of [err.message, err.detail ?? "", err.body]) assert.ok(!text.includes(form), `${form}: ${text}`);
  }
});
