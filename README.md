# smard-cli

[![CI](https://github.com/maschinenlesbar-org/smard-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/smard-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/smard-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/smard-cli/actions/workflows/release.yml)
[![GitHub release](https://img.shields.io/github/v/release/maschinenlesbar-org/smard-cli)](https://github.com/maschinenlesbar-org/smard-cli/releases/latest)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/smard-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/smard-cli)

Query Germany's open **electricity-market data** from your terminal. `smard` is
a command-line tool over the [SMARD chart-data API](https://smard.api.bund.dev/)
(`smard.de`), operated by the Bundesnetzagentur — fetch generation, consumption,
residual load and wholesale prices as clean JSON you can pipe straight into
[`jq`](https://jqlang.github.io/jq/).

- **Works out of the box** — no account, no API key, no configuration. Install and query.
- **Clean JSON output** — pretty-printed by default, `--compact` for one-line/scripting.
- **Seven commands** — discover filters/regions, fetch the newest window in one call, or navigate timestamps manually.
- **No credentials to manage** — the SMARD API is fully open; this tool only reads.

> Want to use this as a TypeScript library or understand how it's built?
> See **[DEVELOPING.md](DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/smard-cli
```

This installs the **`smard`** command. Requires **Node.js 20+**.

Check it works:

```bash
smard --help
```

## Quickstart

No setup needed — the API requires no key. Your first query:

```bash
smard latest 410 DE week
```

That fetches the newest week of total grid load for Germany. The result is a
JSON object: time-series values live under `series`, metadata under `meta_data`.
Pull out just the series with `jq`:

```bash
smard latest 410 DE week | jq '.series'
```

Show just the most recent data point:

```bash
smard --compact latest 410 DE week | jq '.series[-1]'
```

## Commands

```text
timestamps  <filter> <region> <resolution>              available window timestamps
series      <filter> <region> <resolution> <timestamp>  one window's data
latest      <filter> <region> <resolution>              newest window's data (one call)
table       <filter> <region> <timestamp>               quarter-hour table_data
filters     [--group generation|consumption|price|forecast]   filter catalogue
regions                                                  valid region codes
resolutions                                              valid resolution values
```

### Positional arguments

| Argument | What it means |
| --- | --- |
| `<filter>` | Numeric series id — e.g. `410` (total grid load), `4068` (photovoltaics), `4169` (DE-LU wholesale price). Use `smard filters` to browse all documented ids. |
| `<region>` | Grid or bidding-zone code — e.g. `DE`, `DE-LU`, `TenneT`. Use `smard regions` for the full list. |
| `<resolution>` | Temporal granularity: `hour`, `quarterhour`, `day`, `week`, `month`, or `year`. Use `smard resolutions` to confirm. |
| `<timestamp>` | Epoch-millisecond window start from `smard timestamps`. |

### `filters` option

| Flag | Meaning |
| --- | --- |
| `--group <group>` | Only show one group: `generation`, `consumption`, `price`, or `forecast` |

> **Note on `table` timestamps:** `table` reads the separate `table_data`
> endpoint. Its valid window timestamps are **not** the same set returned by
> `timestamps` (which lists `chart_data` windows). A `table` call may `404` for
> a timestamp that is valid for `series`/`latest`.

## Common tasks

A few recipes to get going — see **[Usage.md](Usage.md)** for the full,
use-case-driven set.

```bash
# What filter ids exist? Show just the consumption group
smard filters --group consumption

# Newest week of total grid load for Germany
smard latest 410 DE week

# Newest hourly wholesale price for the DE-LU bidding zone (EUR/MWh)
smard latest 4169 DE-LU hour

# Newest photovoltaic generation, compact output
smard --compact latest 4068 DE hour

# Latest wind onshore and wind offshore generation
smard latest 4067 DE hour    # Wind Onshore
smard latest 1225 DE hour    # Wind Offshore

# Pick a specific window explicitly (available timestamps roll over — don't hard-code one)
TS=$(smard --compact timestamps 4169 DE-LU hour | jq '.[-1]')
smard series 4169 DE-LU hour "$TS"
```

## Output & scripting

Every command prints **pretty JSON to stdout**. Errors go to stderr, so piping
stdout into `jq` stays clean.

```bash
# Count data points in a series window
smard --compact latest 4068 DE hour | jq '.series | length'

# Sum all non-null values in a window (total MWh)
smard --compact latest 4068 DE hour | jq '[.series[][1] | select(. != null)] | add'

# Save a window to a file
smard --compact latest 410 DE day > load.json
```

Use `--compact` for single-line JSON in pipelines and logs:

```bash
smard --compact latest 410 DE week | jq -c '.series[-3:]'
```

`--compact` (and every global option) works **before or after** the command —
both `smard --compact latest …` and `smard latest … --compact` do the same thing.

**Exit codes** make the CLI easy to use in scripts:

| Code | Meaning |
| --- | --- |
| `0` | success (also `--help` / `--version`) |
| `4` | resource not found (`404`) — e.g. a stale timestamp or unknown filter/region combination |
| `1` | any other error: network failure, timeout, parse error, non-404 API status |
| non-zero | usage / invalid argument (bad region, non-integer filter, etc.) |

## Troubleshooting

- **`command not found: smard`** — the global npm bin directory isn't on your
  `PATH`. Run `npm bin -g` to find it and add it, or run via
  `npx @maschinenlesbar.org/smard-cli …`.
- **Exit `4` / "not found"** — the timestamp or filter/region/resolution
  combination doesn't exist. Re-run `smard timestamps <filter> <region>
  <resolution>` to get a fresh list; available windows roll over time. For
  `table`, note that `table_data` timestamps differ from `chart_data` ones.
- **Exit `1` / network error** — connectivity, DNS, or a timeout. Try again,
  or raise the limit with `--timeout 60000`.
- **`smard timestamps` returns an empty array** — the API has no data for that
  filter/region/resolution combination. Verify with `smard regions` and
  `smard filters` that your values are valid.

## Global options

These apply to every command and may be given before *or* after it:

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--base-url <url>` | API base URL (default `https://www.smard.de`) |
| `--timeout <ms>` | Per-request timeout in ms (`0` = no timeout; default `30000`) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

## Learn more

- **[Usage.md](Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](GLOSSARY.md)** — every domain term, filter group, region code, and data shape explained.
- **[DEVELOPING.md](DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.

## License

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.
