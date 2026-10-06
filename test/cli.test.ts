import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "../src/cli/run.js";
import { SmardClient } from "../src/client/client.js";
import type { CliDeps } from "../src/cli/io.js";
import type { HttpRequest, HttpResponse } from "../src/client/http.js";
import { SmardNetworkError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse } from "./helpers.js";

function makeCli(responder: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>) {
  const out: string[] = [];
  const err: string[] = [];
  const mt = makeMockTransport(responder);

  const deps: CliDeps = {
    io: {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    },
    createClient: (opts) => new SmardClient({ ...opts, transport: mt.transport }),
  };
  return { deps, out, err, mt };
}

test("timestamps hits the index path", async () => {
  const cli = makeCli(() => jsonResponse({ timestamps: [1, 2] }));
  const code = await run(["timestamps", "410", "DE", "hour"], cli.deps);
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(cli.out.join("\n")), [1, 2]);
  assert.equal(new URL(cli.mt.last().url).pathname, "/app/chart_data/410/DE/index_hour.json");
});

test("series builds the data-file path", async () => {
  const cli = makeCli(() => jsonResponse({ meta_data: { version: 1, created: 2 }, series: [] }));
  await run(["series", "4068", "DE", "day", "1577836800000"], cli.deps);
  assert.equal(
    new URL(cli.mt.last().url).pathname,
    "/app/chart_data/4068/DE/4068_DE_day_1577836800000.json",
  );
});

test("an invalid region is rejected before any request", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["timestamps", "410", "XX", "hour"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid region/);
});

test("an invalid resolution is rejected before any request", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["timestamps", "410", "DE", "fortnight"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid resolution/);
});

test("a non-integer filter is rejected before any request", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["timestamps", "abc", "DE", "hour"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid filter/);
});

test("filters --group filters the catalogue", async () => {
  const cli = makeCli(() => jsonResponse({}));
  await run(["--compact", "filters", "--group", "consumption"], cli.deps);
  const parsed = JSON.parse(cli.out.join("\n")) as { group: string }[];
  assert.ok(parsed.length > 0);
  assert.ok(parsed.every((f) => f.group === "consumption"));
});

test("a 404 from the API maps to exit code 4", async () => {
  const cli = makeCli(() => jsonResponse({}, 404));
  const code = await run(["series", "410", "DE", "hour", "1"], cli.deps);
  assert.equal(code, 4);
});

test("an exponent-notation timestamp is rejected before any request", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["series", "410", "DE", "hour", "1e21"], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid timestamp/);
});

test("an empty timestamp is rejected and not silently coerced to 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["series", "410", "DE", "hour", ""], cli.deps);
  assert.notEqual(code, 0);
  assert.equal(cli.mt.calls.length, 0);
  assert.match(cli.err.join("\n"), /Invalid timestamp/);
});

test("latest reads the index then fetches the newest window", async () => {
  const cli = makeCli((req) => {
    if (req.url.includes("index_")) return jsonResponse({ timestamps: [10, 20, 30] });
    return jsonResponse({ meta_data: { version: 1, created: 2 }, series: [] });
  });
  const code = await run(["latest", "410", "DE", "week"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.calls.length, 2);
  assert.equal(
    new URL(cli.mt.last().url).pathname,
    "/app/chart_data/410/DE/410_DE_week_30.json",
  );
});

test("table hits the table_data quarterhour path", async () => {
  const cli = makeCli(() => jsonResponse({ meta_data: { version: 1, created: 2 }, series: [] }));
  const code = await run(["table", "410", "DE", "1577836800000"], cli.deps);
  assert.equal(code, 0);
  assert.equal(
    new URL(cli.mt.last().url).pathname,
    "/app/table_data/410/DE/410_DE_quarterhour_1577836800000.json",
  );
});

test("DEL and C1 control characters in server data are escaped in the JSON output", async () => {
  const controls = String.fromCharCode(0x7f, 0x85, 0x9b) + "2J";
  const served = {
    meta_data: { version: 1, created: 2, note: `Strom${controls}`, esc: String.fromCharCode(0x1b) + "[31m" },
    series: [[1577836800000, 42]],
  };
  for (const format of [[], ["--compact"]]) {
    const cli = makeCli(() => jsonResponse(served));
    assert.equal(await run([...format, "series", "4068", "DE", "day", "1577836800000"], cli.deps), 0);
    const text = cli.out.join("\n");
    const raw = [...text].filter((c) =>
      c.charCodeAt(0) < 0x20 ? c !== "\n" : c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f,
    );
    assert.deepEqual(raw, [], format.join(" "));
    assert.match(text, /Strom\\u007f\\u0085\\u009b2J/);
    assert.deepEqual(JSON.parse(text), served);
  }
});

test("a network error maps to exit code 1", async () => {
  const cli = makeCli(() => {
    throw new SmardNetworkError("connection refused");
  });
  const code = await run(["timestamps", "410", "DE", "hour"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /Error: connection refused/);
});

test("a malformed JSON response maps to exit code 1", async () => {
  const cli = makeCli(() => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from("not json"),
  }));
  const code = await run(["timestamps", "410", "DE", "hour"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /Error:/);
});

test("global options propagate into the client via toEngineOptions", async () => {
  const cli = makeCli(() => jsonResponse({ timestamps: [] }));
  const code = await run(
    ["--user-agent", "probe/9", "--timeout", "1234", "timestamps", "410", "DE", "hour"],
    cli.deps,
  );
  assert.equal(code, 0);
  assert.equal(cli.mt.last().headers?.["User-Agent"], "probe/9");
  assert.equal(cli.mt.last().timeoutMs, 1234);
});

test("--timeout accepts up to the largest timer Node supports", async () => {
  const cli = makeCli(() => jsonResponse({ timestamps: [] }));
  assert.equal(await run(["--timeout", "2147483647", "timestamps", "410", "DE", "hour"], cli.deps), 0);
  assert.equal(cli.mt.last().timeoutMs, 2_147_483_647);

  const over = makeCli(() => jsonResponse({ timestamps: [] }));
  assert.equal(await run(["--timeout", "2147483648", "timestamps", "410", "DE", "hour"], over.deps), 1);
  assert.equal(over.mt.calls.length, 0); // rejected before any request
  assert.match(over.err.join("\n"), /Must be <= 2147483647/);
});

test("no command prints help to stdout and exits 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run([], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.mt.calls.length, 0); // never touched the network
  assert.equal(cli.err.length, 0); // help went to stdout, not stderr
  assert.match(cli.out.join("\n"), /Usage: smard/);
});

test("global options without a command still show help on stdout, exit 0", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["--compact", "--timeout", "5000"], cli.deps);
  assert.equal(code, 0);
  assert.equal(cli.err.length, 0);
  assert.match(cli.out.join("\n"), /Usage: smard/);
});

test("an unknown command still errors on stderr with exit 1", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["boguscmd"], cli.deps);
  assert.equal(code, 1);
  assert.equal(cli.out.length, 0);
  assert.match(cli.err.join("\n"), /unknown command 'boguscmd'/);
});

test("an unknown option (no command) still errors with exit 1", async () => {
  const cli = makeCli(() => jsonResponse({}));
  const code = await run(["--bogus-opt"], cli.deps);
  assert.equal(code, 1);
  assert.match(cli.err.join("\n"), /unknown option '--bogus-opt'/);
});

test("a non-http(s) or malformed --base-url is a usage error before any request", async () => {
  for (const bad of ["file:///etc/passwd", "ftp://example.org", "notaurl"]) {
    const cli = makeCli(() => jsonResponse({ timestamps: [] }));
    const code = await run(["--base-url", bad, "timestamps", "410", "DE", "hour"], cli.deps);
    assert.notEqual(code, 0, bad);
    assert.equal(cli.mt.calls.length, 0, `${bad} must not reach the transport`);
    assert.match(cli.err.join("\n"), /--base-url/, bad);
  }
});

test("a malformed index body exits 1 with a parse error, never [] or an invented result", async () => {
  for (const cmd of ["timestamps", "latest"]) {
    for (const body of [null, [1, 2, 3], {}, { timestamps: null }]) {
      const cli = makeCli(() => jsonResponse(body));
      const code = await run(["--compact", cmd, "9", "DE", "hour"], cli.deps);
      assert.equal(code, 1, `${cmd} ${JSON.stringify(body)}`);
      assert.deepEqual(cli.out, []);
      assert.match(cli.err.join("\n"), /Unexpected response shape from .*index_hour\.json/);
    }
  }
});

test("latest on an empty index exits 1 and prints nothing on stdout", async () => {
  const cli = makeCli(() => jsonResponse({ timestamps: [] }));
  const code = await run(["latest", "410", "DE", "hour"], cli.deps);
  assert.equal(code, 1);
  assert.deepEqual(cli.out, []);
  assert.match(cli.err.join("\n"), /lists no windows/);
  assert.equal(cli.mt.calls.length, 1);
});

test("--max-retries is bounded to 0..10", async () => {
  for (const [value, ok] of [["0", true], ["10", true], ["11", false], ["99999999999", false]] as const) {
    const cli = makeCli(() => jsonResponse({ timestamps: [1] }));
    const code = await run(["--max-retries", value, "timestamps", "410", "DE", "hour"], cli.deps);
    assert.equal(code, ok ? 0 : 1, value);
    if (!ok) {
      assert.match(cli.err.join("\n"), /Must be <= 10\./);
      assert.equal(cli.mt.calls.length, 0);
    }
  }
});

test("--base-url with a query or fragment is a usage error before any request", async () => {
  for (const base of ["http://127.0.0.1:18132/prefix?x=1", "http://127.0.0.1:18132/prefix#frag"]) {
    const cli = makeCli(() => jsonResponse({ timestamps: [1] }));
    const code = await run(["--base-url", base, "series", "99", "DE", "hour", "1"], cli.deps);
    assert.equal(code, 1, base);
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), /A base URL cannot have a query \(\?\) or fragment \(#\)\./);
  }
});

test("userinfo in --base-url is sent but redacted in error messages", async () => {
  const cli = makeCli(() => jsonResponse({}, 404));
  const code = await run(["--base-url", "http://user:secretpw@127.0.0.1:18132", "series", "21", "DE", "hour", "1"], cli.deps);
  assert.equal(code, 4);
  assert.ok(cli.mt.last().url.startsWith("http://user:secretpw@127.0.0.1:18132/"));
  const stderr = cli.err.join("\n");
  assert.ok(!stderr.includes("secretpw"), stderr);
  assert.match(stderr, /^Error: HTTP 404 for GET http:\/\/\*\*\*@127\.0\.0\.1:18132\/app\/chart_data\/21\/DE\/21_DE_hour_1\.json$/);
});

test("--user-agent rejects blank, control-character and non-Latin-1 values before any request", async () => {
  for (const [ua, msg] of [
    ["", /Expected a non-empty value\./],
    ["  ", /Expected a non-empty value\./],
    ["a\r\nX-Injected: 1", /Value contains control characters\./],
    ["smard \u{1F642}", /Value contains characters outside Latin-1 \(above U\+00FF\)\./],
  ] as const) {
    const cli = makeCli(() => jsonResponse({ timestamps: [1] }));
    const code = await run(["--user-agent", ua, "timestamps", "410", "DE", "hour"], cli.deps);
    assert.equal(code, 1, JSON.stringify(ua));
    assert.equal(cli.mt.calls.length, 0);
    assert.match(cli.err.join("\n"), msg);
  }
  const cli = makeCli(() => jsonResponse({ timestamps: [1] }));
  assert.equal(await run(["--user-agent", "smard-t\u00fcv\t1", "timestamps", "410", "DE", "hour"], cli.deps), 0);
  assert.equal(cli.mt.last().headers?.["User-Agent"], "smard-t\u00fcv\t1");
});

test("a malformed data file exits 1 with a parse error, never printed as a result", async () => {
  // The bodies a mirror, a proxy or a changed format answered with in the 2026-10-05 sweep:
  // the price-watch recipe named "80" the dearest price, the README sum skipped [2000].
  const meta = { version: 1, created: 2 };
  const bodies: unknown[] = [
    null,
    {},
    [],
    "text",
    { error: "maintenance", series: null },
    { meta_data: meta, series: "oops" },
    { meta_data: meta, series: [[1000, "120.5"], [2000, "80"], [3000, 5]] },
    { meta_data: meta, series: [[1000, 20], [2000], [3000, 20]] },
    { meta_data: meta, series: [[1000, 20, 30]] },
    { meta_data: meta, series: [null] },
    { meta_data: meta, series: [[-5, 1]] },
    { meta_data: meta, series: [[1.5, 1]] },
    { series: [[1000, 1]] },
  ];
  for (const body of bodies) {
    for (const argv of [
      ["series", "830", "DE", "hour", "1000"],
      ["latest", "836", "DE", "hour"],
    ]) {
      const cli = makeCli((req) =>
        req.url.includes("index_") ? jsonResponse({ timestamps: [1000] }) : jsonResponse(body),
      );
      const code = await run(["--compact", ...argv], cli.deps);
      assert.equal(code, 1, `${argv[0]} ${JSON.stringify(body)}`);
      assert.deepEqual(cli.out, [], `${argv[0]} ${JSON.stringify(body)}`);
      assert.match(cli.err.join("\n"), /^Error: (Unexpected response shape|Malformed data file) from \/app\/chart_data\//);
    }
  }
});

test("a malformed table_data file exits 1 with a parse error", async () => {
  const meta = { version: 1, created: 2 };
  const bodies: unknown[] = [
    null,
    {},
    42,
    { meta_data: meta, series: [[1000, 1]] },
    { meta_data: meta, series: [{ values: [{ timestamp: 1000, versions: [{ value: "1", name: 1 }] }] }] },
    { meta_data: meta, series: [{ values: [{ timestamp: "1000", versions: [] }] }] },
    { meta_data: meta, series: [{ values: null }] },
  ];
  for (const body of bodies) {
    const cli = makeCli(() => jsonResponse(body));
    const code = await run(["--compact", "table", "835", "DE", "1000"], cli.deps);
    assert.equal(code, 1, JSON.stringify(body));
    assert.deepEqual(cli.out, []);
    assert.match(cli.err.join("\n"), /^Error: (Unexpected response shape|Malformed table_data file) from \/app\/table_data\//);
  }
  // The live shape, extra keys included, passes unchanged.
  const live = {
    meta_data: { version: 1, created: 1698904671988 },
    series: [{ values: [{ timestamp: 1698012000000, versions: [{ value: 10788.75, name: 1 }, { value: null, name: 2, info: "x" }] }] }],
  };
  const cli = makeCli(() => jsonResponse(live));
  assert.equal(await run(["--compact", "table", "410", "DE", "1698012000000"], cli.deps), 0);
  assert.deepEqual(JSON.parse(cli.out.join("\n")), live);
});

test("a negative timestamp in the index is the server's malformed index, never the user's input (04#2)", async () => {
  for (const argv of [
    ["timestamps", "817", "DE", "hour"],
    ["latest", "817", "DE", "hour"],
  ]) {
    const cli = makeCli(() => jsonResponse({ timestamps: [-5] }));
    const code = await run(argv, cli.deps);
    assert.equal(code, 1, argv[0]);
    assert.deepEqual(cli.out, []);
    assert.match(cli.err.join("\n"), /^Error: Malformed index from \/app\/chart_data\/817\/DE\/index_hour\.json: "timestamps" contains an element that is not a non-negative integer\.$/);
    assert.doesNotMatch(cli.err.join("\n"), /Invalid timestamp/);
    assert.equal(cli.mt.calls.length, 1, "no data file is requested");
  }
});

test("the catalogue commands make no request and never warn about a plain-http: base URL", async () => {
  for (const argv of [["filters"], ["regions"], ["resolutions"]]) {
    const out: string[] = [];
    const err: string[] = [];
    let requests = 0;
    const code = await run(["--base-url", "http://mirror.example", ...argv], {
      io: { out: (s) => out.push(s), err: (s) => err.push(s) },
      createClient: (opts) => new SmardClient({ ...opts, transport: async () => { requests++; throw new Error("no request expected"); } }),
    });
    assert.equal(code, 0, err.join("\n"));
    assert.equal(requests, 0);
    assert.deepEqual(err, []);
  }
});
