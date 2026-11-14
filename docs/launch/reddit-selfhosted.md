# r/selfhosted draft

**Before posting:** read the subreddit's current rules on self-promotion and new projects. r/selfhosted has restricted new-project posts to set days or threads before, so post where and when they allow. Pick the matching flair. The first release must be out: the `npx` commands below work only after it. Don't name a site from your log, and don't say what the searches were about.

**Title:**

> search-hole: a local search gateway for AI assistants, with your own SearXNG, your site rules, and a log of every search

---

AI assistants (Claude, Cursor, Codex and the rest) now search the web on their own, a lot, and you don't see what they search or which pages they open. I wanted what Pi-hole gives me for DNS: see every query, then decide which engines and sites are used. So I built search-hole. It's open source (Apache-2.0) and it runs on your machine.

What two weeks of my own log showed (Claude Code on macOS, default setup): 96 searches returned 1,243 results from 538 sites, and the assistant opened pages from 37 of them. Several sites came back in 5 to 10 separate searches and were never opened once. The block lists I ship hid nothing in that sample. So the value so far is the log itself, and deciding from it.

**What runs where**

- **One Node program.** It's an MCP server your AI client starts, a CLI and a dashboard, in a single bundle with no `node_modules` and no native modules. It needs Node 22.19+.
- **Engines are yours:**
  - `searchhole searxng up` starts a private SearXNG in Docker, bound to 127.0.0.1, with a generated secret. The image is about 380 MB, downloaded once.
  - Tavily (a free plan, no card) and Brave (asks for a card) are optional extras with your own keys. [check: their current terms]
  - No shared keys. search-hole itself doesn't scrape search engines; SearXNG, if you use it, queries them for you.
- **Storage:**
  - a SQLite log in `~/.searchhole/` on macOS, the XDG data folder on Linux, or `%LOCALAPPDATA%` on Windows (`SEARCHHOLE_HOME` overrides);
  - `rules.yaml` and `settings.yaml` you can edit by hand;
  - keys in the OS keychain (macOS Keychain, Secret Service, Windows DPAPI) or environment variables, never in the config files.
  - Retention is per table and configurable.
- **The dashboard** (`searchhole ui`) listens on 127.0.0.1 only, with a one-time login link, a Host allowlist and a strict CSP. It loads nothing from the internet and exits after 30 minutes with no open tab.
- **No telemetry**, no account, no cloud component.
- **What does leave your machine:** your queries, to the engines you chose; your blocked sites, as an exclude list, if you use Tavily or Brave; and about once a week an HTTPS download of the block lists from their GitHub sources (`lists: { autoUpdate: false }` turns it off).

**What it does to searches**

- Rules: `block`, `allow`, `pin`, `raise`, `lower`, per session or profile, with freshness limits. `searchhole explain <url>` tells you which rule decides a URL.
- Results from several engines are merged (reciprocal-rank fusion), deduplicated by canonical URL, and typed (official docs, forum, news…).
- `fetch` opens pages safely: private and link-local addresses are refused on every redirect hop, with size and time caps, and robots.txt is respected.
- Queries that look like they contain secrets are blocked, and private IPs are cut out, before anything leaves your machine.
- First-party lists are CC0. [check: which lists ship in this release, and the subscription support for uBlacklist, AdGuard and hosts formats]

**Try it without an AI client:**

```sh
npx search-hole searxng up        # needed first: the CLI's search uses search-hole's own engines (or: npx search-hole keys set tavily)
npx search-hole search "react compiler" --explain
npx search-hole ui --open
```

[check: only true after the first release]

**Limits**

- A Docker image (`compose.yaml`) and a remote, multi-user mode are planned, not done. Today it is a local, per-user tool.
- SearXNG depends on upstream engines that rate-limit; a second engine covers for it.
- Some hosts (claude.ai on the web, ChatGPT) can't route their built-in search through a local tool.
- I use it daily in Claude Code on macOS only. The other clients are built and their configs are covered by tests, but I haven't tried them in the real app. [check: update with what you have tried by then]
- [check: Windows status from the release's CI and your own test]

Repo, docs and the decision records: https://github.com/baselissmail/search-hole

Feedback I'd value most: what you'd want in the dashboard, and which existing block lists you already use for search (uBlacklist and friends).
