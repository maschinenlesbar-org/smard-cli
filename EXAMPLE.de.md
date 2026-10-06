# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `smard`, eines pro Skill: eine
Anfrage, die `smard`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 6. Oktober 2026 mit `smard` 0.2.0 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [smard-generation-mix](#smard-generation-mix) · [smard-price-watch](#smard-price-watch) · [smard-series-export](#smard-series-export)

## smard-generation-mix

> Wie sah der deutsche Strommix gestern aus? Wie viel davon war erneuerbar?

```bash
smard --compact regions
smard --compact filters --group generation
for id in 1223 4069 4071 1224 1227 4067 1225 4068 4066 1226 1228 4070; do smard --compact latest $id DE day; done
```

Jede `day`-Reihe endet mit `null` für heute und den Rest des Jahres (365 Punkte, 278 befüllt),
deshalb las der Skill für jede Quelle den letzten Wert ungleich `null`. Elf Quellen landeten auf
demselben Zeitstempel, `1791151200000`. In UTC ist das `2026-10-04T22:00:00Z`, aber ein
`day`-Punkt beginnt um Mitternacht Berliner Zeit, deshalb benannte der Skill ihn nach seinem
Berliner Datum: Montag, 05.10.2026, also gestern. Das `latest`-Fenster der Kernenergie stammt noch
aus 2024, der letzte Wert ist eine `0` vom 29.01.2024 – sie blieb außen vor.

```
Deutscher Erzeugungsmix – Montag, 05.10.2026 (Region DE, Tageswerte)
Erneuerbarer Anteil: 58,2 %   ·   Fossil: 41,8 %   ·   gesamt 1,25 TWh (1.251.903 MWh)

  Photovoltaik              296.750 MWh   23,7 %
  Braunkohle                242.403 MWh   19,4 %
  Wind Onshore              195.451 MWh   15,6 %
  Erdgas                    151.910 MWh   12,1 %
  Wind Offshore             117.628 MWh    9,4 %
  Biomasse                   95.966 MWh    7,7 %
  Steinkohle                 93.692 MWh    7,5 %
  Sonstige Konventionelle    35.355 MWh    2,8 %
  Wasserkraft                20.811 MWh    1,7 %
  Sonstige Erneuerbare        1.937 MWh    0,2 %

Wind (an Land und auf See) lieferte 25,0 %; Photovoltaik war die größte Einzelquelle.
Nicht in der Summe: Pumpspeicher 25.315 MWh (Speicher). Kernenergie: Reihe beendet.
```

Als Nächstes angeboten: derselbe Mix für die letzte Stunde oder der bisherige Monat mit Auflösung `month`.

## smard-price-watch

> Wann ist Strom im Großhandel morgen am günstigsten? Und ist er in Frankreich, Österreich oder Polen billiger?

```bash
smard --compact filters --group price
smard --compact latest 4169 DE-LU hour
smard --compact latest 254 DE-LU hour
smard --compact latest 4170 DE-LU hour
smard --compact latest 257 DE-LU hour
smard --compact latest 4169 DE-LU quarterhour
```

Die Anfrage kam am Dienstag, 06.10., um 01:58 Uhr. Das Fenster reicht von Montag, 05.10., bis
Sonntag, 11.10., 48 der 168 Stunden sind belegt; der letzte Wert ungleich `null` ist 06.10.,
23:00 Uhr (23:45 Uhr bei `quarterhour`). Die Preise für Mittwoch, 07.10., waren also noch nicht
veröffentlicht – sie folgen der Auktion am Mittag. Der Skill sagte das und fasste stattdessen
Dienstag, 06.10., zusammen, den gerade begonnenen Tag. Alle vier Zonen enden zur selben Stunde und
ließen sich direkt vergleichen.

```
Day-Ahead-Strompreis Deutschland (DE-LU, MESZ)
  Jetzt (06.10., 01:00, stündlich):   149,89 €/MWh  (15,0 ct/kWh)
  Morgen 07.10.:                      noch nicht veröffentlicht (nach der Auktion heute Mittag)
  Heute 06.10. (stündlich):           Ø 201,70  ·  Tief 127,02 um 13:00  ·  Hoch 382,32 um 19:00
  Heute 06.10. (Viertelstunden):      Tief 124,33 um 13:30  ·  Hoch 406,00 um 18:45

Am günstigsten heute: 12:00–15:00 (132,49 / 127,02 / 136,67 €/MWh, etwa 13 ct/kWh).
  Nachts 00:00–05:00 bleibt es bei etwa 150–153.
Am teuersten: 18:00–21:00 (339,65 / 382,32 / 296,18 €/MWh).

Zonenvergleich, 06.10.            Ø        Tief              Hoch
  Polen                        165,24   101,13 um 13:00    378,35 um 19:00
  Frankreich                   201,37   134,81 um 13:00    353,74 um 19:00
  DE-LU                        201,70   127,02 um 13:00    382,32 um 19:00
  Österreich                   216,65   101,49 um 12:00    373,49 um 19:00
Aktuelle Stunde (06.10., 01:00): Polen 130,18 · DE-LU 149,89 · Frankreich 157,22 · Österreich 206,04
Diese Woche keine negativen Preise. Am Montag, 05.10., fiel DE-LU um 13:00 auf 6,71 €/MWh (5,03 um 13:45).
```

Als Nächstes angeboten: nach etwa 13:00 Uhr erneut nach den Preisen für Mittwoch sehen.

## smard-series-export

> Stündliche Netzlast und Day-Ahead-Preis für Deutschland seit dem 1. September als eine CSV-Datei.

```bash
smard --compact filters
smard --compact timestamps 410 DE hour
smard --compact timestamps 4169 DE-LU hour
for ts in 1788127200000 1788732000000 1789336800000 1789941600000 1790546400000 1791151200000; do smard --compact series 410 DE hour $ts; smard --compact series 4169 DE-LU hour $ts; done
```

`timestamps` kam als einfaches Array zurück (615 Fenster für die Last, 419 für den Preis). Sechs
Wochenfenster, 31.08. bis 11.10., decken den 01.09. bis heute ab; sie schließen ohne doppelte
Zeitstempel aneinander an (1.008 Punkte je Reihe). Die Zeilen sind stündlich, deshalb ist die
Schlüsselspalte der UTC-Zeitpunkt, daneben die Berliner Uhrzeit. Die Zeilen vom 31.08. liegen vor
dem gewünschten Beginn und blieben außen vor.

```
smard-410-4169-hour-2026-09.csv geschrieben – 864 Zeilen plus Kopfzeile, 48,4 KB
  Zeitraum:  2026-08-31T22:00:00Z → 2026-10-06T21:00:00Z (UTC; 01.09. 00:00 – 06.10. 23:00 MESZ)
  Spalten:   timestamp_utc, berlin_time, "Stromverbrauch: Gesamt (Total grid load) [MWh]",
             "Großhandelspreis: Deutschland/Luxemburg [EUR/MWh]"
  Lücken als leere Zellen, nie als 0:
    Netzlast  841 Werte, 23 leer (06.10. ab 01:00, noch nicht veröffentlicht)
    Preis     864 Werte, keine leer
  Entfernt:  120 komplett leere Zeilen am Ende (07.–11.10.)
  Kurzüberblick: Last 35.067–65.684 MWh (Ø 51.238);
                 Preis −19,00 €/MWh am 05.09., 14:00, bis 697,31 €/MWh am 14.09., 19:00 (36 negative Stunden)
```

Als Nächstes angeboten: eine JSON-Fassung (`{ timestamp, value }[]`) oder mehr Historie durch weitere, ältere Fenster.
