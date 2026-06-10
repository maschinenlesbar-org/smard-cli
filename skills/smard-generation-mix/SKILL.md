---
name: smard-generation-mix
description: >
  Build Germany's electricity generation mix and renewable share for a window
  using the smard-cli. Trigger when the user asks "what's the current energy mix
  in Germany?", "how much of the power is renewable right now?", "wind vs solar
  vs gas generation", "what's coal/gas doing today?", or wants a breakdown of the
  power grid by source. Fans out across every generation filter, fetches the
  newest common window, and computes per-source MWh, shares, and renewable
  fraction — the cross-source aggregation the CLI deliberately doesn't do.
version: 1.0.0
userInvocable: true
---

# SMARD Generation Mix

Turn the per-source generation series into a single **energy-mix breakdown** for one
window — MWh and % per technology, plus the renewable share — instead of a dozen separate
`latest` calls the user has to add up by hand.

## Tooling

This skill drives the `smard` command. **Before anything else, validate it is available** — run `command -v smard` (or `smard --version`). If it is not on your PATH, STOP and inform the user that the `smard` CLI (`@maschinenlesbar.org/smard-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Data comes from the `smard` CLI — read-only, no API key, **one (filter, region, resolution) series per call**. The whole job of this skill is the cross-filter aggregation the CLI doesn't do.

Always pass `--compact` so each result is one line, easy to pipe into `jq`. Bump
`--timeout 60000` if a call times out.

## Step 1 — Fix the parameters

- **region**: default `DE` (all-Germany). The user may want a TSO area (`50Hertz`,
  `Amprion`, `TenneT`, `TransnetBW`). Validate against `smard regions`.
- **resolution**: default `day` for "today / latest" — it gives one tidy total per source
  and all sources align on the same window. Use `hour` only if the user explicitly wants
  the latest hour; use `month`/`year` for longer-run shares.
- The **generation filter set** (group `generation`) is fixed; get it from
  `smard --compact filters --group generation` rather than hard-coding:

  | id | source | renewable? |
  |---|---|---|
  | 1223 | Braunkohle (Lignite) | no |
  | 4069 | Steinkohle (Hard coal) | no |
  | 4071 | Erdgas (Natural gas) | no |
  | 1224 | Kernenergie (Nuclear) | no (low-carbon, but **dead series** — see traps) |
  | 1227 | Sonstige Konventionelle (Other conventional) | no |
  | 4067 | Wind Onshore | yes |
  | 1225 | Wind Offshore | yes |
  | 4068 | Photovoltaik | yes |
  | 4066 | Biomasse (Biomass) | yes |
  | 1226 | Wasserkraft (Hydropower) | yes |
  | 1228 | Sonstige Erneuerbare (Other renewable) | yes |
  | 4070 | Pumpspeicher (Pumped storage) | n/a — storage, exclude from mix totals |

## Step 2 — Fetch each source's newest window

Fan out one `latest` per filter (they're independent):

```bash
smard --compact latest 4067 DE day | jq -c '[.series[] | select(.[1] != null)][-1]'
smard --compact latest 4068 DE day | jq -c '[.series[] | select(.[1] != null)][-1]'
# … repeat for every generation filter id
```

Each `latest` returns `{ meta_data, series }`, where `series` is an array of
`[epochMillis, value]` pairs and **value is in MWh** (energy over that window).

> **The critical trap — the tail of every window is `null`.** The newest window runs to
> the *end of the period* (e.g. a `day`/`hour` index that extends into "now" or the
> future), and the not-yet-published points come back as `[ts, null]`. Never read
> `.series[-1]` — it is almost always `null`. **Always take the last non-null point:**
> `[.series[] | select(.[1] != null)][-1]`. That tuple is `[timestampMs, MWh]` for the
> most recent settled window.

## Step 3 — Align on a common timestamp

At `day` (and usually `hour`) resolution every source's last settled point lands on the
**same** timestamp, so you can compare them directly. Sanity-check it: collect each
source's last-non-null `[ts, value]` and confirm the `ts` agree. If one source lags by a
window (its last `ts` is older), either drop back all sources to the latest *common* ts
(re-read each series and pick the point at that ts) or note the source is one window
behind. Don't sum values from different timestamps.

## Step 4 — Compute the mix

- **Total generation** = sum of all generation-source MWh **excluding** Pumpspeicher
  (4070, it's storage, not generation; mention it separately if asked).
- **Per-source share** = source MWh ÷ total × 100.
- **Renewable share** = (Wind Onshore + Wind Offshore + PV + Biomasse + Wasserkraft +
  Sonstige Erneuerbare) ÷ total × 100.
- **Fossil share** = (Braunkohle + Steinkohle + Erdgas + Sonstige Konventionelle) ÷ total.

## Step 5 — Present the breakdown

Lead with the window (human-readable date from the timestamp) and the headline renewable
share, then a ranked table:

```
German generation mix — day of 2026-06-08 (region DE)
Renewable share: 62.1%   ·   Fossil: 37.9%   ·   total 1.19 TWh

  Wind Onshore     410,764 MWh   34.4%
  Photovoltaik     279,356 MWh   23.4%
  Braunkohle       142,484 MWh   11.9%
  Wind Offshore     95,720 MWh    8.0%
  Biomasse          91,124 MWh    7.6%
  Erdgas            77,233 MWh    6.5%
  Wasserkraft       44,883 MWh    3.8%
  Steinkohle        43,622 MWh    3.7%
  …
```

Rules:
- **Rank by MWh, biggest first.** Show MWh and %; convert large day/month totals to
  GWh/TWh for readability (1 TWh = 1,000,000 MWh) but keep the raw MWh available.
- Always state the **window and region** — a `day` total and an `hour` snapshot are very
  different numbers; don't let them be confused.
- Report the **renewable share** prominently — it's the number most users actually want.
- A source reading `0` is normal (e.g. PV overnight, lignite ramped down); keep it in the
  table, don't drop it as missing.

## Traps to respect

- **Tail nulls** (Step 2) — the single most common mistake. Use last non-null.
- **Nuclear (1224) is a flat/dead series.** Germany shut down its last reactors in
  April 2023; filter 1224's last non-null value is an old `0` (e.g. early 2024), not a
  live point. Don't present a stale 2024 zero as "today's nuclear output" — either omit
  nuclear for current windows or label it as ended.
- **Pumpspeicher (4070) is storage**, and there's also a *consumption*-group pumped-storage
  filter (4387). Don't add 4070 into generation totals.
- **Region matters for totals.** Summing the four TSO areas ≈ `DE`, but just query `DE`
  for the national mix rather than adding control areas yourself.
- A `latest` for a valid triple that has no data returns an empty `series` (or all-null);
  say "no settled data for this window" rather than reporting 0 MWh.
