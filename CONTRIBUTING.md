# Contributing to search-hole

Thanks for helping. search-hole is a small personal project, so a short issue before a large change saves time on both sides. Bug reports, list entries with evidence, importer fixes and docs corrections are always welcome.

Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

## Development setup

The toolchain is pinned in [`.mise.toml`](.mise.toml): Node 26.13.0 and pnpm 12.16.1. The published package supports older Node versions (see `engines` in `packages/search-hole/package.json`), but develop on the pinned one.

1. Install [mise](https://mise.jdx.dev), then in the repository:

   ```sh
   mise install                      # Node and pnpm from .mise.toml
   mise exec -- pnpm install --frozen-lockfile
   ```

   Either run commands through `mise exec -- …`, or activate mise in your shell so `node` and `pnpm` resolve to the pinned versions.
2. Build everything and assemble the Claude Code plugin:

   ```sh
   mise exec -- node scripts/build-plugin.mjs     # dashboard, receipt panel, package, then distribution/marketplace/search-hole/
   ```

3. Try it:

   ```sh
   node packages/search-hole/dist/searchhole.mjs doctor      # what is set up, and how to fix what isn't
   pnpm -C packages/search-hole dev doctor                   # the same, straight from source (Node type stripping)
   claude --plugin-dir distribution/marketplace/search-hole  # the plugin in Claude Code; needs no engine
   ```

   The CLI's `search` command uses search-hole's own engines, so it needs one first. With none it exits 2 with "No healthy engine". Add an engine, then search:

   ```sh
   node packages/search-hole/dist/searchhole.mjs searxng up   # a private engine; needs Docker. Or: keys set tavily
   node packages/search-hole/dist/searchhole.mjs search "react compiler" --explain
   ```

   Use a scratch data folder while you experiment, so your real log and rules stay untouched: `SEARCHHOLE_HOME="$PWD/.tmp-home" node packages/search-hole/dist/searchhole.mjs …`.

**Windows:** clone with `git config --global core.autocrlf false` (or `git clone -c core.autocrlf=false …`). The plugin's preflight hook is a sh/PowerShell polyglot, and CRLF line endings break its sh half.

## Checks to run before a pull request

| Command | What it covers |
|---|---|
| `pnpm check` | Biome (lint and format), typecheck of every workspace, the layer check (ADR-0001), unit tests |
| `pnpm check:spdx` | Every code file starts with an SPDX licence line |
| `pnpm check:size` | After a build: dashboard initial JS ≤ 250 kB, receipt panel ≤ 80 kB, CLI entry and bundle limits (gzipped) |
| `pnpm smoke` | After a build: the bundle's CLI, rules, SQLite and MCP stdio, in a temporary home whose path has spaces |
| `pnpm -C apps/dashboard test:e2e` | Playwright and axe against the real `searchhole ui` (needs the build) |
| `pnpm -C apps/receipt-app test:e2e` | The receipt panel inside ext-apps' AppBridge |

The e2e tests use your installed Google Chrome. Without Chrome, run `pnpm -C apps/dashboard exec playwright install chromium` once, then set `E2E_CHANNEL=chromium` (as CI does).

CI runs all of this on Linux, plus unit tests, builds and the `.mcpb` pack on macOS and Windows, the bundle on the lowest supported Node and on Node 24, and `claude plugin validate --strict`. `pnpm format` fixes formatting.

## Code standards

The full list is in MASTER_PLAN §12. The ones reviews check most often:

- **Layers.** `core/`, `lists/` and `engines/` are pure: no I/O and no Node built-ins except `node:crypto`. I/O lives at the edges (`store/`, `fetch/`, `gateway/`, `cli/`, `ui/`). `pnpm check:layers` enforces it.
- **Types.** TypeScript strict, no `any`, and zod validation for anything from outside (MCP arguments, config files, lists, engine responses).
- **Errors** are typed with a code, say why, and give a fix (`→ …`).
- **Secrets** never reach logs, errors, test fixtures or snapshots. Keys come from environment variables or the OS keychain only.
- **Web text** (titles, snippets, URLs) is rendered as text everywhere: no `dangerouslySetInnerHTML`, no `innerHTML`.
- **Every code file** starts with `// SPDX-License-Identifier: Apache-2.0` (`#` for shell and PowerShell).
- **Commits** follow [Conventional Commits](https://www.conventionalcommits.org): `feat(dashboard): …`, `fix(gateway): …`, `docs: …`.

### Dependencies

- Pin exact versions, and only versions that have been on npm for at least two weeks. Renovate follows the same rule.
- The published package has **no runtime dependencies**. Everything is bundled by tsdown into `dist/` (ADR-0002), so a new library goes in `devDependencies`, and it counts against the CLI bundle budget.
- Ask in an issue before adding a dependency. Its licence must be compatible with Apache-2.0. We never copy GPL, AGPL or EUPL code.
- Don't change `pnpm-lock.yaml` by hand. CI installs with `--frozen-lockfile`.

## Sign your commits off (DCO)

search-hole uses the [Developer Certificate of Origin](https://developercertificate.org) instead of a CLA (ADR-0016). Each commit needs a sign-off line that matches the commit's author email:

```text
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it. To fix a branch, run `git rebase --signoff main` and force-push. CI checks every commit in a pull request. The sign-off says you wrote the change, or have the right to submit it, under the project's licence.

## Licences

- **Code and docs:** Apache-2.0 ([LICENSE](LICENSE)). Contributions are accepted under the same licence (inbound = outbound, Apache-2.0 §5).
- **First-party lists** (`lists/`): CC0-1.0 ([lists/LICENSE](lists/LICENSE)), so any blocker can reuse them. List entries are accepted under CC0 only.
- **Third-party lists and code** keep their own licences, recorded in `THIRD_PARTY_NOTICES.md`. Lists under GPL are subscribe-only and are never bundled.

## Contributing to lists

Every entry needs **public evidence**:

- **`official-docs` and `official-health`:** a link from the project's or organisation's own site or repository that points to the documentation domain.
- **`github-clones` and `ai-content-farms`:** an example page next to the original it copies, or other public proof that the site mass-produces copied or generated pages.

No private, NDA'd or personal information, and no sites listed because of a dispute. Open a [list contribution](https://github.com/baselissmail/search-hole/issues/new?template=list.yml) issue, or send a pull request that edits the list and includes the evidence. Importers and list work carry the `good first issue` label.

## Architecture decisions (ADRs)

A non-obvious decision gets an ADR in [`docs/adr/`](docs/adr/README.md), in the same pull request as the code. Examples: a new dependency, a storage format, a security boundary, a default that users will notice, or a change to the tool surface.

1. Copy the shape of a recent ADR, `NNNN-short-title.md` with the next free number. Its sections are Status, Related, Context, Decision, Alternatives considered, Consequences, Evidence and Validate early.
2. Start as **Proposed**. It becomes **Accepted** when merged.
3. Add a row to the index in `docs/adr/README.md`.
4. To change an accepted decision, write a new ADR that supersedes it, or add a dated amendment section. Don't rewrite the history in the old one.

Platform facts (host behaviour, versions, limits) need a source: a doc link, a reference repo at a pinned commit, or a reproducible spike in `docs/research/`.

## Releases

Only the maintainer releases. The checklist is in [docs/release.md](docs/release.md).
