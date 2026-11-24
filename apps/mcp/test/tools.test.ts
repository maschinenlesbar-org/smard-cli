// This server's tools against a mock of SMARD (the client's answers recorded on 2026-11-19), with
// the skills' traps as cases: each tool answers through the protocol (its structuredContent checked
// by the SDK against its output schema), the mix is the newest settled day without nuclear and
// pumped storage, prices are compared on a day's averages and a zone not published is said, a
// series over two windows is stitched and paged, a name several series fit is ambiguous, a series
// SMARD hasn't is empty saying so, and every result carries the files it read and the CC BY 4.0
// attribution. The rules every server follows are the conformance tests (M1-M10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { listTools } from "../src/mcp/server.js";
import { SIZE_HINT, TOOLS } from "../src/mcp/tools.js";
import { connect, recorder } from "./harness.js";
import { makeMockTransport, rawResponse, SERIES, smardApi } from "./helpers.js";

const BASE = "https://www.smard.de/app";

test("five tools: the three use cases, then the series catalogue and the windows", () => {
  assert.deepEqual(listTools().map((t) => t.name), ["getGenerationMix", "getPrices", "getSeries", "listSeries", "listWindows"]);
});

test("getGenerationMix: the newest settled day, renewable share, no nuclear, pumped storage apart; the files and the attribution", async () => {
  const connection = await connect({ transport: smardApi() });
  const result = await connection.call("getGenerationMix", {});
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  assert.deepEqual(content["period"], { start: "2026-11-18T00:00+01:00", label: "2026-11-18" });
  assert.equal(content["renewableShare"], 77.1);
  assert.deepEqual((content["ended"] as { id: number }[]).map((e) => e.id), [1224]);
  assert.equal((content["pumpedStorage"] as { mwh: number }).mwh, 14629.06);
  assert.equal(content["window"], undefined, "the window only makes the source");
  assert.equal(content["source"], `${BASE}/chart_data/{1223,4069,4071,1227,4067,1225,4068,4066,1226,1228,4070}/DE/{id}_DE_day_1767222000000.json`);
  assert.match(String(content["licence"]), /^Data: Bundesnetzagentur \| SMARD\.de, licensed under CC BY 4\.0 \(https:\/\/creativecommons\.org\/licenses\/by\/4\.0\/\)/);
  await connection.close();
});

test("getGenerationMix: a period not published yet is empty with the reason; a bad at is a tool error before any request", async () => {
  const transport = smardApi();
  const connection = await connect({ transport });
  const future = (await connection.call("getGenerationMix", { at: "2026-11-25" })).structuredContent ?? {};
  assert.equal(future["status"], "empty");
  assert.match(String(future["reason"]), /No settled day data for 2026-11-25/);
  const before = transport.calls.length;
  const bad = await connection.call("getGenerationMix", { at: "18.11.2026" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0]?.text ?? "", /Invalid at "18\.11\.2026"\. Expected a Berlin date/);
  assert.equal(transport.calls.length, before);
  await connection.close();
});

test("getPrices: a past day's low, high and average per zone, ranked on the averages; region DE-LU for every zone", async () => {
  const transport = smardApi();
  const connection = await connect({ transport });
  const result = await connection.call("getPrices", { zones: ["DE-LU", "Frankreich", "AT"], day: "2026-11-18" });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  const zones = content["zones"] as { zone: string; slots: number; current?: unknown; min: { time: string } }[];
  assert.deepEqual(zones.map((z) => [z.zone, z.slots]), [["DE-LU", 96], ["FR", 96], ["AT", 96]]);
  assert.equal(zones[0]?.current, undefined, "no current price for another day");
  assert.match(zones[0]?.min.time ?? "", /^2026-11-18T\d\d:\d\d\+01:00$/);
  assert.equal((content["comparison"] as { basis: string }).basis, "the day's average");
  assert.ok(transport.calls.every((c) => c.url.includes("/DE-LU/")));
  assert.equal(content["source"], `${BASE}/chart_data/{4169,254,4170}/DE-LU/{id}_DE-LU_quarterhour_1794783600000.json`);
  await connection.close();
});

test("getPrices: a name several zones fit is ambiguous; an unknown zone is a tool error", async () => {
  const connection = await connect({ transport: smardApi() });
  const denmark = (await connection.call("getPrices", { zones: ["Dänemark"] })).structuredContent ?? {};
  assert.equal(denmark["status"], "ambiguous");
  assert.deepEqual((denmark["candidates"] as { zone: string }[]).map((c) => c.zone), ["DK1", "DK2"]);
  const mars = await connection.call("getPrices", { zones: ["Mars"] });
  assert.equal(mars.isError, true);
  assert.match(mars.content[0]?.text ?? "", /no bidding zone of that name/);
  await connection.close();
});

test("getSeries: two windows stitched, keyed by the UTC instant, paged; the files read are the source", async () => {
  const connection = await connect({ transport: smardApi() });
  const result = await connection.call("getSeries", { series: "Netzlast", from: "2026-11-14", to: "2026-11-16", limit: 24 });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  assert.equal(content["total"], 72);
  assert.equal(content["nextOffset"], 24);
  assert.deepEqual((content["rows"] as { time: string }[])[0], { time: "2026-11-13T23:00:00Z", value: 48558.18 });
  assert.equal(content["header"], "timestamp_utc,Total grid load (MWh)");
  assert.equal(content["source"], `${BASE}/chart_data/410/DE/410_DE_hour_{1794178800000,1794783600000}.json`);
  await connection.close();
});

test("getSeries: 'wind' is ambiguous with the candidates; a series SMARD hasn't is empty naming what was asked", async () => {
  const connection = await connect({ transport: smardApi() });
  const wind = (await connection.call("getSeries", { series: "wind" })).structuredContent ?? {};
  assert.equal(wind["status"], "ambiguous");
  assert.equal((wind["candidates"] as unknown[]).length, 5);
  const missing = (await connection.call("getSeries", { series: "99999" })).structuredContent ?? {};
  assert.equal(missing["status"], "empty");
  assert.match(String(missing["reason"]), /SMARD publishes no series 99999 for region DE at resolution hour \(HTTP 404\)/);
  assert.equal(missing["source"], `${BASE}/chart_data/99999/DE/index_hour.json`);
  await connection.close();
});

test("listSeries and listWindows answer through the protocol", async () => {
  const connection = await connect({ transport: smardApi() });
  const prices = (await connection.call("listSeries", { group: "price" })).structuredContent ?? {};
  assert.equal((prices["series"] as unknown[]).length, 15);
  assert.equal(prices["source"], "https://smard.api.bund.dev/");
  const windows = (await connection.call("listWindows", { series: "pv", resolution: "day", limit: 2 })).structuredContent ?? {};
  assert.equal(windows["status"], "ok");
  assert.equal(windows["total"], 12);
  assert.equal(windows["nextOffset"], 2);
  assert.equal(windows["oldest"], "2015-01-01");
  assert.equal(windows["source"], `${BASE}/chart_data/4068/DE/index_day.json`);
  await connection.close();
});

test("a base URL that reaches no SMARD is a tool error and a WARN record, never an empty 'no such series' answer", async () => {
  const log = recorder();
  const connection = await connect({ transport: makeMockTransport(() => rawResponse("<html>Seite nicht gefunden</html>", "text/html", 404)), log: log.log });
  for (const [tool, args] of [["listWindows", { series: "410" }], ["getSeries", { series: "Netzlast" }], ["getPrices", {}], ["getGenerationMix", {}]] as const) {
    const result = await connection.call(tool, args);
    assert.equal(result.isError, true, `${tool}: ${result.content[0]?.text}`);
    assert.match(result.content[0]?.text ?? "", /HTTP 404 for GET .*grid load \(410, DE, hour\), which SMARD always has, is a 404 too: the base URL is wrong/);
  }
  assert.ok(log.lines.some((line) => /WARN  \[smard-mcp\.api\] getSeries: HTTP 404/.test(line)), log.lines.join("\n"));
  await connection.close();
});

test("getGenerationMix for a control area without some sources answers the others and names the absent ones", async () => {
  const transnet = Object.fromEntries([4069, 4071, 1227, 4067, 4068, 4066, 1226, 1228, 4070].map((id) => [`${id}/TransnetBW/day`, SERIES[`${id}/DE/day`]]));
  const connection = await connect({ transport: smardApi(transnet) });
  const result = await connection.call("getGenerationMix", { region: "TransnetBW" });
  const content = result.structuredContent ?? {};
  assert.equal(content["status"], "ok", result.content[0]?.text);
  assert.deepEqual(content["absent"], [{ id: 1223, name: "Braunkohle" }, { id: 1225, name: "Wind Offshore" }]);
  await connection.close();
});

test("getGenerationMix cites the files it read: nuclear's when nuclear counts, none of a source SMARD hasn't", async () => {
  const start = 1672527600000; // 2023-01-01 Berlin
  const year: Record<string, unknown> = {};
  for (const id of [1223, 4069, 4071, 1227, 1224, 4067, 1225, 4068, 4066, 1226, 1228, 4070]) year[`${id}/DE/year`] = { index: [start], windows: { [String(start)]: [start, 86_400_000, [100]] } };
  const connection = await connect({ transport: smardApi(year as never) });
  const nuclear = (await connection.call("getGenerationMix", { resolution: "year", at: "2023" })).structuredContent ?? {};
  assert.equal(nuclear["status"], "ok");
  assert.equal(nuclear["source"], `${BASE}/chart_data/{1223,4069,4071,1227,1224,4067,1225,4068,4066,1226,1228,4070}/DE/{id}_DE_year_${start}.json`);
  await connection.close();
  const transnet = Object.fromEntries([4069, 4071, 1227, 4067, 4068, 4066, 1226, 1228, 4070].map((id) => [`${id}/TransnetBW/day`, SERIES[`${id}/DE/day`]]));
  const bw = await connect({ transport: smardApi(transnet) });
  const mix = (await bw.call("getGenerationMix", { region: "TransnetBW" })).structuredContent ?? {};
  assert.equal(mix["source"], `${BASE}/chart_data/{4069,4071,1227,4067,4068,4066,1226,1228,4070}/TransnetBW/{id}_TransnetBW_day_1767222000000.json`);
  await bw.close();
});

test("an empty getSeries or listWindows answer cites the index of the series the name resolved to, or the catalogue when none was read", async () => {
  const connection = await connect({ transport: smardApi() });
  for (const tool of ["getSeries", "listWindows"]) {
    const pv = (await connection.call(tool, { series: "pv" })).structuredContent ?? {};
    assert.equal(pv["status"], "empty", tool);
    assert.equal(pv["source"], `${BASE}/chart_data/4068/DE/index_hour.json`, tool);
    const none = (await connection.call(tool, { series: "Kaffee" })).structuredContent ?? {};
    assert.equal(none["status"], "empty", tool);
    assert.equal(none["source"], "https://smard.api.bund.dev/", tool);
    const wind = (await connection.call(tool, { series: "wind" })).structuredContent ?? {};
    assert.equal(wind["source"], "https://smard.api.bund.dev/", tool);
  }
  await connection.close();
});

test("an offset past the end of the list says so in a note, with how many there are", async () => {
  const connection = await connect({ transport: smardApi() });
  const rows = (await connection.call("getSeries", { series: "410", from: "2026-11-14", to: "2026-11-16", offset: 99_999 })).structuredContent ?? {};
  assert.deepEqual(rows["rows"], []);
  assert.match((rows["notes"] as string[]).join(" "), /offset 99999 is past the end: there are 72 rows \(offsets 0-71\)/);
  const windows = (await connection.call("listWindows", { series: "pv", resolution: "day", offset: 12 })).structuredContent ?? {};
  assert.deepEqual(windows["windows"], []);
  assert.match((windows["notes"] as string[]).join(" "), /offset 12 is past the end: there are 12 windows \(offsets 0-11\)/);
  await connection.close();
});

test("the deadline's and the size cap's advice fit every tool: each option named with the tools that take it", async () => {
  const hanging = { transport: (): Promise<never> => new Promise<never>(() => {}) };
  const connection = await connect({ transport: hanging, config: { callTimeoutMs: 30 } });
  const deadline = (await connection.call("getGenerationMix", {})).content[0]?.text ?? "";
  await connection.close();
  assert.match(deadline, /took longer than .* and was stopped/);
  const schemas = new Map(TOOLS.map((tool) => [tool.name, Object.keys((tool.inputSchema as { properties: Record<string, unknown> }).properties)]));
  for (const text of [deadline, SIZE_HINT]) {
    assert.match(text, /getGenerationMix/, "the mix, which takes none of the options, is named");
    const pairs = [...text.matchAll(/(\w+(?: or \w+)*) \((\w+(?:, \w+)*)\)/g)];
    assert.ok(pairs.length >= 2, text);
    for (const [, options, tools] of pairs) {
      for (const tool of (tools as string).split(", ")) {
        for (const option of (options as string).split(" or ")) assert.ok(schemas.get(tool)?.includes(option), `${tool} takes no ${option}: ${text}`);
      }
    }
    const named = new Set(pairs.flatMap(([, options]) => (options as string).split(" or ")));
    for (const option of ["resolution", "limit", "offset", "zones", "nulls", "query", "group", "region"]) {
      assert.ok(!new RegExp(`\\b${option}\\b`).test(text) || named.has(option), `${option} named without its tools: ${text}`);
    }
  }
});
