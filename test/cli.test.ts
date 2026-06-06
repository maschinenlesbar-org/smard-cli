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
