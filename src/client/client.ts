// SmardClient — a typed client over the open (no-auth) chart-data endpoints of
// the Bundesnetzagentur's SMARD electricity-market platform (smard.de).
//
// The API is a static file tree: for a (filter, region, resolution) triple it
// publishes an "index" of available timestamps, and one data file per timestamp.
// Each data file covers a fixed window (e.g. one week of hourly values), so to
// get the newest data you read the index, take the last timestamp, then fetch
// that file. `latest()` does exactly that in one call.
//
//   client.timestamps(410, "DE", "hour")          // available windows
//   client.series(410, "DE", "hour", ts)          // one window's data
//   client.latest(410, "DE", "hour")              // newest window's data
//
// Every response is checked against its documented shape (the index, a data file,
// a table_data file); anything else is a SmardParseError, never data.
//
// Every method checks its arguments before any request (a non-negative safe
// integer filter/timestamp, a region in RegionValues, a resolution in
// ResolutionValues) and rejects a bad one with a SmardValidationError.

import { RequestEngine, type EngineOptions } from "./engine.js";
import type { Region, Resolution } from "./enums.js";
import type { SeriesResult, TableResult } from "./types.js";
import { SmardError, SmardParseError } from "./errors.js";
import { assertId, assertRegion, assertResolution } from "./validate.js";

/**
 * Escape one interpolated path piece. Every method validates its arguments first
 * (`assertId` / `assertRegion` / `assertResolution`, a `SmardValidationError`
 * before any request), so this is defence in depth: no argument can steer the
 * request to another path, query or fragment. A `.`/`..` segment, which escaping
 * leaves unchanged, is also refused by the engine's `buildUrl`.
 */
const enc = (value: string | number): string => encodeURIComponent(String(value));

/** A non-null, non-array JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An epoch-millisecond timestamp as SMARD writes it: a non-negative safe integer. */
function isEpochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A data value: a finite number, or `null` for a gap. */
function isValue(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

/**
 * Check a `chart_data` data file against the documented shape and return it:
 * `{"meta_data": {…}, "series": [[epochMs, number|null], …]}`. SMARD answers a window
 * it has no file for with a 404, so anything else — `null`, `{}`, an array, an error
 * object such as `{"error": "maintenance", "series": null}`, string values (`"80"`, which
 * jq sorts above every number), a short or long tuple — is an error page or a changed
 * format, and is a SmardParseError rather than data a caller computes on.
 */
export function checkSeriesResult(body: unknown, path: string): SeriesResult {
  if (!isObject(body) || !isObject(body.meta_data) || !Array.isArray(body.series)) {
    throw new SmardParseError(
      `Unexpected response shape from ${path}: expected a JSON object with "meta_data" and a "series" array.`,
    );
  }
  const bad = body.series.findIndex(
    (p) => !Array.isArray(p) || p.length !== 2 || !isEpochMs(p[0]) || !isValue(p[1]),
  );
  if (bad >= 0) {
    throw new SmardParseError(
      `Malformed data file from ${path}: "series" point ${bad} is not [epoch-ms timestamp, number or null].`,
    );
  }
  return body as unknown as SeriesResult;
}

/**
 * Check a `table_data` file against the documented shape and return it:
 * `{"meta_data": {…}, "series": [{"values": [{"timestamp": epochMs, "versions":
 * [{"value": number|null, "name": …}, …]}, …]}, …]}`. Anything else is a SmardParseError,
 * as for {@link checkSeriesResult}. Extra keys (a version's `info`) are kept.
 */
export function checkTableResult(body: unknown, path: string): TableResult {
  if (!isObject(body) || !isObject(body.meta_data) || !Array.isArray(body.series)) {
    throw new SmardParseError(
      `Unexpected response shape from ${path}: expected a JSON object with "meta_data" and a "series" array.`,
    );
  }
  const goodPoint = (p: unknown): boolean =>
    isObject(p) &&
    isEpochMs(p.timestamp) &&
    Array.isArray(p.versions) &&
    p.versions.every((v) => isObject(v) && isValue(v.value));
  const bad = body.series.findIndex((e) => !isObject(e) || !Array.isArray(e.values) || !e.values.every(goodPoint));
  if (bad >= 0) {
    throw new SmardParseError(
      `Malformed table_data file from ${path}: "series" entry ${bad} is not {"values": [{"timestamp": epoch-ms, "versions": [{"value": number or null}]}]}.`,
    );
  }
  return body as unknown as TableResult;
}

export class SmardClient {
  private readonly engine: RequestEngine;

  constructor(options: EngineOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /** The timestamps (window starts) available for a (filter, region, resolution). */
  async timestamps(filter: number, region: Region, resolution: Resolution): Promise<number[]> {
    assertId("filter", filter);
    assertRegion(region);
    assertResolution(resolution);
    const path = `/app/chart_data/${enc(filter)}/${enc(region)}/index_${enc(resolution)}.json`;
    const res = await this.engine.getJson<unknown>(path);
    // SMARD answers a (filter, region, resolution) without data with a 404, never
    // with an empty or absent index, so anything but `{"timestamps": [...]}` (null,
    // an array, `{}`, `timestamps: null`) is an error page or a changed format —
    // not "no data".
    const ts = isObject(res) ? res.timestamps : undefined;
    if (!Array.isArray(ts)) {
      throw new SmardParseError(
        `Unexpected response shape from ${path}: expected a JSON object with a "timestamps" array.`,
      );
    }
    // Validate the *element* type, not just that `timestamps` is an array. A
    // later request interpolates a chosen element into the path of a follow-up
    // GET (`series()` in `latest()`). `series()` escapes it, but a string element
    // such as `"x#"` or `"1/../evil"` from a hostile/MITM'd origin is never a
    // window start; requiring safe integers rejects it at the trust boundary.
    if (!ts.every((t) => typeof t === "number" && Number.isSafeInteger(t))) {
      throw new SmardParseError(
        `Malformed index from ${path}: "timestamps" contains a non-integer element.`,
      );
    }
    return ts;
  }

  /** The data file for one window, identified by its timestamp. */
  async series(
    filter: number,
    region: Region,
    resolution: Resolution,
    timestamp: number,
  ): Promise<SeriesResult> {
    assertId("filter", filter);
    assertRegion(region);
    assertResolution(resolution);
    assertId("timestamp", timestamp);
    const path = `/app/chart_data/${enc(filter)}/${enc(region)}/${enc(filter)}_${enc(region)}_${enc(resolution)}_${enc(timestamp)}.json`;
    return checkSeriesResult(await this.engine.getJson<unknown>(path), path);
  }

  /** Convenience: fetch the newest available window's data in one call. */
  async latest(filter: number, region: Region, resolution: Resolution): Promise<SeriesResult> {
    const ts = await this.timestamps(filter, region, resolution);
    if (ts.length === 0) {
      // Never invent a result: there is no newest window to fetch.
      throw new SmardError(
        `The index for filter ${filter}, region ${region}, resolution ${resolution} lists no windows, so there is no newest window to fetch.`,
      );
    }
    // Take the genuinely newest timestamp rather than trusting the index order.
    // Use a reduce rather than `Math.max(...ts)`: spreading a very large index as
    // function arguments overflows the call stack (RangeError).
    const newest = ts.reduce((max, t) => (t > max ? t : max), ts[0]!);
    return this.series(filter, region, resolution, newest);
  }

  /** Quarter-hour `table_data` for one window (richer per-point versions). */
  async tableData(filter: number, region: Region, timestamp: number): Promise<TableResult> {
    assertId("filter", filter);
    assertRegion(region);
    assertId("timestamp", timestamp);
    const path = `/app/table_data/${enc(filter)}/${enc(region)}/${enc(filter)}_${enc(region)}_quarterhour_${enc(timestamp)}.json`;
    return checkTableResult(await this.engine.getJson<unknown>(path), path);
  }
}
