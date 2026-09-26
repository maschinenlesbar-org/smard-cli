import { test } from "node:test";
import assert from "node:assert/strict";
import { SmardClient } from "../src/client/client.js";
import { SmardApiError, SmardError, SmardNetworkError, SmardParseError } from "../src/client/errors.js";
import { makeMockTransport, jsonResponse, constantJson } from "./helpers.js";

function clientWith(mt: ReturnType<typeof makeMockTransport>): SmardClient {
  return new SmardClient({ transport: mt.transport });
}

test("timestamps builds the index path and unwraps the array", async () => {
  const mt = constantJson({ timestamps: [1, 2, 3] });
  const ts = await clientWith(mt).timestamps(410, "DE", "hour");
  assert.deepEqual(ts, [1, 2, 3]);
  assert.equal(new URL(mt.last().url).pathname, "/app/chart_data/410/DE/index_hour.json");
});

test("series builds the data-file path with the duplicated filter/region", async () => {
  const mt = constantJson({ meta_data: { version: 1, created: 2 }, series: [] });
  await clientWith(mt).series(4359, "DE-LU", "quarterhour", 1577836800000);
  assert.equal(
    new URL(mt.last().url).pathname,
    "/app/chart_data/4359/DE-LU/4359_DE-LU_quarterhour_1577836800000.json",
  );
});

test("latest reads the index then fetches the newest window", async () => {
  let call = 0;
  const mt = makeMockTransport((req) => {
    call += 1;
    if (req.url.includes("index_")) return jsonResponse({ timestamps: [10, 20, 30] });
    return jsonResponse({ meta_data: { version: 1, created: 2 }, series: [[30, 5]] });
  });
  const res = await clientWith(mt).latest(410, "DE", "week");
  assert.equal(call, 2);
  assert.deepEqual(res.series, [[30, 5]]);
  assert.equal(
    new URL(mt.last().url).pathname,
    "/app/chart_data/410/DE/410_DE_week_30.json",
  );
});

test("timestamps passes an empty index through as []", async () => {
  const mt = constantJson({ timestamps: [] });
  assert.deepEqual(await clientWith(mt).timestamps(410, "DE", "hour"), []);
});

test("latest on an empty index throws instead of inventing a result", async () => {
  const mt = constantJson({ timestamps: [] });
  await assert.rejects(
    () => clientWith(mt).latest(410, "DE", "hour"),
    (err: unknown) =>
      err instanceof SmardError &&
      !(err instanceof SmardParseError) &&
      err.message ===
        "The index for filter 410, region DE, resolution hour lists no windows, so there is no newest window to fetch.",
  );
  assert.equal(mt.calls.length, 1); // never fetched a data file
});

test("a malformed index body is a SmardParseError, not an empty list", async () => {
  for (const body of [null, [1, 2, 3], {}, { timestamps: null }, { timestamps: { a: 1 } }, "x", 5]) {
    const mt = constantJson(body);
    await assert.rejects(
      () => clientWith(mt).timestamps(410, "DE", "hour"),
      (err: unknown) =>
        err instanceof SmardParseError &&
        err.message ===
          'Unexpected response shape from /app/chart_data/410/DE/index_hour.json: expected a JSON object with a "timestamps" array.',
      JSON.stringify(body),
    );
    await assert.rejects(() => clientWith(mt).latest(410, "DE", "hour"), SmardParseError);
    assert.equal(mt.calls.length, 2, JSON.stringify(body)); // one index request per call, no data file
  }
});

test("a hostile timestamps element cannot steer the follow-up request path", async () => {
  // A hostile/MITM'd origin returns a *string* index element crafted to break
  // out of the intended path when interpolated into the second GET. `latest()`
  // must reject it at the trust boundary and never issue the follow-up request.
  let indexCalls = 0;
  const mt = makeMockTransport((req) => {
    if (req.url.includes("index_")) {
      indexCalls += 1;
      // `"x#"` would strip the `.json` suffix via a URL fragment; `"1/../evil"`
      // would normalise to a different same-origin path.
      return jsonResponse({ timestamps: ["1/../evil"] });
    }
    // If the guard fails, this is the only other response the transport gives.
    return jsonResponse({ meta_data: { version: 1, created: 2 }, series: [] });
  });
  await assert.rejects(
    () => clientWith(mt).latest(410, "DE", "hour"),
    (err) => err instanceof SmardParseError,
  );
  // Only the index was fetched; no follow-up request was steered anywhere.
  assert.equal(indexCalls, 1);
  assert.equal(mt.calls.length, 1);
});

test("timestamps rejects a non-integer element", async () => {
  const mt = constantJson({ timestamps: [10, "20", 30] });
  await assert.rejects(
    () => clientWith(mt).timestamps(410, "DE", "hour"),
    (err) => err instanceof SmardParseError,
  );
});

test("tableData builds the table_data path", async () => {
  const mt = constantJson({ meta_data: { version: 1, created: 2 }, series: [] });
  await clientWith(mt).tableData(122, "DE", 1577836800000);
  assert.equal(
    new URL(mt.last().url).pathname,
    "/app/table_data/122/DE/122_DE_quarterhour_1577836800000.json",
  );
});

test("a 404 raises SmardApiError with status 404", async () => {
  const mt = makeMockTransport(() => jsonResponse({}, 404));
  await assert.rejects(
    () => clientWith(mt).series(410, "DE", "hour", 1),
    (err) => err instanceof SmardApiError && err.status === 404,
  );
});

test("a file: base URL is rejected when the client is constructed, before any request", () => {
  const mt = constantJson({ timestamps: [] });
  assert.throws(
    () => new SmardClient({ baseUrl: "file:///etc/passwd", transport: mt.transport }),
    (err: unknown) => err instanceof SmardNetworkError && /Unsupported protocol "file:"/.test(err.message),
  );
  assert.equal(mt.calls.length, 0);
});

test("a base URL with a query or fragment is rejected at construction (userinfo redacted)", () => {
  for (const base of ["https://www.smard.de/?x=1", "https://u:secret@www.smard.de/#f"]) {
    assert.throws(
      () => new SmardClient({ baseUrl: base, transport: constantJson({}).transport }),
      (err: unknown) =>
        err instanceof SmardNetworkError &&
        /^Base URL must not contain a query or fragment: /.test(err.message) &&
        !err.message.includes("secret"),
      base,
    );
  }
});

test("every path argument is escaped, so a library caller cannot steer the request", async () => {
  const mt = constantJson({ timestamps: [1], meta_data: { version: 1, created: 2 }, series: [] });
  const c = clientWith(mt);
  const anyC = c as unknown as {
    timestamps(f: unknown, r: string, res: string): Promise<unknown>;
    series(f: unknown, r: string, res: string, ts: unknown): Promise<unknown>;
    tableData(f: unknown, r: string, ts: unknown): Promise<unknown>;
  };
  await anyC.timestamps(410, "DE", "hour/../../../admin?x=");
  await anyC.series(410, "DE", "hour/../../secret#", 1);
  await anyC.series("410/../../other", "DE", "hour", 1);
  await anyC.tableData(410, "DE", "1/../../../x");
  const urls = mt.calls.map((r) => new URL(r.url));
  assert.deepEqual(
    urls.map((u) => u.pathname),
    [
      "/app/chart_data/410/DE/index_hour%2F..%2F..%2F..%2Fadmin%3Fx%3D.json",
      "/app/chart_data/410/DE/410_DE_hour%2F..%2F..%2Fsecret%23_1.json",
      "/app/chart_data/410%2F..%2F..%2Fother/DE/410%2F..%2F..%2Fother_DE_hour_1.json",
      "/app/table_data/410/DE/410_DE_quarterhour_1%2F..%2F..%2F..%2Fx.json",
    ],
  );
  assert.ok(urls.every((u) => u.search === "" && u.hash === ""));
});

test("a . or .. path segment is refused before any request", async () => {
  const mt = constantJson({ timestamps: [1] });
  const anyC = clientWith(mt) as unknown as {
    timestamps(f: unknown, r: string, res: string): Promise<unknown>;
  };
  for (const [f, r] of [[410, ".."], ["..", "DE"], [410, "."]] as const) {
    await assert.rejects(
      () => anyC.timestamps(f, r, "hour"),
      (err: unknown) =>
        err instanceof SmardError && /^Invalid path segment "\.{1,2}" in \/app\/chart_data\//.test(err.message),
    );
  }
  assert.equal(mt.calls.length, 0);
});
