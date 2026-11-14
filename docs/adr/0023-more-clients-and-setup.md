# ADR-0023: More clients — Codex and Cursor plugins, `searchhole setup`

**Status:** Accepted (2026-11-01)
**Related:** [0002](0002-runtime-and-packaging.md), [0007](0007-key-storage-and-resolution.md), [0012](0012-mcp-tool-surface-and-output-limits.md), [0014](0014-claude-code-hook-integration.md), MASTER_PLAN §9.3 and P7

## Context

P7 brings search-hole to clients beyond Claude Code and Claude Desktop. The formats were checked on 2026-10-31; the sources are in [docs/clients/README.md](../clients/README.md).

## Decision

1. **Codex: an Agent Plugins plugin with no hooks** (`distribution/codex`, root `plugin.json` + `mcp.json`, host profile `codex`).
   - A plugin with hooks can't be listed in OpenAI's directory.
   - `codex` never gets `apply_rule` (ADR-0012).
2. **Cursor: a `.cursor-plugin` with no hooks** (host profile `cursor`). Cursor's plugin hooks can only run commands, so nothing can call our gateway's `hook` tool. A command hook would start Node on every matching call, without the gateway's turn state. And Cursor has no built-in web search to steer.
3. **No slash-command skills outside Claude Code.** They rely on Claude Code running the command before the model sees the skill. Elsewhere the model would see the raw `SEARCHHOLE_SKILL=1 …` command and could run it. Only the research skill ships to Codex and Cursor.
4. **`searchhole setup <client> [--project] [--env NAME]… [--dry-run] [--yes]`** merges one `search-hole` entry into the client's MCP config. Clients: VS Code, Cursor, Codex (TOML), Windsurf/Devin, Zed, Goose (YAML), Claude Desktop and generic, which prints a snippet.
   - **It keeps what's there:** other servers stay, and so do comments where the format allows them.
   - **It writes carefully:** an exclusive backup first, then an atomic write that keeps the file mode, following symlinks.
   - **It refuses** unparseable or unsafe files, giving a paste-ready snippet instead.
   - **It never writes key values:** `--env` takes variable names only, and a value that looks like a secret is refused without being echoed.
   - **It previews first:** a dry run, then a confirmation in a terminal or `--yes`.
   - **It records the bundle's real path** and refuses to run from source.
   - **The model can't run it:** `setup` and `uninstall` are guarded Bash verbs (ADR-0014 point 3), so neither can be triggered by the model.
5. **`searchhole uninstall [--purge]`** (ADR-0006 point 13) lists, then deletes:
   - own-store keys, through the App;
   - known files by name, never a whole folder (it refuses the home folder and filesystem roots);
   - then the roots, if they end up empty.

   It names what other apps hold and how to remove it.

## Consequences

- One bundle serves every client. Each client gets its own host profile, so the right tools appear for it (ADR-0012).
- **Unverified on real apps:** Codex, Cursor, Zed, Goose, VS Code and Windsurf haven't loaded `setup`'s output yet. The P7 acceptance run ("a fresh install on each client shows a search in the dashboard") is still to do.

## Amendment (2026-11-14): setup shows the change; two merge fixes

- **The change is shown before the question.** `setup <app>` printed only "Write <file>?". It now prints the lines it adds and removes first (the part between the common start and end of the old and new text), and `--dry-run` prints the same. The README's "previews the change" is now true.
- **`setup generic` keeps stdout clean.** The snippet goes to stdout alone, so it can be redirected into a file; what to do with it, and that an engine is needed, goes to stderr.
- **Codex `--env` merges.** It replaced an existing `env_vars` array; it now adds to it, as the JSON clients and Goose do. An array with a comment inside is refused, untouched.
- **A one-line JSON config keeps its numbers.** Such a file was re-printed through JavaScript numbers, so `12345678901234567890` or `1.0` in someone else's key came back changed. When any number would not print back exactly, the file keeps its bytes and the entry is spliced in.
