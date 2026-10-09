import type { Command } from "commander";
import type { CliDeps } from "../io.js";
import { action, renderJson, requireInt } from "../shared.js";
import { assertRegion, assertResolution } from "../../client/validate.js";

// Each command parses its positionals in argument order (filter, region, resolution,
// timestamp) with the library's own checks, so the first bad argument is the one
// reported; the client method then checks them again before its request. The parse runs
// before the cleartext warning (`action()`), so a bad argument is the run's only record.

/** `<filter> <region> <resolution>`. */
function seriesKey([filter, region, resolution]: string[]) {
  return { f: requireInt(filter!, "filter"), r: assertRegion(region), res: assertResolution(resolution) };
}

/** `<filter> <region> <resolution> <timestamp>`. */
function windowKey(positionals: string[]) {
  const key = seriesKey(positionals);
  return { ...key, ts: requireInt(positionals[3]!, "timestamp") };
}

/** `<filter> <region> <timestamp>` (table_data has no resolution). */
function tableKey([filter, region, timestamp]: string[]) {
  return { f: requireInt(filter!, "filter"), r: assertRegion(region), ts: requireInt(timestamp!, "timestamp") };
}

export function registerChartCommands(program: Command, deps: CliDeps): void {
  program
    .command("timestamps <filter> <region> <resolution>")
    .description("List the available window timestamps for a series")
    .action(
      action(deps, async ({ client, global }, { f, r, res }) => {
        renderJson(deps, global, await client.timestamps(f, r, res));
      }, { parse: seriesKey }),
    );

  program
    .command("series <filter> <region> <resolution> <timestamp>")
    .description("Get one window's data (timestamp from `timestamps`)")
    .action(
      action(deps, async ({ client, global }, { f, r, res, ts }) => {
        renderJson(deps, global, await client.series(f, r, res, ts));
      }, { parse: windowKey }),
    );

  program
    .command("latest <filter> <region> <resolution>")
    .description("Get the newest available window's data in one call")
    .action(
      action(deps, async ({ client, global }, { f, r, res }) => {
        renderJson(deps, global, await client.latest(f, r, res));
      }, { parse: seriesKey }),
    );

  program
    .command("table <filter> <region> <timestamp>")
    .description(
      "Get quarter-hour table_data for one window (SMARD has none for windows from late 2024 on: expect a 404)",
    )
    .action(
      action(deps, async ({ client, global }, { f, r, ts }) => {
        renderJson(deps, global, await client.tableData(f, r, ts));
      }, { parse: tableKey }),
    );
}
