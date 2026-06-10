---
name: smard-price-watch
description: >
  Summarise German day-ahead wholesale electricity prices and compare bidding
  zones using the smard-cli. Trigger when the user asks "what's the electricity
  price right now?", "when is power cheapest today?", "spot price for DE-LU",
  "is electricity cheaper in France than Germany?", "peak vs off-peak price", or
  wants EUR/MWh price stats. Pulls the EPEX day-ahead series, finds the latest
  settled price, min/max/average and the cheapest/most-expensive hours, and ranks
  neighbouring zones — the time-series stats the CLI doesn't compute.
version: 1.0.0
userInvocable: true
---

# SMARD Price Watch

Turn the raw day-ahead price series into the answers people actually want: **the current
price, when power is cheapest/most expensive, the average for the window, and how Germany
compares to neighbouring bidding zones** — instead of a wall of `[ts, value]` tuples.

## Tooling

This skill drives the `smard` command. **Before anything else, validate it is available** — run `command -v smard` (or `smard --version`). If it is not on your PATH, STOP and inform the user that the `smard` CLI (`@maschinenlesbar.org/smard-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Data comes from the `smard` CLI — read-only, no API key, **one (filter, region, resolution) series per call**.

Always pass `--compact`. Prices are **EUR/MWh** (divide by 1000 for EUR/kWh; divide by 10
for ct/kWh). Bump `--timeout 60000` on slow calls.

## Step 1 — Pick the price filter(s) and region

Price series live in the `price` group:

```bash
smard --compact filters --group price
```

| id | bidding zone |
|---|---|
| 4169 | **Deutschland/Luxemburg (DE-LU)** — the default German spot price |
| 4170 | Österreich (Austria) |
| 254  | Frankreich (France) |
| 256  | Niederlande (Netherlands) |
| 259  | Schweiz (Switzerland) |
| 252 / 253 | Dänemark 1 / 2 |
| 257 | Polen · 261 Tschechien · 4996 Belgien · 255 Italien Nord · … |

**Critical:** all of these price series use **region `DE-LU`** as the region argument (the
filter id selects the country/zone, not the region code). Querying `254 DE hour` will not
give France — use `254 DE-LU hour`. Resolution is normally `hour` (the day-ahead market is
hourly); `quarterhour` exists for some series.

```bash
smard --compact latest 4169 DE-LU hour      # German spot, newest window
smard --compact latest 254  DE-LU hour      # France spot, newest window
```

## Step 2 — Fetch and clean the series

`latest` returns `{ meta_data, series }`; `series` is `[epochMillis, EUR/MWh]` pairs.

> **The critical trap — the window's tail is `null`.** The newest hourly window spans
> ~168 points and runs to the end of the period, so the most recent points are
> `[ts, null]` (not yet published / future hours). **Never read `.series[-1]`** — it is
> usually `null`. Take the last non-null point for "the current price":
>
> ```bash
> smard --compact latest 4169 DE-LU hour | jq -c '[.series[] | select(.[1] != null)][-1]'
> # e.g. [1781211600000, 116.06]
> ```

For stats, work on the **non-null subset** of the most recent calendar day (or the window
the user asked for). To restrict to a day, filter points whose timestamp falls in that
date's range; otherwise just use all non-null points in the window.

## Step 3 — Compute the stats

Over the non-null points of the chosen window:

```bash
smard --compact latest 4169 DE-LU hour \
| jq '[.series[] | select(.[1] != null)] as $s
      | { current: $s[-1],
          min:  ($s | min_by(.[1])),
          max:  ($s | max_by(.[1])),
          avg:  (([$s[][1]] | add) / ($s | length)) }'
```

- **current** = last non-null `[ts, price]`.
- **min / max** = cheapest / most expensive hour — report the **hour-of-day** (from the
  timestamp) alongside the price; that's the actionable part ("cheapest at 03:00").
- **avg** = arithmetic mean over the window.
- Prices can go **negative** (oversupply) — that's real, not a bug; surface it ("paid to
  consume").

## Step 4 — Compare zones (when asked)

For "is power cheaper in France/Austria/…": fetch each zone's filter (all with region
`DE-LU`), take each one's last non-null price **at the same timestamp** where possible,
and rank cheapest-first. If their latest settled timestamps differ, align on the latest
common one or note the offset — don't compare prices from different hours.

## Step 5 — Present

```
German day-ahead power price (DE-LU, hourly)
  Now (2026-06-08 12:00): 116.06 €/MWh  (11.6 ct/kWh)
  Today:  avg 78.4 €/MWh  ·  low 41.2 @ 03:00  ·  high 142.7 @ 19:00

Cheapest hours today: 02:00–05:00 (≈ 4 ct/kWh) — good window to shift load.

Zone comparison (latest settled hour):
  France      89.1 €/MWh
  DE-LU      116.1 €/MWh
  Austria    109.6 €/MWh
```

Rules:
- Show EUR/MWh and a ct/kWh gloss — most people think in ct/kWh.
- Always give the **timestamp/hour** for current/min/max, in local terms (CET/CEST).
- Lead with what the user asked (current price, cheapest hour, or the cross-zone ranking);
  don't dump all 168 points.
- Note negative or unusually high prices explicitly.

## Traps to respect

- **Tail nulls** (Step 2) — biggest mistake; always last non-null.
- **Region is `DE-LU` for every price filter**, even foreign zones — the filter id picks
  the country, not the region argument.
- Day-ahead prices are set the **day before** for the next 24h, so the freshest non-null
  points may already be "tomorrow's" hours — fine, just label the date from the timestamp.
- Negative prices are valid; don't clamp or treat as errors.
- A 404 (exit code `4`) on `series` means a stale/invalid timestamp — re-run `timestamps`;
  prefer `latest` to avoid hard-coding one.
