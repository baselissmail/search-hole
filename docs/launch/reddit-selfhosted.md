# r/selfhosted draft

**Before posting:** read the subreddit's current rules on self-promotion and new projects. r/selfhosted has restricted new-project posts to set days or threads before, so post where and when they allow. Pick the matching flair.

**Title:**

> search-hole: a local search gateway for AI assistants, with your own SearXNG, your site rules, and a log of every search

---

AI assistants (Claude, Cursor, Codex and the rest) now search the web on their own, a lot. I wanted the same control over that traffic that Pi-hole gives me over DNS: decide which engines and sites are used, and see every query. So I built search-hole. It's open source (Apache-2.0) and everything runs on your machine.

**What runs where**

- **One Node program.** It's an MCP server your AI client starts, a CLI and a dashboard, in a single bundle with no `node_modules` and no native modules. It needs Node 22+.
- **Engines are yours:**
  - `searchhole searxng up` starts a private SearXNG in Docker, bound to 127.0.0.1, with a generated secret. The image is about 380 MB, downloaded once.
  - Tavily (free tier, no card) and Brave are optional extras with your own keys.
  - No shared keys, and no scraping of search engines.
- **Storage:**
  - a SQLite log in `~/.searchhole/` on macOS, the XDG data folder on Linux, or `%LOCALAPPDATA%` on Windows (`SEARCHHOLE_HOME` overrides);
  - `rules.yaml` and `settings.yaml` you can edit by hand;
  - keys in the OS keychain (macOS Keychain, Secret Service, Windows DPAPI) or environment variables, never in the config files.
  - Retention is per table and configurable.
- **The dashboard** (`searchhole ui`) listens on 127.0.0.1 only, with a one-time login link, a Host allowlist and a strict CSP. It loads nothing from the internet and exits after 30 idle minutes.
- **No telemetry**, no account, no cloud component.

**What it does to searches**

- Rules: `block`, `allow`, `pin`, `raise`, `lower`, per session or profile, with freshness limits. `searchhole explain <url>` tells you which rule decides a URL.
- Results from several engines are merged (reciprocal-rank fusion), deduplicated by canonical URL, and typed (official docs, forum, news…).
- `fetch` opens pages safely: private and link-local addresses are refused on every redirect hop, with size and time caps, and robots.txt is respected.
- Queries that look like they contain secrets are blocked, and private IPs are cut out, before anything leaves your machine.
- First-party lists are CC0. [check: which lists ship in this release, and the subscription support for uBlacklist, AdGuard and hosts formats]

**Try it without an AI client:**

```sh
npx search-hole searxng up        # optional: private engine in Docker
npx search-hole search "react compiler" --explain
npx search-hole ui --open
```

**Limits**

- A Docker image (`compose.yaml`) and a remote, multi-user mode are planned, not done. Today it is a local, per-user tool.
- SearXNG alone gets rate-limited upstream under heavy agent use, which is why a second engine helps.
- Some hosts (claude.ai on the web, ChatGPT) can't route their built-in search through a local tool.
- [check: Windows status from the release's CI and your own test]

Repo, docs and the decision records: https://github.com/baselissmail/search-hole

Feedback I'd value most: what you'd want in the dashboard, and which existing block lists you already use for search (uBlacklist and friends).
