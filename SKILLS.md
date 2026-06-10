# smard-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for
German electricity-market intelligence, all powered by the **[smard](README.md)** CLI over
the open [SMARD chart-data API](https://smard.api.bund.dev/) (`smard.de`), operated by the
Bundesnetzagentur.

Each skill teaches Claude how to drive the `smard` CLI to answer a specific, real-world
question — "what's the current energy mix?", "when is power cheapest today?", "export the
grid load as CSV" — and to report the answer with evidence rather than guesswork. They
encode the parts that are easy to get wrong (the unpublished `null` tail on every window,
the bare-array `timestamps` shape, prices addressed by `DE-LU`) so Claude doesn't have to
rediscover them each time.

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **smard-generation-mix** | Fans out across every generation filter, fetches the newest common window, and computes per-source MWh, shares, and the renewable fraction. | "what's the energy mix in Germany?", "how much power is renewable right now?", "wind vs solar vs gas" |
| **smard-price-watch** | Summarises the day-ahead wholesale price — current price, min/max hour, average — and ranks neighbouring bidding zones. | "what's the electricity price now?", "when is power cheapest today?", "is France cheaper than DE-LU?" |
| **smard-series-export** | Stitches per-window data files into one ordered, gap-clean series over a date range and emits ISO-dated CSV/JSON. | "export hourly PV generation as CSV", "pull the grid load for the last weeks", "download the price series" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that loads
  Agent Skills).
- **The `smard` CLI** installed globally and on your PATH:
  ```bash
  npm i -g @maschinenlesbar.org/smard-cli   # installs the `smard` bin
  ```
  No API key is required — the SMARD chart-data API is free, open, and read-only.

## Installation

### Plugin marketplace (recommended)

This repo is a Claude Code **plugin marketplace**, so installation is two commands inside
Claude Code:

```
/plugin marketplace add maschinenlesbar-org/smard-cli
/plugin install smard@smard-skills
```

The first command registers the marketplace; the second installs the `smard` plugin,
which bundles all three skills. Update later with `/plugin marketplace update`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/smard-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/` by swapping `~/.claude/skills` for
`.claude/skills`. Each skill lives in its own directory with a `SKILL.md`, e.g.
`skills/smard-generation-mix/SKILL.md`. Start a new Claude Code session and the skills are
picked up automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from your
request. Just ask in natural language:

> What's Germany's electricity generation mix right now, and how much is renewable?

> When is power cheapest today on the DE-LU day-ahead market?

> Export the last few weeks of hourly grid load as a CSV I can open in a spreadsheet.

You can also invoke a skill explicitly with its slash command, e.g. `/smard-price-watch`.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which
`smard` subcommands to call, in what order, and how to interpret the JSON. The skills
encode the non-obvious parts of this API, for example:

- **the newest window's tail is `null`** — the latest `hour`/`day` window runs to the end
  of its period and the not-yet-published points come back as `[ts, null]`, so
  `.series[-1]` is almost always a gap. The skills always take the **last non-null** point
  (`[.series[] | select(.[1] != null)][-1]`) for "the current value";
- **`timestamps` returns a bare `number[]`**, not the API's underlying
  `{ "timestamps": […] }` — the CLI unwraps the index, so `jq '.[-1]'`, never
  `.timestamps` (see **smard-series-export**);
- **all price series are addressed by region `DE-LU`** — the *filter id* selects the
  country/bidding zone (France `254`, Austria `4170`, …), not the region argument;
  `254 DE` will not give France (see **smard-price-watch**);
- **nuclear (filter `1224`) is a dead series** — Germany shut its last reactors in April
  2023, so its last non-null value is a stale `0`; the mix skill omits/labels it rather
  than reporting it as live (see **smard-generation-mix**);
- **`table` is effectively unreachable** — `table_data` uses a *different, undiscoverable*
  timestamp set (a `table` call `404`s on every `timestamps`/`series` timestamp tested),
  so the export skill stays on `series`/`latest`;
- **one data file covers a long span** (an `hour` window ≈ a week; a `day` window ≈ a
  year), and adjacent windows abut, so the export skill fetches only the windows it needs
  and de-duplicates on timestamp at the boundaries.

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md`
focused, give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md) for
the dual-licensing / commercial option.
