import { test } from "node:test";
import assert from "node:assert/strict";
import { assertValid, type Problem } from "../src/client/validate.js";
import * as lib from "../src/index.js";
import { SmardError, SmardValidationError } from "../src/client/errors.js";
import { SmardClient } from "../src/client/client.js";
import { run } from "../src/cli/run.js";
import type { CliDeps } from "../src/cli/io.js";
import { parity, jsonResponse } from "./helpers.js";

const nonBlank: Problem<string> = (v) => (v.trim() === "" ? "Expected a non-empty value." : undefined);

test("assertValid returns a valid value unchanged", () => {
  assert.equal(assertValid("region", "DE", nonBlank), "DE");
});

test("assertValid throws SmardValidationError 'Invalid <name>: <reason>'", () => {
  assert.throws(
    () => assertValid("region", "  ", nonBlank),
    (err: unknown) =>
      err instanceof SmardValidationError &&
      err instanceof SmardError &&
      err.name === "SmardValidationError" &&
      err.message === "Invalid region: Expected a non-empty value.",
  );
});

test("the validation layer is exported from the package root", () => {
  assert.equal(lib.assertValid, assertValid);
  assert.equal(lib.SmardValidationError, SmardValidationError);
});

test("run() maps a SmardValidationError raised in an action to the usage exit 1, 'Error: <message>'", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    io: { out: (s) => out.push(s), err: (s) => err.push(s) },
    createClient: () => {
      throw new SmardValidationError("Invalid thing: Expected a non-empty value.");
    },
  };
  assert.equal(await run(["timestamps", "410", "DE", "hour"], deps), 1);
  assert.deepEqual(err, ["Error: Invalid thing: Expected a non-empty value."]);
  assert.deepEqual(out, []);
});

test("parity() runs one input through the CLI and the library on one recording transport", async () => {
  const { cli, lib: l } = await parity(
    ["--compact", "timestamps", "410", "DE", "hour"],
    (transport) => new SmardClient({ transport }).timestamps(410, "DE", "hour"),
    () => jsonResponse({ timestamps: [1700000000000] }),
  );
  assert.equal(cli.code, 0);
  assert.equal(cli.requests.length, 1);
  assert.equal(l.ok, true);
  assert.equal(l.requests.length, 1);
  assert.equal(cli.requests[0]!.url, l.requests[0]!.url);
  assert.deepEqual(JSON.parse(cli.out), l.ok ? l.value : undefined);
});
