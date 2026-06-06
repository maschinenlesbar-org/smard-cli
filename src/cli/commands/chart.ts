import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, assertEnum, renderJson, requireInt } from "../shared.js";
import { RegionValues, ResolutionValues } from "../../client/enums.js";

export function registerChartCommands(program: Command, deps: CliDeps): void {
  program
    .command("timestamps <filter> <region> <resolution>")
    .description("List the available window timestamps for a series")
    .action(
      action(deps, async ({ client, global }, [filter, region, resolution]) => {
        const f = requireInt(filter!, "filter");
        const r = assertEnum(region!, RegionValues, "region");
        const res = assertEnum(resolution!, ResolutionValues, "resolution");
        renderJson(deps, global, await client.timestamps(f, r, res));
      }),
    );

  program
    .command("series <filter> <region> <resolution> <timestamp>")
    .description("Get one window's data (timestamp from `timestamps`)")
    .action(
      action(deps, async ({ client, global }, [filter, region, resolution, timestamp]) => {
        const f = requireInt(filter!, "filter");
        const r = assertEnum(region!, RegionValues, "region");
        const res = assertEnum(resolution!, ResolutionValues, "resolution");
        const ts = requireInt(timestamp!, "timestamp");
        renderJson(deps, global, await client.series(f, r, res, ts));
      }),
    );

  program
    .command("latest <filter> <region> <resolution>")
    .description("Get the newest available window's data in one call")
    .action(
      action(deps, async ({ client, global }, [filter, region, resolution]) => {
        const f = requireInt(filter!, "filter");
        const r = assertEnum(region!, RegionValues, "region");
        const res = assertEnum(resolution!, ResolutionValues, "resolution");
        renderJson(deps, global, await client.latest(f, r, res));
      }),
    );

  program
    .command("table <filter> <region> <timestamp>")
    .description("Get quarter-hour table_data for one window")
    .action(
      action(deps, async ({ client, global }, [filter, region, timestamp]) => {
        const f = requireInt(filter!, "filter");
        const r = assertEnum(region!, RegionValues, "region");
        const ts = requireInt(timestamp!, "timestamp");
        renderJson(deps, global, await client.tableData(f, r, ts));
      }),
    );
}
