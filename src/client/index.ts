// Public entry point for the API client library.

export { SmardClient, checkSeriesResult, checkTableResult } from "./client.js";
export { RequestEngine, DEFAULT_BASE_URL, baseUrlProblem, validateBaseUrl, MAX_RETRIES, MAX_RETRY_AFTER_MS, parseRetryAfter } from "./engine.js";
export type { EngineOptions, RawResponse } from "./engine.js";
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
  cutForMessage,
  MAX_MESSAGE_VALUE_LENGTH,
} from "./errors.js";

export { filtersByGroup, filterGroupProblem } from "./catalogue.js";
export * from "./enums.js";
export * from "./types.js";
