# Security policy

search-hole runs on your machine, between your AI assistant and the web. It sees your search queries and the pages your assistant opens, and it holds your engine API keys. Security reports are welcome, and they get priority over feature work.

## Reporting a vulnerability

**Please report privately.** Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/baselissmail/search-hole/security/advisories/new)). Only the maintainer sees the report.

Please include:

- the version (`searchhole version`), your OS and Node.js version, and the host (Claude Code, Claude Desktop, CLI, other);
- what an attacker needs: a malicious web page, a malicious repository, a hostile list subscription, another local user, or a model that has been prompt-injected;
- steps to reproduce, and what you expected instead.

Don't put real API keys, private hostnames or other people's data in a report. If you can't use GitHub's form, open a public issue that asks for a private contact, with no details in it.

This is a one-person project, so the timelines are honest rather than contractual. Expect an acknowledgement within 7 days and an assessment within 14. Fixes for confirmed problems ship as a patch release, with a GitHub security advisory that credits you unless you'd rather stay anonymous. Please give us 90 days, or until a fix is released if that comes sooner, before you publish details.

## Supported versions

Before 1.0, only the latest minor release gets security fixes. Nothing is released yet (no npm package, no plugin marketplace entry, no `.mcpb` download), so today the supported version is the current `main` branch: pull, then build again as the [README](README.md#install-in-claude-code) describes. After the first release you will upgrade with `npx search-hole@latest`, by updating the Claude Code plugin, or by installing the newest `.mcpb` from the releases page.

## Scope

These parts are designed as security boundaries, and a way around any of them is a vulnerability:

- **The MCP gateway** (`searchhole mcp`):
  - **The safe fetcher.** `fetch` refuses private, loopback, link-local and reserved addresses on every redirect hop, allows only http and https, caps size and time, and honours robots.txt.
  - **Query hygiene.** Queries that look like they contain secrets are blocked, and private addresses are cut out, before any engine sees them.
  - **Rules.** The model can only *suggest* a rule (`suggest_rule`). Any path that lets model-controlled input add, remove or approve a rule without the user is in scope.
  - **Engine keys** go only to the engine's own origin. Auth headers are stripped on a cross-origin redirect, and keys never appear in tool output or logs.
- **The Claude Code hooks guard.** The PreToolUse hooks deny the model's attempts to run `searchhole` rule commands, to start the dashboard (`searchhole ui`), or to edit search-hole's rule and settings files (ADR-0014). The README calls this defence in depth: a model with a shell runs as you, so it can always try something new, and it can read search-hole's files, including the dashboard's sign-in secret. A bypass is still worth reporting, so the guard can be extended.
- **Dashboard authentication** (`searchhole ui`, ADR-0004, ADR-0020):
  - it listens on 127.0.0.1 only, with a Host allowlist against DNS rebinding and an Origin check on writes;
  - a single-use login code expires after 60 seconds and becomes a bearer token kept in sessionStorage, with no cookies;
  - the sign-in link is printed only when the output is a terminal, so output captured by a slash command, a script or a model never carries it;
  - a strict CSP, no CORS, and `ui.json` readable by the owner only (0600).

  In scope: another local website, another browser tab, or another user's local process reading or changing data through the dashboard.
- **Receipt panel tokens** (ADR-0021). `apply_rule` is an app-only tool. It runs only for clients that declare MCP Apps, and only with an HMAC token bound to one action and one value. Tokens are single-use, expire after 10 minutes, and never appear in text or `structuredContent`. Forging, replaying or widening a token is in scope, and so is leaking one to the model.
- **Local data:**
  - the database and config files are 0600 and the data folder 0700 (on Windows they inherit your profile's ACL);
  - keys stored with `searchhole keys set` live in the OS keychain (macOS Keychain, Secret Service on Linux, DPAPI files on Windows); search-hole also reads them from environment variables. A key you paste into an app's own settings (the Claude Code plugin options, the Desktop extension) is stored by that app, not by search-hole;
  - config files refuse secrets;
  - a project's `.searchhole.yaml` applies only after you approve its content hash (`searchhole trust`), and it can never set engines, keys or subscription URLs.
- **Rendering web content.** Titles, snippets and URLs from the web are text everywhere, in the dashboard and in the panel. Any script execution or HTML injection from search results is in scope.
- **Release artifacts.** A published npm package, plugin zip or `.mcpb` that doesn't match its provenance attestation, checksum or SBOM.

## Out of scope

- What an engine (SearXNG, Tavily, Brave) does with the queries it receives. Each engine's own privacy terms apply.
- Prompt injection that changes the model's *answer* without crossing one of the boundaries above. Fetched pages are untrusted and marked as such, but search-hole can't make a model ignore them. Reports of injected content that should be *flagged* are still welcome as ideas (MASTER_PLAN "Later").
- Attacks that need code execution as your user account, or root. Such an attacker can already read your files and keychain prompts.
- Denial of service by the local user against their own install.
- Vulnerabilities in a dependency with no path to exploit them through search-hole. Report those upstream. Tell us anyway if you think the bundled copy is affected, because we bundle dependencies and must release to pick up a fix.

## How releases are protected

Nothing has been released yet. The release workflow is in the repository, and this is what it does: a release comes from a signed tag, through a GitHub Actions workflow with least-privilege tokens and actions pinned to commit SHAs. The npm package is published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements). Every release asset gets a GitHub build attestation and a SHA-256 checksum, and the release includes a CycloneDX SBOM of what the package bundles. [docs/release.md](docs/release.md#verify-a-release) shows how to verify them.
