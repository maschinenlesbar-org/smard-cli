---
name: smard-price-watch
description: >
  Summarise German day-ahead wholesale electricity prices and compare bidding
  zones using the smard-cli. Trigger when the user asks "what's the electricity
  price right now?", "when is power cheapest today?", "spot price for DE-LU",
  "is electricity cheaper in France than Germany?", "peak vs off-peak price", or
  wants EUR/MWh price stats. Pulls the EPEX day-ahead series, finds the price for
  the current hour or quarter-hour, the day's min/max/average and the cheapest /
  most-expensive slots, and ranks neighbouring zones — the time-series stats the
  CLI doesn't compute.
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
give France — use `254 DE-LU hour`.

**Resolution: the day-ahead market is quarter-hourly** (since 1 Oct 2025; before that the
`quarterhour` series just repeats each hourly price). The price series have 96 prices per
day at `quarterhour` (checked 15 Sep 2026 for DE-LU, France and Austria), and each `hour`
value is the **mean of its four quarter-hours** — e.g. DE-LU 16.09.2026 13:00 =
97.51 = mean(104.70, 98.37, 96.56, 90.40). Use `hour` for an overview or an hourly average;
use `quarterhour` for "when is it cheapest?" and load shifting, because the hourly mean
hides the cheapest slot (there: 90.40 €/MWh at 13:45, not 97.51 at 13:00). Say which one
you used.

```bash
smard --compact latest 4169 DE-LU hour          # German spot, hourly means
smard --compact latest 4169 DE-LU quarterhour   # German spot, the actual 15-min prices
smard --compact latest 254  DE-LU hour          # France spot, hourly means
```

## Step 2 — Fetch and clean the series

`latest` returns `{ meta_data, series }`; `series` is `[epochMillis, EUR/MWh]` pairs.
Each timestamp is the **start** of its hour / quarter-hour.

> **Two traps at the end of the window.**
>
> 1. **The tail is `null`.** The newest window is one week (Monday 00:00 German time
>    onwards, 168 hourly / 672 quarter-hour points) and runs to the end of that week, so
>    the last points are `[ts, null]`. **Never read `.series[-1]`.**
> 2. **The last non-null point is not "now".** The next day's prices are published after
>    the midday day-ahead auction, so from the afternoon on the last non-null point is
>    usually **tomorrow 23:00** (23:45 at `quarterhour`). The current price is the point whose
>    timestamp is the latest one **at or before the current time**:
>
> ```bash
> smard --compact latest 4169 DE-LU hour \
>   | jq -c '[.series[] | select(.[1] != null and .[0] <= now * 1000)][-1]'
> # e.g. [1789502400000, 199.46]   (15.09.2026 22:00–23:00 CEST)
> ```
>
> If that is `null` — e.g. on a Sunday afternoon, if the newest window holds only
> Monday's prices — take the second-to-last timestamp from
> `smard --compact timestamps 4169 DE-LU hour` and read that window with `series`.

For stats, work on the **non-null subset** of one calendar day in German time (today, or
tomorrow once published) or the window the user asked for — not the whole window, which
mixes up to seven days.

## Step 3 — Compute the stats

Current price and today's stats, with times printed in German local time (`TZ` makes
`strflocaltime` and the "today" date use Europe/Berlin whatever the machine's zone):

```bash
smard --compact latest 4169 DE-LU quarterhour \
| TZ=Europe/Berlin jq '
    def at: if . == null then null
            else [(.[0] / 1000 | strflocaltime("%Y-%m-%d %H:%M")), .[1]] end;
    (now * 1000) as $now
    | ($now / 1000 | strflocaltime("%Y-%m-%d")) as $today
    | [.series[] | select(.[1] != null)] as $s
    | [$s[] | select((.[0] / 1000 | strflocaltime("%Y-%m-%d")) == $today)] as $d
    | { current: ([$s[] | select(.[0] <= $now)] | last | at),
        today_min: ($d | min_by(.[1]) | at),
        today_max: ($d | max_by(.[1]) | at),
        today_avg: (if ($d | length) > 0 then ([$d[][1]] | add) / ($d | length) else null end),
        published_until: ($s | last | at) }'
```

- **current** = the point for the current quarter-hour (or hour, with `hour`) — the
  latest point at or before now, never simply the last non-null one.
- **today_min / today_max** = cheapest / most expensive slot today — report the
  **time of day** alongside the price; that's the actionable part ("cheapest at 13:45").
  With `hour` this is the cheapest *hourly average*, which can hide a cheaper quarter-hour.
- **today_avg** = arithmetic mean over today's points (the same at either resolution, up
  to rounding).
- **published_until** = the last published slot; if it's tomorrow, tomorrow's prices are
  out — to summarise them, set the day with `($now / 1000 + 86400 | strflocaltime("%Y-%m-%d"))
  as $today` (the `today_*` fields then describe tomorrow).
- Prices can go **negative** (oversupply) — that's real, not a bug; surface it ("paid to
  consume").

## Step 4 — Compare zones (when asked)

For "is power cheaper in France/Austria/…": fetch each zone's filter (all with region
`DE-LU`) at the same resolution, take each one's price **for the same timestamp** — the
current hour, via the `.[0] <= now * 1000` selection above — and rank cheapest-first. If
one zone has no price for that timestamp, align on the latest common one or note the
offset — don't compare prices from different hours.

## Step 5 — Present

```
German day-ahead power price (DE-LU, quarter-hourly)
  Now (2026-06-08 12:00–12:15): 116.06 €/MWh  (11.6 ct/kWh)
  Today:  avg 78.4 €/MWh  ·  low 38.9 @ 03:15  ·  high 151.3 @ 19:00
  Tomorrow's prices are published (until 2026-06-09 23:45).

Cheapest stretch today: 02:00–05:00 (≈ 4 ct/kWh) — good window to shift load.

Zone comparison (current hour, 12:00–13:00):
  France      89.1 €/MWh
  DE-LU      116.1 €/MWh
  Austria    109.6 €/MWh
```

Rules:
- Show EUR/MWh and a ct/kWh gloss — most people think in ct/kWh.
- Always give the **timestamp/hour** for current/min/max, in local terms (CET/CEST), and
  say whether the figures are quarter-hour prices or hourly averages.
- Lead with what the user asked (current price, cheapest slot, or the cross-zone ranking);
  don't dump the whole series.
- Note negative or unusually high prices explicitly.

## Traps to respect

- **Tail nulls** (Step 2) — never `.series[-1]`; drop the `null`s.
- **Last non-null ≠ now** (Step 2) — once tomorrow's auction is out, the last non-null
  point is tomorrow 23:00. "Now" is the latest point at or before the current time.
- **`hour` is an average** of four quarter-hour prices — use `quarterhour` for the
  cheapest / most expensive slot.
- **Region is `DE-LU` for every price filter**, even foreign zones — the filter id picks
  the country, not the region argument.
- Day-ahead prices are set the **day before** for the next 24h, so the freshest non-null
  points may already be "tomorrow's" — label the date from the timestamp and don't report
  them as the current price.
- Negative prices are valid; don't clamp or treat as errors.
- A 404 (exit code `4`) on `series` means a stale/invalid timestamp — re-run `timestamps`;
  prefer `latest` to avoid hard-coding one.
