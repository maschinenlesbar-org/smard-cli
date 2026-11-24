// The use cases of the skills as library functions, built on the client: each carries the traps
// the skills document, so no caller (the CLI, the MCP server's tools, a library user) has to know
// them.
// - getGenerationMix: every generation source's energy for one period, the total, the shares and
//   the renewable share (smard-generation-mix);
// - getPrices: the day-ahead price now, a day's low, high and average with their times, and the
//   bidding zones compared at one slot (smard-price-watch);
// - getSeries: one series over a date range, the windows stitched into one ordered list of rows
//   (smard-series-export);
// - listSeries and listWindows: the documented series ids, regions and resolutions, and the
//   windows (files) a series is published in.
//
// Traps that hold for all of them: the newest window runs to the end of its period, so its tail is
// null (unpublished): the last settled point is the last non-null one, never the last one. SMARD's
// periods follow the Europe/Berlin calendar: a day starts at Berlin midnight (22:00Z or 23:00Z the
// UTC day before), so periods are named by their Berlin date and times carry the Berlin offset.
// A series without data is an HTTP 404, answered here as an empty result saying what was asked,
// once SMARD has answered a request (or the grid load's index, which it always has): a 404 from a
// base URL that reaches no SMARD is an error, never "no data".
// Ambiguity (a name several series or zones fit) is reported, never guessed.

import type { SmardClient } from "./client.js";
import { FILTERS, RegionValues, ResolutionValues, type FilterGroup, type Region, type Resolution } from "./enums.js";
import { SmardApiError, SmardValidationError, quoteValue } from "./errors.js";
import type { SeriesMetaData, SeriesPoint, SeriesResult } from "./types.js";
import { assertValid, normalizeText, textProblem } from "./validate.js";

// --- Shared: Berlin time --------------------------------------------------------------------

const BERLIN = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

interface Fields {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** The Berlin wall-clock fields of an instant. */
function berlinFields(ms: number): Fields {
  const parts = BERLIN.formatToParts(new Date(ms));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** Berlin's offset from UTC at an instant, in minutes (60 in winter, 120 in summer). */
function berlinOffset(ms: number): number {
  const f = berlinFields(ms);
  const whole = ms - (((ms % 60_000) + 60_000) % 60_000);
  return Math.round((Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute) - whole) / 60_000);
}

/** The instant of a Berlin wall-clock time. */
export function fromBerlin(year: number, month: number, day = 1, hour = 0, minute = 0): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - berlinOffset(guess) * 60_000;
  return guess - berlinOffset(first) * 60_000;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** An instant as Berlin time with its offset: `2026-11-19T14:00+01:00`. */
export function berlinTime(ms: number): string {
  const f = berlinFields(ms);
  const offset = berlinOffset(ms);
  return `${f.year}-${pad(f.month)}-${pad(f.day)}T${pad(f.hour)}:${pad(f.minute)}+${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`;
}

/** The Berlin date of an instant: `2026-11-19`. */
export function berlinDate(ms: number): string {
  const f = berlinFields(ms);
  return `${f.year}-${pad(f.month)}-${pad(f.day)}`;
}

/**
 * How a point of `resolution` that starts at `ms` is named: by its Berlin period. An hour or
 * quarter-hour is `2026-11-19 14:00` (Berlin time), a day or week (its Monday) the Berlin date, a
 * month `2026-11`, a year `2026`. Never the UTC date: a day starts at 23:00Z the day before.
 */
export function periodLabel(ms: number, resolution: Resolution): string {
  const f = berlinFields(ms);
  if (resolution === "year") return String(f.year);
  if (resolution === "month") return `${f.year}-${pad(f.month)}`;
  if (resolution === "day" || resolution === "week") return `${f.year}-${pad(f.month)}-${pad(f.day)}`;
  return `${f.year}-${pad(f.month)}-${pad(f.day)} ${pad(f.hour)}:${pad(f.minute)}`;
}

/** Where the period of `resolution` that starts at `ms` ends: the next one's start, in Berlin's calendar. */
export function nextPeriod(ms: number, resolution: Resolution): number {
  if (resolution === "quarterhour") return ms + 900_000;
  if (resolution === "hour") return ms + 3_600_000;
  const f = berlinFields(ms);
  if (resolution === "day") return fromBerlin(f.year, f.month, f.day + 1, f.hour, f.minute);
  if (resolution === "week") return fromBerlin(f.year, f.month, f.day + 7, f.hour, f.minute);
  if (resolution === "month") return fromBerlin(f.year, f.month + 1, f.day, f.hour, f.minute);
  return fromBerlin(f.year + 1, f.month, f.day, f.hour, f.minute);
}

/** A time a caller gave: where it starts and where the period it names ends (exclusive). */
export interface TimeSpan {
  start: number;
  end: number;
}

const TIME_HELP =
  "Expected a Berlin date (2026-11-18), month (2026-11), year (2026), Berlin time (2026-11-18T14:00), an ISO instant with Z or an offset, or today, yesterday, tomorrow.";

/**
 * A time as a caller writes it, in Berlin's calendar: a year, a month, a date, a date and time
 * (Berlin wall clock), an instant with `Z` or an offset, or today / yesterday / tomorrow (the
 * Berlin date of `now`). The span runs to the end of the period it names: 2026-11 is all of
 * November, a time is that one minute.
 */
export function parseTime(name: string, value: string, now: Date = new Date()): TimeSpan {
  const text = normalizeText(assertValid(name, value, textProblem));
  const bad = (): never => {
    throw new SmardValidationError(`Invalid ${name} ${quoteValue(text)}. ${TIME_HELP}`);
  };
  const relative = { yesterday: -1, today: 0, tomorrow: 1 }[text.toLowerCase()];
  if (relative !== undefined) {
    const f = berlinFields(now.getTime());
    const start = fromBerlin(f.year, f.month, f.day + relative);
    const s = berlinFields(start);
    return { start, end: fromBerlin(s.year, s.month, s.day + 1) };
  }
  let m = /^(\d{4})$/.exec(text);
  if (m !== null) {
    const year = Number(m[1]);
    return { start: fromBerlin(year, 1), end: fromBerlin(year + 1, 1) };
  }
  m = /^(\d{4})-(\d{2})$/.exec(text);
  if (m !== null) {
    const [year, month] = [Number(m[1]), Number(m[2])];
    if (month < 1 || month > 12) bad();
    return { start: fromBerlin(year, month), end: fromBerlin(year, month + 1) };
  }
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(text);
  if (m !== null) {
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) bad();
    if (m[4] === undefined) return { start: fromBerlin(year, month, day), end: fromBerlin(year, month, day + 1) };
    const [hour, minute] = [Number(m[4]), Number(m[5])];
    if (hour > 23 || minute > 59) bad();
    const start = fromBerlin(year, month, day, hour, minute);
    return { start, end: start + 60_000 };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(text)) {
    const start = Date.parse(text);
    if (Number.isNaN(start)) bad();
    return { start, end: start + 60_000 };
  }
  return bad();
}

// --- Shared: series, regions, resolutions ----------------------------------------------------

/** What a series measures, for its unit. */
export type SeriesKind = "renewable" | "fossil" | "nuclear" | "storage" | "consumption" | "forecast" | "price";

/** A documented series with what the use cases need to know about it. */
export interface SeriesInfo {
  id: number;
  /** SMARD's German name. */
  name: string;
  /** The English name. */
  nameEn: string;
  group: FilterGroup;
  kind: SeriesKind;
  /** MWh (energy over each period) or EUR/MWh (a price). */
  unit: "MWh" | "EUR/MWh";
  /** For a price series: the bidding zone it is the price of. */
  zone?: string;
}

/** English names and kinds of the documented series (FILTERS has the German labels). */
const SERIES_EXTRA: Record<number, { name: string; nameEn: string; kind: SeriesKind; zone?: string; words?: string[] }> = {
  1223: { name: "Braunkohle", nameEn: "Lignite", kind: "fossil", words: ["braunkohle", "lignite", "brown coal"] },
  4069: { name: "Steinkohle", nameEn: "Hard coal", kind: "fossil", words: ["steinkohle", "hard coal", "coal"] },
  4071: { name: "Erdgas", nameEn: "Natural gas", kind: "fossil", words: ["erdgas", "gas", "natural gas"] },
  1227: { name: "Sonstige Konventionelle", nameEn: "Other conventional", kind: "fossil", words: ["sonstige konventionelle", "other conventional"] },
  1224: { name: "Kernenergie", nameEn: "Nuclear", kind: "nuclear", words: ["kernenergie", "nuclear", "atomkraft", "atom"] },
  4067: { name: "Wind Onshore", nameEn: "Wind onshore", kind: "renewable", words: ["wind onshore", "onshore", "wind an land"] },
  1225: { name: "Wind Offshore", nameEn: "Wind offshore", kind: "renewable", words: ["wind offshore", "offshore", "wind auf see"] },
  4068: { name: "Photovoltaik", nameEn: "Solar (photovoltaics)", kind: "renewable", words: ["photovoltaik", "photovoltaics", "pv", "solar", "sonne"] },
  4066: { name: "Biomasse", nameEn: "Biomass", kind: "renewable", words: ["biomasse", "biomass"] },
  1226: { name: "Wasserkraft", nameEn: "Hydropower", kind: "renewable", words: ["wasserkraft", "hydropower", "hydro"] },
  1228: { name: "Sonstige Erneuerbare", nameEn: "Other renewable", kind: "renewable", words: ["sonstige erneuerbare", "other renewable"] },
  4070: { name: "Pumpspeicher (Erzeugung)", nameEn: "Pumped storage (generation)", kind: "storage", words: ["pumpspeicher erzeugung", "pumped storage generation"] },
  410: { name: "Stromverbrauch: Gesamt (Netzlast)", nameEn: "Total grid load", kind: "consumption", words: ["netzlast", "grid load", "load", "stromverbrauch", "verbrauch", "consumption", "demand"] },
  4359: { name: "Stromverbrauch: Residuallast", nameEn: "Residual load", kind: "consumption", words: ["residuallast", "residual load", "residual"] },
  4387: { name: "Stromverbrauch: Pumpspeicher", nameEn: "Pumped storage (consumption)", kind: "consumption", words: ["pumpspeicher verbrauch", "pumped storage consumption"] },
  3791: { name: "Prognose: Wind Offshore", nameEn: "Forecast: wind offshore", kind: "forecast", words: ["prognose wind offshore", "forecast wind offshore"] },
  123: { name: "Prognose: Wind Onshore", nameEn: "Forecast: wind onshore", kind: "forecast", words: ["prognose wind onshore", "forecast wind onshore"] },
  125: { name: "Prognose: Photovoltaik", nameEn: "Forecast: solar", kind: "forecast", words: ["prognose photovoltaik", "forecast solar", "forecast pv", "prognose pv"] },
  715: { name: "Prognose: Sonstige", nameEn: "Forecast: other", kind: "forecast", words: ["prognose sonstige", "forecast other"] },
  5097: { name: "Prognose: Wind und Photovoltaik", nameEn: "Forecast: wind and solar", kind: "forecast", words: ["prognose wind und photovoltaik", "forecast wind and solar"] },
  122: { name: "Prognose: Gesamt", nameEn: "Forecast: total generation", kind: "forecast", words: ["prognose gesamt", "forecast total"] },
  4169: { name: "Großhandelspreis: Deutschland/Luxemburg", nameEn: "Day-ahead price: Germany/Luxembourg", kind: "price", zone: "DE-LU", words: ["deutschland", "germany", "de", "de-lu", "de lu", "luxemburg", "luxembourg", "lu", "strompreis", "price", "spot", "spotpreis", "day-ahead"] },
  5078: { name: "Großhandelspreis: Anrainer DE/LU", nameEn: "Day-ahead price: DE-LU neighbours (average)", kind: "price", zone: "neighbours", words: ["anrainer", "neighbours", "neighbors"] },
  4996: { name: "Großhandelspreis: Belgien", nameEn: "Day-ahead price: Belgium", kind: "price", zone: "BE", words: ["belgien", "belgium", "be"] },
  4997: { name: "Großhandelspreis: Norwegen 2", nameEn: "Day-ahead price: Norway 2", kind: "price", zone: "NO2", words: ["norwegen", "norway", "no2", "norwegen 2", "norway 2"] },
  4170: { name: "Großhandelspreis: Österreich", nameEn: "Day-ahead price: Austria", kind: "price", zone: "AT", words: ["osterreich", "oesterreich", "austria", "at"] },
  252: { name: "Großhandelspreis: Dänemark 1", nameEn: "Day-ahead price: Denmark 1 (west)", kind: "price", zone: "DK1", words: ["danemark 1", "daenemark 1", "denmark 1", "dk1", "dk 1"] },
  253: { name: "Großhandelspreis: Dänemark 2", nameEn: "Day-ahead price: Denmark 2 (east)", kind: "price", zone: "DK2", words: ["danemark 2", "daenemark 2", "denmark 2", "dk2", "dk 2"] },
  254: { name: "Großhandelspreis: Frankreich", nameEn: "Day-ahead price: France", kind: "price", zone: "FR", words: ["frankreich", "france", "fr"] },
  255: { name: "Großhandelspreis: Italien (Nord)", nameEn: "Day-ahead price: Italy (north)", kind: "price", zone: "IT-North", words: ["italien", "italy", "italien nord", "italy north", "it", "it-north", "it north"] },
  256: { name: "Großhandelspreis: Niederlande", nameEn: "Day-ahead price: Netherlands", kind: "price", zone: "NL", words: ["niederlande", "netherlands", "holland", "nl"] },
  257: { name: "Großhandelspreis: Polen", nameEn: "Day-ahead price: Poland", kind: "price", zone: "PL", words: ["polen", "poland", "pl"] },
  259: { name: "Großhandelspreis: Schweiz", nameEn: "Day-ahead price: Switzerland", kind: "price", zone: "CH", words: ["schweiz", "switzerland", "ch"] },
  260: { name: "Großhandelspreis: Slowenien", nameEn: "Day-ahead price: Slovenia", kind: "price", zone: "SI", words: ["slowenien", "slovenia", "si"] },
  261: { name: "Großhandelspreis: Tschechien", nameEn: "Day-ahead price: Czechia", kind: "price", zone: "CZ", words: ["tschechien", "czechia", "czech republic", "cz"] },
  262: { name: "Großhandelspreis: Ungarn", nameEn: "Day-ahead price: Hungary", kind: "price", zone: "HU", words: ["ungarn", "hungary", "hu"] },
};

/** The documented series (the catalogue's order), with English names, kind and unit. */
export const SERIES_INFO: readonly SeriesInfo[] = FILTERS.map((f) => {
  const extra = SERIES_EXTRA[f.id];
  const kind = extra?.kind ?? (f.group === "price" ? "price" : f.group === "consumption" ? "consumption" : "forecast");
  return {
    id: f.id,
    name: extra?.name ?? f.label,
    nameEn: extra?.nameEn ?? f.label,
    group: f.group,
    kind,
    unit: kind === "price" ? "EUR/MWh" : "MWh",
    ...(extra?.zone === undefined ? {} : { zone: extra.zone }),
  };
});

/** Lower case, umlauts as their vowel, ß as ss, other marks dropped, punctuation as spaces. */
export function fold(text: string): string {
  return text
    .normalize("NFC")
    .toLocaleLowerCase("de")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A series a text names: one, several (ambiguous), or none. */
type Lookup = { found: SeriesInfo } | { candidates: SeriesInfo[] } | { unknown: number } | { none: string };

/**
 * The series a caller names: an id (any integer: SMARD has more than the documented ones), or a
 * German or English name, an everyday word (pv, solar, Netzlast, gas, France), or a part of a
 * name. A word that names one series exactly wins; several partial matches are ambiguous.
 * `among` narrows the search (the price zones).
 */
function lookupSeries(value: string | number, among: readonly SeriesInfo[] = SERIES_INFO): Lookup {
  if (typeof value === "number" || /^\s*\d+\s*$/.test(value)) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 0) throw new SmardValidationError(`Invalid series ${quoteValue(String(value))}. Expected a series id (a non-negative integer) or a name.`);
    const found = among.find((s) => s.id === id);
    return found === undefined ? { unknown: id } : { found };
  }
  const text = normalizeText(assertValid("series", value, textProblem));
  const key = fold(text);
  if (key === "") throw new SmardValidationError(`Invalid series ${quoteValue(text)}. Expected a series id or a name.`);
  const exact = among.filter((s) => fold(s.name) === key || fold(s.nameEn) === key || s.zone?.toLowerCase() === text.toLowerCase() || (SERIES_EXTRA[s.id]?.words ?? []).some((w) => fold(w) === key));
  if (exact.length === 1) return { found: exact[0] as SeriesInfo };
  if (exact.length > 1) return { candidates: exact };
  const partial = among.filter((s) => fold(s.name).includes(key) || fold(s.nameEn).includes(key));
  if (partial.length === 1) return { found: partial[0] as SeriesInfo };
  if (partial.length > 1) return { candidates: partial };
  return { none: text };
}

/** A region in SMARD's spelling, whatever its case: DE, DE-LU, 50Hertz, TenneT, … */
export function resolveRegion(value: string | undefined, fallback: Region): Region {
  if (value === undefined) return fallback;
  const text = normalizeText(assertValid("region", value, textProblem));
  const found = RegionValues.find((r) => r.toLowerCase() === text.toLowerCase());
  if (found === undefined) throw new SmardValidationError(`Invalid region ${quoteValue(text)}. Expected one of: ${RegionValues.join(", ")}.`);
  return found;
}

/** A resolution, whatever its case; `quarter-hour` and `15min` name quarterhour. */
export function resolveResolution(value: string | undefined, fallback: Resolution, allowed: readonly Resolution[] = ResolutionValues): Resolution {
  if (value === undefined) return fallback;
  const text = normalizeText(assertValid("resolution", value, textProblem)).toLowerCase().replace(/[\s_-]/g, "");
  const word = ({ "15min": "quarterhour", viertelstunde: "quarterhour", hourly: "hour", stunde: "hour", daily: "day", tag: "day", weekly: "week", woche: "week", monthly: "month", monat: "month", yearly: "year", jahr: "year" } as Record<string, string>)[text] ?? text;
  const found = allowed.find((r) => r === word);
  if (found === undefined) throw new SmardValidationError(`Invalid resolution ${quoteValue(value)}. Expected one of: ${allowed.join(", ")}.`);
  return found;
}

/** What one window (data file) of a resolution holds. */
export const WINDOW_SPANS: Record<Resolution, string> = {
  quarterhour: "one week of quarter-hours, Monday 00:00 to Sunday 23:45 Berlin time",
  hour: "one week of hours, Monday 00:00 to Sunday 23:00 Berlin time",
  day: "one calendar year of days",
  week: "one year of weeks (each starts on its Monday)",
  month: "one calendar year of months",
  year: "one year's value",
};

/** The regions with what each one is. */
export const REGIONS: Record<Region, string> = {
  DE: "Germany (the national totals)",
  AT: "Austria",
  LU: "Luxembourg",
  "DE-LU": "the German-Luxembourg bidding zone (the region of every price series)",
  "DE-AT-LU": "the former German-Austrian-Luxembourg bidding zone (until September 2018)",
  "50Hertz": "the 50Hertz control area (east Germany, Hamburg)",
  Amprion: "the Amprion control area (west Germany)",
  TenneT: "the TenneT control area (north to south through the middle of Germany)",
  TransnetBW: "the TransnetBW control area (Baden-Württemberg)",
  APG: "the APG control area (Austria)",
  Creos: "the Creos control area (Luxembourg)",
};

/** Two decimals, as SMARD publishes. */
const round2 = (n: number): number => Math.round(n * 100) / 100;
/** One decimal, for a share in per cent. */
const round1 = (n: number): number => Math.round(n * 10) / 10;

// --- Shared: reading windows -------------------------------------------------------------------

/** Errors that already say SMARD isn't there: never read as a missing file again. */
const notThereErrors = new WeakSet<object>();

/**
 * Tells a file SMARD lacks from a SMARD that isn't there. SMARD answers a series, region,
 * resolution or window it has no file for with a 404; so does a base URL that reaches no SMARD
 * (one ending in /app, as the API's docs write the server: the client adds /app itself) or an
 * error page. Once a request of the use case has had an answer, a 404 is a missing file; before
 * that, the index of the grid load (410, DE, hour), which SMARD always has, is asked once, and a
 * 404 for it too is the error, naming the request that failed: never "no data".
 */
class Upstream {
  private answered = false;
  private check: Promise<void> | undefined;

  constructor(private readonly client: SmardClient) {}

  /** A request had an answer: SMARD is there. */
  ok(): void {
    this.answered = true;
  }

  /**
   * Resolves when `err` is a 404 for a file SMARD lacks; throws `err` when it is anything else,
   * and the not-there error when the grid load's index is a 404 too.
   */
  async absent(err: unknown, filter: number, region: Region, resolution: Resolution): Promise<void> {
    if (!is404(err)) throw err;
    if (this.answered) return;
    const control = (): never => {
      const notThere = new SmardApiError({
        status: 404,
        url: err.url,
        method: err.method,
        body: err.body,
        detail: "the index of the grid load (410, DE, hour), which SMARD always has, is a 404 too: the base URL is wrong (give it without /app; the client adds /app) or SMARD's chart data are not available; this is not a series SMARD lacks",
      });
      notThereErrors.add(notThere);
      throw notThere;
    };
    if (filter === CONTROL.filter && region === CONTROL.region && resolution === CONTROL.resolution) control();
    this.check ??= this.client.timestamps(CONTROL.filter, CONTROL.region, CONTROL.resolution).then(
      () => this.ok(),
      (failed: unknown) => {
        if (failed instanceof SmardApiError && failed.status === 404) control();
        throw failed;
      },
    );
    await this.check;
  }
}

/** The index SMARD always has: the grid load in Germany at hour. */
const CONTROL = { filter: 410, region: "DE" as Region, resolution: "hour" as Resolution };

/** A 404 that may be a file SMARD lacks (not one already found to mean SMARD isn't there). */
const is404 = (err: unknown): err is SmardApiError => err instanceof SmardApiError && err.status === 404 && !notThereErrors.has(err);

/**
 * One series' index and the windows read so far, so a use case reads each file once. With
 * `shared`, the series takes another's index (the series of one region and resolution share their
 * windows), so the mix reads one index instead of eleven; a window of it this series hasn't got
 * (a 404) makes it read its own: a 404 for that too means SMARD hasn't the series, otherwise the
 * window has no values for it.
 */
class SeriesReader {
  private index: Promise<number[]> | undefined;
  private readonly windows = new Map<number, SeriesPoint[]>();
  private readonly metas = new Map<number, SeriesMetaData>();

  constructor(
    private readonly client: SmardClient,
    readonly filter: number,
    readonly region: Region,
    readonly resolution: Resolution,
    readonly upstream: Upstream = new Upstream(client),
    private readonly shared?: () => Promise<number[]>,
  ) {}

  /** The window starts, oldest first: the series' own index, or the shared one until a window of it is missing. */
  starts(): Promise<number[]> {
    return this.index === undefined && this.shared !== undefined ? this.shared() : this.ownStarts();
  }

  /** The series' own index, oldest first (read once). */
  ownStarts(): Promise<number[]> {
    this.index ??= this.client.timestamps(this.filter, this.region, this.resolution).then((index) => {
      this.upstream.ok();
      return [...index].sort((a, b) => a - b);
    });
    return this.index;
  }

  /** Resolves when `err` is a 404 for a file of this series SMARD lacks, else throws (Upstream). */
  absent(err: unknown): Promise<void> {
    return this.upstream.absent(err, this.filter, this.region, this.resolution);
  }

  /** The points of the window that starts at `start`. */
  async points(start: number): Promise<SeriesPoint[]> {
    let points = this.windows.get(start);
    if (points === undefined) {
      let file: SeriesResult;
      try {
        file = await this.client.series(this.filter, this.region, this.resolution, start);
      } catch (err) {
        // The shared index named a window this series hasn't got: its own index says whether SMARD
        // has the series at all (its 404 is thrown); if so, the window has no values for it.
        if (this.shared === undefined || !is404(err)) throw err;
        await this.ownStarts();
        this.windows.set(start, []);
        return [];
      }
      this.upstream.ok();
      points = [...file.series].sort((a, b) => a[0] - b[0]);
      this.windows.set(start, points);
      this.metas.set(start, file.meta_data);
    }
    return points;
  }

  /** The `meta_data` of a window read (its data version and when SMARD wrote the file). */
  meta(start: number): SeriesMetaData | undefined {
    return this.metas.get(start);
  }

  /** The start of the window an instant falls in (the newest one starting at or before it). */
  async windowAt(instant: number): Promise<number | undefined> {
    const starts = await this.starts();
    let found: number | undefined;
    for (const start of starts) if (start <= instant) found = start;
    return found;
  }

  /** The point whose period holds `instant` (the newest at or before it), or undefined. */
  async pointAt(instant: number): Promise<SeriesPoint | undefined> {
    const start = await this.windowAt(instant);
    if (start === undefined) return undefined;
    let found: SeriesPoint | undefined;
    for (const point of await this.points(start)) if (point[0] <= instant) found = point;
    return found;
  }

  /**
   * The newest settled point: the last non-null one of the newest window, never its last point
   * (the tail is null until published). A newest window without one (just begun) gives the
   * window before's.
   */
  async lastSettled(): Promise<SeriesPoint | undefined> {
    const starts = await this.starts();
    for (const start of starts.slice(-2).reverse()) {
      const settled = (await this.points(start)).filter((p) => p[1] !== null);
      if (settled.length > 0) return settled[settled.length - 1];
    }
    return undefined;
  }

  /** The `source` path of a window file (under the API base). */
  path(window: number): string {
    return `chart_data/${this.filter}/${encodeURIComponent(this.region)}/${this.filter}_${encodeURIComponent(this.region)}_${this.resolution}_${window}.json`;
  }
}

/** The empty answer for a series SMARD has no index for. */
function noSuchSeries(filter: number, region: Region, resolution: Resolution, searched: Record<string, unknown>): Empty {
  const price = SERIES_INFO.find((s) => s.id === filter)?.kind === "price";
  return {
    status: "empty",
    searched,
    reason: `SMARD publishes no series ${filter} for region ${region} at resolution ${resolution} (HTTP 404).${price && region !== "DE-LU" ? " Price series use region DE-LU." : " Check the id with listSeries; not every series exists in every region and resolution."}`,
  };
}

/** No answer, and why. */
export interface Empty {
  status: "empty";
  reason: string;
  searched: Record<string, unknown>;
}

/** A name several series or zones fit: the candidates, to ask which one. */
export interface Ambiguous {
  status: "ambiguous";
  reason: string;
  searched: Record<string, unknown>;
  candidates: { id: number; name: string; nameEn: string; zone?: string }[];
}

const candidatesOf = (list: readonly SeriesInfo[]) => list.map((s) => ({ id: s.id, name: s.name, nameEn: s.nameEn, ...(s.zone === undefined ? {} : { zone: s.zone }) }));

// --- getGenerationMix ---------------------------------------------------------------------------

/** The generation sources of the mix (Pumpspeicher, storage, is reported apart). */
const MIX_SOURCES = [1223, 4069, 4071, 1227, 1224, 4067, 1225, 4068, 4066, 1226, 1228];
const PUMPED_STORAGE = 4070;
const NUCLEAR = 1224;
/** How many files the mix reads at a time. */
const MIX_PARALLEL = 2;

/** `fn` over `items`, at most `limit` at a time, the results in order; after a failure nothing more is started. */
async function inTurns<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i] as T);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Germany's last three reactors went offline on 15 April 2023: no nuclear generation since. */
const NUCLEAR_END = fromBerlin(2023, 4, 16);

export interface GenerationMixInput {
  /** DE (default) or a control area (50Hertz, Amprion, TenneT, TransnetBW), any case. */
  region?: string;
  /** day (default), hour, quarterhour, week, month or year. */
  resolution?: string;
  /** The period to read (parseTime: 2026-11-18, 2026-11, 2026, 2026-11-18T14:00, yesterday); default the newest settled one. */
  at?: string;
  /** The clock for `at`'s today/yesterday (tests). */
  now?: Date;
}

export interface MixSource {
  id: number;
  name: string;
  nameEn: string;
  kind: "renewable" | "fossil" | "nuclear";
  mwh: number;
  /** Per cent of the total generation, one decimal. */
  share: number;
}

export interface GenerationMix {
  status: "ok";
  region: Region;
  resolution: Resolution;
  /** The period every value is for: its start (Berlin time) and its Berlin name. */
  period: { start: string; label: string };
  unit: "MWh";
  /** The sum of the sources, without pumped storage. */
  totalMWh: number;
  renewableShare: number;
  fossilShare: number;
  /** Only when nuclear is in the mix (a period before 16 April 2023). */
  nuclearShare?: number;
  /** Biggest first; a source that generated 0 is listed, not dropped. */
  sources: MixSource[];
  /** Pumped storage's generation (4070): storage, not counted in the total. */
  pumpedStorage: { id: number; mwh: number | null };
  /** Sources left out with why (nuclear since April 2023). */
  ended: { id: number; name: string; note: string }[];
  /** Sources with no value for the period (not published yet): the total is without them. */
  missing: { id: number; name: string }[];
  /** Sources (and pumped storage) SMARD publishes no series of for the region (a 404 for the index): the total is without them. */
  absent: { id: number; name: string }[];
  /** Sources whose newest settled value is older than the others': every source is read at their period. */
  behind: { id: number; name: string; newest: string }[];
  notes: string[];
  searched: Record<string, unknown>;
  /** The window file the period is in, for `source`. */
  window: number;
}

/**
 * The generation mix for one period: every source's energy (MWh), the total, each share, the
 * renewable and the fossil share. Without `at`, the newest period every source has settled data
 * for (the last non-null point, never the null tail; a source ahead of the others is read at the
 * period all have, the sources behind named). Kernenergie is left out of any period after 15 April 2023 (its series is dead,
 * its last point an old 0), Pumpspeicher (storage) is given apart and not counted. One index
 * (the sources share their windows) and a window file per source (about 12 requests), two at a
 * time; a source's own index only when the shared one names a window it hasn't got.
 */
export async function getGenerationMix(client: SmardClient, input: GenerationMixInput = {}): Promise<GenerationMix | Empty> {
  const region = resolveRegion(input.region, "DE");
  const resolution = resolveResolution(input.resolution, "day");
  const at = input.at === undefined ? undefined : parseTime("at", input.at, input.now);
  const searched = { region, resolution, ...(input.at === undefined ? {} : { at: input.at }) };
  const info = (id: number) => SERIES_INFO.find((s) => s.id === id) as SeriesInfo;
  const ended: GenerationMix["ended"] = [];
  const ids = MIX_SOURCES.filter((id) => {
    if (id !== NUCLEAR || (at !== undefined && at.start < NUCLEAR_END)) return true;
    ended.push({ id, name: info(id).name, note: "Germany's last reactors went offline on 15 April 2023; SMARD's series has no live values since, so it is left out." });
    return false;
  });
  const upstream = new Upstream(client);
  // A source SMARD hasn't for the region (TransnetBW has no lignite): left out and named.
  const absent = new Set<number>();
  const order = [4067, ...ids.filter((id) => id !== 4067), PUMPED_STORAGE];
  // One index for every source, they share their windows: Wind Onshore's, else the next source's.
  let sharedIndex: Promise<number[]> | undefined;
  const shared = (): Promise<number[]> =>
    (sharedIndex ??= (async () => {
      for (const id of order) {
        try {
          return await reader(id).ownStarts();
        } catch (err) {
          await upstream.absent(err, id, region, resolution);
          absent.add(id);
        }
      }
      return [];
    })());
  const readers = new Map(order.map((id) => [id, new SeriesReader(client, id, region, resolution, upstream, shared)]));
  const reader = (id: number) => readers.get(id) as SeriesReader;
  /** `read` of a source, or undefined when SMARD hasn't the source for the region (a 404 for its index). */
  const ofSource = async <T>(id: number, read: (r: SeriesReader) => Promise<T>): Promise<T | undefined> => {
    if (absent.has(id)) return undefined;
    try {
      return await read(reader(id));
    } catch (err) {
      await upstream.absent(err, id, region, resolution);
      absent.add(id);
      return undefined;
    }
  };
  const absentOnes = () => order.filter((id) => absent.has(id)).map((id) => ({ id, name: info(id).name }));

  // The period: the one `at` names, or the newest all sources have settled.
  let target: number;
  const behind: GenerationMix["behind"] = [];
  const windows = await shared();
  if (ids.every((id) => absent.has(id))) {
    return { status: "empty", searched, reason: `SMARD publishes none of the generation series for region ${region} at resolution ${resolution} (HTTP 404). Not every region has every resolution; DE has all.` };
  }
  if (at !== undefined) {
    let point: SeriesPoint | undefined;
    for (const id of ids) if (point === undefined) point = await ofSource(id, (r) => r.pointAt(at.start));
    if (point === undefined) return { status: "empty", searched, reason: `SMARD's ${resolution} series start later than ${input.at}: ask for a later period.` };
    // The newest point at or before `at` is the period holding it only if that period reaches `at`:
    // after the newest file it is the file's last point, a period the caller never named.
    if (nextPeriod(point[0], resolution) <= at.start) {
      return { status: "empty", searched, reason: `Nothing published for ${input.at} at resolution ${resolution} in region ${region} yet: SMARD publishes a period after it ends. Leave out at for the newest settled period.` };
    }
    target = point[0];
  } else {
    const newest = new Map<number, number>();
    const settledOf = await inTurns(ids, MIX_PARALLEL, (id) => ofSource(id, (r) => r.lastSettled()));
    ids.forEach((id, i) => {
      const settled = settledOf[i];
      if (settled !== undefined) newest.set(id, settled[0]);
    });
    if (newest.size === 0) return { status: "empty", searched, reason: `No source has settled ${resolution} data in region ${region} yet.` };
    target = Math.min(...newest.values());
    const latest = Math.max(...newest.values());
    if (latest > target) {
      for (const [id, ts] of newest) if (ts < latest) behind.push({ id, name: info(id).name, newest: periodLabel(ts, resolution) });
    }
  }

  const sources: MixSource[] = [];
  const missing: GenerationMix["missing"] = [];
  const valueAt = async (id: number): Promise<number | null> => {
    const point = await ofSource(id, (r) => r.pointAt(target));
    return point !== undefined && point[0] === target ? point[1] : null;
  };
  const values = await inTurns(ids, MIX_PARALLEL, valueAt);
  for (const [i, id] of ids.entries()) {
    if (absent.has(id)) continue;
    const value = values[i] as number | null;
    const s = info(id);
    if (value === null) missing.push({ id, name: s.name });
    else sources.push({ id, name: s.name, nameEn: s.nameEn, kind: s.kind as MixSource["kind"], mwh: value, share: 0 });
  }
  const label = periodLabel(target, resolution);
  if (sources.length === 0) {
    return { status: "empty", searched, reason: `No settled ${resolution} data for ${label} in region ${region} yet (the values are not published). Leave out at for the newest settled period.` };
  }
  const pumped = await valueAt(PUMPED_STORAGE);
  const total = sources.reduce((sum, s) => sum + s.mwh, 0);
  const shareOf = (kind: MixSource["kind"]) => (total > 0 ? round1((sources.filter((s) => s.kind === kind).reduce((sum, s) => sum + s.mwh, 0) / total) * 100) : 0);
  for (const s of sources) s.share = total > 0 ? round1((s.mwh / total) * 100) : 0;
  sources.sort((a, b) => b.mwh - a.mwh || a.id - b.id);

  const notes: string[] = [];
  const gone = absentOnes().filter((a) => a.id !== PUMPED_STORAGE);
  if (gone.length > 0) notes.push(`SMARD publishes no ${gone.map((a) => a.name).join(", ")} series for region ${region} (HTTP 404): the total and the shares are without ${gone.length === 1 ? "it" : "them"}.`);
  if (behind.length > 0) notes.push(`${behind.map((b) => `${b.name} (newest ${b.newest})`).join(", ")} ${behind.length === 1 ? "lags" : "lag"} behind the others; every source is read at ${label}, the newest period all have.`);
  if (missing.length > 0) notes.push(`${missing.map((m) => m.name).join(", ")}: no value for ${label} yet; the total and the shares are without ${missing.length === 1 ? "it" : "them"}.`);
  notes.push(`Values are energy over the ${resolution} in MWh (1 TWh = 1,000,000 MWh). Pumped storage is storage, not generation: not in the total.`);
  const window = windows.filter((start) => start <= target).pop() ?? target;
  return {
    status: "ok",
    region,
    resolution,
    period: { start: berlinTime(target), label },
    unit: "MWh",
    totalMWh: round2(total),
    renewableShare: shareOf("renewable"),
    fossilShare: shareOf("fossil"),
    ...(sources.some((s) => s.kind === "nuclear") ? { nuclearShare: shareOf("nuclear") } : {}),
    sources,
    pumpedStorage: { id: PUMPED_STORAGE, mwh: pumped },
    ended,
    missing,
    absent: absentOnes(),
    behind,
    notes,
    searched,
    window,
  };
}

// --- getPrices ----------------------------------------------------------------------------------

/** The price series, the bidding zones. */
export const PRICE_ZONES: readonly SeriesInfo[] = SERIES_INFO.filter((s) => s.kind === "price");

export interface PricesInput {
  /** 1-8 bidding zones: a code (DE-LU, FR, AT, NL, DK1 …), a name (Frankreich, Austria), or a price series id; default DE-LU. */
  zones?: (string | number)[];
  /** quarterhour (default: the actual day-ahead prices) or hour (each the mean of its four quarter-hours). */
  resolution?: string;
  /** The Berlin day: today (default), tomorrow, yesterday or a date (2026-11-18). */
  day?: string;
  /** The clock (tests). */
  now?: Date;
}

/** A price at a slot: when it starts (Berlin time), EUR/MWh and ct/kWh. */
export interface PriceAt {
  time: string;
  eurPerMWh: number;
  ctPerKWh: number;
}

export interface ZonePrices {
  zone: string;
  id: number;
  name: string;
  nameEn: string;
  /** False when the day's prices aren't published yet (or SMARD has none for it). */
  published: boolean;
  /** The slot running now (the newest at or before now, never simply the last published one); only for today. */
  current?: PriceAt;
  /** The day's cheapest and dearest slot (the first of equal ones). */
  min?: PriceAt;
  max?: PriceAt;
  average?: { eurPerMWh: number; ctPerKWh: number };
  /** The day's slots with a price, and how many of them are negative (paid to consume). */
  slots: number;
  negativeSlots: number;
  /** The last slot with a price: once the noon auction is out, tomorrow 23:45. */
  publishedUntil?: string;
  /** For today: whether tomorrow's prices are out. */
  tomorrowPublished?: boolean;
}

export interface Prices {
  status: "ok";
  day: string;
  resolution: "quarterhour" | "hour";
  basis: string;
  unit: "EUR/MWh";
  zones: ZonePrices[];
  /** Two or more zones: ranked cheapest first at one slot all have (today: the current one), else on the day's averages. */
  comparison?: { at: string; basis: string; ranking: { zone: string; eurPerMWh: number; ctPerKWh: number }[]; notIncluded: string[] };
  notes: string[];
  searched: Record<string, unknown>;
  /** The window file of the first zone, for `source`. */
  window: number;
  filter: number;
}

/** EUR/MWh as ct/kWh (a tenth), two decimals. */
const ct = (eurPerMWh: number): number => Math.round(eurPerMWh * 10) / 100 + 0;

const priceAt = (point: [number, number]): PriceAt => ({ time: berlinTime(point[0]), eurPerMWh: point[1], ctPerKWh: ct(point[1]) });

/**
 * Day-ahead prices for a Berlin day in one or more bidding zones: the current slot (today only:
 * the newest slot at or before now, never the last published one, which from the afternoon is
 * tomorrow 23:45), the day's low and high with their times, the average, negative slots. Every
 * price series is read with region DE-LU (the series id picks the zone). quarterhour is the
 * market's own price since October 2025; hour is the mean of four quarter-hours and hides the
 * cheapest slot. Zones are compared at one slot all have published, or, for another day, on their
 * averages. A name several zones fit (Dänemark) is ambiguous.
 */
export async function getPrices(client: SmardClient, input: PricesInput = {}): Promise<Prices | Empty | Ambiguous> {
  const resolution = resolveResolution(input.resolution, "quarterhour", ["quarterhour", "hour"]) as "quarterhour" | "hour";
  const now = input.now ?? new Date();
  const dayText = input.day ?? "today";
  const day = parseTime("day", dayText, now);
  if (day.end - day.start < 22 * 3_600_000 || day.end - day.start > 26 * 3_600_000) {
    throw new SmardValidationError(`Invalid day ${quoteValue(dayText)}. Expected one day: today, tomorrow, yesterday or a date (2026-11-18).`);
  }
  const isToday = berlinDate(day.start) === berlinDate(now.getTime());
  const asked = input.zones === undefined || input.zones.length === 0 ? ["DE-LU"] : input.zones;
  if (asked.length > 8) throw new SmardValidationError("Invalid zones: at most 8 bidding zones per call.");
  const searched = { zones: asked, resolution, day: dayText };
  const zones: SeriesInfo[] = [];
  for (const value of asked) {
    const found = lookupSeries(value, PRICE_ZONES);
    if ("candidates" in found) {
      return { status: "ambiguous", searched, candidates: candidatesOf(found.candidates), reason: `${quoteValue(String(value))} fits ${found.candidates.length} bidding zones: ask which one, then call again with its zone code.` };
    }
    if ("unknown" in found) throw new SmardValidationError(`Invalid zone ${quoteValue(String(value))}: ${found.unknown} is not one of SMARD's price series (${PRICE_ZONES.map((z) => `${z.id} ${z.zone}`).join(", ")}).`);
    if ("none" in found) throw new SmardValidationError(`Invalid zone ${quoteValue(String(value))}: no bidding zone of that name. SMARD has prices for ${PRICE_ZONES.map((z) => z.zone).join(", ")}.`);
    if (!zones.includes(found.found)) zones.push(found.found);
  }

  const results: ZonePrices[] = [];
  const dayPoints = new Map<string, [number, number][]>();
  const currents = new Map<string, [number, number]>();
  let firstWindow: number | undefined;
  const upstream = new Upstream(client);
  for (const zone of zones) {
    const reader = new SeriesReader(client, zone.id, "DE-LU", resolution, upstream);
    const result: ZonePrices = { zone: zone.zone ?? String(zone.id), id: zone.id, name: zone.name, nameEn: zone.nameEn, published: false, slots: 0, negativeSlots: 0 };
    results.push(result);
    let starts: number[];
    try {
      starts = await reader.starts();
    } catch (err) {
      await reader.absent(err);
      continue;
    }
    const newest = starts[starts.length - 1];
    if (newest === undefined) continue;
    // The day lies in one window (Monday to Sunday, Berlin time).
    const window = await reader.windowAt(day.start);
    firstWindow ??= window ?? newest;
    const points = window === undefined ? [] : (await reader.points(window)).filter((p): p is [number, number] => p[1] !== null && p[0] >= day.start && p[0] < day.end);
    const settled = (await reader.lastSettled()) as [number, number] | undefined;
    if (settled !== undefined) result.publishedUntil = berlinTime(settled[0]);
    if (isToday) {
      result.tomorrowPublished = settled !== undefined && settled[0] >= day.end;
      const current = await reader.pointAt(now.getTime());
      if (current !== undefined && current[1] !== null) {
        currents.set(result.zone, current as [number, number]);
        result.current = priceAt(current as [number, number]);
      }
    }
    if (points.length === 0) continue;
    dayPoints.set(result.zone, points);
    result.published = true;
    result.slots = points.length;
    result.negativeSlots = points.filter((p) => p[1] < 0).length;
    result.min = priceAt(points.reduce((a, b) => (b[1] < a[1] ? b : a)));
    result.max = priceAt(points.reduce((a, b) => (b[1] > a[1] ? b : a)));
    const average = points.reduce((sum, p) => sum + p[1], 0) / points.length;
    result.average = { eurPerMWh: round2(average), ctPerKWh: ct(average) };
  }

  const label = berlinDate(day.start);
  const firstZone = zones[0] as SeriesInfo;
  if (results.every((r) => !r.published)) {
    const until = results.find((r) => r.publishedUntil !== undefined)?.publishedUntil;
    return {
      status: "empty",
      searched,
      reason: `No day-ahead prices for ${label} yet${until === undefined ? "" : ` (published until ${until})`}. The next day's prices are set in the noon auction; SMARD publishes some zones (DE-LU among them) hours later, at times only late in the evening. Ask for today or an earlier day, or ask again later.`,
    };
  }

  const notes: string[] = [];
  const unpublished = results.filter((r) => !r.published).map((r) => r.zone);
  if (unpublished.length > 0) notes.push(`No prices for ${label} yet: ${unpublished.join(", ")}.`);
  const negative = results.filter((r) => r.negativeSlots > 0);
  if (negative.length > 0) notes.push(`Negative prices (paid to consume) in ${negative.map((r) => `${r.zone} (${r.negativeSlots} slots)`).join(", ")}: real, not an error.`);
  notes.push("1 EUR/MWh is 0.1 ct/kWh. Day-ahead wholesale prices, without grid fees, taxes or levies.");

  let comparison: Prices["comparison"];
  if (results.length > 1) {
    if (isToday && currents.size > 1) {
      // One slot all have: the earliest of the zones' current slots.
      const at = Math.min(...[...currents.values()].map((p) => p[0]));
      const ranking: { zone: string; eurPerMWh: number; ctPerKWh: number }[] = [];
      for (const r of results) {
        const point = (dayPoints.get(r.zone) ?? []).find((p) => p[0] === at);
        if (point !== undefined) ranking.push({ zone: r.zone, eurPerMWh: point[1], ctPerKWh: ct(point[1]) });
      }
      ranking.sort((a, b) => a.eurPerMWh - b.eurPerMWh);
      comparison = { at: berlinTime(at), basis: `the ${resolution === "hour" ? "hour" : "quarter-hour"} running now`, ranking, notIncluded: results.filter((r) => !ranking.some((x) => x.zone === r.zone)).map((r) => r.zone) };
    } else {
      const ranking = results.filter((r) => r.average !== undefined).map((r) => ({ zone: r.zone, eurPerMWh: r.average?.eurPerMWh ?? 0, ctPerKWh: r.average?.ctPerKWh ?? 0 }));
      ranking.sort((a, b) => a.eurPerMWh - b.eurPerMWh);
      comparison = { at: label, basis: "the day's average", ranking, notIncluded: results.filter((r) => r.average === undefined).map((r) => r.zone) };
    }
  }
  return {
    status: "ok",
    day: label,
    resolution,
    basis: resolution === "quarterhour" ? "quarter-hour prices (the day-ahead market's own, since 1 October 2025)" : "hourly averages (each the mean of its four quarter-hour prices: it hides the cheapest quarter-hour)",
    unit: "EUR/MWh",
    zones: results,
    ...(comparison === undefined ? {} : { comparison }),
    notes,
    searched,
    window: firstWindow ?? day.start,
    filter: firstZone.id,
  };
}

// --- getSeries ----------------------------------------------------------------------------------

export interface SeriesInput {
  /** A series id or name (Netzlast, pv, Wind Onshore, Frankreich …). */
  series: string | number;
  /** DE by default; DE-LU for a price series. */
  region?: string;
  /** hour (default), quarterhour, day, week, month or year. */
  resolution?: string;
  /** Range start and end (parseTime; `to` includes the whole period it names); default the newest window. */
  from?: string;
  to?: string;
  /** Gaps inside the range: drop (default, a dense list) or keep (rows with value null). The unpublished tail is never a row. */
  nulls?: "drop" | "keep";
  /** At most this many windows (files) are read; the rest is named, to call again from there. */
  maxWindows?: number;
  now?: Date;
}

export interface SeriesRow {
  /** Sub-day: the UTC instant (ISO 8601); day and longer: the Berlin period (2026-11-18, 2026-11, 2026). */
  time: string;
  value: number | null;
}

/** A window file read: its start (Berlin time and epoch ms) and its `meta_data` (version, created) as SMARD sent it. */
export interface SeriesFile {
  start: string;
  timestamp: number;
  version: unknown;
  created: unknown;
}

export interface SeriesExport {
  status: "ok";
  series: { id: number; name: string; nameEn: string; unit: string; group?: FilterGroup };
  region: Region;
  resolution: Resolution;
  /** What `time` is, and a CSV header for the rows. */
  timeKey: string;
  header: string;
  rows: SeriesRow[];
  first?: string;
  last?: string;
  /** Gaps (null inside the range) kept or dropped, and the unpublished points after the last settled one, left out. */
  nulls: { kept: number; dropped: number; unpublished: number };
  windowsRead: number;
  /** The range needs more windows than were read: call again from `nextFrom`. */
  incomplete?: { reason: string; nextFrom: string };
  notes: string[];
  searched: Record<string, unknown>;
  /** The window files read: their start, and SMARD's data version and file time as the file states them. */
  files: SeriesFile[];
}

/**
 * One series over a range as one ordered list of rows: the windows (files) the range touches are
 * read, stitched, sorted, de-duplicated on the timestamp, cut to the range. The unpublished tail
 * (nulls after the last settled point) is left out and counted; gaps inside are dropped or kept
 * as null, never 0. Sub-day rows are keyed by their UTC instant, day and longer by their Berlin
 * period (a day starts at 23:00Z the day before: its UTC date is the day before).
 */
export async function getSeries(client: SmardClient, input: SeriesInput): Promise<SeriesExport | Empty | Ambiguous> {
  const found = lookupSeries(input.series);
  const searched: Record<string, unknown> = { series: input.series, ...(input.region === undefined ? {} : { region: input.region }), ...(input.resolution === undefined ? {} : { resolution: input.resolution }), ...(input.from === undefined ? {} : { from: input.from }), ...(input.to === undefined ? {} : { to: input.to }) };
  if ("candidates" in found) {
    return { status: "ambiguous", searched, candidates: candidatesOf(found.candidates), reason: `${quoteValue(String(input.series))} fits ${found.candidates.length} series: ask which one, then call again with its id.` };
  }
  if ("none" in found) {
    return { status: "empty", searched, reason: `No documented series is called ${quoteValue(found.none)}. listSeries gives the ids and names; any other SMARD id works as a number.` };
  }
  const info = "found" in found ? found.found : undefined;
  const id = info?.id ?? (found as { unknown: number }).unknown;
  const region = resolveRegion(input.region, info?.kind === "price" ? "DE-LU" : "DE");
  const resolution = resolveResolution(input.resolution, "hour");
  const now = input.now ?? new Date();
  const from = input.from === undefined ? undefined : parseTime("from", input.from, now);
  const to = input.to === undefined ? undefined : parseTime("to", input.to, now);
  if (from !== undefined && to !== undefined && to.end <= from.start) throw new SmardValidationError(`Invalid range: to (${input.to}) is before from (${input.from}).`);
  const maxWindows = input.maxWindows ?? 10;
  const reader = new SeriesReader(client, id, region, resolution);
  let starts: number[];
  try {
    starts = await reader.starts();
  } catch (err) {
    await reader.absent(err);
    return noSuchSeries(id, region, resolution, searched);
  }
  const newest = starts[starts.length - 1];
  if (newest === undefined) return { status: "empty", searched, reason: `SMARD lists no windows for series ${id} in ${region} at ${resolution}.` };
  // The windows the range touches: from the one holding `from` to the one holding `to`.
  // Neither: the newest window with published values (a week just begun has none yet).
  const settled = from === undefined && to === undefined ? await reader.lastSettled() : undefined;
  const fromWindow = from !== undefined ? ((await reader.windowAt(from.start)) ?? starts[0]) : to === undefined ? ((settled === undefined ? undefined : await reader.windowAt(settled[0])) ?? newest) : undefined;
  const toLimit = to?.end ?? (from === undefined ? (starts[starts.indexOf(fromWindow as number) + 1] ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER);
  let wanted = starts.filter((s) => s < toLimit && (fromWindow === undefined ? true : s >= fromWindow));
  if (from === undefined && to !== undefined) wanted = wanted.slice(-1);
  if (wanted.length === 0) {
    return { status: "empty", searched, reason: `SMARD's ${resolution} series ${id} starts at ${periodLabel(starts[0] as number, resolution)}: the range ends before it.` };
  }
  let incomplete: SeriesExport["incomplete"];
  let upper = toLimit;
  if (wanted.length > maxWindows) {
    const next = wanted[maxWindows] as number;
    wanted = wanted.slice(0, maxWindows);
    upper = next;
    incomplete = { reason: `The range spans more than ${maxWindows} windows (${WINDOW_SPANS[resolution]} each); these rows cover the first ${maxWindows}.`, nextFrom: berlinTime(next) };
  }
  const byTime = new Map<number, number | null>();
  for (const start of wanted) for (const [t, v] of await reader.points(start)) if (!byTime.has(t) || byTime.get(t) === null) byTime.set(t, v);
  const lower = from?.start ?? Number.MIN_SAFE_INTEGER;
  const points = [...byTime].filter(([t]) => t >= lower && t < upper).sort((a, b) => a[0] - b[0]);
  let lastSettled = -1;
  points.forEach(([, v], i) => {
    if (v !== null) lastSettled = i;
  });
  const unpublished = points.length - 1 - lastSettled;
  const inside = points.slice(0, lastSettled + 1);
  const gaps = inside.filter(([, v]) => v === null).length;
  const keep = input.nulls === "keep";
  const subDay = resolution === "hour" || resolution === "quarterhour";
  const timeOf = (t: number) => (subDay ? new Date(t).toISOString().replace(".000Z", "Z") : periodLabel(t, resolution));
  const rows: SeriesRow[] = inside.filter(([, v]) => keep || v !== null).map(([t, v]) => ({ time: timeOf(t), value: v }));
  const unit = info?.unit ?? "MWh for amounts, EUR/MWh for prices (not in the catalogue)";
  const column = { quarterhour: "timestamp_utc", hour: "timestamp_utc", day: "date", week: "week_starting", month: "month", year: "year" }[resolution];
  const notes: string[] = [];
  if (unpublished > 0) notes.push(`${unpublished} points after ${rows.length > 0 ? rows[rows.length - 1]?.time : "the range's start"} are not published yet (null): left out.`);
  if (gaps > 0) notes.push(keep ? `${gaps} gaps kept as null: an empty cell, never 0.` : `${gaps} gaps (null inside the range) dropped; nulls: keep keeps them as empty cells.`);
  if (subDay) notes.push("time is the UTC instant each period starts; for Berlin wall-clock time add a second column (the last Sunday in October repeats 02:00-02:59).");
  else notes.push(`time is the Berlin ${resolution === "week" ? "date of the week's Monday" : resolution} each value is for (SMARD's periods start at Berlin midnight; their UTC date is the day before).`);
  if (rows.length === 0) {
    return { status: "empty", searched: { ...searched, region, resolution }, reason: `No published values of series ${id} in ${region} at ${resolution} in the range${unpublished > 0 ? " yet (only the unpublished tail)" : ""}.` };
  }
  return {
    status: "ok",
    series: { id, name: info?.name ?? `series ${id}`, nameEn: info?.nameEn ?? `series ${id}`, unit, ...(info === undefined ? {} : { group: info.group }) },
    region,
    resolution,
    timeKey: subDay ? "the UTC instant the period starts (ISO 8601)" : `the Berlin ${resolution} (${resolution === "week" ? "its Monday" : "its calendar name"})`,
    header: `${column},${info?.nameEn ?? `series ${id}`} (${info?.unit ?? "value"})`,
    rows,
    first: rows[0]?.time,
    last: rows[rows.length - 1]?.time,
    nulls: { kept: keep ? gaps : 0, dropped: keep ? 0 : gaps, unpublished },
    windowsRead: wanted.length,
    ...(incomplete === undefined ? {} : { incomplete }),
    notes,
    searched: { ...searched, region, resolution },
    files: wanted.map((start) => {
      const meta = reader.meta(start) as Record<string, unknown> | undefined;
      const created = meta?.["created"];
      return { start: berlinTime(start), timestamp: start, version: meta?.["version"] ?? null, created: typeof created === "number" && Number.isSafeInteger(created) && created >= 0 ? berlinTime(created) : (created ?? null) };
    }),
  };
}

// --- listSeries, listWindows --------------------------------------------------------------------

export interface SeriesList {
  status: "ok" | "empty";
  series: SeriesInfo[];
  regions: { region: Region; is: string }[];
  resolutions: { resolution: Resolution; window: string }[];
  reason?: string;
  searched: Record<string, unknown>;
}

/** The documented series (all, one group, or those whose name contains a text), the regions, the resolutions. No request. */
export function listSeries(input: { group?: string; query?: string } = {}): SeriesList {
  let series = [...SERIES_INFO];
  const searched: Record<string, unknown> = {};
  if (input.group !== undefined) {
    const group = normalizeText(assertValid("group", input.group, textProblem)).toLowerCase();
    if (!(["generation", "consumption", "price", "forecast"] as string[]).includes(group)) throw new SmardValidationError(`Invalid group ${quoteValue(input.group)}. Expected one of: generation, consumption, price, forecast.`);
    series = series.filter((s) => s.group === group);
    searched["group"] = group;
  }
  if (input.query !== undefined) {
    const key = fold(normalizeText(assertValid("query", input.query, textProblem)));
    series = series.filter((s) => fold(s.name).includes(key) || fold(s.nameEn).includes(key) || (SERIES_EXTRA[s.id]?.words ?? []).some((w) => fold(w) === key) || fold(s.zone ?? "") === key);
    searched["query"] = input.query;
  }
  return {
    status: series.length === 0 ? "empty" : "ok",
    series,
    regions: RegionValues.map((region) => ({ region, is: REGIONS[region] })),
    resolutions: ResolutionValues.map((resolution) => ({ resolution, window: WINDOW_SPANS[resolution] })),
    ...(series.length === 0 ? { reason: "No documented series matches; try a shorter word, a group, or none. SMARD has more ids than the documented ones: any id works as a number." } : {}),
    searched,
  };
}

export interface WindowList {
  status: "ok";
  series: { id: number; name: string };
  region: Region;
  resolution: Resolution;
  /** What one window holds. */
  span: string;
  /** Newest first: each window's start (Berlin time), its Berlin name and its epoch ms (the CLI's timestamp). */
  windows: { start: string; label: string; timestamp: number }[];
  total: number;
  oldest: string;
  newest: string;
  searched: Record<string, unknown>;
}

/** The windows (data files) a series is published in, newest first: how far back it goes. */
export async function listWindows(client: SmardClient, input: { series: string | number; region?: string; resolution?: string }): Promise<WindowList | Empty | Ambiguous> {
  const found = lookupSeries(input.series);
  const searched: Record<string, unknown> = { series: input.series };
  if ("candidates" in found) return { status: "ambiguous", searched, candidates: candidatesOf(found.candidates), reason: `${quoteValue(String(input.series))} fits ${found.candidates.length} series: ask which one, then call again with its id.` };
  if ("none" in found) return { status: "empty", searched, reason: `No documented series is called ${quoteValue(found.none)}. listSeries gives the ids and names.` };
  const info = "found" in found ? found.found : undefined;
  const id = info?.id ?? (found as { unknown: number }).unknown;
  const region = resolveRegion(input.region, info?.kind === "price" ? "DE-LU" : "DE");
  const resolution = resolveResolution(input.resolution, "hour");
  Object.assign(searched, { region, resolution });
  const reader = new SeriesReader(client, id, region, resolution);
  let starts: number[];
  try {
    starts = await reader.starts();
  } catch (err) {
    await reader.absent(err);
    return noSuchSeries(id, region, resolution, searched);
  }
  if (starts.length === 0) return { status: "empty", searched, reason: `SMARD lists no windows for series ${id} in ${region} at ${resolution}.` };
  const windows = [...starts].reverse().map((timestamp) => ({ start: berlinTime(timestamp), label: periodLabel(timestamp, resolution), timestamp }));
  return {
    status: "ok",
    series: { id, name: info?.name ?? `series ${id}` },
    region,
    resolution,
    span: WINDOW_SPANS[resolution],
    windows,
    total: windows.length,
    oldest: periodLabel(starts[0] as number, resolution),
    newest: periodLabel(starts[starts.length - 1] as number, resolution),
    searched,
  };
}
