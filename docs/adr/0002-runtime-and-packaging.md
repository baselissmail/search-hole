# ADR-0002: Runtime and packaging

- **Status:** Accepted (2026-10-30)
- **Related:** [0001](0001-monorepo-shape.md), [0003](0003-sqlite-driver-and-access-layer.md), [0014](0014-claude-code-hook-integration.md)

## Context

The gateway is a stdio MCP server that each host spawns. §4 lists three options for when a host has no `node` on its PATH: (a) require Node, (b) ship standalone per-platform binaries, (c) point the plugin at the `.mcpb`. Verified facts (2026-10-29; [platform-facts-claude-code-runtime.md](../research/platform-facts-claude-code-runtime.md) §G–J, [platform-facts-mcp.md](../research/platform-facts-mcp.md) §4):

- **Claude Code supplies no runtime.** Every install method, npm included, ships a native binary that never invokes Node. The docs' only guidance for `node: command not found` is "install it, or make sure it's on the PATH". Every plugin MCP example still uses `"command": "node"`.
- **Plugins have no per-platform binary selection.** One `command` string serves all platforms. Files in `bin/` go only on the **Bash tool's** PATH, and **claude.ai and Cowork refuse to install plugins that have a top-level `bin/`**.
- **Standalone binaries are heavy.** Bun 1.4.4's runtime is 88.7 MB (darwin-arm64) to 107 MB (linux-x64), so 8 targets total about 0.8 GB. That rules out a git marketplace or an npm package. Node SEA is similar in size, lacks macOS x64 and musl, and is still Stability 1.1. Deno has no musl. Bun's `--trim` is unreleased.
- **Desktop bundles Node** (macOS and Windows; Electron 44.9.3 embeds Node v24.22.0, found by local inspection, not documented). The `.mcpb` `node` server type uses it.
- **A plugin `.mcpb` reference is unverified for Claude Code.** `mcpServers` accepts a `.mcpb` path, but nothing documents which runtime Claude Code uses for a `node`-type bundle. Whether option (c) solves "no node" is **unverifiable** until it's tested on a clean machine.
- **The marketplace `npm` source runs the user's own `npm`** (`npm pack --ignore-scripts`), so it needs Node on PATH just to *install* the plugin. The `archive` source (an https zip ≤ 256 MiB with a `sha256` pin, v2.1.224+) and the `github`/`git-subdir` sources need no Node.
- **Startup failures are sticky.** If a plugin stdio server failed to connect less than 15 minutes ago, Claude Code skips it, so a first-run crash stays broken for 15 minutes after the user fixes it.
- **`node:sqlite` is now viable without native modules** ([ADR-0003](0003-sqlite-driver-and-access-layer.md)). It is unflagged from Node 22.13, a release candidate from 24.15, LTS-ready on 26, and implemented by Bun 1.4.4. That removes the main reason option (b) was attractive (`bun:sqlite`).
- **Node lifecycle:** Node 26 became Active LTS on 2026-10-28. Node 24 is in maintenance until 2028-04-30. Node 22 is in maintenance until **2027-04-30**. Node 20 is EOL.
- **Hooks can avoid Node entirely.** `mcp_tool` hooks call our gateway, so only the gateway process needs a runtime ([ADR-0014](0014-claude-code-hook-integration.md)).

## Decision

**Option (a+): require Node and make its absence loud.**

1. **Runtime floor:** `engines.node: ">=22.13"`. Develop on Node 26 LTS; CI covers 22, 24 and 26. Raise the floor to `>=24.15` after Node 22 reaches EOL on 2027-04-30 (in a minor release with a CHANGELOG note). On Node 22, the gateway suppresses only the `node:sqlite` `ExperimentalWarning` by filtering that warning code in-process before the dynamic import. It writes to stderr anyway, so this is cosmetic.
2. **One bundled artifact.** `tsdown` builds `packages/search-hole/dist/`: `searchhole.mjs` plus lazy chunks, the embedded receipt HTML and the dashboard assets. It needs **no `node_modules` and no native module**.
   - The same `dist/` runs as the CLI (`searchhole …`), the stdio gateway (`searchhole mcp --host <profile>`) and the dashboard server (`searchhole ui`).
   - The plugin ships **no `package.json` runtime dependencies**, so Claude Code's automatic `npm`/`bun` dependency install never runs.
3. **Host launch commands** (exec form, no shell, so paths with spaces need no quoting):
   - **Claude Code plugin:** `{"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/searchhole.mjs", "mcp", "--host", "claude-code"]}`. Executables are not placed in top-level `bin/`, which keeps claude.ai and Cowork installs possible later. Slash commands reference `${CLAUDE_PLUGIN_ROOT}/dist/searchhole.mjs` by path.
   - **Claude Desktop:** `.mcpb` with `manifest_version: "0.3"` and `server: {type: "node", entry_point: "dist/searchhole.mjs", mcp_config: {command: "node", args: ["${__dirname}/dist/searchhole.mjs", "mcp", "--host", "claude-desktop"], env: {SEARCHHOLE_BRAVE_API_KEY: "${user_config.brave_api_key}", …}}}`. Desktop spawns `mcp_config` exactly as written; `entry_point` is not added to the args. It runs on Desktop's bundled Node. A unit test runs mcpb's `getMcpConfigForManifest` on the generated manifest.
   - **Cursor, Codex, VS Code, others:** `node <path>/searchhole.mjs mcp --host <profile>`. `npx search-hole setup` writes these configs. `npx -y search-hole mcp` also works.
4. **No node on PATH is caught before the MCP connection fails.** A Claude Code `SessionStart` **command** hook (shell form, because Windows has no `sh` for exec form) runs a tiny POSIX-sh / PowerShell polyglot preflight (borrowing nightshift's launcher technique; MIT, attributed; details in ADR-0014). If `node` is missing or older than 22.13, it prints a `systemMessage` with platform-specific install steps and "then run `/mcp` → reconnect search-hole". It sets `"onFailure": "continue"`, so it can never block the session. The gateway also checks `process.versions.node` and its SQLite driver at startup. On failure it **starts anyway** and reports the problem through tool errors and `doctor`, instead of crashing into the 15-minute skip.
5. **Plugin distribution source:** the marketplace entry uses the **`archive` source**: a GitHub Release zip of the plugin layout (`.claude-plugin/`, `skills/`, `hooks/`, `.mcp.json`, `dist/`), pinned by `sha256` in `marketplace.json`.
   - Installing it needs no Node, so the preflight hook (point 4) reaches users without Node.
   - Build output stays out of the main branch, and the release workflow attaches build provenance (GitHub artifact attestation) to the zip.
   - Fallback: a `git-subdir` source at a release tag whose tree contains `dist/`.
   - The npm package `search-hole` serves `npx search-hole …` users only (published with npm provenance).
   - `plugin.json` always carries an explicit `version`.
   - For local development and the P3 dogfood, a relative-path marketplace points at a local build.
6. **Standalone binaries (option b) are deferred, not rejected.** Revisit in P8 if Bun `--trim` ships and a first-run downloader into `${CLAUDE_PLUGIN_DATA}` (checksum-pinned, from GitHub Releases) proves acceptable for security and UX. The code stays Bun-compatible: `node:sqlite` works on Bun, and nothing uses Node-only APIs that Bun lacks. A CI smoke test runs the bundle under Bun.

## Alternatives considered

- **(b) Bun-compiled binaries in the plugin.** Rejected for v1. About 0.8 GB across targets, no per-platform selection in the plugin manifest, `bin/` blocks claude.ai and Cowork, and binaries need macOS signing and notarisation. Kept as a later option (point 6).
- **(c) Plugin `mcpServers` → `.mcpb`.** Not relied on for Claude Code: the runtime Claude Code uses for a `node` bundle is undocumented (unverified, not disproven). A P0/P1 spike on a machine with no Node settles it. If Claude Code supplies a runtime, (c) becomes the better answer to "no node" and supersedes point 4. For now it is used for Desktop only.
- **The marketplace `npm` source as the primary plugin source.** Rejected: installing needs the user's npm, so it fails exactly on the no-Node machines point 4 is for.
- **A launcher script that downloads a runtime on first run.** Rejected for v1. It needs `sh` on Unix and PowerShell on Windows, a download path with a supply-chain surface, and an offline story. It is the same machinery as point 6, so it ships with it if ever.
- **Floor at Node ≥ 24.15** (no warning at all). Rejected for now. Node 22 is still common and in maintenance until April 2027. The warning is cosmetic and suppressed.
- **Committing `dist/` to a release tag** (`git-subdir` source). Kept as the fallback if the `archive` source misbehaves. It needs no npm client, but it puts build output in git history.

## Consequences

- Install story: "needs Node 22+" is one line in the README quickstart, plus the preflight hook and `doctor`. Users of natively installed Claude Code without Node get a clear message on the first session, not a silent MCP failure.
- One build output serves every host. The `.mcpb` is a zip of the same `dist/` plus a manifest.
- Startup budget (< 300 ms, §12.3) must hold on Node 22. The dashboard and list compilers load lazily.
- Desktop's undocumented Node version is a residual risk for `node:sqlite` (Electron may build Node without SQLite). See validation.

## Evidence

[platform-facts-claude-code-runtime.md](../research/platform-facts-claude-code-runtime.md) (§A `bin/`, §C npm source and auto dependency install, §E 15-minute skip, §G–J runtime, SQLite, binaries, Node schedule) · [platform-facts-mcp.md](../research/platform-facts-mcp.md) §4 · [mcpb.md](../research/mcpb.md) (node type, `platform_overrides` keyed by OS only) · [nightshift.md](../research/nightshift.md) (polyglot launcher, hooks without Node) · [smart-doctor.md](../research/smart-doctor.md) (`bun build --compile` precedent, version-constant test).

## Validate early

- **Done (2026-10-30, macOS):** Desktop's Electron 44.9.3 embeds Node v24.22.0 with `node:sqlite` compiled in (symbol inspection; [spikes-2026-10-30.md](../research/spikes-2026-10-30.md) §2). **Remaining (P5):** a throwaway `.mcpb` that reports `process.version` and `typeof require('node:sqlite').DatabaseSync` at runtime, on macOS and Windows. If `node:sqlite` is missing in Desktop's Node, use the better-sqlite3 13 fallback (N-API prebuilds) for the `.mcpb` only (ADR-0003).
- **P0/P1 spike:** on a machine with no Node, point a test plugin's `mcpServers` at a `.mcpb` and see whether Claude Code starts it (settles option c).
- **P3:** install the plugin from the `archive` source on a machine with no Node and confirm the preflight message, then install Node, reconnect, and confirm it works.
- **P3:** confirm Claude Code honours `onFailure` on the preflight hook (needs v2.1.295 or later; the dev machine runs 2.1.97 and must be updated).
