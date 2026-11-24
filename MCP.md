# smard-mcp

An [MCP](https://modelcontextprotocol.io/) server for [SMARD](https://www.smard.de), the
Bundesnetzagentur's electricity-market data for Germany: generation by source, consumption (grid
load and residual load), forecasts and the day-ahead wholesale prices of Germany and its
neighbouring bidding zones, from 2015 to the latest published hour, as tools for AI agents.
Read-only, no API key. The data is under CC BY 4.0, credited as "Bundesnetzagentur | SMARD.de"
(see Licence).

It is the MCP side of [smard-cli](https://github.com/maschinenlesbar-org/smard-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/smard-mcp
```

This installs the **`smard-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/smard-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add smard -- smard-mcp
# or with the image:
claude mcp add smard -- docker run -i --rm ghcr.io/maschinenlesbar-org/smard-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "smard": { "command": "smard-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "smard": { "type": "stdio", "command": "smard-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
smard-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http smard http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/smard-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/smard-cli/releases) instead of
`latest`: `…/smard-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/smard-mcp:<version> --repo maschinenlesbar-org/smard-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `getGenerationMix` | Germany's generation by source for one period (the newest settled day by default, or an hour, month or year): each source's energy and share, the total, the renewable and the fossil share; nuclear left out after April 2023, pumped storage apart. |
| `getPrices` | The day-ahead price for a Berlin day in one or more bidding zones: the slot running now, the day's low and high with their times, the average, negative slots, the zones ranked; in EUR/MWh and ct/kWh. |
| `getSeries` | One series over a date range as one ordered list of rows (time, value), the weekly or yearly files stitched, with a CSV header, for a table, chart or export. |
| `listSeries` | The documented series ids with German and English names, units and kinds, the regions and the resolutions. |
| `listWindows` | The windows (files) a series is published in, newest first: how far back it goes. |

The newest values of every series are not published yet (null): the tools take the last published
one and name its period, never the last point of a file; the current price is the slot running
now, not the last published one (from the afternoon, tomorrow 23:45). Periods follow the Berlin
calendar: a day starts at 23:00 UTC the day before, so day and longer periods are named by their
Berlin date and times carry the Berlin offset. Amounts are MWh per period, prices EUR/MWh
(wholesale, without grid fees, taxes or levies; they can be negative). A name several series or
zones fit ("wind", "Dänemark") is reported with the candidates, never guessed; a series SMARD has
no file for is an empty answer saying what was asked. SMARD publishes one file per series and
week (or year), so getGenerationMix reads 22 files (an index and a window per source), one after the
other.

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from and the data licence. A text over 2000 characters is cut and ends in `…[cut, N
characters in all]`, and the answer says `truncated`. A failure is a tool error that says what to
change.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API base URL (default https://www.smard.de; the client adds /app/chart_data)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10); getSeries: the files (weeks of hours, years of days) per call
--user-agent <ua>          User-Agent header value (Latin-1, one line)
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages; a page on one of
  those origins gets CORS (its preflight answered, the answers readable). With `--auth-token-file
  <path>` every request must send `Authorization: Bearer <token>` (the file holds one token of at
  least 32 characters, mode 600, owned by the user the server runs as, a regular file (a FIFO is
  refused at once, never waited on); read once at start; `(umask 077; openssl rand -hex 32 >
  mcp-token)` makes one); anything else is answered 401. Exposed beyond localhost (it logs a warning
  then), it belongs behind a proxy that authenticates or at least terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses on HTTP 429 (as long as its Retry-After asks, at most 30 s), and stops a
  tool call after its deadline (a tool that has read part of its answer by then may answer with that
  part, and says so). A request those limits would hold longer than it or its call may wait is not
  sent: the call fails at once, naming the limit and when to ask again (and the log says so).
- **Results are data.** Text from the API, keys included, is cleaned (control, bidi, zero-width, tag
  and other invisible characters removed, but an emoji keeps its joiners; a key that cleaning makes
  equal to another stays, as `name~2`), but it is still other people's text: a model can be told
  things in it. The server can't act on that (it has no tool that writes), but other tools in the
  same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new connection
  and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal ends it at
  once. On stdio a signal ends it at once; when stdin ends, it first answers the requests it has
  read (each within its call deadline), then exits.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory.
- **Logs** go to stderr, one record per line; stdout carries only the protocol. A call that fails
  upstream or reaches its deadline leaves a WARN record naming the tool.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/smard-cli/blob/main/LICENSING.md)).
Data: the Bundesnetzagentur's, under
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/) (CC BY 4.0):
use, copying, distribution and adaptation, commercial too, are allowed with credit, which SMARD
asks to be given as "Bundesnetzagentur | SMARD.de"
([data use](https://www.smard.de/en/datennutzung),
[DATA_LICENSE.md](https://github.com/maschinenlesbar-org/smard-cli/blob/main/DATA_LICENSE.md)).
Every result carries that credit and the licence link in its `licence` field. The Bundesnetzagentur
gives no warranty of correctness or completeness; the data come from ENTSO-E and the transmission
system operators. We provide the tool, not the data.
