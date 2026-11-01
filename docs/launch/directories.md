# Directory and list submissions

A checklist per directory. Requirements change often: re-read each directory's current submission guide before you submit, and note the date you checked it here.

## Shared prerequisites

- [ ] A public release whose install works from the README on macOS, Windows and Linux (docs/release.md step 7).
- [ ] README: a one-line description, the hero GIF, a 60-second quickstart per client, the privacy model, the limits, and the licence.
- [ ] PRIVACY.md (MASTER_PLAN §12.5). It doesn't exist yet. Directories that review data handling ask for it.
- [x] A square icon: `distribution/claude-plugin/.claude-plugin/icon.png`, the same 512×512 icon as the Desktop extension.
- [ ] Screenshots: the dashboard in light and dark, and the receipt card in Claude Desktop.
- [ ] Short descriptions, kept consistent:
  - **short:** "A local search gateway for AI assistants: choose the engines and sites your AI searches, see every search, get source receipts."
  - **long:** the Desktop manifest's `long_description`.

## Claude Code: our own marketplace

- [ ] `.claude-plugin/marketplace.json` at the repository root with the `archive` entry from the release (docs/release.md, one-time setup and step 7).
- [ ] `claude plugin validate . --strict` passes on the repository root.
- [ ] Install test: `claude plugin marketplace add baselissmail/search-hole`, then `/plugin install search-hole@search-hole`.

## Claude Code: Anthropic's plugin directory

`claude plugin validate` prints "plugin directory checks" for the directory's catalog. As of Claude Code 2.1.312 they report one warning for us:

- [x] **ICON_MISSING** (fixed: `claude plugin validate --strict` no longer reports it). Add a square PNG, 512 to 2048 px and under 2 MB, at `.claude-plugin/icon.png` in the plugin (copy the Desktop icon into `distribution/claude-plugin/.claude-plugin/`), or set `icon` in plugin.json. The validator warns that the icon may become the listing icon **only once**, the first time the plugin is saved or submitted in the developer portal. Get it right before the first submission.
- [ ] Re-run `claude plugin validate <assembled plugin> --strict` and read the directory section. The directory also runs a safety scan and a policy review that the CLI does not.
- [ ] Expect questions about the hooks: what they do, that they fail open, and that the Bash and Edit guard only denies changes to search-hole's own rules. ADR-0014 is the explanation to link.
- [ ] The plugin has no top-level `bin/`. Keep it that way, because claude.ai and Cowork refuse plugins that have one (ADR-0002).
- [ ] Submit through the developer portal that the validator output names. [check: the current URL and form]

## Claude Desktop extensions

- [ ] The `.mcpb` from the release, signed if you have a certificate (`MCPB_SIGNING`, docs/release.md).
- [ ] Manifest fields the directory is likely to want, none of which we set yet: `repository`, `homepage`, `documentation`, `support`, `privacy_policies` (a URL to PRIVACY.md) and `screenshots`. Add them to `distribution/claude-desktop/manifest.json` before you submit; `mcpb validate` accepts all of them in manifest 0.3.
- [ ] Tested in Claude Desktop on macOS **and Windows**: it starts on Desktop's own Node with `node:sqlite`, the receipt card renders, and its buttons work. This is still open in STATUS.md (P5).
- [ ] Submit through Anthropic's Desktop extension submission form. [check: the current URL and requirements]

## Cursor

Blocked on P7. The Cursor manifest (`.cursor-plugin/plugin.json` plus `mcp.json` and hooks) doesn't exist yet.

- [ ] P7 done: manifest, docs page, and a fresh-install test in Cursor that shows a search in the dashboard.
- [ ] Cursor's plugin or MCP directory submission. [check: which directory is current and what it requires]

## Codex

Blocked on P7. Codex gets the **hookless** variant: a root `plugin.json` plus `mcp.json` in the Agent Plugins format, so it can be listed (MASTER_PLAN §9.3).

- [ ] P7 done: the hookless manifests, and a fresh-install test in Codex.
- [ ] Codex plugin directory submission. [check: the URL and requirements]

## MCP server lists

- [ ] The official MCP Registry (`modelcontextprotocol/registry`): publish `server.json` for the npm package `search-hole`. [check: the current publisher CLI, and namespace verification for `io.github.baselissmail/search-hole`]
- [ ] awesome-mcp-servers lists. Open one pull request each, follow the list's format and category (search), and keep the line factual:

  > [search-hole](https://github.com/baselissmail/search-hole) – Local search gateway: your engines (SearXNG, Tavily, Brave), site rules, a local log of every search, and source receipts with dates.

  - `punkpeye/awesome-mcp-servers` [check: contribution rules; some lists require a badge or a Glama listing]
  - `appcypher/awesome-mcp-servers` [check: still maintained]
- [ ] `hesreallyhim/awesome-claude-code`, for the Claude Code plugin. [check: its submission process, which has used an issue form]

## After each submission

| Directory | Date submitted | Status | Link |
|---|---|---|---|
| | | | |
