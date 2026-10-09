# Glossary

A reference for the domain concepts and project-specific terms used throughout
`smard-cli`. The SMARD domain is German; this glossary gives the English term
used in the CLI/library (where one exists) alongside the original German.

> **Translation table** (the labels the `filters` catalogue carries). The CLI's
> filter labels are German with an English gloss in parentheses:
>
> | German | English |
> | --- | --- |
> | Stromerzeugung | (electricity) generation |
> | Stromverbrauch | (electricity) consumption |
> | Residuallast | residual load |
> | Großhandelspreis | wholesale price |
> | Prognose | forecast |
> | Braunkohle / Steinkohle | lignite / hard coal |
> | Kernenergie | nuclear |
> | Wasserkraft / Pumpspeicher | hydropower / pumped storage |
> | Erdgas | natural gas |
> | Photovoltaik | photovoltaics |

---

## SMARD & the platform

**SMARD — Strommarktdaten** ("electricity market data"). The German power-market
data platform operated by the **Bundesnetzagentur** (the Federal Network Agency)
at [`smard.de`](https://www.smard.de). It publishes electricity generation,
consumption, residual load and wholesale market prices.

**Bundesnetzagentur (BNetzA).** The German Federal Network Agency, regulator of
the electricity, gas, telecommunications, post and railway markets, and operator
of SMARD.

**chart-data API.** The open, no-authentication HTTP interface this tool wraps.
It is not a query API but a **static file tree**: for each
*(filter, region, resolution)* combination SMARD publishes an *index* of
available window timestamps plus one *data file* per window. The base URL is
`https://www.smard.de`.

**Read-only, no auth.** The chart-data endpoints require no API key. This client
only performs `GET` requests and never writes. No credential header is ever
constructed. Redirects are **not followed** — a `3xx` surfaces as a
`SmardApiError` — and only `http:`/`https:` base URLs are accepted (enforced by the
`--base-url` parser, the request engine and the default transport). See
DEVELOPING.md "Design notes" for the network policy and the deliberate
redirect divergence from the workspace blueprint.

---

## The request triple

Almost every data call is addressed by three coordinates — a **filter**, a
**region** and a **resolution** — plus, for a specific window, a **timestamp**.

**filter.** A numeric series id identifying *what* time series you want
(e.g. `410` = total grid load, `4068` = photovoltaic generation,
`4169` = DE/LU wholesale price). The API accepts **any integer** filter id, so
the CLI and client accept any non-negative integer; the bundled `FILTERS` catalogue (see
`smard filters`) documents the well-known ones but is **not exhaustive**.

**region.** A market or grid area code. See `smard regions`; the valid set
(`RegionValues`) is `DE`, `AT`, `LU`, `DE-LU`, `DE-AT-LU`, `50Hertz`, `Amprion`,
`TenneT`, `TransnetBW`, `APG`, `Creos`.

**resolution.** The temporal granularity of a series: one of `hour`,
`quarterhour`, `day`, `week`, `month`, `year` (`ResolutionValues`). See
`smard resolutions`.

**timestamp.** An **epoch-millisecond** value marking the start of one data
window. Obtain valid values from `smard timestamps`; pass one to `series`. Each
data file covers a fixed window (e.g. one week of hourly values).

---

## Filter groups

The `FILTERS` catalogue tags each documented filter with one of four groups
(`FilterGroupValues`; `smard filters --group <group>`, or `filtersByGroup(group)` in
the library — an unknown group is an error there too, not an empty list):

**generation (Stromerzeugung).** Realised electricity generation by source, e.g.
Braunkohle/lignite (`1223`), Kernenergie/nuclear (`1224`), Wind Offshore
(`1225`), Wasserkraft/hydropower (`1226`), Biomasse (`4066`), Wind Onshore
(`4067`), Photovoltaik (`4068`), Steinkohle/hard coal (`4069`),
Pumpspeicher/pumped storage (`4070`), Erdgas/natural gas (`4071`).

**consumption (Stromverbrauch).** Total grid load (`410`), residual load
(`4359`) and pumped-storage consumption (`4387`).

**forecast (Prognose).** Forecasted generation, e.g. Wind Offshore (`3791`),
Wind Onshore (`123`), Photovoltaik (`125`), combined Wind & PV (`5097`) and
total (`122`).

**price (Großhandelspreis).** Day-ahead wholesale market prices for Germany/
Luxembourg (`4169`) and neighbouring bidding zones (e.g. Austria `4170`,
France `254`, Netherlands `256`, Switzerland `259`). Since 1 October 2025 the
day-ahead market sets a price per quarter-hour, and the `hour` series holds the
mean of the four quarter-hour prices (before that, the `quarterhour` series
repeats the hourly price). The next day's prices are published after the midday
auction, so from the afternoon on the newest window already contains tomorrow's
values.

---

## Regions in detail

**DE / AT / LU.** Germany, Austria and Luxembourg.

**DE-LU.** The German–Luxembourg **bidding zone**, the price area used for most
current wholesale-price series.

**DE-AT-LU.** The former combined Germany–Austria–Luxembourg bidding zone (split
in 2018), used for historical data.

**TSO control areas (Regelzonen).** `50Hertz`, `Amprion`, `TenneT` and
`TransnetBW` are the four German transmission-system-operator control areas.

**APG / Creos.** The Austrian (Austrian Power Grid) and Luxembourg (Creos) TSOs.

---

## Resolutions

**hour / quarterhour / day / week / month / year.** The supported aggregation
intervals for a series. `quarterhour` (15-minute) is also the granularity of the
richer `table_data` response.

**Time zone of the periods.** Timestamps are UTC epoch milliseconds, but SMARD's
periods follow the **Europe/Berlin** calendar: a `day`, `week` (Monday), `month` or
`year` point starts at Berlin midnight, i.e. 22:00Z (summer) or 23:00Z (winter) on the
previous UTC day, and its value is the sum over the Berlin day, week, month or year
(a 23- or 25-hour day at a DST switch). Label such a point with its Berlin date
(`TZ=Europe/Berlin` + jq's `strflocaltime("%Y-%m-%d")`), never with its UTC date
(`todate`), which names the previous day: the value for Sunday 04.10.2026 has the
timestamp `2026-10-03T22:00:00Z`.

---

## Data shapes

**index (`TimestampIndex`).** The response of an `index_{resolution}.json`
request: `{ timestamps: number[] }` — the epoch-millisecond start of each
available data window. Surfaced by `client.timestamps()` / `smard timestamps`.

**series (`SeriesResult`).** The response of a `chart_data` request:
`{ meta_data, series }` where `series` is an array of `SeriesPoint`s. Returned by
`client.series()` / `client.latest()`.

**SeriesPoint.** A single `[timestampMs, value]` tuple. The second element is
`null` for a **gap** (no data for that point).

**SeriesMetaData (`meta_data`).** `{ version, created }` — the data version and
its creation time accompanying a series/table response.

**table_data (`TableResult`).** A richer quarter-hour response
(`smard table`). Its `series` is an array of `TableSeriesEntry` objects, each
nesting the actual points under a `values` array of `TablePoint`s.

**TablePoint.** `{ timestamp, versions }` — one quarter-hour point carrying
multiple versioned values.

**TableVersion.** One versioned value of a table point: `{ value, name }`. Note
that `name` identifies the **data version** and is a *number* at runtime, not a
label string. Either field may be `null`.

---

## Units & semantics

**MWh — megawatt-hour.** The unit for generation and consumption series (energy
per window). Note: values are unitless numbers in the JSON; the unit is implied
by the chosen filter.

**EUR/MWh — euro per megawatt-hour.** The unit for the wholesale-price filters
(the `price` group).

**Residual load (Residuallast).** Total grid load minus generation from
fluctuating renewables (wind + solar) — the load that must be met by other
sources. Filter `4359`.

**Total grid load (Gesamtstromverbrauch).** Overall electricity consumption in a
region. Filter `410`.

**Window / data file.** The fixed time span covered by one `*_{timestamp}.json`
data file (e.g. one week of hourly values). To read the newest data you fetch
the index, take the last timestamp, then fetch that file — what `latest` does in
one call.

---

## Commands & methods

**timestamps.** `smard timestamps <filter> <region> <resolution>` /
`client.timestamps(...)` — list a series' available window timestamps.

**series.** `smard series <filter> <region> <resolution> <timestamp>` /
`client.series(...)` — fetch one window's data.

**latest.** `smard latest <filter> <region> <resolution>` /
`client.latest(...)` — convenience that reads the index, picks the newest
timestamp and fetches that window in one call.

**table.** `smard table <filter> <region> <timestamp>` /
`client.tableData(...)` — quarter-hour `table_data` for one window. There is no
discovery endpoint for `table_data`, and SMARD seems to have stopped publishing it:
checked 2026-09-26, windows from 2021 to October 2023 answer (keyed by the weekly
window starts `timestamps` lists), every window from December 2024 on returns a
`404`. A `404` from `table` for a recent window is therefore expected.

**filters / regions / resolutions.** Catalogue commands that print the
documented filter ids (optionally one `--group`), the valid region codes and the
valid resolution values — served locally from the bundled enums, no network call.

**Log record.** Every diagnostic line the CLI writes to stderr: a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic `smard.<area>`, as text (log4j style) or with
`--log-format jsonl` as one JSON object per line. The areas: `cli` (usage errors,
commander's messages, unexpected errors), `api` (the API's answers: an error status such
as the `404` for a window without data, and a malformed answer — not JSON, the wrong
shape, an unknown charset), `http` (the connection, the cleartext warning, and one WARN per retry before it waits) and `output`
(a failed write to stdout). A record is always one line; control characters in it are
escaped.

---

> **Library & internals.** Terms for the TypeScript client and its internals —
> `SmardClient`, the request engine, transport, retry/backoff, error types,
> `FILTERS`/`RegionValues`/`ResolutionValues`, and the validation boundary —
> now live in **[DEVELOPING.md](DEVELOPING.md)**.
