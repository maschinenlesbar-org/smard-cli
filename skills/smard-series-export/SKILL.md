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
version: 1.0.0
userInvocable: true
---

# SMARD Series Export

Turn a `(filter, region, resolution)` series into a **single, ordered, gap-clean dataset**
spanning as many windows as the user wants — ready for CSV, a spreadsheet, or pandas —
instead of separate per-window JSON blobs with confusing null tails.

## Tooling

This skill drives the `smard` command. **Before anything else, validate it is available** — run `command -v smard` (or `smard --version`). If it is not on your PATH, STOP and inform the user that the `smard` CLI (`@maschinenlesbar.org/smard-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

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

An empty `[]` means no data for that triple — verify filter/region/resolution are valid.

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

Convert each `[epochMillis, value]` into a row with an ISO timestamp:

```bash
smard --compact series 410 DE hour "$ts" \
| jq -r '.series[] | select(.[1] != null)
         | [(.[0] / 1000 | todate), .[1]] | @csv'
# 2026-06-08T11:00:00Z,58231.5
```

- Emit a header: `timestamp,<filter-label>` (use the catalogue `label`, plus the unit —
  `MWh` or `EUR/MWh`).
- Use ISO-8601 UTC (`todate`) for the timestamp column; mention these are UTC (SMARD's
  underlying clock is CET/CEST — note the offset if local time matters to the user).
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
- **Stale timestamps 404** (exit `4`); read a fresh list from `timestamps`, don't hard-code.
- **Don't use `table`** for bulk export — its `table_data` timestamps are a *different,
  undiscoverable* set (a `table` call 404s on `timestamps`/`series` timestamps), so it's
  unreliable for ranged export. Stick to `series`/`latest`.
