import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RETRY_AFTER_MS,
  RequestEngine,
  bigIntegerKeysOption,
  firstInexactNumber,
  parseRetryAfter,
  scanNumbers,
} from "../src/engine.js";
import {
  SmardApiError,
  SmardError,
  SmardNetworkError,
  SmardParseError,
  SmardResponseTooLargeError,
  SmardValidationError,
  cutText,
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
      assert.equal(err.detail, "boom[31mred2J");
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
