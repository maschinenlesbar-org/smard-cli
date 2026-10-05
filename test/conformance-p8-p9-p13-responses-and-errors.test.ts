// Conformance test P8 + P9 + P13 (fix plan 2026-10-06): a body is decoded by its declared
// charset (P8); a 2xx body without the documented shape is a parse error, never data or
// "nothing found" (P9); every rejected input is the library's validation error, never a raw
// TypeError or RangeError (P13). Shared across the *-cli repos; only the adapter differs.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpResponse } from "../src/client/http.js";

// ---- adapter (per repo) -------------------------------------------------------------
import { SmardClient as Client } from "../src/client/client.js";
import {
  SmardError as BaseError,
  SmardParseError as ParseError,
  SmardValidationError as ValidationError,
} from "../src/client/errors.js";
import type { Region, Resolution } from "../src/client/enums.js";
/**
 * A call whose answer contains a text field, and how to read that field from the result.
 * SMARD's data files carry no text; `meta_data` is passed through as served, so the text
 * rides there.
 */
const textCall = (client: Client): Promise<unknown> => client.series(410, "DE", "hour", 1700000000000);
const textBody = (text: string): unknown => ({ meta_data: { version: 1, created: 2, note: text }, series: [[1700000000000, 1]] });
const readText = (result: unknown): string => (result as { meta_data: { note: string } }).meta_data.note;
/** 2xx bodies the call must reject (error envelopes, empty or wrong shapes). */
const malformedBodies: unknown[] = [
  null,
  {},
  [],
  "text",
  42,
  { error: "maintenance", series: null },
  { message: "Not available" },
  { meta_data: {}, series: "oops" },
  { meta_data: {}, series: [[1, "12.5"]] },
  { meta_data: {}, series: [[2]] },
  { meta_data: {}, series: [null] },
];
/** Library calls with wrong-typed or out-of-range input. */
const badCalls: Array<[string, () => unknown]> = [
  ["timestamps('410', …)", () => new Client().timestamps("410" as unknown as number, "DE", "hour")],
  ["timestamps(410n, …)", () => new Client().timestamps(410n as unknown as number, "DE", "hour")],
  ["timestamps(-1, …)", () => new Client().timestamps(-1, "DE", "hour")],
  ["timestamps(410, 'de', …)", () => new Client().timestamps(410, "de" as Region, "hour")],
  ["timestamps(410, 5, …)", () => new Client().timestamps(410, 5 as unknown as Region, "hour")],
  ["timestamps(410, 'DE', null)", () => new Client().timestamps(410, "DE", null as unknown as Resolution)],
  ["series(…, 1.5)", () => new Client().series(410, "DE", "hour", 1.5)],
  ["series(…, {})", () => new Client().series(410, "DE", "hour", {} as unknown as number)],
  ["tableData(…, NaN)", () => new Client().tableData(410, "DE", Number.NaN)],
  ["latest(null, …)", () => new Client().latest(null as unknown as number, "DE", "hour")],
  ["timeoutMs: 'x'", () => new Client({ timeoutMs: "x" as unknown as number })],
  ["timeoutMs: -1", () => new Client({ timeoutMs: -1 })],
  ["maxRetries: 1.5", () => new Client({ maxRetries: 1.5 })],
  ["retryDelayMs: 3e9", () => new Client({ retryDelayMs: 3_000_000_000 })],
  ["maxResponseBytes: -1", () => new Client({ maxResponseBytes: -1 })],
  ["baseUrl: 5", () => new Client({ baseUrl: 5 as unknown as string })],
  ["userAgent: {}", () => new Client({ userAgent: {} as unknown as string })],
  ["transport: 'x'", () => new Client({ transport: "x" as unknown as never })],
  ["sleep: 5", () => new Client({ sleep: 5 as unknown as never })],
];
// --------------------------------------------------------------------------------------

const respond = (body: Buffer, contentType: string) => async (): Promise<HttpResponse> => ({
  status: 200,
  headers: { "content-type": contentType },
  body,
});

test("P8: a body is decoded by its declared charset", async () => {
  const text = "Müller µg/l";
  for (const [charset, encoding] of [["iso-8859-1", "latin1"], ["utf-8", "utf8"]] as const) {
    const body = Buffer.from(JSON.stringify(textBody(text)), encoding);
    const client = new Client({ transport: respond(body, `application/json; charset=${charset}`) });
    assert.equal(readText(await textCall(client)), text, charset);
  }
});

test("P9: a 2xx body without the documented shape is a parse error", async () => {
  for (const body of malformedBodies) {
    const client = new Client({ transport: respond(Buffer.from(JSON.stringify(body)), "application/json"), maxRetries: 0 });
    await assert.rejects(textCall(client), ParseError, `body ${JSON.stringify(body)}`);
  }
  for (const raw of ["", "<html>maintenance</html>"]) {
    const client = new Client({ transport: respond(Buffer.from(raw), "text/html"), maxRetries: 0 });
    await assert.rejects(textCall(client), BaseError, `raw ${JSON.stringify(raw)}`);
  }
});

test("P13: every rejected input is the validation error, never a raw TypeError", async () => {
  for (const [label, fn] of badCalls) {
    await assert.rejects(async () => fn(), (e: unknown) => e instanceof ValidationError, label);
  }
});
