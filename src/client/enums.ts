// Enum-like value sets and the filter catalogue. These const arrays double as
// runtime CLI choice validators and as TS union types.

/** Temporal resolution of a series. */
export const ResolutionValues = ["hour", "quarterhour", "day", "week", "month", "year"] as const;
export type Resolution = (typeof ResolutionValues)[number];

/**
 * Market/grid regions. `DE-LU` is the German-Luxembourg bidding zone; the
 * `50Hertz`/`Amprion`/`TenneT`/`TransnetBW` codes are the four German TSO control
 * areas; `APG`/`Creos` are the Austrian/Luxembourg TSOs.
 */
export const RegionValues = [
  "DE",
  "AT",
  "LU",
  "DE-LU",
  "DE-AT-LU",
  "50Hertz",
  "Amprion",
  "TenneT",
  "TransnetBW",
  "APG",
  "Creos",
] as const;
export type Region = (typeof RegionValues)[number];

/**
 * The documented chart-data filters (the time series you can request), grouped
 * for readability. The numeric id is what the API path takes; the label is for
 * human help output. Not exhaustive — the API accepts any integer filter id, so
 * the CLI accepts any integer and uses this only for the `filters` listing.
 */
export interface FilterInfo {
  id: number;
  label: string;
  group: "generation" | "consumption" | "price" | "forecast";
}

export const FILTERS: FilterInfo[] = [
  // Realised generation
  { id: 1223, label: "Braunkohle (Lignite)", group: "generation" },
  { id: 1224, label: "Kernenergie (Nuclear)", group: "generation" },
  { id: 1225, label: "Wind Offshore", group: "generation" },
  { id: 1226, label: "Wasserkraft (Hydropower)", group: "generation" },
  { id: 1227, label: "Sonstige Konventionelle (Other conventional)", group: "generation" },
  { id: 1228, label: "Sonstige Erneuerbare (Other renewable)", group: "generation" },
  { id: 4066, label: "Biomasse (Biomass)", group: "generation" },
  { id: 4067, label: "Wind Onshore", group: "generation" },
  { id: 4068, label: "Photovoltaik (Photovoltaics)", group: "generation" },
  { id: 4069, label: "Steinkohle (Hard coal)", group: "generation" },
  { id: 4070, label: "Pumpspeicher (Pumped storage)", group: "generation" },
  { id: 4071, label: "Erdgas (Natural gas)", group: "generation" },
  // Consumption
  { id: 410, label: "Stromverbrauch: Gesamt (Total grid load)", group: "consumption" },
  { id: 4359, label: "Stromverbrauch: Residuallast (Residual load)", group: "consumption" },
  { id: 4387, label: "Stromverbrauch: Pumpspeicher (Pumped storage)", group: "consumption" },
  // Forecasted generation
  { id: 3791, label: "Prognose: Wind Offshore", group: "forecast" },
  { id: 123, label: "Prognose: Wind Onshore", group: "forecast" },
  { id: 125, label: "Prognose: Photovoltaik", group: "forecast" },
  { id: 715, label: "Prognose: Sonstige", group: "forecast" },
  { id: 5097, label: "Prognose: Wind und Photovoltaik", group: "forecast" },
  { id: 122, label: "Prognose: Gesamt (Total)", group: "forecast" },
  // Wholesale market prices (Großhandelspreise)
  { id: 4169, label: "Großhandelspreis: Deutschland/Luxemburg", group: "price" },
  { id: 5078, label: "Großhandelspreis: Anrainer DE/LU", group: "price" },
  { id: 4996, label: "Großhandelspreis: Belgien", group: "price" },
  { id: 4997, label: "Großhandelspreis: Norwegen 2", group: "price" },
  { id: 4170, label: "Großhandelspreis: Österreich", group: "price" },
  { id: 252, label: "Großhandelspreis: Dänemark 1", group: "price" },
  { id: 253, label: "Großhandelspreis: Dänemark 2", group: "price" },
  { id: 254, label: "Großhandelspreis: Frankreich", group: "price" },
  { id: 255, label: "Großhandelspreis: Italien (Nord)", group: "price" },
  { id: 256, label: "Großhandelspreis: Niederlande", group: "price" },
  { id: 257, label: "Großhandelspreis: Polen", group: "price" },
  { id: 259, label: "Großhandelspreis: Schweiz", group: "price" },
  { id: 260, label: "Großhandelspreis: Slowenien", group: "price" },
  { id: 261, label: "Großhandelspreis: Tschechien", group: "price" },
  { id: 262, label: "Großhandelspreis: Ungarn", group: "price" },
];
