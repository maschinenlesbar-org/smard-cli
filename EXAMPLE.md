# Examples

Real examples for the Claude Code skills of the `smard` plugin, one per skill: a request,
the `smard` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `smard` 0.0.8.
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

Every `day` series ends in `null` for today and the rest of the year (365 points, 257 filled), so
the skill read each source's last non-null point. Eleven sources landed on 14.09.2026. Kernenergie's
`latest` window is still 2024, with its last value a `0` on 29.01.2024, so it was left out.

```
German generation mix — Monday 14.09.2026 (region DE, day)
Renewable share: 45.4 %   ·   Fossil: 54.6 %   ·   total 1.07 TWh (1,072,954 MWh)

  Photovoltaik              276,133 MWh   25.7 %
  Braunkohle                256,633 MWh   23.9 %
  Erdgas                    179,928 MWh   16.8 %
  Steinkohle                109,827 MWh   10.2 %
  Biomasse                   93,944 MWh    8.8 %
  Wind Onshore               63,657 MWh    5.9 %
  Sonstige Konventionelle    39,425 MWh    3.7 %
  Wasserkraft                29,574 MWh    2.8 %
  Wind Offshore              21,739 MWh    2.0 %
  Sonstige Erneuerbare        2,096 MWh    0.2 %

Wind (onshore + offshore) supplied only 8.0 %; solar was the largest single source.
Not in the total: Pumpspeicher 32,704 MWh (storage). Kernenergie: series ended.
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

The window runs Monday 14.09. to Sunday 20.09. with 72 of 168 hours set. The last non-null point
is 16.09. 23:00, already tomorrow's day-ahead result, so the skill labelled it as tomorrow and read
the price for the current clock hour separately. All four zones end at the same hour, so they
could be compared directly.

```
German day-ahead power price (DE-LU, hourly, CEST)
  Now (15.09. 17:00):  213.47 €/MWh  (21.3 ct/kWh)
  Today 15.09.:        avg 180.07  ·  low 29.50 @ 13:00  ·  high 303.37 @ 19:00
  Tomorrow 16.09.:     avg 182.34  ·  low 97.51 @ 13:00  ·  high 254.43 @ 19:00

Cheapest tomorrow: 12:00–15:00 (113.52 / 97.51 / 102.44 €/MWh, about 10 ct/kWh).
  Cheapest quarter-hour: 13:45 at 90.40 €/MWh. Night hours 02:00–04:00 stay near 169.
Most expensive: 18:00–21:00 (231.08–254.43 €/MWh).

Zone comparison, 16.09.        avg      low              high
  Polen                      162.68    85.57 @ 12:00    252.42 @ 19:00
  Frankreich                 178.28    93.99 @ 13:00    255.72 @ 19:00
  DE-LU                      182.34    97.51 @ 13:00    254.43 @ 19:00
  Österreich                 183.73    98.41 @ 14:00    256.57 @ 19:00
Latest settled hour (16.09. 23:00): Polen 180.82 · DE-LU 185.20 · Frankreich 186.31 · Österreich 186.35
No negative prices this week. Monday 14.09. peaked at 697.31 €/MWh (19:00) in DE-LU.
```

## smard-series-export

> Export hourly German grid load and the day-ahead price since 1 September as one CSV.

```bash
smard --compact filters
smard --compact timestamps 410 DE hour
smard --compact timestamps 4169 DE-LU hour
for ts in 1788127200000 1788732000000 1789336800000; do smard --compact series 410 DE hour $ts; smard --compact series 4169 DE-LU hour $ts; done
smard --compact latest 4169 DE-LU day      # is 13.09. missing in the day series too?
```

`timestamps` came back as a plain array (612 windows for load, 416 for price). Three weekly windows
cover 01.09. to today, and they abut with no duplicate timestamps. The price window of 07.09. has
all 24 hours of Sunday 13.09. as `null`. The day series has `null` for that date too, so the gap is
upstream and the cells stay empty.

```
Wrote smard-410-4169-hour-2026-09.csv — 384 rows + header, 13.4 KB
  Range:   2026-08-31T22:00:00Z → 2026-09-16T21:00:00Z (UTC; 01.09. 00:00 – 16.09. 23:00 CEST)
  Columns: timestamp, "Stromverbrauch: Gesamt (Total grid load) [MWh]",
           "Großhandelspreis: Deutschland/Luxemburg [EUR/MWh]"
  Gaps kept as empty cells, never 0:
    grid load  353 values, 31 empty (not published yet after 15.09. 16:00)
    price      360 values, 24 empty (all of 13.09., null upstream)
  Dropped: 96 all-empty tail rows (17.–20.09.)
  Quick look: load 35,709–63,731 MWh (avg 50,869);
              price −19.00 €/MWh on 05.09. 14:00 to 697.31 €/MWh on 14.09. 19:00
```

Next steps offered: a JSON version (`{ timestamp, value }[]`), or more history by adding earlier windows.
