# smard-cli

A TypeScript **API client** and **command-line interface** for the open
[SMARD](https://smard.api.bund.dev/) chart-data API (`smard.de`) operated by the
**Bundesnetzagentur** — German electricity-market data: **generation**,
**consumption / residual load**, and **wholesale prices**.

- **Zero runtime HTTP dependencies** — built on Node's built-in `http`/`https` (no axios, no fetch polyfill).
- **One small dependency** for the CLI: [`commander`](https://github.com/tj/commander.js).
- **Strongly typed** — typed client surface, series shapes, and region/resolution enums.
- **Well tested** — unit tests on Node's built-in test runner (`node --test`), every HTTP response mocked.
- **Read-only, no auth** — the SMARD chart-data API needs no key; this client only reads.

New to SMARD, or terms like *filter*, *bidding zone*, *residual load* or
*resolution*? See **[GLOSSARY.md](GLOSSARY.md)** for the domain concepts and the
project's own vocabulary.

## Requirements

- Node.js **>= 20** (uses the stable built-in test runner, ESM and top-level `await`).

## Install

```bash
npm install
npm run build        # compiles TypeScript to dist/
```

Run the CLI without a global install:

```bash
node dist/src/cli/index.js --help
# or, after `npm link` / global install:
smard --help
```

---

## How the API works

SMARD publishes a static file tree. For a **(filter, region, resolution)** triple
it offers an **index** of available window timestamps, and one **data file** per
timestamp. Each data file covers a fixed window (e.g. one week of hourly values),
so to get the newest data you read the index, take the last timestamp, then fetch
that file. The `latest` command does that for you in one call.

- **filter** — a numeric series id (see `smard filters`), e.g. `410` = total grid load.
- **region** — see `smard regions`, e.g. `DE`, `DE-LU`, `TenneT`.
- **resolution** — `hour | quarterhour | day | week | month | year`.
- **timestamp** — an epoch-millisecond value from `smard timestamps`.

### Global options

| Option | Description |
| --- | --- |
| `--base-url <url>` | API base URL (default `https://www.smard.de`) |
| `--timeout <ms>` | Per-request timeout (default `30000`; `0` = no timeout) |
| `--user-agent <ua>` | `User-Agent` header value |
| `--max-retries <n>` | Retries for transient `429`/`503` responses (default `2`) |
| `--max-response-bytes <n>` | Cap response body size in bytes (`0` = unlimited; default 100 MiB) |
| `--compact` | Print JSON on a single line |

Global options may be passed **before or after** the command (commander resolves
them either way), e.g. `smard --compact latest 410 DE hour` or
`smard latest 410 DE hour --compact`. Placing them before the command is the
conventional, recommended position.

### Commands

```text
timestamps <filter> <region> <resolution>              available window timestamps
series     <filter> <region> <resolution> <timestamp>  one window's data
latest     <filter> <region> <resolution>              newest window's data (one call)
table      <filter> <region> <timestamp>               quarter-hour table_data (see note)
filters    [--group generation|consumption|price|forecast]   filter catalogue
regions                                                 valid region codes
resolutions                                             valid resolution values
```

> **Note on `table` timestamps:** the `table` command reads from `table_data`,
> whose valid window timestamps are **not** the same set returned by the
> `timestamps` command (which lists `chart_data` windows). There is no discovery
> endpoint for `table_data` timestamps in the public API, so a `table` call may
> `404` for a timestamp that is valid for `series`/`latest`.

### Examples

```bash
# Which filters exist? (just the consumption ones)
smard filters --group consumption

# Newest week of total grid load for Germany
smard latest 410 DE week

# Newest hour-resolution photovoltaic generation, compact
smard --compact latest 4068 DE hour

# Pick a specific window explicitly. The available timestamps roll over time, so
# read one from `timestamps` rather than hard-coding a value (older windows 404).
smard timestamps 4169 DE-LU hour          # -> [ ..., <some valid timestamp> ]
TS=$(smard --compact timestamps 4169 DE-LU hour | python3 -c 'import json,sys; print(json.load(sys.stdin)[-1])')
smard series 4169 DE-LU hour "$TS"
```

Exit codes: `0` success, `4` on a `404` from the API, `1` for any other error,
non-zero for usage errors. Network errors, timeouts, parse errors and non-404 API
statuses (e.g. `500`/`503`) **deliberately** all map to `1`; only `404` is given a
distinct code. If you script against this CLI, treat any non-zero, non-`4` code as
a generic failure rather than expecting per-cause granularity.

---

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

---

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

---

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

**Dual-licensed** — use it under **either**:

- **[AGPL-3.0-or-later](LICENSE)** (default, free). Note the AGPL's §13 network
  clause: if you run a modified version as a network service, you must offer that
  modified source to the service's users.
- **Commercial license** (paid), for closed-source / proprietary or SaaS use
  without the AGPL's obligations.

See **[LICENSING.md](LICENSING.md)** for details, and **[CONTRIBUTING.md](CONTRIBUTING.md)**
for the contribution policy (this project does not accept external code
contributions). Commercial enquiries: **sebs@2xs.org**.
