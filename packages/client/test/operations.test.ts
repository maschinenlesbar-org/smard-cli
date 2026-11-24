// The use cases (operations.ts) against a mock of SMARD (fixtures.ts, answers recorded on
// 2026-11-19), with the skills' traps as cases: the null tail of the newest window (the last
// settled point is the last non-null one), periods named by their Berlin date (a day starts at
// 23:00Z the day before), nuclear left out since April 2023, pumped storage not in the total,
// sources aligned on the newest period all have, the current price the slot running now (not the
// last published one, tomorrow 23:45), hourly prices as means that hide the cheapest quarter-hour,
// zones compared at one slot, windows stitched and de-duplicated, gaps never 0, a name several
// series fit reported as ambiguous, a 404 answered as empty with what was asked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SmardClient } from "../src/client.js";
import { SmardApiError, SmardValidationError } from "../src/errors.js";
import {
  berlinTime,
  fromBerlin,
  getGenerationMix,
  getPrices,
  getSeries,
  listSeries,
  listWindows,
  parseTime,
  periodLabel,
  resolveRegion,
} from "../src/operations.js";
import { SERIES, smardAnswer, smardApi, windowPoints, type RecordedSeries, type SeriesOverrides } from "./fixtures.js";
import { makeMockTransport, rawResponse } from "./helpers.js";

function api(overrides: SeriesOverrides = {}) {
  const mock = smardApi(overrides);
  return { mock, client: new SmardClient({ transport: mock.transport }) };
}

/** Thursday 19 November 2026, 15:07 in Berlin. */
const NOW = new Date("2026-11-19T14:07:00Z");
const DAY_2026 = 1767222000000;

/** A recorded series with the value at `at` replaced. */
function withValue(key: string, window: number, at: number, value: number | null): RecordedSeries {
  const recorded = SERIES[key] as RecordedSeries;
  const [first, step, values] = recorded.windows[String(window)] as [number, number, (number | null)[]];
  const changed = [...values];
  changed[(at - first) / step] = value;
  return { index: recorded.index, windows: { ...recorded.windows, [String(window)]: [first, step, changed] } };
}

// --- Berlin time ---

test("periods are named by their Berlin date: a day starting at 23:00Z is the next day, a summer one at 22:00Z", () => {
  assert.equal(periodLabel(Date.parse("2026-11-17T23:00:00Z"), "day"), "2026-11-18");
  assert.equal(periodLabel(Date.parse("2026-10-03T22:00:00Z"), "day"), "2026-10-04");
  assert.equal(periodLabel(Date.parse("2026-08-31T22:00:00Z"), "month"), "2026-09");
  assert.equal(periodLabel(Date.parse("2025-12-31T23:00:00Z"), "year"), "2026");
  assert.equal(periodLabel(Date.parse("2026-11-19T13:45:00Z"), "quarterhour"), "2026-11-19 14:45");
  assert.equal(berlinTime(Date.parse("2026-07-01T10:00:00Z")), "2026-07-01T12:00+02:00");
  assert.equal(fromBerlin(2026, 11, 18), Date.parse("2026-11-17T23:00:00Z"));
  assert.equal(fromBerlin(2026, 3, 29, 3), Date.parse("2026-03-29T01:00:00Z"), "the first summer hour");
});

test("parseTime: a date, month, year, Berlin time, instant, today/tomorrow; the span runs to the period's end", () => {
  assert.deepEqual(parseTime("at", "2026-11-18"), { start: Date.parse("2026-11-17T23:00:00Z"), end: Date.parse("2026-11-18T23:00:00Z") });
  assert.deepEqual(parseTime("at", "2026-11"), { start: Date.parse("2026-10-31T23:00:00Z"), end: Date.parse("2026-11-30T23:00:00Z") });
  assert.equal(parseTime("at", "2026").start, Date.parse("2025-12-31T23:00:00Z"));
  assert.equal(parseTime("at", "2026-11-18T14:00").start, Date.parse("2026-11-18T13:00:00Z"));
  assert.equal(parseTime("at", "2026-11-18T14:00:00Z").start, Date.parse("2026-11-18T14:00:00Z"));
  assert.equal(parseTime("day", "tomorrow", NOW).start, Date.parse("2026-11-19T23:00:00Z"));
  assert.equal(parseTime("day", "yesterday", new Date("2026-11-18T23:30:00Z")).start, Date.parse("2026-11-17T23:00:00Z"), "00:30 Berlin on the 19th: yesterday is the 18th");
  for (const bad of ["18.11.2026", "2026-02-30", "2026-13", "2026-11-18T25:00", "last week"]) {
    assert.throws(() => parseTime("at", bad), SmardValidationError, bad);
  }
});

test("regions in any case; an unknown one names the valid ones", () => {
  assert.equal(resolveRegion("tennet", "DE"), "TenneT");
  assert.equal(resolveRegion("de-lu", "DE"), "DE-LU");
  assert.throws(() => resolveRegion("Bayern", "DE"), /Invalid region "Bayern"\. Expected one of: DE, AT/);
});

// --- getGenerationMix ---

test("the mix of the newest settled day: the last non-null point, never the null tail; Berlin date; biggest first", async () => {
  const { client, mock } = api();
  const mix = await getGenerationMix(client);
  assert.equal(mix.status, "ok");
  if (mix.status !== "ok") return;
  // The 2026 window runs to 31 December; 18 November is the last settled day on the 19th.
  assert.deepEqual(mix.period, { start: "2026-11-18T00:00+01:00", label: "2026-11-18" });
  assert.equal(mix.sources[0]?.name, "Wind Onshore");
  assert.equal(mix.sources[0]?.mwh, 982392.5);
  assert.equal(mix.sources.length, 10);
  assert.ok(mix.sources.every((s, i) => i === 0 || (mix.sources[i - 1]?.mwh ?? 0) >= s.mwh), "sorted by MWh");
  assert.equal(mix.totalMWh, 1676916.19);
  assert.equal(mix.renewableShare, 77.1);
  assert.equal(mix.fossilShare, 22.9);
  assert.equal(mix.window, DAY_2026);
  assert.equal(mock.calls.length, 12, "one index, then a window per source and pumped storage; nuclear not read");
  assert.equal(mock.calls.filter((c) => c.url.includes("/index_")).length, 1);
});

test("the mix reads two files at a time, and a source's own index only when the shared one names a window it hasn't got", async () => {
  let inFlight = 0;
  let most = 0;
  const lagging: SeriesOverrides = { "1228/DE/day": { index: (SERIES["1228/DE/day"] as RecordedSeries).index.slice(0, -1), windows: {} } };
  const mock = makeMockTransport(async (request) => {
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight--;
    return smardAnswer(request, lagging);
  });
  const mix = await getGenerationMix(new SmardClient({ transport: mock.transport }), { at: "2026-11-10" });
  assert.equal(most, 2);
  assert.equal(mix.status, "ok");
  if (mix.status !== "ok") return;
  assert.deepEqual(mix.missing, [{ id: 1228, name: "Sonstige Erneuerbare" }], "its 2026 window not published: no value");
  assert.deepEqual(mock.calls.filter((c) => c.url.includes("/index_")).map((c) => new URL(c.url).pathname), ["/app/chart_data/4067/DE/index_day.json", "/app/chart_data/1228/DE/index_day.json"]);
});

test("nuclear is left out after 15 April 2023 and said so; pumped storage is given apart, not in the total", async () => {
  const mix = await getGenerationMix(api().client);
  assert.equal(mix.status, "ok");
  if (mix.status !== "ok") return;
  assert.deepEqual(mix.ended.map((e) => e.id), [1224]);
  assert.match(mix.ended[0]?.note ?? "", /15 April 2023/);
  assert.ok(!mix.sources.some((s) => s.id === 1224 || s.id === 4070));
  assert.equal(mix.pumpedStorage.mwh, 14629.06);
  assert.equal(mix.nuclearShare, undefined);
});

test("a source behind the others: every source is read at the newest period all have, and the late one named", async () => {
  const lateOffshore = withValue("1225/DE/day", DAY_2026, Date.parse("2026-11-17T23:00:00Z"), null);
  const mix = await getGenerationMix(api({ "1225/DE/day": lateOffshore }).client);
  assert.equal(mix.status, "ok");
  if (mix.status !== "ok") return;
  assert.equal(mix.period.label, "2026-11-17", "not 18 November for some sources and 17 for one");
  assert.deepEqual(mix.behind, [{ id: 1225, name: "Wind Offshore", newest: "2026-11-17" }]);
  assert.match(mix.notes[0] ?? "", /Wind Offshore \(newest 2026-11-17\) lags behind the others; every source is read at 2026-11-17/);
});

test("a period asked for (at); a source without a value there is missing and the total is without it; 0 stays a value", async () => {
  const noHydro = withValue("1226/DE/day", DAY_2026, Date.parse("2026-11-09T23:00:00Z"), null);
  const zeroPv = withValue("4068/DE/day", DAY_2026, Date.parse("2026-11-09T23:00:00Z"), 0);
  const mix = await getGenerationMix(api({ "1226/DE/day": noHydro, "4068/DE/day": zeroPv }).client, { at: "2026-11-10" });
  assert.equal(mix.status, "ok");
  if (mix.status !== "ok") return;
  assert.equal(mix.period.label, "2026-11-10");
  assert.deepEqual(mix.missing, [{ id: 1226, name: "Wasserkraft" }]);
  assert.equal(mix.sources.find((s) => s.id === 4068)?.mwh, 0, "PV at 0 is listed, not dropped");
  assert.match(mix.notes.join(" "), /Wasserkraft: no value for 2026-11-10 yet; the total and the shares are without it/);
});

test("a period not published yet is empty, saying so; a region without the series is empty naming it", async () => {
  const future = await getGenerationMix(api().client, { at: "2026-11-25" });
  assert.equal(future.status, "empty");
  if (future.status === "empty") assert.match(future.reason, /No settled day data for 2026-11-25 in region DE yet/);
  const tennet = await getGenerationMix(api().client, { region: "tennet" });
  assert.equal(tennet.status, "empty");
  if (tennet.status === "empty") assert.match(tennet.reason, /SMARD publishes none of the generation series for region TenneT at resolution day \(HTTP 404\)/);
});

test("a period after the newest file is not published yet, named as asked: never another period's answer", async () => {
  for (const at of ["2027-03-01", "2030-06-01"]) {
    const mix = await getGenerationMix(api().client, { at });
    assert.equal(mix.status, "empty");
    if (mix.status !== "empty") continue;
    assert.match(mix.reason, new RegExp(`Nothing published for ${at} at resolution day in region DE yet`));
    assert.doesNotMatch(mix.reason, /2026-12-31/);
  }
});

/** The recorded DE day series of `ids` as region `region`'s. */
function asRegion(region: string, ids: number[]): SeriesOverrides {
  return Object.fromEntries(ids.map((id) => [`${id}/${region}/day`, SERIES[`${id}/DE/day`]]));
}

test("a control area without some sources (TransnetBW has no lignite, no offshore wind) gives its mix from the others, naming the absent ones", async () => {
  const { client, mock } = api(asRegion("TransnetBW", [4069, 4071, 1227, 4067, 4068, 4066, 1226, 1228, 4070]));
  const mix = await getGenerationMix(client, { region: "TransnetBW" });
  assert.equal(mix.status, "ok", JSON.stringify(mix));
  if (mix.status !== "ok") return;
  assert.deepEqual(mix.absent, [{ id: 1223, name: "Braunkohle" }, { id: 1225, name: "Wind Offshore" }]);
  assert.equal(mix.sources.length, 8);
  assert.ok(!mix.sources.some((s) => s.id === 1223 || s.id === 1225));
  assert.match(mix.notes.join(" "), /SMARD publishes no Braunkohle, Wind Offshore series for region TransnetBW \(HTTP 404\): the total and the shares are without them/);
  assert.ok(!mock.calls.some((c) => c.url.includes("/410/")), "SMARD answered: no check needed");
});

test("a window file one source lacks, or pumped storage absent, or Wind Onshore absent, never empties the mix", async () => {
  const noWindow: SeriesOverrides = { "1228/DE/day": { index: (SERIES["1228/DE/day"] as RecordedSeries).index, windows: {} } };
  const one = await getGenerationMix(api(noWindow).client);
  assert.equal(one.status, "ok");
  if (one.status === "ok") assert.deepEqual(one.missing, [{ id: 1228, name: "Sonstige Erneuerbare" }]);
  const noPumped = await getGenerationMix(api({ "4070/DE/day": undefined }).client);
  assert.equal(noPumped.status, "ok");
  if (noPumped.status === "ok") {
    assert.deepEqual(noPumped.pumpedStorage, { id: 4070, mwh: null });
    assert.deepEqual(noPumped.absent, [{ id: 4070, name: "Pumpspeicher (Erzeugung)" }]);
  }
  const noOnshore = await getGenerationMix(api({ "4067/DE/day": undefined }).client, { at: "2026-11-10" });
  assert.equal(noOnshore.status, "ok");
  if (noOnshore.status === "ok") {
    assert.equal(noOnshore.period.label, "2026-11-10");
    assert.deepEqual(noOnshore.absent, [{ id: 4067, name: "Wind Onshore" }]);
  }
});

test("before 16 April 2023 nuclear is in the mix, with its own share", async () => {
  const start = fromBerlin(2023, 1, 1);
  const series = (value: number): RecordedSeries => ({ index: [start], windows: { [String(start)]: [start, 86_400_000, [value, value, value]] } });
  const overrides: SeriesOverrides = {};
  for (const id of [1223, 4069, 4071, 1227, 1224, 4067, 1225, 4068, 4066, 1226, 1228, 4070]) overrides[`${id}/DE/day`] = series(id === 1224 ? 1000 : 100);
  const mix = await getGenerationMix(api(overrides).client, { at: "2023-01-02" });
  assert.equal(mix.status, "ok");
  if (mix.status !== "ok") return;
  assert.deepEqual(mix.ended, []);
  assert.equal(mix.totalMWh, 2000, "ten sources of 100 and nuclear 1000; pumped storage not counted");
  assert.equal(mix.nuclearShare, 50);
  assert.equal(mix.renewableShare, 30);
  assert.equal(mix.fossilShare, 20);
});

test("nuclear is counted by the period read, not by the date in at: 2023 and 2023-06 at year are one answer", async () => {
  const mixOf = async (resolution: "year" | "month" | "week", start: number, ats: string[]) => {
    const overrides: SeriesOverrides = {};
    for (const id of [1223, 4069, 4071, 1227, 1224, 4067, 1225, 4068, 4066, 1226, 1228, 4070]) {
      overrides[`${id}/DE/${resolution}`] = { index: [start], windows: { [String(start)]: [start, 86_400_000, [id === 1224 ? 1000 : 100]] } };
    }
    return Promise.all(ats.map((at) => getGenerationMix(api(overrides).client, { resolution, at })));
  };
  for (const [resolution, start, ats] of [
    ["year", fromBerlin(2023, 1), ["2023", "2023-06", "2023-12-31"]],
    ["month", fromBerlin(2023, 4), ["2023-04", "2023-04-20"]],
    ["week", fromBerlin(2023, 4, 10), ["2023-04-10", "2023-04-16"]],
  ] as const) {
    const answers = await mixOf(resolution, start, [...ats]);
    for (const [i, mix] of answers.entries()) {
      assert.equal(mix.status, "ok", `${resolution} ${ats[i]}`);
      if (mix.status !== "ok") continue;
      assert.equal(mix.nuclearShare, 50, `${resolution} ${ats[i]}: nuclear ran until 15 April 2023, inside the period`);
      assert.deepEqual(mix.ended, []);
      assert.equal(mix.totalMWh, 2000);
    }
  }
});

test("a year or month in at without a resolution reads that year or month; with a finer resolution its first period is said", async () => {
  const overrides: SeriesOverrides = {};
  const year = fromBerlin(2025, 1);
  const october = fromBerlin(2026, 10);
  for (const id of [1223, 4069, 4071, 1227, 4067, 1225, 4068, 4066, 1226, 1228, 4070]) {
    overrides[`${id}/DE/year`] = { index: [year], windows: { [String(year)]: [year, 86_400_000, [365]] } };
    overrides[`${id}/DE/month`] = { index: [fromBerlin(2026, 1)], windows: { [String(fromBerlin(2026, 1))]: [october, 86_400_000, [31]] } };
  }
  const y = await getGenerationMix(api(overrides).client, { at: "2025" });
  assert.equal(y.status, "ok");
  if (y.status === "ok") assert.deepEqual([y.resolution, y.period.label, y.totalMWh], ["year", "2025", 3650]);
  const m = await getGenerationMix(api(overrides).client, { at: "2026-10" });
  assert.equal(m.status, "ok");
  if (m.status === "ok") assert.deepEqual([m.resolution, m.period.label], ["month", "2026-10"]);
  const firstDay = await getGenerationMix(api().client, { at: "2026-11", resolution: "day" });
  assert.equal(firstDay.status, "ok");
  if (firstDay.status === "ok") {
    assert.equal(firstDay.period.label, "2026-11-01");
    assert.match(firstDay.notes.join(" "), /2026-11 spans more than one day: this is its first, 2026-11-01\. For all of it, ask with resolution month/);
  }
});

test("a source that stopped publishing doesn't hold the mix back: the others are read at their newest period, it is missing and named", async () => {
  const recorded = SERIES["1228/DE/day"] as RecordedSeries;
  const [first, step, values] = recorded.windows[String(DAY_2026)] as [number, number, (number | null)[]];
  const stalled: RecordedSeries = { index: recorded.index, windows: { [String(DAY_2026)]: [first, step, values.map((v, i) => (i < 5 ? v : null))] } };
  const mix = await getGenerationMix(api({ "1228/DE/day": stalled }).client);
  assert.equal(mix.status, "ok");
  if (mix.status !== "ok") return;
  assert.equal(mix.period.label, "2026-11-18");
  assert.deepEqual(mix.behind, [{ id: 1228, name: "Sonstige Erneuerbare", newest: "2026-11-05", stalled: true }]);
  assert.deepEqual(mix.missing, [{ id: 1228, name: "Sonstige Erneuerbare" }]);
  assert.match(mix.notes.join(" "), /Sonstige Erneuerbare \(newest 2026-11-05\) published nothing since: left out of 2026-11-18, the newest period the others have/);
});

test("a mix of Austria or Luxembourg has no nuclear to leave out", async () => {
  const austria = Object.fromEntries([1223, 4069, 4071, 1227, 4067, 1225, 4068, 4066, 1226, 1228, 4070].map((id) => [`${id}/AT/day`, SERIES[`${id}/DE/day`]]));
  const { client, mock } = api(austria);
  const mix = await getGenerationMix(client, { region: "AT" });
  assert.equal(mix.status, "ok");
  if (mix.status === "ok") assert.deepEqual(mix.ended, []);
  assert.ok(!mock.calls.some((c) => c.url.includes("/1224/")));
});

// --- getPrices ---

test("the current price is the slot running now, not the last published one; the day's low and high with their times", async () => {
  const prices = await getPrices(api().client, { now: NOW, zones: ["FR"] });
  assert.equal(prices.status, "ok");
  if (prices.status !== "ok") return;
  const fr = prices.zones[0];
  assert.equal(fr?.publishedUntil, "2026-11-20T23:45+01:00", "tomorrow's prices are out");
  assert.equal(fr?.tomorrowPublished, true);
  assert.deepEqual(fr?.current, { time: "2026-11-19T15:00+01:00", eurPerMWh: 8.76, ctPerKWh: 0.88 });
  assert.deepEqual(fr?.min, { time: "2026-11-19T11:15+01:00", eurPerMWh: -0.01, ctPerKWh: 0 });
  assert.equal(fr?.max?.time, "2026-11-19T18:45+01:00");
  assert.equal(fr?.slots, 96);
  assert.equal(fr?.negativeSlots, 7);
  assert.match(prices.notes.join(" "), /Negative prices \(paid to consume\) in FR \(7 slots\): real, not an error/);
});

test("DE-LU by default; region DE-LU is sent for every zone (the series id picks the zone)", async () => {
  const { client, mock } = api();
  const prices = await getPrices(client, { now: NOW, zones: ["Frankreich"] });
  assert.equal(prices.status, "ok");
  assert.ok(mock.calls.every((c) => c.url.includes("/254/DE-LU/")), mock.calls.map((c) => c.url).join("\n"));
  const de = await getPrices(api().client, { now: NOW });
  if (de.status === "ok") {
    assert.equal(de.zones[0]?.zone, "DE-LU");
    assert.equal(de.zones[0]?.average?.eurPerMWh, 224.83);
    assert.equal(de.zones[0]?.tomorrowPublished, false);
  }
});

test("hourly prices are the means of four quarter-hours: the hourly low hides the cheapest quarter-hour", async () => {
  const quarter = await getPrices(api().client, { now: NOW });
  const hour = await getPrices(api().client, { now: NOW, resolution: "hour" });
  assert.ok(quarter.status === "ok" && hour.status === "ok");
  if (quarter.status !== "ok" || hour.status !== "ok") return;
  assert.equal(hour.zones[0]?.slots, 24);
  assert.ok((hour.zones[0]?.min?.eurPerMWh ?? 0) > (quarter.zones[0]?.min?.eurPerMWh ?? 0));
  assert.match(hour.basis, /mean of its four quarter-hour prices/);
});

test("zones today are compared at the slot running now, cheapest first", async () => {
  const prices = await getPrices(api().client, { now: NOW, zones: ["DE-LU", "France", "Österreich"] });
  assert.equal(prices.status, "ok");
  if (prices.status !== "ok") return;
  assert.equal(prices.comparison?.at, "2026-11-19T15:00+01:00");
  assert.deepEqual(prices.comparison?.ranking.map((r) => [r.zone, r.eurPerMWh]), [["FR", 8.76], ["DE-LU", 244.95], ["AT", 262.93]]);
});

test("tomorrow: a zone not published yet is said so and left out of the ranking (day averages); none published is empty", async () => {
  const prices = await getPrices(api().client, { now: NOW, day: "tomorrow", zones: ["DE-LU", "FR"] });
  assert.equal(prices.status, "ok");
  if (prices.status !== "ok") return;
  assert.equal(prices.day, "2026-11-20");
  assert.equal(prices.zones[0]?.published, false);
  assert.equal(prices.zones[0]?.current, undefined, "no current slot for another day");
  assert.deepEqual(prices.comparison?.notIncluded, ["DE-LU"]);
  assert.equal(prices.comparison?.basis, "the day's average");
  assert.match(prices.notes[0] ?? "", /No prices for 2026-11-20 yet: DE-LU/);
  const none = await getPrices(api().client, { now: NOW, day: "tomorrow" });
  assert.equal(none.status, "empty");
  if (none.status === "empty") assert.match(none.reason, /No day-ahead prices for 2026-11-20 yet \(published until 2026-11-19T23:45\+01:00\)/);
});

test("Sunday night before the new week's first slot: the current price comes from the window before", async () => {
  const sunday = new Date("2026-11-15T22:50:00Z");
  const prices = await getPrices(api().client, { now: sunday });
  assert.equal(prices.status, "ok");
  if (prices.status !== "ok") return;
  assert.equal(prices.day, "2026-11-15");
  assert.deepEqual(prices.zones[0]?.current, { time: "2026-11-15T23:45+01:00", eurPerMWh: 105.76, ctPerKWh: 10.58 });
  assert.equal(prices.zones[0]?.slots, 96);
});

test("just after Monday midnight, a zone whose new week isn't listed yet has no current price: never Sunday's last slot", async () => {
  const recorded = SERIES["4169/DE-LU/quarterhour"] as RecordedSeries;
  const late: SeriesOverrides = { "4169/DE-LU/quarterhour": { index: recorded.index.slice(0, -1), windows: recorded.windows } };
  const monday = new Date("2026-11-15T23:10:00Z");
  const prices = await getPrices(api(late).client, { now: monday, zones: ["DE-LU", "FR"] });
  assert.equal(prices.status, "ok");
  if (prices.status !== "ok") return;
  const [de, fr] = prices.zones;
  assert.equal(de?.current, undefined, JSON.stringify(de?.current));
  assert.equal(de?.published, false);
  assert.equal(fr?.current?.time, "2026-11-16T00:00+01:00");
  assert.deepEqual(prices.comparison?.ranking.map((r) => r.zone), ["FR"]);
  assert.deepEqual(prices.comparison?.notIncluded, ["DE-LU"]);
});

test("a zone name several zones fit is ambiguous; an unknown zone or a non-price id is refused before any request", async () => {
  const denmark = await getPrices(api().client, { now: NOW, zones: ["Dänemark"] });
  assert.equal(denmark.status, "ambiguous");
  if (denmark.status === "ambiguous") assert.deepEqual(denmark.candidates.map((c) => c.zone), ["DK1", "DK2"]);
  const { client, mock } = api();
  await assert.rejects(getPrices(client, { zones: ["Mars"] }), /Invalid zone "Mars": no bidding zone of that name/);
  await assert.rejects(getPrices(client, { zones: [410] }), /410 is not one of SMARD's price series/);
  await assert.rejects(getPrices(client, { day: "2026-11" }), /Expected one day/);
  assert.equal(mock.calls.length, 0);
});

// --- getSeries ---

test("two windows stitched in order, cut to the Berlin days asked for, keyed by the UTC instant", async () => {
  const rows = await getSeries(api().client, { series: "Netzlast", from: "2026-11-14", to: "2026-11-16", now: NOW });
  assert.equal(rows.status, "ok");
  if (rows.status !== "ok") return;
  assert.equal(rows.series.id, 410);
  assert.equal(rows.windowsRead, 2);
  assert.equal(rows.rows.length, 72, "three Berlin days of hours");
  assert.equal(rows.first, "2026-11-13T23:00:00Z", "14 November starts at 23:00Z on the 13th");
  assert.equal(rows.last, "2026-11-16T22:00:00Z");
  assert.ok(rows.rows.every((r, i) => i === 0 || (rows.rows[i - 1]?.time ?? "") < r.time), "ordered");
  assert.equal(rows.header, "timestamp_utc,Total grid load (MWh)");
  assert.deepEqual(rows.files.map((f) => [f.start, f.version]), [["2026-11-09T00:00+01:00", 1], ["2026-11-16T00:00+01:00", 1]]);
  assert.match(String(rows.files[0]?.created), /^2026-11-\d\dT\d\d:\d\d\+01:00$/, "when SMARD wrote the file, Berlin time");
});

test("the unpublished tail is left out and counted; gaps are dropped, or kept as null, never 0", async () => {
  const gap = withValue("410/DE/hour", 1794783600000, Date.parse("2026-11-17T05:00:00Z"), null);
  const dropped = await getSeries(api({ "410/DE/hour": gap }).client, { series: 410, from: "2026-11-17", to: "2026-11-22", now: NOW });
  assert.equal(dropped.status, "ok");
  if (dropped.status !== "ok") return;
  assert.equal(dropped.last, "2026-11-19T18:00:00Z", "the last settled hour, not the null tail to Sunday");
  assert.equal(dropped.nulls.unpublished, 76);
  assert.equal(dropped.nulls.dropped, 1);
  assert.ok(dropped.rows.every((r) => r.value !== null));
  const kept = await getSeries(api({ "410/DE/hour": gap }).client, { series: 410, from: "2026-11-17", to: "2026-11-22", nulls: "keep", now: NOW });
  assert.equal(kept.status, "ok");
  if (kept.status !== "ok") return;
  assert.deepEqual(kept.rows.find((r) => r.time === "2026-11-17T05:00:00Z"), { time: "2026-11-17T05:00:00Z", value: null });
  assert.equal(kept.nulls.kept, 1);
});

test("day rows carry the Berlin date, never the UTC one (todate would name the day before)", async () => {
  const rows = await getSeries(api().client, { series: "pv", resolution: "day", from: "2026-11-01", to: "2026-11-03", now: NOW });
  assert.equal(rows.status, "ok");
  if (rows.status !== "ok") return;
  assert.deepEqual(rows.rows.map((r) => r.time), ["2026-11-01", "2026-11-02", "2026-11-03"]);
  assert.equal(rows.header, "date,Solar (photovoltaics) (MWh)");
});

test("without a range: the newest window; a range over more windows than allowed says where to go on", async () => {
  const newest = await getSeries(api().client, { series: 410 });
  assert.equal(newest.status, "ok");
  if (newest.status === "ok") assert.equal(newest.first, "2026-11-15T23:00:00Z");
  const capped = await getSeries(api().client, { series: 410, from: "2026-11-09", maxWindows: 1, now: NOW });
  assert.equal(capped.status, "ok");
  if (capped.status !== "ok") return;
  assert.equal(capped.last, "2026-11-15T22:00:00Z");
  assert.equal(capped.incomplete?.nextFrom, "2026-11-16T00:00+01:00");
});

test("a price series reads region DE-LU by default; a series SMARD hasn't is empty saying what was asked", async () => {
  const { client, mock } = api();
  const price = await getSeries(client, { series: "spot", resolution: "hour" });
  assert.equal(price.status, "ok");
  assert.ok(mock.calls[0]?.url.endsWith("/app/chart_data/4169/DE-LU/index_hour.json"));
  if (price.status === "ok") assert.equal(price.series.unit, "EUR/MWh");
  const missing = await getSeries(api().client, { series: 99999 });
  assert.equal(missing.status, "empty");
  if (missing.status === "empty") assert.match(missing.reason, /SMARD publishes no series 99999 for region DE at resolution hour \(HTTP 404\)/);
  const wrongRegion = await getSeries(api().client, { series: 4169, region: "AT" });
  if (wrongRegion.status === "empty") assert.match(wrongRegion.reason, /Price series use region DE-LU/);
});

test("a name several series fit is ambiguous with the candidates; a name none fits is empty", async () => {
  const wind = await getSeries(api().client, { series: "wind" });
  assert.equal(wind.status, "ambiguous");
  if (wind.status === "ambiguous") assert.deepEqual(wind.candidates.map((c) => c.id), [1225, 4067, 3791, 123, 5097]);
  const onshore = await getSeries(api().client, { series: "Wind Onshore", resolution: "day", from: "2026-11-18", to: "2026-11-18" });
  assert.equal(onshore.status, "ok");
  const none = await getSeries(api().client, { series: "Kaffee" });
  assert.equal(none.status, "empty");
});

// --- listSeries, listWindows ---

test("listSeries: a group, a word, the regions and what one window of each resolution holds", () => {
  const prices = listSeries({ group: "price" });
  assert.equal(prices.series.length, 15);
  assert.ok(prices.series.every((s) => s.unit === "EUR/MWh" && s.zone !== undefined));
  assert.deepEqual(listSeries({ query: "solar" }).series.map((s) => s.id), [4068, 125, 5097], "forecast wind and solar too");
  assert.equal(listSeries({ query: "netzlast" }).series[0]?.id, 410);
  assert.equal(listSeries().regions.find((r) => r.region === "DE-LU")?.is, "the German-Luxembourg bidding zone (the region of every price series)");
  assert.throws(() => listSeries({ group: "prices" }), /Expected one of: generation, consumption, price, forecast/);
  assert.equal(listSeries({ query: "Kaffee" }).status, "empty");
});

test("listWindows: newest first, with how far back the series goes", async () => {
  const windows = await listWindows(api().client, { series: "pv", resolution: "day" });
  assert.equal(windows.status, "ok");
  if (windows.status !== "ok") return;
  assert.equal(windows.total, 12);
  assert.deepEqual(windows.windows[0], { start: "2026-01-01T00:00+01:00", label: "2026-01-01", timestamp: DAY_2026 });
  assert.equal(windows.oldest, "2015-01-01");
  assert.equal(windows.span, "one calendar year of days");
  assert.equal(windowPoints("410/DE/hour", 1794783600000).length, 168);
});

// --- A 404 is "no such file" only from a SMARD that is there ---

test("a base URL that reaches no SMARD (every path a 404, an HTML error page) is an error naming both requests, never 'no data'", async () => {
  // As with --base-url https://www.smard.de/app, which the API's docs list: the client adds /app itself.
  const page = makeMockTransport(() => rawResponse("<html><body>Seite nicht gefunden – Wartungsarbeiten</body></html>", "text/html", 404));
  const client = new SmardClient({ transport: page.transport, baseUrl: "https://www.smard.de/app" });
  const notThere = (err: unknown): boolean =>
    err instanceof SmardApiError &&
    err.status === 404 &&
    /^HTTP 404 for GET https:\/\/www\.smard\.de\/app\/app\/chart_data\//.test(err.message) &&
    /index of the grid load \(410, DE, hour\), which SMARD always has, is a 404 too/.test(err.message) &&
    /base URL is wrong/.test(err.message);
  await assert.rejects(listWindows(client, { series: "410" }), notThere);
  await assert.rejects(getSeries(client, { series: "Netzlast" }), notThere);
  await assert.rejects(getPrices(client, { now: NOW }), notThere);
  await assert.rejects(getGenerationMix(client), notThere);
  await assert.rejects(listWindows(client, { series: "4068", region: "TenneT" }), notThere);
});

test("a 404 from a SMARD that answers is a series it lacks: the grid load's index is asked once, and not after another answer", async () => {
  const { client, mock } = api();
  const missing = await listWindows(client, { series: 99999 });
  assert.equal(missing.status, "empty");
  assert.deepEqual(mock.calls.map((c) => new URL(c.url).pathname), ["/app/chart_data/99999/DE/index_hour.json", "/app/chart_data/410/DE/index_hour.json"]);
  const control = makeMockTransport((request) => (request.url.includes("/410/DE/index_hour") ? rawResponse("", "text/plain", 500) : smardAnswer(request)));
  await assert.rejects(listWindows(new SmardClient({ transport: control.transport, maxRetries: 0 }), { series: 99999 }), /HTTP 500/);
});
