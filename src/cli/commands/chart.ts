import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, renderJson, requireInt } from "../shared.js";
import { assertRegion, assertResolution } from "../../client/validate.js";

// Each action parses its positionals in argument order (filter, region, resolution,
// timestamp) with the library's own checks, so the first bad argument is the one
// reported; the client method then checks them again before its request.
export function registerChartCommands(program: Command, deps: CliDeps): void {
  program
    .command("timestamps <filter> <region> <resolution>")
    .description("List the available window timestamps for a series")
    .action(
      action(deps, async ({ client, global }, [filter, region, resolution]) => {
        const f = requireInt(filter!, "filter");
        const r = assertRegion(region);
        const res = assertResolution(resolution);
        renderJson(deps, global, await client.timestamps(f, r, res));
      }),
    );

  program
    .command("series <filter> <region> <resolution> <timestamp>")
    .description("Get one window's data (timestamp from `timestamps`)")
    .action(
      action(deps, async ({ client, global }, [filter, region, resolution, timestamp]) => {
        const f = requireInt(filter!, "filter");
        const r = assertRegion(region);
        const res = assertResolution(resolution);
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
        const r = assertRegion(region);
        const res = assertResolution(resolution);
        renderJson(deps, global, await client.latest(f, r, res));
      }),
    );

  program
    .command("table <filter> <region> <timestamp>")
    .description(
      "Get quarter-hour table_data for one window (SMARD has none for windows from late 2024 on: expect a 404)",
    )
    .action(
      action(deps, async ({ client, global }, [filter, region, timestamp]) => {
        const f = requireInt(filter!, "filter");
        const r = assertRegion(region);
        const ts = requireInt(timestamp!, "timestamp");
        renderJson(deps, global, await client.tableData(f, r, ts));
      }),
    );
}
