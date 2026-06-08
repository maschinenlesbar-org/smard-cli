# smard-cli — Usage

Task-oriented examples for the `smard` CLI, a client for the open
[SMARD](https://smard.de) chart-data API run by the Bundesnetzagentur — German
electricity-market **generation**, **consumption / residual load** and
**wholesale prices**. All output is JSON, so the examples pipe through
[`jq`](https://jqlang.github.io/jq/) where it helps.

## Install

```bash
npm i -g @maschinenlesbar.org/smard-cli
```

The installed binary is **`smard`**. To run from a checkout instead of a global
install, replace `smard` with `node dist/src/cli/index.js` (after `npm run build`).

## Concepts in one line

A series is addressed by a **(filter, region, resolution)** triple. `filter` is a
numeric series id (`smard filters`), `region` is a grid/bidding-zone code
(`smard regions`), `resolution` is one of `hour | quarterhour | day | week |
month | year` (`smard resolutions`). Generation/consumption values are in **MWh**,
wholesale prices in **EUR/MWh**.

---

## Use cases

### 1. Discover the available filters (series ids)

Why: you need the numeric `filter` id before you can request any data.

```bash
smard filters                       # full catalogue
smard filters --group consumption   # only one group
```

`--group` accepts `generation | consumption | price | forecast`. Output is an
array of `{ id, label, group }`. Grab just the ids for prices:

```bash
smard --compact filters --group price | jq '[.[].id]'
# [4169, 5078, 4996, ...]
```

### 2. List the valid regions and resolutions

Why: `region` and `resolution` are validated against fixed value sets; check them
before scripting.

```bash
smard regions       # ["DE","AT","LU","DE-LU","DE-AT-LU","50Hertz","Amprion","TenneT","TransnetBW","APG","Creos"]
smard resolutions   # ["hour","quarterhour","day","week","month","year"]
```

`DE-LU` is the German-Luxembourg bidding zone; `50Hertz`/`Amprion`/`TenneT`/
`TransnetBW` are the four German TSO control areas; `APG`/`Creos` are the
Austrian/Luxembourg TSOs.

### 3. Get the newest data in one call

Why: `latest` reads the timestamp index and fetches the most recent window for
you, so you don't have to discover the timestamp first.

```bash
# Newest hourly day-ahead wholesale price for the DE-LU bidding zone (EUR/MWh)
smard latest 4169 DE-LU hour
```

Output is `{ meta_data, series }`, where `series` is an array of
`[epochMillis, value]` pairs. Show just the most recent price:

```bash
smard --compact latest 4169 DE-LU hour | jq '.series[-1]'
# [1780916400000, 55.22]
```

### 4. Latest renewable generation (photovoltaics / wind)

Why: track the most recent realised feed-in by technology, in MWh.

```bash
smard latest 4068 DE hour    # Photovoltaik (PV)
smard latest 4067 DE hour    # Wind Onshore
smard latest 1225 DE hour    # Wind Offshore
```

Sum the latest PV window into a single total:

```bash
smard --compact latest 4068 DE hour | jq '[.series[][1] | select(. != null)] | add'
```

### 5. Total grid load vs. residual load

Why: compare total consumption (filter `410`) against residual load (filter
`4359`, the load left after subtracting renewables) for the same window.

```bash
smard latest 410  DE week    # Stromverbrauch: Gesamt (total grid load)
smard latest 4359 DE week    # Stromverbrauch: Residuallast (residual load)
```

### 6. Fetch one explicit window (timestamps → series)

Why: pull a specific historical window rather than the newest one. Available
windows roll over time, so read a current timestamp from `timestamps` instead of
hard-coding one (stale timestamps return a 404).

```bash
smard timestamps 4169 DE-LU hour          # -> [ ..., <valid epoch-ms timestamps> ]

# Pick the last available window and fetch it
TS=$(smard --compact timestamps 4169 DE-LU hour | jq '.[-1]')
smard series 4169 DE-LU hour "$TS"
```

`timestamps` returns a plain `number[]` of epoch-millisecond window starts;
`series` returns the same `{ meta_data, series }` shape as `latest`.

### 7. Day-ahead price series for a neighbouring market

Why: each neighbouring bidding zone has its own price filter id; the region for
these price series is `DE-LU`.

```bash
smard latest 254 DE-LU hour    # Großhandelspreis: Frankreich
smard latest 256 DE-LU hour    # Großhandelspreis: Niederlande
smard latest 259 DE-LU hour    # Großhandelspreis: Schweiz
```

Find any price filter id by label without leaving the shell:

```bash
smard --compact filters --group price | jq '.[] | select(.label | test("Frankreich"))'
```

### 8. Generation forecast for the next windows

Why: the `forecast` group holds the published prognoses (wind, PV, total).

```bash
smard latest 125 DE hour     # Prognose: Photovoltaik
smard latest 122 DE hour     # Prognose: Gesamt (total)
```

### 9. Quarter-hour table data

Why: the `table` command reads the separate `table_data` endpoint for a single
window (3 positional args: `filter region timestamp`, no resolution).

```bash
smard table 410 DE <timestamp>
```

Note: `table_data` windows are a **different** timestamp set than the one
`timestamps` returns, and the public API has no discovery endpoint for them, so a
`table` call may `404` for a timestamp that is valid for `series`/`latest`.

### 10. Pretty vs. compact, and saving for later

Why: pipe machine-readable output into files or other tools.

```bash
smard --compact latest 410 DE day > load.json     # single-line JSON
smard --compact latest 4068 DE hour | jq '.series | length'   # count data points
```

---

## Global options

These apply to every command and may be placed before or after it (before is
recommended):

| Option | Description |
| --- | --- |
| `-V, --version` | print the version |
| `--base-url <url>` | API base URL (default `https://www.smard.de`) |
| `--timeout <ms>` | per-request timeout in ms (`0` = no timeout; default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | print JSON on a single line instead of pretty-printed |
| `-h, --help` | help for the program or a command (`smard <command> --help`) |

Exit codes: `0` success, `4` on a `404` from the API, `1` for any other error
(network, timeout, parse, non-404 status), non-zero for usage errors.
