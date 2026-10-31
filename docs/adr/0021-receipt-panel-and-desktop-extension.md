# ADR-0021: Receipt panel (MCP App) and the Claude Desktop extension

**Status:** Accepted (2026-10-31)
**Related:** [0001](0001-monorepo-shape.md), [0002](0002-runtime-and-packaging.md), [0007](0007-key-storage-and-resolution.md), [0012](0012-mcp-tool-surface-and-output-limits.md), MASTER_PLAN §8.5, §9.2 and P5

## Context

P5 ships two pieces:
- an in-chat receipt panel for hosts that render MCP Apps (Claude Desktop, claude.ai, VS Code, Cursor, Goose);
- a `.mcpb` for Claude Desktop.

ADR-0012 already fixed the tool shape (`receipt` carries the UI; an app-only `apply_rule` is token-gated) and the card limits (two actions, 4–5 data points). The research is [ext-apps.md](../research/ext-apps.md) and [mcpb.md](../research/mcpb.md).

## Decision

### Panel (`apps/receipt-app`)

1. **Stack:**
   - vanilla TypeScript plus `@modelcontextprotocol/ext-apps` 2.0.3 (`App`, the host theming helpers);
   - Vite 8 with `vite-plugin-singlefile` 2.3.4, producing one self-contained `receipt.html`;
   - budget ≤ 80 KB gzipped.

   2.0.4 was four days old on the decision date, so 2.0.3 is pinned (releases at least two weeks old).
2. **Served from disk, not compiled in.**
   - ADR-0001 planned the HTML as a string constant in the gateway. The bundle already ships sibling assets (`dist/ui`), so the package build copies `receipt.html` to `dist/panel/receipt.html`, and the gateway reads it once on the first `resources/read`.
   - When it is missing (a source checkout without the build), the gateway serves a short text page that says to build. This avoids a generated source file.
3. **Resource:**
   - `ui://search-hole/v<version>/receipt.html`, versioned so the one-day `cacheScope: 'public'` hint (ADR-0012) never serves a stale panel;
   - `mimeType: text/html;profile=mcp-app`;
   - `_meta.ui` on the content item, with `prefersBorder: true` and no extra CSP domains: no network, fonts from the host (`var(--font-sans)`), and system fallbacks.
4. **`receipt` declares the panel** (`_meta.ui.resourceUri` plus the flat `ui/resourceUri`) on every host profile, so `tools/list` stays identical. Only `receipt` has a panel; a panel on every search would be noise.
5. **What the panel receives.** When the client declares `extensions["io.modelcontextprotocol/ui"]` with the `mcp-app` mime type, the receipt result's `_meta["search-hole/panel"]` carries:
   - the receipts, the same data as `structuredContent`, so that the Claude Code profile, which sends no `structuredContent`, still has data;
   - one-time action tokens for blocking each opened source's site and for approving pending suggestions;
   - the dashboard URL when one is running.

   The tokens never appear in text or `structuredContent`.
6. **Card:**
   - 4–5 data points: searches, results kept and hidden, sources opened with their types, and stale sources;
   - two actions: "Full receipt", which switches to the fullscreen display mode when the host offers it, and "Block a site…", which goes fullscreen to the list of opened sites;
   - suggestions to approve appear in the fullscreen view.

   Without `serverTools` in the host capabilities, the buttons are replaced by the matching `/search-hole:block <site>` and `/search-hole:approve <id>` text. After an applied action, the panel calls `updateModelContext` (when offered) with `blocked: <site>`, so the model stops proposing it. Every web string is set with `textContent`.

### `apply_rule` (app-only)

7. **Registration:** host profiles `claude-desktop`, `vscode`, `cursor` and `claude-code` (hidden there, verified for `hook`), with `_meta.ui.visibility: ["app"]`; never on hosts not known to hide app-only tools (ADR-0012). Input: `{ kind: "block" | "approve", value, token }`. This is the minimal form of ADR-0012's `{ suggestionId | rule, actionToken }`: the panel can only block a site or approve a pending suggestion.
8. **Checks:**
   - the request's client must declare the MCP Apps extension;
   - `token` must be the HMAC-SHA256 (per-process secret) of `kind`, `value` and its expiry, at most 10 minutes old, and unused (tokens are single-use).

   A refusal names the slash command to use instead. A block is written as a global rule with the note "added from the receipt panel"; an approval goes through the normal suggestion path.

### Claude Desktop extension

9. **Manifest:** `distribution/claude-desktop/manifest.json`, with `manifest_version` 0.3 and a `node` server running the bundled `dist/searchhole.mjs mcp --host claude-desktop` on Desktop's own Node (ADR-0002). The `user_config` keys `brave_api_key` and `tavily_api_key` are `sensitive` and optional, mapped to `SEARCHHOLE_<ENGINE>_API_KEY`. An unset optional key arrives as the literal placeholder, which key resolution already treats as unset (ADR-0007).
10. **Build:** `scripts/build-mcpb.mjs` assembles manifest, `dist/`, `LICENSE` and a 512×512 icon. It validates with `@anthropic-ai/mcpb` (2.1.2) and packs `distribution/out/search-hole-<version>.mcpb`, which is git-ignored. A test runs the toolchain's `getMcpConfigForManifest` on the manifest. Signing (`mcpb sign`) waits for a certificate in P8.

## Consequences

- Hosts that render apps get a receipt card with no setup. Claude Code and other text hosts keep the text receipt.
- The panel can change exactly two things, and only through tokens it received in its own result. The model never sees the tokens, and a forged or replayed call fails.
- **Validate early (needs Basel's Claude Desktop):**
  - Install the `.mcpb` and confirm the server starts on Desktop's Node with `node:sqlite` (ADR-0002's open spike).
  - Confirm the card renders and the buttons work.
  - The fallback, if `node:sqlite` is missing there, is ADR-0003's better-sqlite3 path for the `.mcpb` only.
