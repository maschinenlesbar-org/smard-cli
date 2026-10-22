import { test } from "node:test";
import assert from "node:assert/strict";
import { SmardClient } from "../src/client.js";
import { SmardApiError, SmardParseError, SmardValidationError } from "../src/errors.js";
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

test("latest on an empty index is the answer's error (SmardParseError naming the request), never an invented result", async () => {
  const mt = constantJson({ timestamps: [] });
  await assert.rejects(
    () => clientWith(mt).latest(410, "DE", "hour"),
    (err: unknown) =>
      err instanceof SmardParseError &&
      err.message ===
        "GET https://www.smard.de/app/chart_data/410/DE/index_hour.json: the index lists no windows, so there is no newest window to fetch.",
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
          'GET https://www.smard.de/app/chart_data/410/DE/index_hour.json: unexpected response shape: expected a JSON object with a "timestamps" array.',
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
    (err: unknown) => err instanceof SmardValidationError && /Unsupported scheme "file:"/.test(err.message),
  );
  assert.equal(mt.calls.length, 0);
});

test("a base URL with a query or fragment is rejected at construction (userinfo redacted)", () => {
  for (const base of ["https://www.smard.de/?x=1", "https://u:secret@www.smard.de/#f"]) {
    assert.throws(
      () => new SmardClient({ baseUrl: base, transport: constantJson({}).transport }),
      (err: unknown) =>
        err instanceof SmardValidationError &&
        err.message === "Invalid baseUrl: A base URL cannot have a query (?) or fragment (#)." &&
        !err.message.includes("secret"),
      base,
    );
  }
});

test("a path-steering argument is rejected before any request, never escaped and sent", async () => {
  const mt = constantJson({ timestamps: [1], meta_data: { version: 1, created: 2 }, series: [] });
  const anyC = clientWith(mt) as unknown as {
    timestamps(f: unknown, r: string, res: string): Promise<unknown>;
    series(f: unknown, r: string, res: string, ts: unknown): Promise<unknown>;
    tableData(f: unknown, r: string, ts: unknown): Promise<unknown>;
  };
  for (const call of [
    () => anyC.timestamps(410, "DE", "hour/../../../admin?x="),
    () => anyC.series(410, "DE", "hour/../../secret#", 1),
    () => anyC.series("410/../../other", "DE", "hour", 1),
    () => anyC.tableData(410, "DE", "1/../../../x"),
    () => anyC.timestamps(410, "..", "hour"),
    () => anyC.timestamps("..", "DE", "hour"),
    () => anyC.timestamps(410, ".", "hour"),
  ]) {
    await assert.rejects(call, SmardValidationError);
  }
  assert.equal(mt.calls.length, 0);
});

test("series, latest and tableData return a well-formed file and reject anything else", async () => {
  const good = { meta_data: { version: 1, created: 2 }, series: [[1000, 1.5], [2000, null], [3000, 0]] };
  assert.deepEqual(await clientWith(constantJson(good)).series(410, "DE", "hour", 1000), good);
  for (const body of [null, {}, [], { meta_data: {}, series: [[1000, "1"]] }, { meta_data: {}, series: [[1000]] }]) {
    await assert.rejects(clientWith(constantJson(body)).series(410, "DE", "hour", 1000), SmardParseError, JSON.stringify(body));
    const mt = makeMockTransport((req) =>
      req.url.includes("index_") ? jsonResponse({ timestamps: [1000] }) : jsonResponse(body),
    );
    await assert.rejects(clientWith(mt).latest(410, "DE", "hour"), SmardParseError, JSON.stringify(body));
    await assert.rejects(clientWith(constantJson(body)).tableData(410, "DE", 1000), SmardParseError, JSON.stringify(body));
  }
});

test("a region and a resolution are tokens: sent trimmed and NFC, case kept; an invisible character is refused visibly (D8, D10)", async () => {
  const mt = constantJson({ timestamps: [1577836800000] });
  await clientWith(mt).timestamps(410, " DE " as never, "hour\n" as never);
  assert.equal(mt.last().url, "https://www.smard.de/app/chart_data/410/DE/index_hour.json");
  const data = constantJson({ meta_data: {}, series: [] });
  await clientWith(data).series(410, " DE-LU" as never, " quarterhour " as never, 1577836800000);
  assert.equal(data.last().url, "https://www.smard.de/app/chart_data/410/DE-LU/410_DE-LU_quarterhour_1577836800000.json");
  for (const [call, shown] of [
    [(c: SmardClient) => c.timestamps(410, "D​E" as never, "hour"), 'Invalid region: "D\\u200bE" contains an invisible or control character (U+200B).'],
    [(c: SmardClient) => c.timestamps(410, "DE", "ho­ur" as never), 'Invalid resolution: "ho\\u00adur" contains an invisible or control character (U+00AD).'],
    [(c: SmardClient) => c.timestamps("4​10" as never, "DE", "hour"), 'Invalid filter: "4\\u200b10" contains an invisible or control character (U+200B).'],
    [(c: SmardClient) => c.timestamps(410, "de" as never, "hour"), 'Invalid region "de". Expected one of: DE, AT, LU, DE-LU, DE-AT-LU, 50Hertz, Amprion, TenneT, TransnetBW, APG, Creos.'],
    [(c: SmardClient) => c.timestamps(410, "​" as never, "hour"), "Invalid region: Expected a non-empty value."],
  ] as const) {
    const none = constantJson({});
    await assert.rejects(call(clientWith(none)), (err: unknown) => err instanceof SmardValidationError && err.message === shown, shown);
    assert.equal(none.calls.length, 0);
  }
});
