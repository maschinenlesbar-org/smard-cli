# smard-cli — Exploratory / black-box bug report

**Date:** 2026-06-06
**Node:** v22.14.0
**Build:** `npm run build` clean; `npm test` → 39/39 pass.
**Live SMARD API:** reachable (`GET https://www.smard.de/app/chart_data/410/DE/index_hour.json` → 200).
**CLI invoked as:** `node dist/src/cli/index.js ...`

**Summary:** 20 genuine, reproducible findings below. All were reproduced against the
real CLI build; network/shape edge cases were reproduced with a local mock HTTP
server (`--base-url http://127.0.0.1:<port>`) where the live API cannot be coerced
into the required state. Findings are grouped by severity. Counts: **High 3,
Medium 9, Low 8.**

> Note on exit codes: `head`/pipes mask the CLI exit code, so every exit code
> below was captured with `node ... >/dev/null 2>&1; echo $?` (no pipe).

---

## HIGH

### 1. `latest` crashes with "Maximum call stack size exceeded" on a large index
- **Severity:** High · **Confidence:** High
- **Repro:** point at a mock returning an index with ~500k timestamps, then:
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT latest 410 DE hour
  ```
  (mock: `index_*.json` → `{"timestamps":[ ...500000 ints... ]}`)
- **Expected:** newest window's data, or a clear typed error.
- **Actual:**
  ```
  Unexpected error: Maximum call stack size exceeded
  ```
  exit code **1**. The error is only caught by the generic `catch` in `run.ts`
  (printed as "Unexpected error"), i.e. it is an uncaught runtime `RangeError`,
  not a handled `SmardError`.
- **Root cause:** `Math.max(...ts)` in `src/client/client.ts:54` spreads the
  whole index as function arguments; large arrays overflow the call stack. Should
  use a reduce/loop. (The live `410 DE hour` index is ~400 entries today, so it
  works now, but the API publishes a new file weekly and the spread is unbounded.)

### 2. `latest` throws an uncaught `TypeError` when `timestamps` is not an array
- **Severity:** High · **Confidence:** High
- **Repro:** mock returns `{"timestamps":{"0":123}}` for `index_*.json`, then:
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT latest 410 DE hour
  ```
- **Expected:** typed `SmardParseError`/empty result for a malformed index.
- **Actual:**
  ```
  Unexpected error: Spread syntax requires ...iterable[Symbol.iterator] to be a function
  ```
  exit code **1** (generic "Unexpected error" path).
- **Root cause:** `client.ts:32` does `res.timestamps ?? []` with no array/shape
  check; a non-array survives, `ts.length` (line 50) is falsy/undefined-safe but
  `Math.max(...ts)` (line 54) then spreads a non-iterable. `getJson`/`timestamps`
  perform no runtime validation of the declared `TimestampIndex` shape.

### 3. `filters --group <invalid>` silently returns `[]` with exit 0 (no validation)
- **Severity:** High · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js filters --group bogus      # -> []   exit 0
  node dist/src/cli/index.js filters --group GENERATION # -> []   exit 0 (case)
  ```
- **Expected:** a usage error (non-zero exit) — the help text constrains the value
  to `generation|consumption|price|forecast`, and the README documents exit codes
  as "non-zero for usage errors".
- **Actual:** empty JSON array, **exit 0**. A scripted caller cannot distinguish
  "no filters in this group" from "you typed the group name wrong".
- **Root cause:** `src/cli/commands/catalogue.ts:13-14` filters `FILTERS` by the
  raw `--group` string with no membership check (unlike the positional
  `region`/`resolution` args, which use `assertEnum`). `commander`'s `.choices()`
  is not applied to the option.

---

## MEDIUM

### 4. Declared `TableResult` type does not match the real API response shape
- **Severity:** Medium · **Confidence:** High
- **Repro (live):**
  ```
  node dist/src/cli/index.js --compact table 410 DE 1647817200000
  ```
- **Expected (per `src/client/types.ts`):** `series: TablePoint[]` where
  `TablePoint = { timestamp, versions: {value, name}[] }`.
- **Actual:** real `series` elements are `{ "values": [ { timestamp, versions:[...] } ] }`
  — a nested `values` array, never `{timestamp, versions}` directly. The CLI prints
  the raw JSON faithfully (no data loss in CLI output — verified
  `curl == CLI`), but **any library consumer using the typed `tableData()` return
  will mis-index the data** (`result.series[0].timestamp` is `undefined`).
- **Root cause:** `TablePoint`/`TableResult` in `src/client/types.ts:33-42` model
  the wrong structure; `client.ts:59 tableData()` casts the parsed JSON to this
  incorrect type with no validation.

### 5. `TablePoint.versions[].name` typed `string | null` but is a number at runtime
- **Severity:** Medium · **Confidence:** High
- **Repro (live):**
  ```
  node dist/src/cli/index.js --compact table 410 DE 1647817200000
  ```
  → `..."versions":[{"value":12225.25,"name":1}]...`
- **Expected:** `name` is `string | null` (`src/client/types.ts:35`).
- **Actual:** `name` is the integer `1`. Confirmed `type(name) == int` against the
  live response. Wrong compile-time type for library callers.
- **Root cause:** `src/client/types.ts:35`.

### 6. Empty `--user-agent ""` causes a confusing "Failed to parse JSON" on the live API
- **Severity:** Medium · **Confidence:** High
- **Repro (live, deterministic, 3/3 runs):**
  ```
  node dist/src/cli/index.js --user-agent "" timestamps 410 DE hour
  ```
- **Expected:** either a default UA is used, or a clear error telling the user a
  User-Agent is required.
- **Actual:**
  ```
  Error: Failed to parse JSON response from /app/chart_data/410/DE/index_hour.json
  ```
  exit code **1**. With an empty UA, smard.de returns a **200 HTML challenge page**
  (confirmed via a raw `node:https` probe: `status 200`, body starts
  `<!DOCTYPE HTML ... <title>Bundesnetzagentur</title>`), which then fails JSON
  parsing. The error message blames "parse" and hides the real cause.
- **Root cause:** `src/client/engine.ts:58` `this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;`
  — `??` only substitutes `null`/`undefined`, so an empty string is sent verbatim.
  Should treat empty/blank UA as "use default", or detect a non-JSON 200 and emit
  a clearer error.

### 7. README "specific window" example is broken — the timestamp 404s
- **Severity:** Medium · **Confidence:** High
- **Repro (live), copied verbatim from README.md:86-87:**
  ```
  node dist/src/cli/index.js series 4169 DE-LU hour 1577836800000
  ```
- **Expected:** one window's wholesale-price data.
- **Actual:**
  ```
  Error: HTTP 404 for GET https://www.smard.de/app/chart_data/4169/DE-LU/4169_DE-LU_hour_1577836800000.json
  ```
  exit code **4**. The timestamp `1577836800000` is **not in the current index**
  (verified: `timestamps 4169 DE-LU hour` → 401 entries, value absent). The
  documented example fails for any new reader.
- **Root cause:** hard-coded example timestamp in `README.md` (lines 86-87) that no
  longer exists in the rolling index.

### 8. No runtime shape validation: `timestamps` prints a non-array object as-is
- **Severity:** Medium · **Confidence:** High
- **Repro:** mock returns `{"timestamps":{"0":123}}`:
  ```
  node dist/src/cli/index.js --compact timestamps 410 DE hour   # -> {"0":123}
  ```
- **Expected:** `number[]` per the declared `TimestampIndex`/method return type, or
  a parse error.
- **Actual:** prints `{"0":123}` (a JSON object), exit 0 — the typed contract
  (`Promise<number[]>`) is violated at runtime.
- **Root cause:** `client.ts:28-33` casts and returns `res.timestamps ?? []` with
  no `Array.isArray` check; `engine.getJson` does `JSON.parse(...) as T` with no
  schema validation.

### 9. Help omits documented defaults for `--timeout` and `--max-retries`
- **Severity:** Medium · **Confidence:** High
- **Repro:** `node dist/src/cli/index.js --help`
- **Expected:** README (lines 53-56) documents `--timeout` default `30000` and
  `--max-retries` default `2`; `--base-url` shows its default in `--help`.
- **Actual:** only `--base-url` and `--max-response-bytes` mention a default in
  `--help`; `--timeout` and `--max-retries` show none, so the help understates the
  actual behaviour.
- **Root cause:** `src/cli/program.ts:32,34` register these options without the
  optional default-value argument that `commander` renders into help (the engine
  still applies 30000 / 2 internally at `engine.ts:59-60`).

### 10. README says global options must go "before" the command, but they also work after
- **Severity:** Medium · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js timestamps 410 DE hour --compact        # compact output, exit 0
  node dist/src/cli/index.js timestamps 410 DE hour --base-url https://nonexistent.invalid.example
  # -> Error: getaddrinfo ENOTFOUND nonexistent.invalid.example  (i.e. honored)
  ```
- **Expected (per README.md:59):** "Global options go **before** the command".
- **Actual:** `commander`'s `optsWithGlobals()` accepts them after the command too;
  the README is misleading (and there is no enforcement either way).
- **Root cause:** documentation/behaviour mismatch; `shared.ts:114` uses
  `optsWithGlobals()`.

### 11. `series`/`table`/`latest` perform no validation that the parsed JSON matches the result type
- **Severity:** Medium · **Confidence:** High
- **Repro:** mock returns `{"meta_data":{"version":1,"created":2},"series":[[1,2]]}`
  for a `table` request and the CLI happily prints it even though that is the
  *series* shape, not the *table* shape.
- **Expected:** structural validation, or at least documented "pass-through".
- **Actual:** any 200 JSON is cast to the method's return type and emitted.
  Combined with #4/#5/#8 this means the typed library surface gives no runtime
  guarantee at all.
- **Root cause:** `engine.getJson<T>` (`engine.ts:114-122`) does `JSON.parse(text) as T`.

### 12. `--base-url=` (empty) yields a low-level "Invalid URL" instead of a usage error
- **Severity:** Medium · **Confidence:** Medium
- **Repro:**
  ```
  node dist/src/cli/index.js --base-url= timestamps 410 DE hour
  ```
- **Expected:** a usage-level rejection of an empty base URL.
- **Actual:**
  ```
  Error: Invalid URL: /app/chart_data/410/DE/index_hour.json
  ```
  exit code 1. The base URL is empty, so the engine builds a relative URL and the
  transport's `new URL()` fails. The message leaks an internal path and does not
  say "base-url is empty".
- **Root cause:** `engine.ts:56` `(options.baseUrl ?? DEFAULT_BASE_URL)` — `??`
  keeps the empty string; no non-empty validation. Surfaces at `http.ts:44-46`.

---

## LOW

### 13. No-arg invocation prints full help but exits 1 (help on stderr)
- **Severity:** Low · **Confidence:** High
- **Repro:** `node dist/src/cli/index.js; echo $?`
- **Expected:** arguably exit 0 for a bare "show me help" (many CLIs do), or at
  least the README could note it.
- **Actual:** the entire help text is written to **stderr** and exit code is **1**.
  (Reasonable as "usage error", but undocumented and the help-to-stderr is easy to
  miss.)
- **Root cause:** `commander` default `helpCommand`/no-command behaviour; `run.ts`
  returns `err.exitCode` (1) for the `CommanderError`.

### 14. `series`/`timestamps` accept zero-padded filter ids that silently normalise
- **Severity:** Low · **Confidence:** High
- **Repro:** mock capturing the request URL:
  ```
  node dist/src/cli/index.js --base-url http://127.0.0.1:PORT timestamps 0410 DE hour
  # server sees: /app/chart_data/410/DE/index_hour.json
  ```
- **Expected:** either reject the non-canonical `0410`, or document the
  normalisation.
- **Actual:** `parseNonNegativeInt`'s regex `^\d+$` matches `0410`, `Number()`
  drops the leading zero → the request silently targets filter `410`. Benign here
  but a surprising input→output transform with no warning.
- **Root cause:** `src/cli/shared.ts:21-26`.

### 15. Timestamp `0` / far-past / far-future all map to a generic 404 (exit 4) with no hint
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js series 410 DE hour 0                 # 404, exit 4
  node dist/src/cli/index.js series 410 DE hour 99999999999999    # 404, exit 4
  ```
- **Expected:** since the CLI already has the index available (`latest` fetches
  it), it could tell the user "timestamp not in index; run `timestamps`".
- **Actual:** a raw HTTP-404 message; the user gets no guidance that the value must
  come from `timestamps`.
- **Root cause:** `series()` (`client.ts:36-45`) fetches the file directly without
  consulting the index; design choice, but poor UX for the common mistake.

### 16. `table` rejects all `timestamps`-command outputs; the only working timestamps are undiscoverable
- **Severity:** Low · **Confidence:** High
- **Repro (live):**
  ```
  node dist/src/cli/index.js timestamps 410 DE quarterhour   # e.g. ...,1780264800000
  node dist/src/cli/index.js table 410 DE 1780264800000      # HTTP 404, exit 4
  ```
  (The spec example `table 410 DE 1647817200000` *does* work — 200 — but there is
  no `index_quarterhour.json` under `table_data` (404), so a user has no command to
  discover a valid `table` timestamp.)
- **Expected:** README/help should note that `table` timestamps are not the same
  set returned by `timestamps`, and/or provide a way to list them.
- **Actual:** every timestamp the CLI can surface via `timestamps` 404s for
  `table`, with no documentation of where valid table timestamps come from.
- **Root cause:** documentation gap; `client.ts:59` builds the table URL from a
  caller-supplied timestamp with no discovery endpoint.

### 17. `--max-response-bytes 1` aborts with a network-style error (exit 1), conflating size cap with network failure
- **Severity:** Low · **Confidence:** High
- **Repro (live):**
  ```
  node dist/src/cli/index.js --max-response-bytes 1 timestamps 410 DE hour
  ```
- **Expected:** a distinct "response too large" signal.
- **Actual:**
  ```
  Error: Response exceeded maxResponseBytes (1)
  ```
  raised as a `SmardNetworkError` → exit **1**, indistinguishable from a real
  connection failure. (Documented as "all non-404 → 1", so within spec, but a
  size-cap breach is not a network error.)
- **Root cause:** `src/client/http.ts:78` throws `SmardNetworkError` for the size
  cap.

### 18. `--timeout 0` silently disables the timeout with no indication
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js --timeout 0 timestamps 410 DE hour   # runs, no timeout
  ```
- **Expected:** README documents default 30000 but not that `0` means "no
  timeout"; `--max-response-bytes` documents `0 = unlimited` but `--timeout` does
  not.
- **Actual:** `0` disables the timeout entirely (`http.ts:98` guards
  `timeoutMs > 0`), undocumented in help/README.
- **Root cause:** doc gap; `engine.ts:59` / `http.ts:98`.

### 19. `requireInt` error message wording differs from commander's for the same concept
- **Severity:** Low · **Confidence:** High
- **Repro:**
  ```
  node dist/src/cli/index.js timestamps -5 DE hour
  # -> Error: Invalid filter "-5". Expected a non-negative integer.
  node dist/src/cli/index.js --max-retries -1 filters
  # -> error: option '--max-retries <n>' argument '-1' is invalid. Expected a non-negative integer.
  ```
- **Expected:** consistent casing/format ("Error:" vs "error:", quoting style)
  across positional vs option validation.
- **Actual:** two different message formats and capitalisation for the same
  validation rule (positional args go through `requireInt`/`SmardError`; options
  go through `parseIntArg`/`InvalidArgumentError`).
- **Root cause:** `src/cli/shared.ts:32` vs `45`.

### 20. Far-past/unknown integer filter and far-future timestamp are all surfaced identically; no input sanity bounds
- **Severity:** Low · **Confidence:** Medium
- **Repro (live):**
  ```
  node dist/src/cli/index.js timestamps 777777 DE hour   # HTTP 404, exit 4
  ```
- **Expected:** the CLI documents `FILTERS` as the known set; an obviously-unknown
  id could warn ("777777 is not in the documented catalogue; run `filters`")
  before issuing a request.
- **Actual:** any non-negative integer is sent straight to the API; the only signal
  is the eventual 404. (By design per README, but a usability cost — the catalogue
  the tool already ships is never consulted for input feedback.)
- **Root cause:** intentional design (`README.md:174-175`, `chart.ts:12`), listed as
  a UX shortfall rather than a defect.

---

## Things explicitly checked that are CORRECT (not bugs)

- Filter parsing rejects `0x10`, `1e21`, `1.5`, `""`, `abc`, negatives, and
  `> MAX_SAFE_INTEGER` with a clear message + exit 1 (`shared.ts:21`). The `1e21`
  URL-injection concern is **not** present — it is rejected, never reaches the URL.
- `region`/`resolution` are enum-validated (case-sensitive) with a clear list.
- 404 → exit **4**; 503 (with retries) / timeout / bad host / malformed JSON /
  size cap → exit **1**; help/version → exit 0. Matches the README exit-code table.
- `series` output is byte-for-byte identical to a raw `curl` of the chart_data
  JSON — **no fields dropped** (verified with `meta_data` + `series` deep-equal).
- `table` output is deep-equal to raw `curl` — no data loss in CLI output (the bug
  is the declared *type*, #4/#5, not the printed bytes).
- `User-Agent`, `Accept: application/json`, retries (3 attempts/call on 503),
  trailing-slash base-url normalisation, `--max-response-bytes 0` (unlimited),
  and `--compact` vs pretty all behave as documented.
- Missing/extra positionals and unknown command/flag all exit non-zero with usage.
