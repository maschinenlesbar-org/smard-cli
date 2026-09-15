# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `smard`, eines pro Skill: eine
Anfrage, die `smard`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `smard` 0.0.8 gegen die Live-API.
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

Jede `day`-Reihe endet mit `null` für heute und den Rest des Jahres (365 Punkte, 257 befüllt),
deshalb las der Skill für jede Quelle den letzten Wert ungleich `null`. Elf Quellen landeten auf
dem 14.09.2026. Das `latest`-Fenster der Kernenergie stammt noch aus 2024, der letzte Wert ist eine
`0` vom 29.01.2024 – sie blieb außen vor.

```
Deutscher Erzeugungsmix – Montag, 14.09.2026 (Region DE, Tageswerte)
Erneuerbarer Anteil: 45,4 %   ·   Fossil: 54,6 %   ·   gesamt 1,07 TWh (1.072.954 MWh)

  Photovoltaik              276.133 MWh   25,7 %
  Braunkohle                256.633 MWh   23,9 %
  Erdgas                    179.928 MWh   16,8 %
  Steinkohle                109.827 MWh   10,2 %
  Biomasse                   93.944 MWh    8,8 %
  Wind Onshore               63.657 MWh    5,9 %
  Sonstige Konventionelle    39.425 MWh    3,7 %
  Wasserkraft                29.574 MWh    2,8 %
  Wind Offshore              21.739 MWh    2,0 %
  Sonstige Erneuerbare        2.096 MWh    0,2 %

Wind (an Land und auf See) lieferte nur 8,0 %; Photovoltaik war die größte Einzelquelle.
Nicht in der Summe: Pumpspeicher 32.704 MWh (Speicher). Kernenergie: Reihe beendet.
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

Das Fenster reicht von Montag, 14.09., bis Sonntag, 20.09., 72 der 168 Stunden sind belegt. Der
letzte Wert ungleich `null` ist 16.09., 23:00 Uhr – schon das Day-Ahead-Ergebnis für morgen. Der
Skill kennzeichnete ihn als morgen und las den Preis der aktuellen Stunde getrennt aus. Alle vier
Zonen enden zur selben Stunde und ließen sich direkt vergleichen.

```
Day-Ahead-Strompreis Deutschland (DE-LU, stündlich, MESZ)
  Jetzt (15.09., 17:00):  213,47 €/MWh  (21,3 ct/kWh)
  Heute 15.09.:           Ø 180,07  ·  Tief 29,50 um 13:00  ·  Hoch 303,37 um 19:00
  Morgen 16.09.:          Ø 182,34  ·  Tief 97,51 um 13:00  ·  Hoch 254,43 um 19:00

Am günstigsten morgen: 12:00–15:00 (113,52 / 97,51 / 102,44 €/MWh, etwa 10 ct/kWh).
  Günstigste Viertelstunde: 13:45 mit 90,40 €/MWh. Nachts 02:00–04:00 bleibt es bei etwa 169.
Am teuersten: 18:00–21:00 (231,08–254,43 €/MWh).

Zonenvergleich, 16.09.            Ø        Tief              Hoch
  Polen                        162,68    85,57 um 12:00    252,42 um 19:00
  Frankreich                   178,28    93,99 um 13:00    255,72 um 19:00
  DE-LU                        182,34    97,51 um 13:00    254,43 um 19:00
  Österreich                   183,73    98,41 um 14:00    256,57 um 19:00
Letzte feste Stunde (16.09., 23:00): Polen 180,82 · DE-LU 185,20 · Frankreich 186,31 · Österreich 186,35
Diese Woche keine negativen Preise. Am Montag, 14.09., lag die Spitze in DE-LU bei 697,31 €/MWh (19:00).
```

## smard-series-export

> Stündliche Netzlast und Day-Ahead-Preis für Deutschland seit dem 1. September als eine CSV-Datei.

```bash
smard --compact filters
smard --compact timestamps 410 DE hour
smard --compact timestamps 4169 DE-LU hour
for ts in 1788127200000 1788732000000 1789336800000; do smard --compact series 410 DE hour $ts; smard --compact series 4169 DE-LU hour $ts; done
smard --compact latest 4169 DE-LU day      # fehlt der 13.09. auch in der Tagesreihe?
```

`timestamps` kam als einfaches Array zurück (612 Fenster für die Last, 416 für den Preis). Drei
Wochenfenster decken den 01.09. bis heute ab; sie schließen ohne doppelte Zeitstempel aneinander
an. Im Preisfenster ab 07.09. sind alle 24 Stunden von Sonntag, 13.09., `null`. Die Tagesreihe hat
für dieses Datum ebenfalls `null` – die Lücke stammt also von der Quelle, die Zellen bleiben leer.

```
smard-410-4169-hour-2026-09.csv geschrieben – 384 Zeilen plus Kopfzeile, 13,4 KB
  Zeitraum:  2026-08-31T22:00:00Z → 2026-09-16T21:00:00Z (UTC; 01.09. 00:00 – 16.09. 23:00 MESZ)
  Spalten:   timestamp, "Stromverbrauch: Gesamt (Total grid load) [MWh]",
             "Großhandelspreis: Deutschland/Luxemburg [EUR/MWh]"
  Lücken als leere Zellen, nie als 0:
    Netzlast  353 Werte, 31 leer (nach 15.09., 16:00 noch nicht veröffentlicht)
    Preis     360 Werte, 24 leer (der ganze 13.09., in der Quelle null)
  Entfernt:  96 komplett leere Zeilen am Ende (17.–20.09.)
  Kurzüberblick: Last 35.709–63.731 MWh (Ø 50.869);
                 Preis −19,00 €/MWh am 05.09., 14:00, bis 697,31 €/MWh am 14.09., 19:00
```

Als Nächstes angeboten: eine JSON-Fassung (`{ timestamp, value }[]`) oder mehr Historie durch weitere, ältere Fenster.
