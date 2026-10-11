// Lookups over the bundled filter catalogue (no network call).

import { FILTERS, FilterGroupValues, type FilterGroup, type FilterInfo } from "./enums.js";
import { assertArgument, oneOfProblem } from "./validate.js";

/** The rule for a filter group: one of `FilterGroupValues`. */
export const filterGroupProblem = oneOfProblem(FilterGroupValues);

/**
 * The `FILTERS` catalogue, or only the entries of one group. Without a group
 * (`undefined`) it returns the whole catalogue. An unknown group — a misspelling,
 * another case, padding, a blank — throws a `SmardValidationError`
 * (`Invalid group "Price". Expected one of: generation, consumption, price, forecast.`)
 * rather than returning a silent empty list.
 */
export function filtersByGroup(group?: FilterGroup): FilterInfo[] {
  if (group === undefined) return FILTERS;
  assertArgument("group", group, filterGroupProblem);
  return FILTERS.filter((f) => f.group === group);
}
