import { test } from "node:test";
import assert from "node:assert/strict";
import * as lib from "../src/index.js";
import { FILTERS, FilterGroupValues } from "@maschinenlesbar.org/smard-client/internal/enums";
import { filtersByGroup } from "@maschinenlesbar.org/smard-client/internal/catalogue";
import { oneOfProblem } from "@maschinenlesbar.org/smard-client/internal/validate";
import { SmardValidationError } from "@maschinenlesbar.org/smard-client/internal/errors";
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

test("filtersByGroup takes a group as a token: trimmed and NFC, case kept (D8)", () => {
  assert.deepEqual(filtersByGroup(" price " as never), filtersByGroup("price"));
});

test("filtersByGroup refuses an invisible or control character, showing it escaped (D8, D10)", () => {
  for (const [bad, shown] of [["pr\u200bice", "pr\\u200bice"], ["price\u00ad", "price\\u00ad"], ["\u202eprice", "\\u202eprice"]]) {
    assert.throws(
      () => filtersByGroup(bad as never),
      (err: unknown) => err instanceof SmardValidationError && err.message.includes(shown!) && !err.message.includes(bad!),
      shown,
    );
  }
  assert.throws(() => filtersByGroup("" as never), { message: "Invalid group: Expected a non-empty value." });
  assert.throws(() => filtersByGroup("\u200b" as never), { message: "Invalid group: Expected a non-empty value." });
});

test("filtersByGroup rejects an unknown group with SmardValidationError", () => {
  for (const bad of ["Price", "bogus", "constructor"]) {
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
  for (const group of ["price", "forecast", "Price", " price", "", "bogus", "pr\u200bice"]) {
    const { cli, lib: l } = await parity(["--compact", "filters", "--group", group], () =>
      filtersByGroup(group as never),
    );
    assert.equal(cli.requests.length + l.requests.length, 0);
    if (l.ok) {
      assert.equal(cli.code, 0, group);
      assert.deepEqual(JSON.parse(cli.out), l.value, group);
    } else {
      assert.equal(cli.code, 1, group);
      assert.equal(cli.err, `ERROR [smard.cli] ${(l.error as Error).message}`, group);
    }
  }
});

test("filtersByGroup() hands out a copy: sorting the result never reorders the catalogue", () => {
  const first = FILTERS[0];
  const all = filtersByGroup();
  assert.notEqual(all, FILTERS);
  all.sort((a, b) => a.label.localeCompare(b.label));
  all.push({ ...first!, id: -1 });
  assert.equal(FILTERS[0], first);
  assert.equal(filtersByGroup()[0], first);
  assert.ok(!filtersByGroup().some((f) => f.id === -1));
});
