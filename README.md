# search-hole

A local search gateway for AI assistants. You choose the engines and sites your AI searches, every search is logged on your machine, and each answer comes with a receipt of what was searched, hidden and opened.

**Status: v0.1, a test build for Claude Code.** The dashboard, other hosts, list subscriptions and releases come later. How it works: [ARCHITECTURE.md](ARCHITECTURE.md). Why: [docs/adr/](docs/adr/README.md).

## Requirements

- Claude Code 2.1.296 or newer.
- Node.js 22.19 or newer on your PATH. Without it the plugin shows a message at session start and the MCP server cannot run.
- Optional, for better results: Docker (a private SearXNG engine) or a free Tavily key. See [Optional engines](#optional-engines).

## Quickstart in Claude Code

1. Build the plugin. This needs [mise](https://mise.jdx.dev) (Node 26, pnpm 12). It builds the package and assembles `distribution/marketplace/search-hole/`, then prints the steps below with your paths:

   ```sh
   node scripts/build-plugin.mjs
   ```

2. Install it from the local marketplace `search-hole-local`. In a terminal:

   ```sh
   claude plugin marketplace add "<repo>/distribution/marketplace"
   claude plugin install search-hole@search-hole-local
   ```

   Or inside Claude Code: `/plugin marketplace add "<repo>/distribution/marketplace"`, then `/plugin install search-hole@search-hole-local`.

   For a quick try with nothing installed: `claude --plugin-dir "<repo>/distribution/marketplace/search-hole"`.

3. Restart Claude Code, then run `/search-hole:doctor`. The plugin has two optional settings, a Brave key and a Tavily key; leave them empty to start with zero setup, and change them later with `claude plugin configure search-hole`.

4. Ask a question that needs the web. If the turn searched, a one-line receipt appears when it ends, for example `search-hole · 2 searches · 18 results · 3 hidden`.

After a rebuild, run the script again and restart Claude Code.

## Claude Desktop

1. Build the extension (after `node scripts/build-plugin.mjs`, which builds everything):

   ```sh
   pnpm -C packages/search-hole build:mcpb
   ```

   It writes `distribution/out/search-hole-<version>.mcpb`.
2. In Claude Desktop, open Settings → Extensions → Install Extension…, and pick that file. Leave the Brave and Tavily keys empty, or paste a key; Desktop keeps it in your system keychain.
3. Ask Claude to search, then to show the search-hole receipt. Desktop shows it as a card. "Full receipt" lists what was searched and opened, and "Block a site…" blocks a site Claude used, with one click. Claude can't press these buttons; only you can.

Without an engine set up, `search` tells Claude to use its built-in search; for a private engine run `searchhole searxng up` in a terminal.

## Search modes

The default is `auto`. Change it with `/search-hole:mode auto|builtin|engines` (or `searchhole mode …`); a running session picks the change up on its next search. The `SEARCHHOLE_MODE` environment variable overrides the setting.

| Mode | What happens |
|---|---|
| `auto` (default) | With a healthy engine, WebSearch is steered to search-hole's `search` (full ranking, snippets, dates). With none, Claude's own WebSearch runs, filtered by your rules. It upgrades by itself when you add an engine. |
| `builtin` | Claude's own WebSearch always runs. Your blocked domains are added to the search, and results are filtered again afterwards. |
| `engines` | Searches always go to search-hole's engines. The built-in search runs (filtered) only if every engine fails. |

## Slash commands

All of these are user-only: Claude cannot run them. A `<match>` is a domain (`example.com`), a host and path (`example.com/blog`), a URL pattern with `*`, or a `/regex/`. Arguments are passed to a shell, so quote anything that contains `*`, `|` or spaces.

| Command | What it does |
|---|---|
| `/search-hole:block <match>` | Hide a site from results |
| `/search-hole:allow <match>` | Always show a site, even if a list blocks it |
| `/search-hole:pin <match>` | Put a site's results first |
| `/search-hole:raise <match>` / `lower <match>` | Move a site up or down (`--weight 1-10`) |
| `/search-hole:unblock <id-or-match>` | Remove a rule you added (also undoes raise and lower) |
| `/search-hole:rules` | List your rules |
| `/search-hole:log [show <id>]` | Recent searches and what was hidden |
| `/search-hole:explain <url>` | Why a URL is shown or hidden |
| `/search-hole:suggestions` | Rules Claude suggested, waiting for you |
| `/search-hole:approve <id>` / `reject <id>` | Decide on a suggestion |
| `/search-hole:mode [auto\|builtin\|engines]` | Show or set the mode |
| `/search-hole:doctor` | Check Node, hooks, engines and keys |
| `/search-hole:status` | Quick health check (`doctor --probe`) |
| `/search-hole:dashboard` | Open the dashboard in your browser |
| `/search-hole:searxng up --yes` / `status` / `down` | Manage the private SearXNG engine (`--yes` allows the first download, since there is no terminal to ask) |

The plugin also ships a `research` skill that Claude loads when it searches: when to use `search` or `fetch`, how deep to go, citing with dates, and saying "opened" rather than "cited". Claude can only suggest rules (`suggest_rule`); you approve them.

## CLI basics

The same build is a command line tool (`searchhole`, or `node <repo>/packages/search-hole/dist/searchhole.mjs` from a checkout):

```sh
searchhole search "react compiler" --explain   # run a search and show every decision
searchhole log                                  # recent searches
searchhole doctor                               # check the setup and get fixes
searchhole searxng up                           # start the private engine (Docker)
```

Data lives in `~/.searchhole/` on macOS (XDG directories on Linux, AppData on Windows; `SEARCHHOLE_HOME` overrides): a SQLite log plus your `rules.yaml` and `settings.yaml`.

## Dashboard

`/search-hole:dashboard` (or `searchhole ui --open`) opens a local dashboard at `http://127.0.0.1:7341`. It has a live search log you can expand to see every result and the rule that decided it, your rules and Claude's suggestions, engine health, and settings. Keyboard: `⌘K` opens the command palette, `?` shows the shortcuts, and on a selected result `b`, `a`, `p`, `r` and `l` block, allow, pin, raise and lower its site, with Undo.

It runs only when you start it, listens on 127.0.0.1 only, and signs you in with a one-time link that expires after 60 seconds. It exits after 30 minutes with no open tab (`--stay` keeps it running; `ui.port` and `ui.idleMinutes` in `settings.yaml` change the defaults). Nothing loads from the internet.

## Optional engines

Claude Code works with no engine (see the limits below). An engine gives better developer results, snippets, dates and freshness rules.

- **SearXNG** (free, private, no account). Needs Docker. `searchhole searxng up` (or `/search-hole:searxng up --yes`) downloads about 380 MB once and listens on 127.0.0.1 only.
- **Tavily** (free: 1,000 searches a month, no card). Sign up at https://app.tavily.com and paste the key into the plugin settings.
- **Brave** ($5 free credit a month, but it needs a card and an attribution link): https://brave.com/search/api/.

Recommended: SearXNG plus a free Tavily key, so SearXNG's upstream rate limits do not degrade results.

## Honest limits

- **Built-in mode has no snippets or dates.** Claude's WebSearch returns titles and URLs only. Freshness rules can use only dates from pages Claude opens. If a result is removed only after the search, the summary is withheld because it may mention it.
- **Other hosts need an engine.** Claude Desktop, claude.ai, ChatGPT, VS Code and Zed offer no way to filter their built-in search, so search-hole would be their search tool. They are not part of this test build.
- **WebFetch filtering is blocking only.** A blocked domain is denied; nothing is ranked or rewritten.
- **Hooks fail open.** If the gateway is not running, WebSearch runs unfiltered, and the receipt line says so when it can.
- **The guard on rule changes is defence in depth.** A hook denies Claude's attempts to run `searchhole` rule commands or edit rule files, but a model with a shell can always try. The slash commands and your own terminal are the supported ways to change rules.
- **Not yet tested on Windows.** SearXNG also slows down under heavy agent use; that is why a second engine helps.

## Troubleshooting

- *Node message at session start:* install Node 22.19+, then run `/mcp` and reconnect `search-hole`.
- *A slash command says a shell command permission check failed:* add `Bash(SEARCHHOLE_SKILL=1 node *)` to your allowed tools, or approve it when asked.
- *Nothing is filtered:* run `/mcp` and check that `plugin:search-hole:search-hole` is connected. If it is not, the hooks do nothing.

## Uninstall

```sh
claude plugin uninstall search-hole@search-hole-local
claude plugin marketplace remove search-hole-local
```

Removing the marketplace also deletes the plugin's saved options and keys. Your log, rules and any keys stored with `searchhole keys set` stay in `~/.searchhole/` and the OS keychain until you delete them.

## Licence

Apache-2.0 for the code ([LICENSE](LICENSE)); CC0-1.0 for the first-party lists ([lists/LICENSE](lists/LICENSE)).
