# Examples

Real examples for the Claude Code skills of the `smard` plugin, one per skill: a request,
the `smard` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 6 October 2026 with `smard` 0.2.0.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [smard-generation-mix](#smard-generation-mix) · [smard-price-watch](#smard-price-watch) · [smard-series-export](#smard-series-export)

## smard-generation-mix

> What was Germany's electricity mix yesterday? How much of it was renewable?

```bash
smard --compact regions
smard --compact filters --group generation
for id in 1223 4069 4071 1224 1227 4067 1225 4068 4066 1226 1228 4070; do smard --compact latest $id DE day; done
```

Every `day` series ends in `null` for today and the rest of the year (365 points, 278 filled), so
the skill read each source's last non-null point. Eleven sources landed on the same timestamp,
`1791151200000`. That is `2026-10-04T22:00:00Z` in UTC, but a `day` point starts at Berlin midnight,
so the skill named it by its Berlin date: Monday 05.10.2026, yesterday. Kernenergie's `latest`
window is still 2024, with its last value a `0` on 29.01.2024, so it was left out.

```
German generation mix — Monday 05.10.2026 (region DE, day)
Renewable share: 58.2 %   ·   Fossil: 41.8 %   ·   total 1.25 TWh (1,251,903 MWh)

  Photovoltaik              296,750 MWh   23.7 %
  Braunkohle                242,403 MWh   19.4 %
  Wind Onshore              195,451 MWh   15.6 %
  Erdgas                    151,910 MWh   12.1 %
  Wind Offshore             117,628 MWh    9.4 %
  Biomasse                   95,966 MWh    7.7 %
  Steinkohle                 93,692 MWh    7.5 %
  Sonstige Konventionelle    35,355 MWh    2.8 %
  Wasserkraft                20,811 MWh    1.7 %
  Sonstige Erneuerbare        1,937 MWh    0.2 %

Wind (onshore + offshore) supplied 25.0 %; solar was the largest single source.
Not in the total: Pumpspeicher 25,315 MWh (storage). Kernenergie: series ended.
```

Next steps offered: the same mix for the latest hour, or month-to-date with `month` resolution.

## smard-price-watch

> When is wholesale power cheapest tomorrow? And is it cheaper in France, Austria or Poland?

```bash
smard --compact filters --group price
smard --compact latest 4169 DE-LU hour
smard --compact latest 254 DE-LU hour
smard --compact latest 4170 DE-LU hour
smard --compact latest 257 DE-LU hour
smard --compact latest 4169 DE-LU quarterhour
```

The request came at 01:58 on Tuesday 06.10. The window runs Monday 05.10. to Sunday 11.10. with
48 of 168 hours set; the last non-null point is 06.10. 23:00 (23:45 at `quarterhour`). So prices
for Wednesday 07.10. were not out yet — they follow the midday auction — and the skill said so and
summarised Tuesday 06.10., the day just begun, instead. All four zones end at the same hour, so
they could be compared directly.

```
German day-ahead power price (DE-LU, CEST)
  Now (06.10. 01:00, hourly):   149.89 €/MWh  (15.0 ct/kWh)
  Tomorrow 07.10.:              not published yet (after the midday auction today)
  Today 06.10. (hourly):        avg 201.70  ·  low 127.02 @ 13:00  ·  high 382.32 @ 19:00
  Today 06.10. (quarter-hour):  low 124.33 @ 13:30  ·  high 406.00 @ 18:45

Cheapest today: 12:00–15:00 (132.49 / 127.02 / 136.67 €/MWh, about 13 ct/kWh).
  Night hours 00:00–05:00 stay near 150–153.
Most expensive: 18:00–21:00 (339.65 / 382.32 / 296.18 €/MWh).

Zone comparison, 06.10.        avg      low              high
  Polen                      165.24   101.13 @ 13:00    378.35 @ 19:00
  Frankreich                 201.37   134.81 @ 13:00    353.74 @ 19:00
  DE-LU                      201.70   127.02 @ 13:00    382.32 @ 19:00
  Österreich                 216.65   101.49 @ 12:00    373.49 @ 19:00
Current hour (06.10. 01:00): Polen 130.18 · DE-LU 149.89 · Frankreich 157.22 · Österreich 206.04
No negative prices this week. Monday 05.10. dipped to 6.71 €/MWh at 13:00 in DE-LU (5.03 at 13:45).
```

Next steps offered: check again after about 13:00 for Wednesday's prices.

## smard-series-export

> Export hourly German grid load and the day-ahead price since 1 September as one CSV.

```bash
smard --compact filters
smard --compact timestamps 410 DE hour
smard --compact timestamps 4169 DE-LU hour
for ts in 1788127200000 1788732000000 1789336800000 1789941600000 1790546400000 1791151200000; do smard --compact series 410 DE hour $ts; smard --compact series 4169 DE-LU hour $ts; done
```

`timestamps` came back as a plain array (615 windows for load, 419 for price). Six weekly windows,
31.08. to 11.10., cover 01.09. to today; they abut with no duplicate timestamps (1,008 points per
series). The rows are hourly, so the key column is the UTC instant, with Berlin wall-clock time next
to it. The rows of 31.08. fall before the requested start and were left out.

```
Wrote smard-410-4169-hour-2026-09.csv — 864 rows + header, 48.4 KB
  Range:   2026-08-31T22:00:00Z → 2026-10-06T21:00:00Z (UTC; 01.09. 00:00 – 06.10. 23:00 CEST)
  Columns: timestamp_utc, berlin_time, "Stromverbrauch: Gesamt (Total grid load) [MWh]",
           "Großhandelspreis: Deutschland/Luxemburg [EUR/MWh]"
  Gaps kept as empty cells, never 0:
    grid load  841 values, 23 empty (06.10. from 01:00, not published yet)
    price      864 values, none empty
  Dropped: 120 all-empty tail rows (07.–11.10.)
  Quick look: load 35,067–65,684 MWh (avg 51,238);
              price −19.00 €/MWh on 05.09. 14:00 to 697.31 €/MWh on 14.09. 19:00 (36 negative hours)
```

Next steps offered: a JSON version (`{ timestamp, value }[]`), or more history by adding earlier windows.
