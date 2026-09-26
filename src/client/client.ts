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

import { RequestEngine, type EngineOptions } from "./engine.js";
import type { Region, Resolution } from "./enums.js";
import type { SeriesResult, TableResult } from "./types.js";
import { SmardError, SmardParseError } from "./errors.js";

/**
 * Escape one interpolated path piece. Every argument goes through it — not only
 * `region` — because the client does not validate its arguments (the CLI does), so
 * a JS caller's `resolution` of `"hour/../../admin?x="` or a string `filter` would
 * otherwise steer the request to another path, query or fragment. A `.`/`..` segment,
 * which escaping leaves unchanged, is refused by the engine's `buildUrl`.
 */
const enc = (value: string | number): string => encodeURIComponent(String(value));

/** A non-null, non-array JSON object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class SmardClient {
  private readonly engine: RequestEngine;

  constructor(options: EngineOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /** The timestamps (window starts) available for a (filter, region, resolution). */
  async timestamps(filter: number, region: Region, resolution: Resolution): Promise<number[]> {
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
  series(
    filter: number,
    region: Region,
    resolution: Resolution,
    timestamp: number,
  ): Promise<SeriesResult> {
    return this.engine.getJson(
      `/app/chart_data/${enc(filter)}/${enc(region)}/${enc(filter)}_${enc(region)}_${enc(resolution)}_${enc(timestamp)}.json`,
    );
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
  tableData(filter: number, region: Region, timestamp: number): Promise<TableResult> {
    return this.engine.getJson(
      `/app/table_data/${enc(filter)}/${enc(region)}/${enc(filter)}_${enc(region)}_quarterhour_${enc(timestamp)}.json`,
    );
  }
}
