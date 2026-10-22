// Lookups over the bundled filter catalogue (no network call).

import { FILTERS, FilterGroupValues, type FilterGroup, type FilterInfo } from "./enums.js";
import { assertArgument, canonicalToken, oneOfProblem } from "./validate.js";

/** The rule for a filter group: one of `FilterGroupValues`. */
export const filterGroupProblem = oneOfProblem(FilterGroupValues);

/**
 * The `FILTERS` catalogue, or only the entries of one group, as a new array the caller
 * owns. Without a group (`undefined`) it returns the whole catalogue. The group is a token: trimmed and NFC,
 * an invisible or control character refused (`canonicalToken`). An unknown group — a
 * misspelling, another case, a blank — throws a `SmardValidationError`
 * (`Invalid group "Price". Expected one of: generation, consumption, price, forecast.`)
 * rather than returning a silent empty list.
 */
export function filtersByGroup(group?: FilterGroup): FilterInfo[] {
  // A copy, like the filtered list: a caller that sorts or extends its result must not
  // reorder the catalogue every later call returns.
  if (group === undefined) return [...FILTERS];
  const wanted = assertArgument<FilterGroup>("group", canonicalToken("group", group), filterGroupProblem, String(group));
  return FILTERS.filter((f) => f.group === wanted);
}
