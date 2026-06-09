# Developing & integrating

This document covers `smard-cli` as a **TypeScript library**, plus its
architecture, testing and release setup. If you just want to use the
command-line tool, start with the **[README](README.md)** and
**[Usage.md](Usage.md)** instead.

The package ships both a CLI (`smard`) and a typed API client (`SmardClient`)
for the [SMARD chart-data API](https://smard.api.bund.dev/) (`www.smard.de`).

**Design goals**

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed client surface, series shapes, and region/resolution enums.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only, no auth** — the SMARD chart-data API needs no key; this client only reads.

## Build from source

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the locally built CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link`:
smard --help
```

## Library usage

```ts
import { SmardClient, SmardApiError, FILTERS } from "@maschinenlesbar.org/smard-cli";

const client = new SmardClient(); // defaults to https://www.smard.de

const windows = await client.timestamps(410, "DE", "week"); // number[]
const data = await client.series(410, "DE", "week", windows.at(-1)!);
console.log(data.series.length, "points");

// Or in one call:
const latest = await client.latest(4068, "DE", "hour");

try {
  await client.series(410, "DE", "hour", 1);
} catch (err) {
  if (err instanceof SmardApiError) console.error(err.status, err.detail);
}
```

### Client options

```ts
new SmardClient({
  baseUrl: "https://www.smard.de",
  timeoutMs: 15_000,
  maxRetries: 3,              // 429 / 503 are retried with linear backoff
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",
  transport: customTransport, // inject your own HTTP transport
});
```

### Methods

`client.timestamps(filter, region, resolution)`, `client.series(filter, region, resolution, timestamp)`,
`client.latest(filter, region, resolution)`, `client.tableData(filter, region, timestamp)`.
The `FILTERS` array and the `RegionValues` / `ResolutionValues` enums are exported for reference.

> **Note for library callers:** `SmardClient` performs **no** validation of its
> `filter` / `region` / `resolution` / `timestamp` arguments — all input
> validation (non-negative integers, enum membership) lives in the CLI layer.
> The `Region` / `Resolution` types are compile-time hints only; an arbitrary
> string cast to `Region` is merely `encodeURIComponent`-escaped, not checked
> against `RegionValues`. Validate untrusted input yourself before calling.
>
> Likewise, the **response** types (`SeriesResult` / `TableResult`) are a typed
> **pass-through**: any successful (2xx) JSON body is parsed and returned cast to
> the method's return type without structural validation. The one exception is
> `timestamps()`, which validates that `timestamps` is an array (else throws
> `SmardParseError`). For `series` / `latest` / `tableData`, treat the typing as a
> convenience over the documented API shape, not a runtime guarantee.

## Architecture

```
src/
  client/
    enums.ts     # Region/Resolution value sets + the filter catalogue (FILTERS)
    types.ts     # response interfaces (TimestampIndex, SeriesResult, TableResult)
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, JSON/raw decoding, error mapping
    errors.ts    # SmardError / SmardApiError / SmardNetworkError / SmardParseError
    client.ts    # SmardClient — the chart-data surface over the engine
  cli/
    io.ts        # injectable I/O seam (stdout/stderr/file)
    shared.ts    # option parsers, global-option resolver, JSON renderer
    commands/    # chart (timestamps/series/latest/table) + catalogue commands
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
```

**Design notes**

- The HTTP layer is a single `Transport` function (`(req) => Promise<HttpResponse>`). The default
  uses `node:http`/`node:https`; tests inject a mock. This keeps the client free of any HTTP framework.
- The CLI is built around injectable `CliDeps` (client factory + I/O), so the whole program can be
  driven in-process by tests with a mocked client and captured output — no subprocesses.
- The API accepts any integer filter id, so the CLI accepts any integer and uses the `FILTERS`
  catalogue only for the `filters` listing and documentation.

### Library / technical terms

**API client.** [`SmardClient`](src/client/client.ts) — the typed wrapper over
the chart-data endpoints. Usable as a library independently of the CLI.

**Transport.** A single function `(HttpRequest) => Promise<HttpResponse>`
([`http.ts`](src/client/http.ts)). The default uses Node's built-in
`http`/`https`; tests inject a mock. This is the only HTTP seam.

**Request engine.** [`RequestEngine`](src/client/engine.ts) — builds URLs,
serialises queries, applies retry/backoff, decodes JSON/raw responses and maps
errors. Sits between the client and the transport.

**RawResponse.** The engine's raw result: `{ data: Buffer, contentType, status }`
— raw bytes, never lossily decoded.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object (`out`/`err`/…).
Lets the whole CLI run in tests with a mocked client and captured output — no
subprocess.

**Retry / backoff.** The engine automatically retries transient `429`
(rate-limited) and `503` responses with **linear** backoff, up to `--max-retries`
(default `2`). `SmardApiError.isRetryable` flags these statuses.

**maxResponseBytes.** A hard cap (default 100 MiB; `0` = unlimited) on response
body size, defending against memory exhaustion; a breach aborts the request with
`SmardResponseTooLargeError`.

**Error types.** [`errors.ts`](src/client/errors.ts): `SmardApiError` (non-2xx,
carries `status`/`detail`/`url`/`body`), `SmardNetworkError` (transport
failure/timeout), `SmardResponseTooLargeError` (size-cap breach, a subclass of
`SmardNetworkError`) and `SmardParseError` (bad JSON), all extending
`SmardError`. The CLI maps a `404` to exit code `4`, every other error to `1`.

**FILTERS / RegionValues / ResolutionValues.** The exported catalogue and const
value arrays — used for the `filters`/`regions`/`resolutions` listing commands
and as compile-time `Region`/`Resolution` union types. `FILTERS` is not
exhaustive: the API accepts any integer filter id.

**Validation boundary.** All input validation (non-negative integers, enum
membership) lives in the **CLI** layer. `SmardClient` performs **no** validation;
a `Region`/`Resolution` is a compile-time hint only, merely
`encodeURIComponent`-escaped, not checked against the value arrays.

**Typed pass-through.** Response types (`SeriesResult`, `TableResult`) are a
convenience typing over the documented shape, not a runtime guarantee. The one
exception is `timestamps()`, which checks that `timestamps` is an array (else
throws `SmardParseError`).

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry — mocked transport.
- **`client.test.ts`** — every method's URL mapping, including the `latest` index→data flow — mocked transport.
- **`cli.test.ts`** — end-to-end command parsing, validation and exit codes — mocked client.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build TypeDoc API docs and deploy to GitHub Pages on each `v*` tag.

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
