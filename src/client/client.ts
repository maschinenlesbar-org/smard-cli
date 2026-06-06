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
import type { TimestampIndex, SeriesResult, TableResult } from "./types.js";

const enc = encodeURIComponent;

export class SmardClient {
  private readonly engine: RequestEngine;

  constructor(options: EngineOptions = {}) {
    this.engine = new RequestEngine(options);
  }

  /** The timestamps (window starts) available for a (filter, region, resolution). */
  async timestamps(filter: number, region: Region, resolution: Resolution): Promise<number[]> {
    const res = await this.engine.getJson<TimestampIndex>(
      `/app/chart_data/${filter}/${enc(region)}/index_${resolution}.json`,
    );
    return res.timestamps ?? [];
  }

  /** The data file for one window, identified by its timestamp. */
  series(
    filter: number,
    region: Region,
    resolution: Resolution,
    timestamp: number,
  ): Promise<SeriesResult> {
    return this.engine.getJson(
      `/app/chart_data/${filter}/${enc(region)}/${filter}_${enc(region)}_${resolution}_${timestamp}.json`,
    );
  }

  /** Convenience: fetch the newest available window's data in one call. */
  async latest(filter: number, region: Region, resolution: Resolution): Promise<SeriesResult> {
    const ts = await this.timestamps(filter, region, resolution);
    if (ts.length === 0) {
      return { meta_data: { version: 0, created: 0 }, series: [] };
    }
    // Take the genuinely newest timestamp rather than trusting the index order.
    const newest = Math.max(...ts);
    return this.series(filter, region, resolution, newest);
  }

  /** Quarter-hour `table_data` for one window (richer per-point versions). */
  tableData(filter: number, region: Region, timestamp: number): Promise<TableResult> {
    return this.engine.getJson(
      `/app/table_data/${filter}/${enc(region)}/${filter}_${enc(region)}_quarterhour_${timestamp}.json`,
    );
  }
}
