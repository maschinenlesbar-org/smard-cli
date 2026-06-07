import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, assertEnum, renderJson } from "../shared.js";
import { FILTERS, RegionValues, ResolutionValues } from "../../client/enums.js";

const FILTER_GROUPS = ["generation", "consumption", "price", "forecast"] as const;

export function registerCatalogueCommands(program: Command, deps: CliDeps): void {
  program
    .command("filters")
    .description("List the documented chart-data filter ids")
    .option("--group <group>", "only show one group: generation|consumption|price|forecast")
    .action(
      action(deps, async ({ global, opts }) => {
        const raw = opts["group"] as string | undefined;
        const group = raw === undefined ? undefined : assertEnum(raw, FILTER_GROUPS, "group");
        const filters = group ? FILTERS.filter((f) => f.group === group) : FILTERS;
        renderJson(deps, global, filters);
      }),
    );

  program
    .command("regions")
    .description("List the valid region codes")
    .action(
      action(deps, async ({ global }) => {
        renderJson(deps, global, [...RegionValues]);
      }),
    );

  program
    .command("resolutions")
    .description("List the valid resolution values")
    .action(
      action(deps, async ({ global }) => {
        renderJson(deps, global, [...ResolutionValues]);
      }),
    );
}
