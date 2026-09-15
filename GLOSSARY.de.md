# Glossar

Ein Nachschlagewerk für die Fachbegriffe und projektspezifischen Begriffe, die in
`smard-cli` verwendet werden. Die SMARD-Domäne ist deutsch; dieses Glossar nennt den
englischen Begriff aus CLI und Bibliothek (sofern es einen gibt) neben dem deutschen Original.

> **Übersetzungstabelle** (die Bezeichnungen aus dem `filters`-Katalog). Die
> Filterbezeichnungen der CLI sind deutsch, mit einer englischen Erläuterung in Klammern:
>
> | Deutsch | Englisch |
> | --- | --- |
> | Stromerzeugung | (electricity) generation |
> | Stromverbrauch | (electricity) consumption |
> | Residuallast | residual load |
> | Großhandelspreis | wholesale price |
> | Prognose | forecast |
> | Braunkohle / Steinkohle | lignite / hard coal |
> | Kernenergie | nuclear |
> | Wasserkraft / Pumpspeicher | hydropower / pumped storage |
> | Erdgas | natural gas |
> | Photovoltaik | photovoltaics |

---

## SMARD & die Plattform

**SMARD – Strommarktdaten.** Die deutsche Strommarkt-Datenplattform der
**Bundesnetzagentur** unter [`smard.de`](https://www.smard.de). Sie veröffentlicht
Stromerzeugung, Stromverbrauch, Residuallast und Großhandelspreise.

**Bundesnetzagentur (BNetzA).** Die deutsche Regulierungsbehörde für die Märkte Strom,
Gas, Telekommunikation, Post und Eisenbahn und Betreiberin von SMARD.

**Chart-Data-API.** Die offene HTTP-Schnittstelle ohne Authentifizierung, die dieses Tool
kapselt. Sie ist keine Abfrage-API, sondern ein **statischer Dateibaum**: Für jede
Kombination aus *(Filter, Region, Auflösung)* veröffentlicht SMARD einen *Index* der
verfügbaren Fenster-Zeitstempel sowie eine *Datendatei* pro Fenster. Die Basis-URL ist
`https://www.smard.de`.

**Nur lesend, ohne Authentifizierung.** Die Chart-Data-Endpoints benötigen keinen
API-Schlüssel. Dieser Client führt ausschließlich `GET`-Anfragen aus und schreibt nie.
Es wird nie ein Credential-Header erzeugt. Weiterleitungen werden **nicht verfolgt** –
ein `3xx` erscheint als `SmardApiError` –, und es werden nur Basis-URLs mit
`http:`/`https:` akzeptiert (durchgesetzt im Standard-Transport). Diese bewussten
Abweichungen vom Workspace-Blueprint beschreibt DEVELOPING.md im Abschnitt „Design notes“.

---

## Das Anfrage-Tripel

Fast jeder Datenabruf wird über drei Koordinaten adressiert – einen **Filter**, eine
**Region** und eine **Auflösung** – sowie, für ein bestimmtes Fenster, einen **Zeitstempel**.

**Filter.** Eine numerische Reihen-ID, die festlegt, *welche* Zeitreihe Sie abrufen
(z. B. `410` = Gesamtnetzlast, `4068` = Erzeugung Photovoltaik,
`4169` = Großhandelspreis DE/LU). Die API akzeptiert **jede ganzzahlige** Filter-ID,
deshalb akzeptieren CLI und Client jede ganze Zahl; der mitgelieferte `FILTERS`-Katalog
(siehe `smard filters`) dokumentiert die bekannten IDs, ist aber **nicht vollständig**.

**Region.** Ein Code für ein Marktgebiet oder eine Netzregion. Siehe `smard regions`; die
gültige Menge (`RegionValues`) ist `DE`, `AT`, `LU`, `DE-LU`, `DE-AT-LU`, `50Hertz`, `Amprion`,
`TenneT`, `TransnetBW`, `APG`, `Creos`.

**Auflösung (resolution).** Die zeitliche Granularität einer Reihe: einer der Werte `hour`,
`quarterhour`, `day`, `week`, `month`, `year` (`ResolutionValues`). Siehe
`smard resolutions`.

**Zeitstempel (timestamp).** Ein Wert in **Epoch-Millisekunden**, der den Beginn eines
Datenfensters markiert. Gültige Werte liefert `smard timestamps`; einen davon übergeben Sie an
`series`. Jede Datendatei deckt ein festes Fenster ab (z. B. eine Woche mit Stundenwerten).

---

## Filtergruppen

Der `FILTERS`-Katalog ordnet jeden dokumentierten Filter einer von vier Gruppen zu
(`smard filters --group <group>`):

**generation (Stromerzeugung).** Tatsächliche Stromerzeugung nach Energieträger, z. B.
Braunkohle (`1223`), Kernenergie (`1224`), Wind Offshore
(`1225`), Wasserkraft (`1226`), Biomasse (`4066`), Wind Onshore
(`4067`), Photovoltaik (`4068`), Steinkohle (`4069`),
Pumpspeicher (`4070`), Erdgas (`4071`).

**consumption (Stromverbrauch).** Gesamtnetzlast (`410`), Residuallast
(`4359`) und Verbrauch der Pumpspeicher (`4387`).

**forecast (Prognose).** Prognostizierte Erzeugung, z. B. Wind Offshore (`3791`),
Wind Onshore (`123`), Photovoltaik (`125`), Wind und PV zusammen (`5097`) sowie
gesamt (`122`).

**price (Großhandelspreis).** Day-Ahead-Großhandelspreise für Deutschland/Luxemburg
(`4169`) und benachbarte Gebotszonen (z. B. Österreich `4170`,
Frankreich `254`, Niederlande `256`, Schweiz `259`).

---

## Regionen im Detail

**DE / AT / LU.** Deutschland, Österreich und Luxemburg.

**DE-LU.** Die deutsch-luxemburgische **Gebotszone**, das Preisgebiet der meisten
aktuellen Großhandelspreis-Reihen.

**DE-AT-LU.** Die frühere gemeinsame Gebotszone Deutschland–Österreich–Luxemburg (2018
aufgeteilt), verwendet für historische Daten.

**Regelzonen der Übertragungsnetzbetreiber.** `50Hertz`, `Amprion`, `TenneT` und
`TransnetBW` sind die vier deutschen Regelzonen der Übertragungsnetzbetreiber.

**APG / Creos.** Die Übertragungsnetzbetreiber Österreichs (Austrian Power Grid) und
Luxemburgs (Creos).

---

## Auflösungen

**hour / quarterhour / day / week / month / year.** Die unterstützten
Aggregationsintervalle einer Reihe. `quarterhour` (15 Minuten) ist zugleich die
Granularität der ausführlicheren `table_data`-Antwort.

---

## Datenstrukturen

**Index (`TimestampIndex`).** Die Antwort einer Anfrage an `index_{resolution}.json`:
`{ timestamps: number[] }` – der Beginn jedes verfügbaren Datenfensters in
Epoch-Millisekunden. Bereitgestellt über `client.timestamps()` / `smard timestamps`.

**series (`SeriesResult`).** Die Antwort einer `chart_data`-Anfrage:
`{ meta_data, series }`, wobei `series` ein Array von `SeriesPoint`s ist. Rückgabewert von
`client.series()` / `client.latest()`.

**SeriesPoint.** Ein einzelnes Tupel `[timestampMs, value]`. Das zweite Element ist
bei einer **Lücke** `null` (keine Daten für diesen Punkt).

**SeriesMetaData (`meta_data`).** `{ version, created }` – die Datenversion und ihr
Erstellungszeitpunkt, die eine Reihen- oder Tabellenantwort begleiten.

**table_data (`TableResult`).** Eine ausführlichere Viertelstunden-Antwort
(`smard table`). Ihr `series` ist ein Array von `TableSeriesEntry`-Objekten, die die
eigentlichen Punkte jeweils in einem `values`-Array von `TablePoint`s verschachteln.

**TablePoint.** `{ timestamp, versions }` – ein Viertelstunden-Punkt mit mehreren
versionierten Werten.

**TableVersion.** Ein versionierter Wert eines Tabellenpunkts: `{ value, name }`. Beachten
Sie, dass `name` die **Datenversion** bezeichnet und zur Laufzeit eine *Zahl* ist, keine
Bezeichnung als Zeichenkette. Beide Felder können `null` sein.

---

## Einheiten und Bedeutung

**MWh – Megawattstunde.** Die Einheit der Erzeugungs- und Verbrauchsreihen (Energie pro
Fenster). Hinweis: Im JSON sind die Werte Zahlen ohne Einheit; die Einheit ergibt sich
aus dem gewählten Filter.

**EUR/MWh – Euro pro Megawattstunde.** Die Einheit der Großhandelspreis-Filter
(die Gruppe `price`).

**Residuallast.** Gesamtnetzlast abzüglich der Erzeugung aus fluktuierenden
erneuerbaren Energien (Wind + Solar) – die Last, die andere Quellen decken müssen.
Filter `4359`.

**Gesamtstromverbrauch.** Der gesamte Stromverbrauch in einer Region. Filter `410`.

**Fenster / Datendatei.** Der feste Zeitraum, den eine Datendatei `*_{timestamp}.json`
abdeckt (z. B. eine Woche mit Stundenwerten). Für die neuesten Daten rufen Sie den Index
ab, nehmen den letzten Zeitstempel und laden dann diese Datei – genau das erledigt
`latest` in einem Aufruf.

---

## Befehle & Methoden

**timestamps.** `smard timestamps <filter> <region> <resolution>` /
`client.timestamps(...)` – listet die verfügbaren Fenster-Zeitstempel einer Reihe.

**series.** `smard series <filter> <region> <resolution> <timestamp>` /
`client.series(...)` – ruft die Daten eines Fensters ab.

**latest.** `smard latest <filter> <region> <resolution>` /
`client.latest(...)` – Komfortfunktion, die den Index liest, den neuesten Zeitstempel
wählt und dieses Fenster in einem Aufruf abruft.

**table.** `smard table <filter> <region> <timestamp>` /
`client.tableData(...)` – Viertelstunden-`table_data` für ein Fenster. Die gültigen
Zeitstempel dafür sind eine **andere Menge** als die von `timestamps` (das
`chart_data`-Fenster auflistet); für `table_data`-Zeitstempel gibt es keinen
Discovery-Endpoint, daher kann ein `table`-Aufruf mit `404` scheitern, obwohl der
Zeitstempel für `series` gültig ist.

**filters / regions / resolutions.** Katalogbefehle, die die dokumentierten Filter-IDs
(optional nur eine `--group`), die gültigen Regionscodes und die gültigen Auflösungswerte
ausgeben – lokal aus den mitgelieferten Enums, ohne Netzwerkaufruf.

---

> **Bibliothek & Interna.** Begriffe zum TypeScript-Client und seinen Interna –
> `SmardClient`, die Request-Engine, Transport, Retry/Backoff, Fehlertypen,
> `FILTERS`/`RegionValues`/`ResolutionValues` und die Validierungsgrenze –
> stehen jetzt in **[DEVELOPING.md](DEVELOPING.md)**.
