---
name: smard-series-export
description: >
  Export a SMARD electricity time series over a date range as clean CSV/JSON
  using the smard-cli. Trigger when the user asks "export the grid load for the
  last N weeks as CSV", "give me hourly PV generation as a spreadsheet", "download
  the price series for analysis", "pull a time series into a dataframe", or wants
  a continuous, gap-handled series across multiple windows. Resolves window
  timestamps, stitches the per-window files into one ordered series, drops the
  unpublished null tail, and emits ISO-dated rows — the multi-window stitching the
  CLI doesn't do.
compatibility: >
  Requires the `smard` CLI (npm package @maschinenlesbar.org/smard-cli) on PATH,
  installed by the user; the skill never installs it. Uses jq for JSON
  filtering. Network access to www.smard.de.
---

# SMARD Series Export

Turn a `(filter, region, resolution)` series into a **single, ordered, gap-clean dataset**
spanning as many windows as the user wants — ready for CSV, a spreadsheet, or pandas —
instead of separate per-window JSON blobs with confusing null tails.

## Tooling

This skill drives the `smard` command. **Before anything else, validate it is available** — run `command -v smard` (or `smard --version`). If it is not on your PATH, STOP and inform the user that the `smard` CLI (`@maschinenlesbar.org/smard-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

Data comes from the `smard` CLI — read-only, no API key. The chart-data API is a **static file tree**: each `(filter, region, resolution)` has an *index* of window timestamps and one *data file* per window.

Always pass `--compact`. Values are **MWh** for generation/consumption, **EUR/MWh** for
prices.

## Step 1 — Resolve the triple

- **filter**: numeric series id — browse with `smard --compact filters` (or `--group`).
  Any integer is accepted; the catalogue is just the documented ones.
- **region**: validate against `smard regions` (`DE`, `DE-LU`, `TenneT`, …). Price filters
  use region `DE-LU`.
- **resolution**: `smard resolutions` → `hour | quarterhour | day | week | month | year`.

## Step 2 — List the window timestamps

```bash
smard --compact timestamps 410 DE hour
```

> **Shape trap:** despite the API's underlying `index_*.json` being
> `{ "timestamps": [...] }`, the CLI **unwraps it** and returns a plain `number[]` of
> epoch-millisecond window starts. Treat it as a bare array — `jq '.[-1]'`, `jq 'length'`,
> not `.timestamps`.

Each timestamp is the **start of one data file**, and each file covers a fixed span (e.g.
one `hour`-resolution file = ~one week of hourly points; a `day` file = ~one year of daily
points). So you usually need only a **few** windows to cover a long range — don't fetch all
402 of them. Pick the last N timestamps for "the last N windows", or filter timestamps to
the date range the user asked for.

```bash
# the most recent 4 windows
smard --compact timestamps 410 DE hour | jq '.[-4:]'
```

A triple without data is a **404 (exit `4`)**, not an empty `[]` — then verify
filter/region/resolution with `smard filters` / `smard regions`.

## Step 3 — Fetch each window and stitch

For each chosen timestamp, fetch the window:

```bash
for ts in $(smard --compact timestamps 410 DE hour | jq '.[-4:][]'); do
  smard --compact series 410 DE hour "$ts" | jq -c '.series[]'
done
```

`series` returns `{ meta_data, series }`; `series` is `[epochMillis, value]` pairs.
Concatenate the windows' points and **sort by timestamp ascending**. Adjacent windows can
**overlap or abut** at the boundary — **de-duplicate on timestamp** (keep one point per
unique ts) so a boundary hour isn't listed twice.

> **The null-tail trap.** The newest window runs to the end of its period and its
> not-yet-published points come back as `[ts, null]` (a gap). For an export you have two
> honest choices — **drop null rows** (`select(.[1] != null)`) for a dense dataset, or
> **keep them as empty cells** so the time axis stays continuous. Pick one and tell the
> user; never silently treat `null` as `0`. Mid-series single nulls are genuine data gaps
> and should be preserved as empty, not zero.

## Step 4 — Format the rows

How to label a point depends on the resolution, because SMARD's periods follow the
**Europe/Berlin** calendar:

- **`hour` / `quarterhour`** — label each row with its ISO-8601 UTC instant (`todate`) and
  say the column is UTC:

  ```bash
  smard --compact series 410 DE hour "$ts" \
  | jq -r '.series[] | select(.[1] != null)
           | [(.[0] / 1000 | todate), .[1]] | @csv'
  # 2026-06-08T11:00:00Z,58231.5
  ```

  If the user wants Berlin wall-clock time, add it as a **second** column
  (`TZ=Europe/Berlin` + `strflocaltime("%Y-%m-%d %H:%M")`) and keep the UTC column as the
  key: the last Sunday in October repeats 02:00–02:59 Berlin time, so a wall-clock column
  alone has duplicate rows.
- **`day` / `week` / `month` / `year`** — each point starts at **Berlin midnight** (22:00Z
  or 23:00Z on the previous UTC day), so label it with its **Berlin date**, never with
  `todate`: `todate` names the previous day (Sunday 04.10.2026 becomes
  `2026-10-03T22:00:00Z`, September becomes `2026-08-31T22:00:00Z`, January
  `2025-12-31T23:00:00Z`). Set `TZ=Europe/Berlin` on jq, whatever the machine's zone:

  ```bash
  smard --compact latest 410 DE day \
  | TZ=Europe/Berlin jq -r '.series[] | select(.[1] != null)
           | [(.[0] / 1000 | strflocaltime("%Y-%m-%d")), .[1]] | @csv'
  # "2026-10-04",1084745.62
  ```

  Use `"%Y-%m"` for `month`, `"%Y"` for `year`, and for `week` the Monday's date
  (`"%Y-%m-%d"`, label the column "week starting").
- Emit a header: `timestamp,<filter-label>` (use the catalogue `label`, plus the unit —
  `MWh` or `EUR/MWh`); name the column `timestamp_utc` for sub-day rows and `date` (or
  `month`, `week_starting`) for period rows.
- For multiple filters side by side (e.g. load + price), build a **wide** table keyed on
  the shared timestamp via an outer join, leaving blanks where a series has no point.

## Step 5 — Output

Write to a file the user can open (default
`./smard-<filter>-<region>-<resolution>.csv`) and report:
- **the path you wrote**,
- row count and the actual covered date range (first → last timestamp),
- how many null/gap points were dropped or kept,
- the unit.

If a name the user supplied already exists, confirm before overwriting it (re-running with
the default name to refresh is fine).

Offer JSON (`{ timestamp, value }[]`) as an alternative, and offer a wider/longer range
(more windows) if the user wants more history.

## Traps to respect

- **`timestamps` is a bare `number[]`**, not `{timestamps:[…]}` (Step 2).
- **Null tail + mid-series gaps** — drop or keep deliberately, never coerce to 0 (Step 3).
- **Window overlap at boundaries** — de-duplicate on timestamp when stitching.
- **One file covers a long span** — fetch only the windows you need, not the whole index.
- **Period values carry Berlin dates** — a `day`/`week`/`month`/`year` point starts at
  Berlin midnight; label it with `TZ=Europe/Berlin` + `strflocaltime`, never `todate`,
  which names the previous day (Step 4).
- **A 404 (exit `4`) means "not a window start"** (or no data for the triple), not
  "too old": old windows stay available. Take timestamps from the `timestamps` list.
- **Don't use `table`** for export — SMARD seems to have stopped publishing `table_data`
  (windows up to October 2023 answer, every window from December 2024 on 404s), so it
  has nothing recent. Stick to `series`/`latest`.
