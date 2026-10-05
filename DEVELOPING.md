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
  timeoutMs: 15_000,          // 0..MAX_TIMEOUT_MS (0 = no timeout)
  maxRetries: 3,              // 0..MAX_RETRIES (10); 429 / 503 are retried (Retry-After, else linear backoff)
  maxResponseBytes: 50 << 20, // abort responses larger than 50 MiB (0 = unlimited)
  userAgent: "my-app/1.0",    // a header value: no control characters, nothing above U+00FF
  transport: customTransport, // inject your own HTTP transport
});
```

### Methods

`client.timestamps(filter, region, resolution)`, `client.series(filter, region, resolution, timestamp)`,
`client.latest(filter, region, resolution)`, `client.tableData(filter, region, timestamp)`.
The `FILTERS` array and the `RegionValues` / `ResolutionValues` / `FilterGroupValues` enums are
exported for reference; `filtersByGroup(group?)` returns the catalogue or one group of it (what
`smard filters --group` prints) and throws `SmardValidationError` for an unknown group instead of
returning an empty list.

> **Input checks.** Every `SmardClient` method checks its arguments before any
> request: `filter` and `timestamp` must be non-negative safe integers (so `-1`,
> `1.5`, `NaN`, `Infinity`, a string or an integer beyond `Number.MAX_SAFE_INTEGER`,
> which would be rounded to another file, are refused), `region` must be one of
> `RegionValues` and `resolution` one of `ResolutionValues` (exact case, no padding).
> A bad argument rejects with `SmardValidationError` — the same message the CLI
> prints, e.g. `Invalid region "de". Expected one of: DE, AT, …` — and sends no
> request, so a typo is never mistaken for SMARD's "no data" 404. The rules are
> exported (`nonNegativeIntegerProblem`, `regionProblem`, `resolutionProblem`,
> `assertId`, `assertRegion`, `assertResolution`) and the CLI calls the same ones.
> Every argument is still `encodeURIComponent`-escaped and the engine's `buildUrl`
> refuses a `.` / `..` segment, as defence in depth.
>
> Likewise, every **response** is checked against its documented shape, because
> SMARD answers a triple or window without data with a 404 — never with an empty or
> absent file — so any other 2xx body is an error page or a changed format, and a
> `SmardParseError` (CLI exit 1), never data:
>
> - `timestamps()`: a JSON object with a `timestamps` array of safe integers.
> - `series()` / `latest()` (`checkSeriesResult`): `{"meta_data": {…}, "series":
>   [[epochMs, number|null], …]}` — every point a two-element array of a
>   non-negative safe-integer timestamp and a finite number or `null`. `null`, `{}`,
>   an error object, string values (`"80"`, which jq sorts above every number) and
>   short or long tuples are refused.
> - `tableData()` (`checkTableResult`): `{"meta_data": {…}, "series": [{"values":
>   [{"timestamp": epochMs, "versions": [{"value": number|null, …}]}]}]}`; extra keys
>   (a version's `info`) are kept.
>
> `latest()` on an index that lists no windows throws a `SmardError` rather than
> returning a made-up empty result.

## Architecture

```
src/
  client/
    enums.ts     # Region/Resolution value sets + the filter catalogue (FILTERS)
    types.ts     # response interfaces (TimestampIndex, SeriesResult, TableResult)
    query.ts     # dependency-free query-string builder
    http.ts      # the Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, JSON/raw decoding, error mapping
    errors.ts    # SmardError / SmardApiError / SmardNetworkError / SmardParseError / SmardValidationError
    validate.ts  # input rules (Problem functions) + assertValid, shared with the CLI
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
- The API accepts any integer filter id, so the client and the CLI accept any non-negative integer
  and use the `FILTERS` catalogue only for the `filters` listing and documentation.
- **Network policy.** Redirects are **never followed** (a deliberate blueprint
  divergence): any `3xx` falls into the non-2xx branch and surfaces as a
  `SmardApiError`, so there is no cross-origin hop on which anything could leak
  (and, being keyless, nothing to leak). The base-URL rules live in one place,
  the library's `baseUrlProblem` / `validateBaseUrl` (`engine.ts`), checked on the
  value as passed: an absolute URL, an `http:`/`https:` scheme, no query (`?`) or
  fragment (`#`) (the API path is appended to it as a string), no surrounding
  whitespace, and no `%` in the userinfo that isn't an escape (a literal `%` is
  written `%25`; Node would fail every request with "URI malformed"). The `RequestEngine` constructor throws a `SmardValidationError` for
  a bad base URL — a configuration error, not a `SmardNetworkError` — so a library
  caller's custom `Transport` never receives one, and the `--base-url` option
  parser (`parseBaseUrl`) calls the same rule to make it a usage error at parse
  time. The default transport (`http.ts`) still checks the scheme of every request
  URL (`SmardNetworkError`). Userinfo (`https://user:pw@mirror`) is kept and sent
  as Basic auth, but `redactUrl` shows it as `***` in every error message and in
  `SmardApiError.url`, and no base-URL rejection echoes the value.
- **Output redaction (CLI).** Commander repeats a rejected option value in its usage
  error (`option '--base-url <url>' argument '…' is invalid`), and the CLI's own
  messages echo rejected arguments. `run()` therefore starts with
  `withRedactedOutput(deps, argv)`: it collects the exact userinfo of every argv
  token and of the value part of `--opt=value` tokens (`credentialsIn`, which also
  finds it in values that don't parse as a URL and in scheme-less `user:pw@host`),
  and every line printed on stdout or stderr has those strings replaced by `***`
  (`redactCredentials`), with a pattern-based backstop. A pattern alone can't
  delimit a password that holds a space, quote, `#`, `?` or `/`; the exact strings
  can. `test/conformance-p1-cli-redaction.test.ts` checks ten such passwords in
  seven URL shapes on every echo path.

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
— raw bytes, never lossily decoded. `getJson` decodes them by the charset the
`Content-Type` names (UTF-8 when it names none; SMARD sends none) with
`TextDecoder`, which drops a leading byte order mark; an unknown charset label is a
`SmardParseError`.

**Closed pipes.** The bin shim installs `handleOutputErrors()` (`io.ts`) before
`run()`: an EPIPE on stdout (`| head`) exits 0 quietly, an EPIPE on stderr is
ignored so a failed run keeps its exit code, and any other stdout error prints one
`Output error:` line and exits 1. `test/conformance-p7-pipes-exit-codes.test.ts`
runs the built bin to check it.

**CliDeps / CliIO.** The dependency-injection seam for the CLI
([`io.ts`](src/cli/io.ts)): a client factory plus an I/O object (`out`/`err`/…).
Lets the whole CLI run in tests with a mocked client and captured output — no
subprocess.

**Retry / backoff.** The engine automatically retries transient `429`
(rate-limited) and `503` responses, and connections reset mid-request
(`ECONNRESET`, `EPIPE`, `ECONNABORTED`, undici's `UND_ERR_SOCKET`, anywhere in the
error's `cause` chain), up to `maxRetries` / `--max-retries` (default
`2`; an integer from `0` to `MAX_RETRIES`, 10 — the engine rejects anything else
with `SmardValidationError`, and the CLI's parser uses the same constant). Each
retry waits `retryDelayMs * attempt` (linear backoff, `retryDelayMs` an integer
`0`–`30000`, default `200`), or the response's `Retry-After` — delay-seconds or an
IMF-fixdate HTTP-date, parsed by `parseRetryAfter` — when that is longer: the
header can lengthen a wait, never shorten it, so `Retry-After: 0` or a date in the
past never makes a zero-delay burst. A `Retry-After` longer than
`MAX_RETRY_AFTER_MS` (30 s) is not retried: the `SmardApiError` surfaces at once,
says "the server asked to retry after N s, longer than the 30 s the client waits;
not retried" and carries `retryAfterMs`. After spent retries the message ends
"(after N retries)" and `SmardApiError.retries` holds the count.
`SmardApiError.isRetryable` flags these statuses
(`test/conformance-p6-retry-policy.test.ts`).

**maxResponseBytes.** A hard cap (default 100 MiB; `0` = unlimited) on response
body size, defending against memory exhaustion; a breach aborts the request with
`SmardResponseTooLargeError`, whose message names `maxResponseBytes` and
`--max-response-bytes`.

**The transport contract (engine-enforced).** The engine holds the documented
limits for any transport, not only the built-in one
(`test/conformance-p5-transport-contract.test.ts`): it runs every call under the
`timeoutMs` deadline and passes an `AbortSignal` in `HttpRequest.signal` (a `fetch`
transport hands it on; the call rejects at the deadline either way), checks
`maxResponseBytes` on the body a transport returns, reads headers from a plain
object in any case, a `fetch` `Headers` or a `Map`, accepts any `ArrayBuffer` view
or `ArrayBuffer` as the body (by internal slot, so from any realm), and turns a
malformed response (no integer status 100–599, no headers object, no byte body)
or anything thrown into a `SmardNetworkError`.

**Engine option bounds.** The `RequestEngine` constructor (so `new SmardClient`)
checks every numeric option that is set and throws `SmardValidationError` for a
value out of range: `timeoutMs` an integer from `0` to `MAX_TIMEOUT_MS`,
`maxRetries` from `0` to `MAX_RETRIES`, `retryDelayMs` from `0` to
`MAX_RETRY_AFTER_MS` (30 000), `maxResponseBytes` a non-negative integer. `-1`, `NaN`, `1.5` or `Infinity` would otherwise silently
switch off the timeout or the size cap, or retry without bound. `undefined` keeps
the default, and `0` keeps its documented meaning. A `userAgent` must be a valid
header value (`headerValueProblem`: no C0 control character other than tab — so
no CR/LF — no DEL, nothing above U+00FF); the constructor rejects anything else
with `SmardValidationError`, whatever the transport, and the CLI's `--user-agent`
parser applies the same rule. Should Node's HTTP layer still refuse a header, the
default transport rejects with a `SmardNetworkError`, never a raw `TypeError`.

**Blank options.** Only `undefined` selects a default (`DEFAULT_BASE_URL`, the
`smard-cli` User-Agent). An explicit blank `baseUrl` or `userAgent`, or a
`baseUrl` with surrounding whitespace, throws `SmardValidationError` — the same
values the CLI's `--base-url` / `--user-agent` reject — instead of silently meaning
production, the default User-Agent or a different path on a mirror.

**Error types.** [`errors.ts`](src/client/errors.ts): `SmardApiError` (non-2xx,
carries `status`/`detail`/`url`/`body`), `SmardNetworkError` (transport
failure/timeout), `SmardResponseTooLargeError` (size-cap breach, a subclass of
`SmardNetworkError`), `SmardParseError` (bad JSON) and `SmardValidationError` (an
input the library rejects before any request), all extending `SmardError`. The
CLI maps a `404` to exit code `4`, every other error to `1` — a
`SmardValidationError` included, which is the CLI's usage exit code.
Whatever a custom transport throws (a `TypeError` from `fetch`, an `AbortError`, a
string) reaches the caller as a `SmardNetworkError` with the original as `cause`.
The base URL lives in a real `#private` field of the engine, so `console.log`,
`util.inspect` and `JSON.stringify` of a client never show its password, and the
engine scrubs the base URL's userinfo (raw and percent-decoded) from error bodies,
details, transport error text and the `cause` chain
(`test/conformance-p2-library-redaction.test.ts`).

**Error classes and messages.** Every rejected input is a `SmardValidationError`,
never a raw `TypeError`: a non-function `transport` or `sleep` fails in the
constructor, `null` options count as none, a `.`/`..` path segment in direct engine
use is a validation error too. Echoed values and server text (an API `detail`) are
cut at `MAX_MESSAGE_VALUE_LENGTH` (500) characters with `cutForMessage`;
`SmardApiError.body` keeps the full text.
`test/conformance-p8-p9-p13-responses-and-errors.test.ts` holds the shared checks
for the declared charset (P8), 2xx bodies without the documented shape (P9) and
wrong-typed input (P13).

**Repeated options.** Every single-value option (`--base-url`, `--timeout`,
`--user-agent`, `--max-retries`, `--max-response-bytes`, `filters --group`) is
wrapped in `once()` (`shared.ts`): commander keeps the last of a repeated option
and drops the others without a word, so a repeat is a usage error naming the flag.

**Input validation.** A rule about what a request may contain belongs in the
library, in [`validate.ts`](src/client/validate.ts) or next to the option it
guards, as an exported `…Problem(value)` function that returns the reason a value
is invalid (or `undefined`). The library enforces it with `assertValid(name,
value, problem)`, which throws `SmardValidationError` with the message
`Invalid <name>: <reason>` before any request (methods that return a promise
reject; constructors throw). The CLI's parsers call the same functions and turn
the reason into a usage error rather than keeping a copy. Tests check this with
the `parity()` helper in `test/helpers.ts`, which sends one input through `run()`
and through the library on one recording mock transport.

**FILTERS / RegionValues / ResolutionValues / FilterGroupValues.** The exported
catalogue and const value arrays — used for the `filters`/`regions`/`resolutions`
listing commands and as `Region`/`Resolution`/`FilterGroup` union types.
`filtersByGroup(group?)` selects one group of `FILTERS` and rejects a group not in
`FilterGroupValues` (`SmardValidationError`); the `filters` command calls it. `FILTERS` is not
exhaustive: the API accepts any integer filter id.

**Validation boundary.** The library owns the input rules
([`validate.ts`](src/client/validate.ts)): `SmardClient` rejects a filter or
timestamp that is not a non-negative safe integer, a region outside
`RegionValues` and a resolution outside `ResolutionValues` with a
`SmardValidationError` before any request. The CLI only turns the argv strings
into values (plain ASCII digits for a number) and calls the same rules, so the
CLI and the library reject the same inputs with the same message. Every path
argument is also escaped, and the engine's `buildUrl` refuses a `.`/`..` segment.

**Typed pass-through.** Response types (`SeriesResult`, `TableResult`) are a
convenience typing over the documented shape, not a runtime guarantee. The one
exception is `timestamps()`, which checks that the body is a JSON object whose
`timestamps` is an array **and that every element is a safe integer** (else throws
`SmardParseError` — `null`, an array, `{}` or `timestamps: null` are not "no data",
which SMARD reports as a 404). The
element-type check is a security boundary: `latest()` interpolates a chosen
element into the path of a follow-up `series()` request, so a hostile or MITM'd
origin's string element (e.g. `"1/../evil"`) is refused before it gets there
(`series()` escapes every argument as well).

## Testing

```bash
npm test          # builds, then runs `node --test` over dist/test
```

- **`query.test.ts`** — query-string serialisation.
- **`http.test.ts`** — the default transport against a real loopback `http.createServer`.
- **`engine.test.ts`** — URL building, JSON decoding, error mapping, 429/503 retry — mocked transport.
- **`client.test.ts`** — every method's URL mapping, including the `latest` index→data flow — mocked transport.
- **`cli.test.ts`** — end-to-end command parsing, validation and exit codes — mocked client.
- **`validate.test.ts`** — `assertValid`, the `SmardValidationError` exit-code mapping and the `parity()` helper.

## Continuous integration

GitHub Actions workflows under `.github/workflows/`:

- **ci.yml** — type-check, build and test on Node 20/22/24 for every push and PR.
- **release.yml** — on a `v*` tag: verify the tag matches `package.json`, test, `npm pack`, and create a GitHub Release with the tarball.
- **publish.yml** — manual dispatch: publish to npm via OIDC **Trusted Publishing** (no stored `NPM_TOKEN`) with provenance.
- **docs.yml** — build the project website (`site/`, English and German) with the TypeDoc API docs
  under `/api/`, and deploy both to GitHub Pages on each `v*` tag.
  TypeDoc runs from the isolated, lockfile-pinned `tools/docs/` toolchain because it
  needs the TypeScript 6 compiler API, which TypeScript 7 no longer ships; locally,
  run `npm ci --prefix tools/docs` once before `npm run docs`.

## Website

The project website — <https://maschinenlesbar-org.github.io/smard-cli/> in English and
<https://maschinenlesbar-org.github.io/smard-cli/de/> in German — is built from `site/` with
[Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components and
[Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/smard-cli/
```

## License

Dual-licensed under **[AGPL-3.0-or-later](LICENSE)** or a commercial license — see
**[LICENSING.md](LICENSING.md)**. This project does **not** accept external code
contributions; see **[CONTRIBUTING.md](CONTRIBUTING.md)**.
