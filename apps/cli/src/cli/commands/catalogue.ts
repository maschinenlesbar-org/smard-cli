import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, once } from "../shared.js";
import { renderJson } from "../output.js";
import { FilterGroupValues, RegionValues, ResolutionValues, type FilterGroup } from "@maschinenlesbar.org/smard-client/internal/enums";
import { filtersByGroup } from "@maschinenlesbar.org/smard-client/internal/catalogue";

export function registerCatalogueCommands(program: Command, deps: CliDeps): void {
  program
    .command("filters")
    .description("List the documented chart-data filter ids")
    .option(
      "--group <group>",
      `only show one group: ${FilterGroupValues.join("|")}`,
      once("--group", (value: string) => value),
    )
    .action(
      action(deps, async ({ global, opts }) => {
        renderJson(deps, global, filtersByGroup(opts["group"] as FilterGroup | undefined));
      }, { makesRequests: false }),
    );

  program
    .command("regions")
    .description("List the valid region codes")
    .action(
      action(deps, async ({ global }) => {
        renderJson(deps, global, [...RegionValues]);
      }, { makesRequests: false }),
    );

  program
    .command("resolutions")
    .description("List the valid resolution values")
    .action(
      action(deps, async ({ global }) => {
        renderJson(deps, global, [...ResolutionValues]);
      }, { makesRequests: false }),
    );
}
