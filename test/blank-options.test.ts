import { test } from "node:test";
import assert from "node:assert/strict";
import { RequestEngine, baseUrlProblem } from "../src/client/engine.js";
import * as lib from "../src/index.js";
import { SmardClient } from "../src/client/client.js";
import { SmardError, SmardValidationError } from "../src/client/errors.js";
import { jsonResponse, makeMockTransport, parity } from "./helpers.js";

const ok = () => jsonResponse({ timestamps: [1700000000000] });

test("baseUrlProblem rejects a blank or whitespace-padded base URL", () => {
  assert.equal(baseUrlProblem("https://mirror.example/"), undefined);
  assert.equal(baseUrlProblem(""), "Expected an absolute http(s) URL.");
  assert.equal(baseUrlProblem("   "), "Expected an absolute http(s) URL.");
  for (const bad of ["https://mirror.example/ ", " https://mirror.example", "https://x.test\t"]) {
    assert.equal(baseUrlProblem(bad), "A base URL cannot have surrounding whitespace.", JSON.stringify(bad));
  }
  assert.equal(lib.baseUrlProblem, baseUrlProblem);
});

test("the engine rejects a blank or padded baseUrl and a blank userAgent; only undefined means the default", async () => {
  const cases: [Record<string, string>, string][] = [
    [{ baseUrl: "" }, "Invalid baseUrl: Expected an absolute http(s) URL."],
    [{ baseUrl: "  " }, "Invalid baseUrl: Expected an absolute http(s) URL."],
    [{ baseUrl: "https://mirror.example/ " }, "Invalid baseUrl: A base URL cannot have surrounding whitespace."],
    [{ baseUrl: " https://mirror.example " }, "Invalid baseUrl: A base URL cannot have surrounding whitespace."],
    [{ userAgent: "" }, "Invalid userAgent: Expected a non-empty value."],
    [{ userAgent: "   " }, "Invalid userAgent: Expected a non-empty value."],
  ];
  for (const [opts, message] of cases) {
    const mt = makeMockTransport(ok);
    assert.throws(
      () => new RequestEngine({ transport: mt.transport, ...opts }),
      (e: unknown) => e instanceof SmardValidationError && e.message === message,
      JSON.stringify(opts),
    );
    assert.equal(mt.calls.length, 0);
  }
  const mt = makeMockTransport(ok);
  await new RequestEngine({ transport: mt.transport, baseUrl: undefined, userAgent: undefined }).getJson("/x");
  assert.equal(mt.last().url, "https://www.smard.de/x");
  assert.equal(mt.last().headers?.["User-Agent"], "smard-cli");
});

test("parity: blank or padded --base-url and a blank --user-agent are rejected on both sides with no request", async () => {
  const cases: [string[], Record<string, string>][] = [
    [["--base-url", "https://mirror.example/ "], { baseUrl: "https://mirror.example/ " }],
    [["--base-url", " https://mirror.example "], { baseUrl: " https://mirror.example " }],
    [["--base-url", ""], { baseUrl: "" }],
    [["--user-agent", ""], { userAgent: "" }],
    [["--user-agent", "  "], { userAgent: "  " }],
  ];
  for (const [flags, opts] of cases) {
    const { cli, lib: l } = await parity(
      ["--compact", ...flags, "timestamps", "410", "DE", "hour"],
      (transport) => new SmardClient({ transport, ...opts }).timestamps(410, "DE", "hour"),
      ok,
    );
    const label = JSON.stringify(flags);
    assert.equal(cli.code, 1, label);
    assert.equal(cli.requests.length, 0, label);
    assert.ok(!l.ok && l.error instanceof SmardError, label);
    assert.equal(l.requests.length, 0, label);
    const reason = (l as { error: Error }).error.message.replace(/^Invalid \w+: /, "");
    assert.ok(cli.err.includes(reason), `${label}: ${cli.err}`);
  }
  const { cli, lib: l } = await parity(
    ["--compact", "--base-url", "https://mirror.example/", "timestamps", "410", "DE", "hour"],
    (transport) => new SmardClient({ transport, baseUrl: "https://mirror.example/" }).timestamps(410, "DE", "hour"),
    ok,
  );
  assert.equal(cli.code, 0);
  assert.ok(l.ok);
  assert.equal(cli.requests[0]!.url, "https://mirror.example/app/chart_data/410/DE/index_hour.json");
  assert.equal(l.requests[0]!.url, cli.requests[0]!.url);
});
