// SPDX-License-Identifier: Apache-2.0
/** Help text for `searchhole help` and `searchhole <command> --help`. */
import { VERSION } from './version.ts'

const MAIN = `searchhole ${VERSION}: a local search gateway for AI assistants

Usage: searchhole <command> [options]

Search and rules
  search "<query>"      Run a search through your engines and rules (try --explain)
  block <match>         Hide a site or pattern from results
  allow <match>         Always keep a site, even if a list blocks it
  pin <match>           Put a site at the top of results
  raise <match>         Rank a site higher (--weight 1-10)
  lower <match>         Rank a site lower (--weight 1-10)
  normal <match>        Cancel a raise or lower
  unrule <id|match>     Remove a rule
  rules                 List your rules
  explain <url>         Say how your rules treat a URL
  log                   Recent searches; "log show <id>" for one search in full
  suggestions           Rules your assistant proposed, waiting for you
  approve <id>          Accept a suggested rule
  reject <id>           Dismiss a suggested rule
  trust [dir]           Trust a project's .searchhole.yaml

Setup
  doctor                Check engines, keys and paths (--probe tests engines live)
  keys set <engine>     Store an API key (typed hidden, or piped on stdin)
  keys status           Show which engines have a key
  keys remove <engine>  Delete a stored key
  searxng up|down|status|apply
                        Run a private SearXNG in Docker on 127.0.0.1
  mode [auto|builtin|engines]
                        Claude Code search mode

Other
  ui [--open]           Open the dashboard on 127.0.0.1 (live log, rules, engines)
  mcp --host <profile>  Start the MCP gateway on stdio (your AI host runs this)
  version               Print the version
  help [command]        Show help

Common options: --json for machine output; --yes to confirm a change when there is no terminal.
Environment: NO_COLOR=1 turns colour off; SEARCHHOLE_HOME moves search-hole's folder;
SEARCHHOLE_SKILL=1 (set by the plugin's slash commands) lets a skill change rules without --yes.
Exit codes: 0 done, 2 something you can fix (the message says how), 1 an internal failure.`

const RULE_COMMON = `Options:
  --profile <name>   Apply only when this profile is active
  --project          Save in this project's .searchhole.yaml (needs searchhole trust)
  --session          Apply to this Claude Code session only
  --global           Save in your global rules (default)
  --note <text>      A reminder of why
  --until <when>     Stop applying on a date (2026-12-31) or after a duration (7d, 12h)
  --important        Run before every other rule (global and session only)
  --yes, -y          Confirm when there is no terminal (the change is marked non-interactive)
  --json             Print the rule as JSON

<match> is a domain (example.com), a host and path (example.com/blog), a URL pattern with *, or /regex/.`

const HELP: Readonly<Record<string, string>> = {
  search: `Usage: searchhole search "<query>" [options]

Runs the query through your engines and rules and prints the results.

Options:
  --depth quick|standard|deep   How many engines and results (default: standard)
  --profile <name>              Use this profile instead of guessing from the query
  --engine <id>                 Use only this engine; repeat for several
  --max-age-days <n>            Hide results older than n days (can only tighten the profile)
  --limit <n>                   Number of results to show
  --explain                     Show hidden results, the rule behind each decision, engines and warnings
  --json                        Print the full outcome as JSON

Put -- before a query that starts with a dash.`,
  block: `Usage: searchhole block <match> [options]\n\nHides results that match.\n\n${RULE_COMMON}`,
  allow: `Usage: searchhole allow <match> [options]\n\nKeeps matching results even when a list or a lower rule would hide them.\n\n${RULE_COMMON}`,
  pin: `Usage: searchhole pin <match> [options]\n\nPuts matching results at the top (they must already be in the results).\n\n${RULE_COMMON}`,
  raise: `Usage: searchhole raise <match> [--weight 1-10] [options]\n\nRanks matching results higher. A bigger weight pulls harder (1-10, default 1).\n\n${RULE_COMMON}`,
  lower: `Usage: searchhole lower <match> [--weight 1-10] [options]\n\nRanks matching results lower. A bigger weight pushes harder (1-10, default 1).\n\n${RULE_COMMON}`,
  normal: `Usage: searchhole normal <match> [options]\n\nCancels a raise or lower for matching results.\n\n${RULE_COMMON}`,
  unrule: `Usage: searchhole unrule <id|match> [--global|--project|--session] [--yes] [--json]

Removes a rule by its id (from \`searchhole rules\`) or by its match text.`,
  rules: `Usage: searchhole rules [--global|--project|--session] [--json]\n\nLists your rules.`,
  explain: `Usage: searchhole explain <url> [--profile <name>] [--json]\n\nShows which rules match a URL and what they decide.`,
  log: `Usage: searchhole log [--limit <n>] [--hidden] [--json]
       searchhole log show <searchId> [--json]

Recent searches, newest first. --hidden lists only searches that hid something.
"log show" prints every result of one search with its decision and rule.`,
  suggestions: `Usage: searchhole suggestions [--json]\n\nLists rules your assistant proposed. Nothing applies until you approve it.`,
  approve: `Usage: searchhole approve <id> [--yes] [--json]\n\nApplies a suggested rule.`,
  reject: `Usage: searchhole reject <id> [--yes] [--json]\n\nDismisses a suggested rule.`,
  trust: `Usage: searchhole trust [dir] [--yes] [--json]

Trusts the .searchhole.yaml in a project (default: the current project) by its content hash.
Until you do, its rules do not apply. Trust again after you edit the file.`,
  mode: `Usage: searchhole mode [auto|builtin|engines] [--yes] [--json]

Claude Code search mode. With no argument it shows the current mode.
  auto      your engines when one is healthy, otherwise Claude's own search with your rules applied
  builtin   always Claude's own search, with your rules applied
  engines   always your engines`,
  keys: `Usage: searchhole keys set <engine>
       searchhole keys status [--json]
       searchhole keys remove <engine> [--yes]

"keys set" reads the key from a hidden prompt, or from stdin when piped:
  pbpaste | searchhole keys set tavily
A key is never accepted as an argument. Engines: searxng, brave, tavily, exa, mojeek, kagi, marginalia.`,
  doctor: `Usage: searchhole doctor [--probe] [--strict] [--json]

Checks your engines, keys and paths and says what to fix. --probe makes a live test call to
engines whose health is unknown. The exit code is 0 even when a check fails, so the report is
always shown; --strict exits 1 when any check fails (for scripts).`,
  searxng: `Usage: searchhole searxng up|down|status|apply [--yes] [--json]

A private SearXNG search engine in Docker, on 127.0.0.1 only (container "search-hole-searxng").
  up       start it (asks before downloading the ~380 MB image; --yes skips the question)
  down     stop and remove the container (your settings stay)
  status   show whether it runs and answers
  apply    rewrite its settings and recreate the container after changing searxng.port`,
  ui: `Usage: searchhole ui [--open] [--detach] [--stay] [--port <n>]

Runs the dashboard on http://127.0.0.1:7341 (ui.port in settings.yaml), or reuses the one
already running. It prints a one-time sign-in link (valid 60 s); --open opens it in your browser.
  --detach  run it in the background and return (what /search-hole:dashboard does)
  --stay    don't exit after ui.idleMinutes (default 30) with no open tab
  --port    use another port for this run`,
  mcp: `Usage: searchhole mcp --host <profile>

Starts the MCP gateway on stdio. Your AI host launches this; run it yourself only to test.
Profiles: claude-code, claude-desktop, cursor, codex, vscode, goose, zed, generic.`,
  version: `Usage: searchhole version [--json]\n\nPrints the version.`,
  help: 'Usage: searchhole help [command]',
}

/** Help for one command, or the overview when the topic is missing or unknown. Never throws. */
export function usageText(topic?: string): string {
  return (topic === undefined ? undefined : HELP[topic]) ?? MAIN
}

/** True when `topic` has its own help page. */
export function hasHelp(topic: string): boolean {
  return topic in HELP
}
