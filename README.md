# smard-cli

[![CI](https://github.com/maschinenlesbar-org/smard-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/maschinenlesbar-org/smard-cli/actions/workflows/ci.yml)
[![Release](https://github.com/maschinenlesbar-org/smard-cli/actions/workflows/release.yml/badge.svg)](https://github.com/maschinenlesbar-org/smard-cli/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/@maschinenlesbar.org/smard-cli)](https://www.npmjs.com/package/@maschinenlesbar.org/smard-cli)

**Website:** [English](https://maschinenlesbar-org.github.io/smard-cli/) · [Deutsch](https://maschinenlesbar-org.github.io/smard-cli/de/) — command reference, guides and API docs

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
> See **[DEVELOPING.md](https://github.com/maschinenlesbar-org/smard-cli/blob/main/DEVELOPING.md)**.

## Install

```bash
npm i -g @maschinenlesbar.org/smard-cli
```

This installs the **`smard`** command. Requires **Node.js 22.12+**.

Check it works:

```bash
smard --help
```

## Quickstart

No setup needed — the API requires no key. Your first query:

```bash
smard latest 410 DE week
```

That fetches the newest `week` file of total grid load for Germany: one value per
week for the current year (52 weekly totals, the weeks still to come as `null`). An
`hour` or `quarterhour` file covers one week; a `day`, `week` or `month` file covers
a year. The result is a JSON object: time-series values live under `series`,
metadata under `meta_data`. Pull out just the series with `jq`:

```bash
smard latest 410 DE week | jq '.series'
```

Show just the most recent data point (the window runs to the end of its period, so
`.series[-1]` is usually `[ts, null]` — skip the `null`s):

```bash
smard --compact latest 410 DE week | jq -c '[.series[] | select(.[1] != null)][-1]'
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

> **Note on `table`:** `table` reads the separate `table_data` endpoint, which
> has no index of its own. SMARD seems to have **stopped publishing it**: in a
> check on 2026-09-26, windows from 2021 to October 2023 answered (with the same
> weekly window starts that `timestamps` lists), but every window from December
> 2024 on — including the newest — returned `404`, for `DE` and `DE-LU` alike. The
> cut-off lies between October 2023 and December 2024. So a `404` from `table` for
> a recent window is the normal case, not a wrong timestamp; for current data use
> `series`/`latest`.

## Common tasks

A few recipes to get going — see **[Usage.md](https://github.com/maschinenlesbar-org/smard-cli/blob/main/Usage.md)** for the full,
use-case-driven set.

```bash
# What filter ids exist? Show just the consumption group
smard filters --group consumption

# Total grid load for Germany, one value per week of the current year
smard latest 410 DE week

# Newest hourly wholesale price for the DE-LU bidding zone (EUR/MWh)
smard latest 4169 DE-LU hour

# Newest photovoltaic generation, compact output
smard --compact latest 4068 DE hour

# Latest wind onshore and wind offshore generation
smard latest 4067 DE hour    # Wind Onshore
smard latest 1225 DE hour    # Wind Offshore

# Pick a specific window explicitly (any timestamp from the list; old windows stay available)
TS=$(smard --compact timestamps 4169 DE-LU hour | jq '.[-1]')
smard series 4169 DE-LU hour "$TS"
```

## Output & scripting

Every command prints **pretty JSON to stdout**. Errors go to stderr, so piping
stdout into `jq` stays clean.

Each line on stderr is a **log record**: a timestamp (UTC), a level (`ERROR`, `WARN`,
`INFO`) and a topic, the program and the area it comes from (`smard.cli` for usage
errors, `smard.api` for the API's answers, `smard.http` for the connection). By default
it is written log4j style; `--log-format jsonl` writes one JSON object per line instead.
A record is always one line: a line break, a control character or a bidi control in a
message (a server's text, a value you typed) is written as an escape (`\n`, `\u001b`,
`\u202e`), so it can neither split a record nor forge another one, nor steer the
terminal; a message longer than 4000 characters is cut and ends in
`… (N more characters)`:

```text
2026-10-09T14:03:12.481Z WARN  [smard.http] requests to mirror.test are sent unencrypted (http:, not https:)
2026-10-09T14:03:12.902Z ERROR [smard.api] HTTP 404 for GET https://www.smard.de/app/chart_data/4169/DE/4169_DE_hour_1700000000000.json
```

```bash
smard --log-format jsonl series 4169 DE hour 1700000000000 2>log.jsonl   # {"ts":"…","level":"ERROR","topic":"smard.api","msg":"HTTP 404 …"}
```

```bash
# Count data points in a series window
smard --compact latest 4068 DE hour | jq '.series | length'

# Sum all non-null values in a window (total MWh of the window — the published part
# of one week for an `hour` file, not a day)
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
| `4` | resource not found (`404`) — a timestamp that is not a window start, or a filter/region/resolution combination without data |
| `1` | any other error: network failure, timeout, parse error, non-404 API status |
| non-zero | usage / invalid argument (bad region, non-integer filter, etc.) |

A reader that stops early (`| head`, `| jq` exiting on its first match) ends the
run with exit `0` and no stack trace; a failed run keeps its exit code even when
its stderr reader has gone away (`2>&1 | true`).

## Troubleshooting

- **`command not found: smard`** — the global npm bin directory isn't on your
  `PATH`. Run `echo "$(npm prefix -g)/bin"` to find it and add it, or run via
  `npx @maschinenlesbar.org/smard-cli …`.
- **Exit `4` / "not found"** — the timestamp is not a window start, or the
  filter/region/resolution combination has no data (SMARD answers both with a
  `404`; it never returns an empty list). Take a timestamp from `smard timestamps
  <filter> <region> <resolution>` — old windows stay available, so a timestamp
  from that list keeps working — and check the combination with `smard regions`
  and `smard filters`. For `table`, see the `table_data` note above.
- **Exit `1` / network error** — connectivity, DNS, or a timeout. Try again,
  or raise the limit with `--timeout 60000`.
- **Exit `1` with "Unexpected response shape" or "Malformed data file"** — the
  index was not `{"timestamps": [...]}`, or a data file was not `{"meta_data": {…},
  "series": [[timestamp, number or null], …]}` (an error page from a proxy, or a
  changed format), so the CLI refuses to print it as data or read it as "no data".
  `latest` also exits `1` if an index lists no windows at all.

## Global options

These apply to every command and may be given before *or* after it, each at most once
(a repeated option, like `filters --group` twice, is a usage error rather than "last one wins"):

| Option | Description |
| --- | --- |
| `-V, --version` | Print the version number |
| `-h, --help` | Show help for the program or a command |
| `--compact` | Print JSON on a single line instead of pretty-printed |
| `--log-format <format>` | How errors, warnings and notes are written to stderr: `text` (default; log4j style, `2026-10-09T14:03:12.481Z WARN  [smard.http] …`) or `jsonl` (one JSON object per line: `ts`, `level`, `topic`, `msg`). stdout is not affected |
| `--base-url <url>` | API base URL (default `https://www.smard.de`; an `http:`/`https:` URL, optionally with a path prefix; a query `?`, fragment `#`, surrounding whitespace or a `%` in the userinfo that isn't an escape — write a literal `%` as `%25` — is a usage error). Userinfo (`https://user:pw@mirror`) is sent as Basic auth and shown as `***` in everything the CLI prints, a rejected `--base-url` included. A plain `http:` base URL to a remote host logs one `WARN` record of `smard.http` on stderr (`… sent unencrypted to <host> (http:, not https:)`) before the first request (naming the base URL's credentials when it carries any, never printing them); loopback hosts (`localhost`, `127.x`, `::1`) and the offline catalogue commands don't warn, and stdout and the exit code are unchanged |
| `--timeout <ms>` | Time limit per request in ms, reading the whole response included (`0` = no timeout; default `30000`; at most `2147483647`) |
| `--user-agent <ua>` | `User-Agent` header value (non-blank; no control characters or characters above U+00FF — a usage error before any request) |
| `--max-retries <n>` | Retries for transient `429`/`503` responses and reset connections (`0`–`10`, default `2`). Each retry backs off linearly (200 ms × attempt) or waits the server's `Retry-After` when that is longer (up to 30 s; a longer one is not retried, and the error names the wait) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |

## Learn more

- **[SKILLS.md](https://github.com/maschinenlesbar-org/smard-cli/blob/main/SKILLS.md)** — Claude Code Agent Skills that drive this CLI for energy-mix, price-watch and time-series-export tasks.
- **[Usage.md](https://github.com/maschinenlesbar-org/smard-cli/blob/main/Usage.md)** — full use-case-driven cookbook.
- **[GLOSSARY.md](https://github.com/maschinenlesbar-org/smard-cli/blob/main/GLOSSARY.md)** — every domain term, filter group, region code, and data shape explained.
- **[DEVELOPING.md](https://github.com/maschinenlesbar-org/smard-cli/blob/main/DEVELOPING.md)** — TypeScript library usage, architecture, testing, CI.

## Data license

This CLI is a **client** — it accesses data it does not own or redistribute. The
upstream data is © its provider and licensed **separately from this tool's code**.
See **[DATA_LICENSE.md](DATA_LICENSE.md)**.

> **Bundesnetzagentur** — CC BY 4.0. Attribution required, exact source string
> `Bundesnetzagentur | SMARD.de`; commercial use and modification allowed.

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
