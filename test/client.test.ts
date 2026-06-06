import { test } from "node:test";
import assert from "node:assert/strict";
import { SmardClient } from "../src/client/client.js";
import { SmardApiError } from "../src/client/errors.js";
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

test("latest returns an empty series when the index is empty", async () => {
  const mt = constantJson({ timestamps: [] });
  const res = await clientWith(mt).latest(410, "DE", "hour");
  assert.deepEqual(res.series, []);
  assert.equal(mt.calls.length, 1); // never fetched a data file
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
