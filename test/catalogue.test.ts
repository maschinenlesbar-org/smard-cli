import { test } from "node:test";
import assert from "node:assert/strict";
import * as lib from "../src/index.js";
import { FILTERS, FilterGroupValues } from "../src/client/enums.js";
import { filtersByGroup } from "../src/client/catalogue.js";
import { oneOfProblem } from "../src/client/validate.js";
import { SmardValidationError } from "../src/client/errors.js";
import { parity } from "./helpers.js";

test("FilterGroupValues lists the four groups and covers every FILTERS entry", () => {
  assert.deepEqual([...FilterGroupValues], ["generation", "consumption", "price", "forecast"]);
  assert.ok(FILTERS.every((f) => (FilterGroupValues as readonly string[]).includes(f.group)));
  assert.equal(lib.filtersByGroup, filtersByGroup);
  assert.equal(lib.FilterGroupValues, FilterGroupValues);
});

test("oneOfProblem names the allowed values", () => {
  const p = oneOfProblem(["a", "b"]);
  assert.equal(p("a"), undefined);
  for (const bad of ["A", " a", "", "c", 1, undefined, "constructor"]) {
    assert.equal(p(bad), "Expected one of: a, b.", String(bad));
  }
});

test("filtersByGroup returns the whole catalogue without a group, else one group", () => {
  assert.deepEqual(filtersByGroup(), FILTERS);
  assert.deepEqual(filtersByGroup(undefined), FILTERS);
  const price = filtersByGroup("price");
  assert.equal(price.length, 15);
  assert.ok(price.every((f) => f.group === "price"));
});

test("filtersByGroup rejects an unknown group with SmardValidationError", () => {
  for (const bad of ["Price", " price", "", "bogus", "constructor"]) {
    assert.throws(
      () => filtersByGroup(bad as never),
      (err: unknown) =>
        err instanceof SmardValidationError &&
        err.message === `Invalid group "${bad}". Expected one of: generation, consumption, price, forecast.`,
      bad,
    );
  }
});

test("parity: filters --group gives the same result as filtersByGroup()", async () => {
  for (const group of ["price", "forecast", "Price", " price", "", "bogus"]) {
    const { cli, lib: l } = await parity(["--compact", "filters", "--group", group], () =>
      filtersByGroup(group as never),
    );
    assert.equal(cli.requests.length + l.requests.length, 0);
    if (l.ok) {
      assert.equal(cli.code, 0, group);
      assert.deepEqual(JSON.parse(cli.out), l.value, group);
    } else {
      assert.equal(cli.code, 1, group);
      assert.equal(cli.err, `Error: ${(l.error as Error).message}`, group);
    }
  }
});
