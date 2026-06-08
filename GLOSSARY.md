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
only performs `GET` requests and never writes.

---

## The request triple

Almost every data call is addressed by three coordinates — a **filter**, a
**region** and a **resolution** — plus, for a specific window, a **timestamp**.

**filter.** A numeric series id identifying *what* time series you want
(e.g. `410` = total grid load, `4068` = photovoltaic generation,
`4169` = DE/LU wholesale price). The API accepts **any integer** filter id, so
the CLI and client accept any integer; the bundled `FILTERS` catalogue (see
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
(`smard filters --group <group>`):

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
France `254`, Netherlands `256`, Switzerland `259`).

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
`client.tableData(...)` — quarter-hour `table_data` for one window. Its valid
timestamps are a **different set** from those returned by `timestamps` (which
lists `chart_data` windows); there is no discovery endpoint for `table_data`
timestamps, so a `table` call may `404` for a timestamp valid for `series`.

**filters / regions / resolutions.** Catalogue commands that print the
documented filter ids (optionally one `--group`), the valid region codes and the
valid resolution values — served locally from the bundled enums, no network call.

---

## Identifiers & validation

**FILTERS.** The exported catalogue of documented filters: `{ id, label, group }`
records. Used for the `filters` listing only — not a closed set.

**RegionValues / ResolutionValues.** Const arrays that double as runtime CLI
choice validators and as the `Region` / `Resolution` TypeScript union types.

**Validation boundary.** All input validation (non-negative integers, enum
membership) lives in the **CLI** layer. `SmardClient` performs **no** validation:
a `Region`/`Resolution` is a compile-time hint only and is merely
`encodeURIComponent`-escaped, not checked against the value arrays. Validate
untrusted input yourself before calling the library directly.

**Typed pass-through.** Response types (`SeriesResult`, `TableResult`) are a
convenience typing over the documented shape, not a runtime guarantee: any 2xx
JSON body is parsed and cast to the return type without structural validation.
The one exception is `timestamps()`, which checks that `timestamps` is an array
(else throws `SmardParseError`).

---

## Project / technical terms

**API client.** [`SmardClient`](src/client/client.ts) — the typed wrapper over
the chart-data endpoints. Usable as a library independently of the CLI.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](src/client/http.ts)). The default uses Node's built-in
`http`/`https`; tests inject a mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](src/client/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, decodes JSON/raw responses and maps
errors. Sits between the client and the transport.

**RawResponse.** The engine's raw result: `{ data: Buffer, contentType, status }`
— raw bytes, never lossily decoded.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object (`out`/`err`/…).
Lets the whole CLI run in tests with a mocked client and captured output — no
subprocess.

**Retry / backoff.** The engine automatically retries transient `429`
(rate-limited) and `503` responses with **linear** backoff, up to `--max-retries`
(default `2`). `SmardApiError.isRetryable` flags these statuses.

**maxResponseBytes.** A hard cap (default 100 MiB; `0` = unlimited) on response
body size, defending against memory exhaustion; a breach aborts the request with
`SmardResponseTooLargeError`.

**Error types.** [`errors.ts`](src/client/errors.ts): `SmardApiError` (non-2xx,
carries `status`/`detail`/`url`/`body`), `SmardNetworkError` (transport
failure/timeout), `SmardResponseTooLargeError` (size-cap breach, a subclass of
`SmardNetworkError`) and `SmardParseError` (bad JSON), all extending
`SmardError`. The CLI maps a `404` to exit code `4`, every other error to `1`.
