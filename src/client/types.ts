// Domain types for the SMARD chart-data API (smard.de).

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Response of an `index_{resolution}.json` request. */
export interface TimestampIndex {
  /** Epoch-millisecond timestamps; each marks the start of one data file. */
  timestamps: number[];
}

export interface SeriesMetaData {
  version: number;
  created: number;
}

/** A single `[timestampMs, value]` point. `value` is null for gaps. */
export type SeriesPoint = [number, number | null];

/** Response of a `chart_data` series request. */
export interface SeriesResult {
  meta_data: SeriesMetaData;
  series: SeriesPoint[];
}

/** A point of the quarter-hour `table_data` response. */
export interface TablePoint {
  timestamp: number;
  versions: { value: number | null; name: string | null }[];
}

/** Response of a `table_data` request. */
export interface TableResult {
  meta_data: SeriesMetaData;
  series: TablePoint[];
}
