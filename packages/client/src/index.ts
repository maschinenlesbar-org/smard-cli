// Public entry point for the API client library.

export { SmardClient, checkSeriesResult, checkTableResult } from "./client.js";
export { RequestEngine, DEFAULT_BASE_URL, baseUrlProblem, cleartextProblem, validateBaseUrl, MAX_RETRIES, MAX_RETRY_AFTER_MS, parseRetryAfter } from "./engine.js";
export type { EngineOptions, RawResponse, RetryEvent } from "./engine.js";
export { MAX_TIMEOUT_MS, nodeHttpTransport } from "./http.js";
export type { Transport, HttpRequest, HttpResponse } from "./http.js";
export { buildQueryString } from "./query.js";
export type { QueryParams, QueryValue } from "./query.js";
export {
  assertValid,
  assertArgument,
  oneOfProblem,
  intRangeProblem,
  headerValueProblem,
  assertHeaderValue,
  nonNegativeIntegerProblem,
  regionProblem,
  resolutionProblem,
  assertId,
  assertRegion,
  assertResolution,
  tokenProblem,
  normalizeToken,
  textProblem,
  normalizeText,
  splitList,
  listProblem,
} from "./validate.js";
export type { Problem } from "./validate.js";
export {
  SmardError,
  SmardApiError,
  SmardNetworkError,
  SmardResponseTooLargeError,
  SmardParseError,
  SmardValidationError,
  redactUrl,
  credentialsIn,
  redactCredentials,
  echoedCredentialForms,
  redactSecrets,
  cutForMessage,
  cutText,
  toWellFormed,
  quoteValue,
  MAX_MESSAGE_VALUE_LENGTH,
} from "./errors.js";

export { filtersByGroup, filterGroupProblem } from "./catalogue.js";
export * from "./enums.js";
export * from "./types.js";

// The skills' use cases (generation mix, prices, a series over a range) and the listings behind them.
export {
  berlinDate,
  berlinTime,
  fold,
  fromBerlin,
  getGenerationMix,
  getPrices,
  getSeries,
  listSeries,
  listWindows,
  parseTime,
  periodLabel,
  resolveRegion,
  resolveResolution,
  PRICE_ZONES,
  REGIONS,
  SERIES_INFO,
  WINDOW_SPANS,
} from "./operations.js";
export type {
  Ambiguous,
  Empty,
  GenerationMix,
  GenerationMixInput,
  MixSource,
  PriceAt,
  Prices,
  PricesInput,
  SeriesExport,
  SeriesFile,
  SeriesInfo,
  SeriesInput,
  SeriesKind,
  SeriesList,
  SeriesRow,
  TimeSpan,
  WindowList,
  ZonePrices,
} from "./operations.js";
