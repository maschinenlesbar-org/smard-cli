import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, renderJson } from "../shared.js";
import { FilterGroupValues, RegionValues, ResolutionValues, type FilterGroup } from "../../client/enums.js";
import { filtersByGroup } from "../../client/catalogue.js";

export function registerCatalogueCommands(program: Command, deps: CliDeps): void {
  program
    .command("filters")
    .description("List the documented chart-data filter ids")
    .option("--group <group>", `only show one group: ${FilterGroupValues.join("|")}`)
    .action(
      action(deps, async ({ global, opts }) => {
        renderJson(deps, global, filtersByGroup(opts["group"] as FilterGroup | undefined));
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
