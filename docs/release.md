# Releasing search-hole

This is the maintainer's checklist (MASTER_PLAN §11 P8). A release is a **signed tag** `vX.Y.Z` on `main`. Pushing it runs [`.github/workflows/release.yml`](../.github/workflows/release.yml), which publishes:

| Artifact | Where | For |
|---|---|---|
| `search-hole-X.Y.Z.tgz` | npm, with provenance; also a release asset | `npx search-hole …`, Cursor, Codex and other MCP clients |
| `search-hole-plugin-X.Y.Z.zip` | GitHub release | The Claude Code marketplace `archive` source (ADR-0002 point 5) |
| `search-hole-X.Y.Z.mcpb` | GitHub release | Claude Desktop |
| `search-hole-X.Y.Z.cdx.json` | GitHub release | CycloneDX 1.6 SBOM of what the npm package bundles |
| `marketplace-entry.json`, `SHA256SUMS.txt` | GitHub release | The plugin entry to commit, and checksums for every asset |

Every asset also gets a GitHub build attestation. Nothing is published from a laptop.

## 0. One-time setup (before the first release)

Do these once, in this order. None of the workflows can publish without them.

**The repository**

1. Push the repository to `github.com/baselissmail/search-hole` and make it **public**. npm provenance, artifact attestations on a free plan, and Scorecard's published results all need a public repository.
2. Add `repository` to `packages/search-hole/package.json`. npm refuses a provenance statement without it, and `check-release.mjs` fails until it is there:

   ```json
   "repository": { "type": "git", "url": "git+https://github.com/baselissmail/search-hole.git", "directory": "packages/search-hole" }
   ```

3. Under **Settings → Code security**:
   - enable **Private vulnerability reporting** (SECURITY.md points to it);
   - enable the **Dependency graph** and **Dependabot alerts**. Renovate reads the alerts for security PRs; don't enable Dependabot version updates.
   - Leave **CodeQL default setup off**. `codeql.yml` is the advanced setup, and the two conflict.
4. Under **Settings → Actions → General**:
   - Workflow permissions: **Read repository contents** (the workflows ask for more per job);
   - leave "Allow GitHub Actions to create and approve pull requests" **off**;
   - for fork pull requests, require approval for all outside collaborators.
   - Optionally, allow only GitHub's actions plus `jdx/mise-action` and `ossf/scorecard-action`, which are the only third-party actions used.
5. Under **Settings → Rules**, add two rulesets:
   - **`main`:** require the status check **"CI result"** (the `ci-ok` job), block force pushes and deletion. Requiring signed commits is optional.
   - **Tags `v*`:** only you may create them; block updates and deletion. A pushed tag is permanent.
6. Create the labels `dependencies`, `security` and `lists` (Renovate and the issue forms use them). `bug`, `enhancement` and `good first issue` exist by default.
7. Install the [Renovate GitHub app](https://github.com/apps/renovate) on the repository. `renovate.json` is already there.
8. Optionally, install the GitHub [DCO app](https://github.com/apps/dco) as well as the `DCO sign-off` CI job. Either one is enough.

**Signing tags.** The release refuses a tag unless GitHub shows it as **Verified**. With an SSH key:

```sh
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global tag.gpgSign true
# To verify locally (git tag -v):
echo "<your-email> $(cat ~/.ssh/id_ed25519.pub)" >> ~/.config/git/allowed_signers
git config --global gpg.ssh.allowedSignersFile ~/.config/git/allowed_signers
```

Then add the same public key on GitHub under **Settings → SSH and GPG keys → New SSH key**, with **Key type: Signing key**. The tagger email must be a verified email on your GitHub account. GPG works the same way: add the GPG key on GitHub.

**npm**

1. Publish the name placeholders by hand once (`distribution/npm-reserve/README.md`). A trusted publisher can be added only to a package that exists.
2. On npmjs.com, open `search-hole` → **Settings → Trusted publishing → GitHub Actions**, and enter:
   - user: `baselissmail`
   - repository: `search-hole`
   - workflow: `release.yml`
   - environment: `npm`

   The workflow then publishes through OIDC, with no token stored anywhere. Then set **Publishing access** to "Require two-factor authentication and disallow tokens".
3. **Fallback only:** if you can't use trusted publishing, create a granular npm token (publish rights on `search-hole` only, short expiry) and store it as the `NPM_TOKEN` secret of the `npm` environment.

**GitHub environments.** Under **Settings → Environments**:

| Environment | Protection | Secrets and variables |
|---|---|---|
| `npm` | Required reviewer: you. Deployment branches and tags: tags matching `v*` only. | `NPM_TOKEN` (optional fallback) |
| `release` | Same as `npm` | `MCPB_SIGNING_CERT`, `MCPB_SIGNING_KEY`, `MCPB_SIGNING_INTERMEDIATE` (optional; PEM text) |

`.mcpb` signing is off until you have a code-signing certificate. To turn it on, add the three secrets to `release` and set the repository variable **`MCPB_SIGNING`** = `true` (Settings → Secrets and variables → Actions → Variables). Signing runs `mcpb sign`, then `mcpb verify`.

**The public marketplace.** After the first release, commit `.claude-plugin/marketplace.json` at the repository root. Users then install with `claude plugin marketplace add baselissmail/search-hole`. Fill `plugins` with the `marketplace-entry.json` from the release (step 7):

```json
{
  "name": "search-hole",
  "owner": { "name": "Basel Issmail" },
  "description": "search-hole, a local search gateway for AI assistants.",
  "plugins": [ { "…": "the contents of marketplace-entry.json" } ]
}
```

Users then install with `/plugin install search-hole@search-hole`. The local test marketplace in `distribution/marketplace/` (`search-hole-local`) stays as it is.

## 1. Before you start

- [ ] **Dogfood gate** ([dogfood.md](dogfood.md)): at least 14 days of daily use, and no open P0 or P1 entry.
- [ ] CI is green on `main` for the commit you'll tag, including Windows and the runtime-floor job.
- [ ] The README quickstart works exactly as written for each client, the hero GIF is current, and the status line is current.
- [ ] Anything STATUS.md lists as "needs a real host" for this release has been checked. For P5 that means the `.mcpb` in Claude Desktop on macOS and Windows.
- [ ] `CHANGELOG.md` has everything user-visible under `## [Unreleased]`.

## 2. Bump the version

The version is written in six places. The release checks all of them:

| File | Field |
|---|---|
| `packages/search-hole/package.json` | `version`, the npm version |
| `packages/search-hole/src/cli/version.ts` | `VERSION`, which `searchhole version` and the MCP `serverInfo` report. A test keeps it equal to package.json |
| `apps/dashboard/package.json` | `version` |
| `apps/receipt-app/package.json` | `version`. The panel URI is `ui://search-hole/v<version>/…` |
| `distribution/claude-plugin/.claude-plugin/plugin.json` | `version`, which Claude Code uses to detect updates |
| `distribution/claude-desktop/manifest.json` | `version`. `build-mcpb.mjs` also stamps it at pack time, and a test keeps it equal |

One command sets all six and turns `## [Unreleased]` into a dated `## [X.Y.Z]` section:

```sh
pnpm release:bump 0.3.0            # or: node .github/scripts/bump-version.mjs 0.3.0 --date 2026-11-14
pnpm check && node scripts/build-plugin.mjs && pnpm check:size && pnpm smoke
pnpm check:release v0.3.0          # versions, changelog section, package.json repository
```

Update the status line in the README and the STATUS.md entry by hand. Commit with a sign-off (`git commit -s -m "chore(release): v0.3.0"`), push to `main` (or merge a PR), and wait for CI.

## 3. Rehearse (recommended, and required the first time)

Go to **Actions → Release → Run workflow**, pick `main`, leave **tag** empty and keep **dry_run** ticked. This builds, tests, validates and packages exactly as a release would, using the version in package.json, but skips the signature check and publishes nothing. Download the `release-assets` artifact and look inside:

- `tar -tzf search-hole-X.Y.Z.tgz`: `package/dist/…`, README, LICENSE, no `src/`;
- unzip the plugin and run `claude --plugin-dir <dir>`;
- install the `.mcpb` in Claude Desktop.

## 4. Tag

```sh
git switch main && git pull --ff-only
git tag -s v0.3.0 -m "search-hole 0.3.0"
git tag -v v0.3.0                  # should say "Good signature"
git push origin v0.3.0
```

A pre-release tag such as `v0.3.0-rc.1` publishes to npm under the `next` dist-tag and marks the GitHub release as a pre-release.

## 5. What the workflow does

| Job | Token permissions | What it does |
|---|---|---|
| `verify` | `contents: read` | Checks that the tag is annotated and its signature shows as verified by GitHub (API `git/tags`), and that it points at a commit on `main`. Runs `check-release.mjs`: six version strings, the changelog section (which becomes the release notes), and `repository.url` |
| `build` | `contents: read` | Builds the dashboard, panel and package. Runs every unit test, the bundle smoke test and the size budgets. Assembles and zips the plugin (sorted entries, timestamps fixed to the tag's commit time). Runs `claude plugin validate --strict` on the unzipped plugin and on a marketplace made from the new entry. Packs and validates the `.mcpb`, packs the npm tarball (with README and LICENSE), and writes the SBOM |
| `sign-mcpb` | `contents: read`, environment `release` | Only when `MCPB_SIGNING` is `true`: `mcpb sign`, then `mcpb verify` |
| `publish-npm` | `contents: read`, `id-token: write`, environment `npm` | **Waits for your approval.** Then runs `npm publish <the built tarball> --provenance --access public --tag latest\|next`. It skips a version that is already on npm, so a re-run is safe |
| `github-release` | `contents: write`, `id-token: write`, `attestations: write` | Writes `SHA256SUMS.txt`, attests every asset, and creates the release with the changelog notes. A re-run replaces the assets |

The job summary prints the checksums and the marketplace entry. Fork copies of the repository never run any of this (`if: github.repository == 'baselissmail/search-hole'`).

## 6. Approve

GitHub asks you to approve the `npm` environment (and `release`, when signing is on). Approve after `build` is green. Rejecting stops the release before anything is public. The tag stays; see Rollback.

## 7. After the release

1. Copy `marketplace-entry.json` from the release (or the job summary) into `plugins` in `.claude-plugin/marketplace.json`. Commit it with a sign-off and push. Until you do, marketplace users stay on the previous version.
2. [Verify the release](#verify-a-release), as a user would.
3. **P8 acceptance**, on a clean macOS, Windows and Linux machine:
   - [ ] `claude plugin marketplace add baselissmail/search-hole`, then `/plugin install search-hole@search-hole`, `/search-hole:doctor`, and one search that shows up in the dashboard;
   - [ ] `npx search-hole@X.Y.Z doctor`;
   - [ ] the `.mcpb` from the release in Claude Desktop (macOS and Windows): it starts, and the receipt card renders;
   - [ ] uninstall leaves nothing behind. `searchhole uninstall --purge` does not exist yet, so until it does, check the data root by hand (`~/.searchhole`, the XDG folders, or `%APPDATA%`/`%LOCALAPPDATA%\searchhole`) and the keychain entries.
4. Add a STATUS.md line: the version, the date, and anything still open.

## Verify a release

Anyone can run these. Replace `0.3.0` with the version.

```sh
# npm provenance: the tarball was built by release.yml from the tagged commit
npm view search-hole@0.3.0 dist.attestations --json
mkdir /tmp/sh-check && cd /tmp/sh-check && npm init -y >/dev/null && npm install search-hole@0.3.0 && npm audit signatures

# GitHub assets: checksums and build attestations
gh release download v0.3.0 -R baselissmail/search-hole -D release && cd release
sha256sum -c SHA256SUMS.txt
for f in search-hole-0.3.0.tgz search-hole-plugin-0.3.0.zip search-hole-0.3.0.mcpb search-hole-0.3.0.cdx.json; do
  gh attestation verify "$f" -R baselissmail/search-hole
done

# The npm tarball is byte-identical to the attested release asset
npm pack search-hole@0.3.0 --pack-destination /tmp && sha256sum /tmp/search-hole-0.3.0.tgz search-hole-0.3.0.tgz

# Signed .mcpb (when signing is on)
npx --yes @anthropic-ai/mcpb@2.1.2 verify search-hole-0.3.0.mcpb

# What is bundled
jq -r '.components[] | "\(.group // "")\(if .group then "/" else "" end)\(.name)@\(.version)  \(.licenses[0].license.id // "?")"' search-hole-0.3.0.cdx.json
```

On npmjs.com, the version page shows a **Provenance** section that links to the workflow run and the commit.

## Rollback

Fix forward when you can. A version number, once published, is used up on npm.

- **Nothing published yet** (`build` failed, or you rejected the approval): fix on `main`. If the tag itself is wrong (wrong commit or version), delete it before anyone uses it: `git push --delete origin vX.Y.Z && git tag -d vX.Y.Z`. The tag ruleset must allow this, so lift it briefly. Then tag again. Otherwise, bump to the next patch.
- **npm is broken:**
  - `npm deprecate search-hole@X.Y.Z "Broken: use X.Y.Z+1 (see the changelog)"`, then point `latest` back at the last good version: `npm dist-tag add search-hole@<previous> latest`;
  - then release a patch.
  - Use `npm unpublish search-hole@X.Y.Z` only for a release that is harmful (for example a leaked secret or malware), within 72 hours, and expect the version number to stay burned.
- **The plugin is broken:** revert `.claude-plugin/marketplace.json` to the previous entry (its URL and `sha256` are in the previous release's `marketplace-entry.json`) and push. Claude Code offers the old version on the next marketplace update. Edit the GitHub release to say it is withdrawn. Keep the tag and the assets, because the checksums and attestations refer to them.
- **The `.mcpb` is broken:** mark the release as a pre-release or edit its notes, and point Desktop users to the previous release's `.mcpb`. Desktop doesn't update it automatically.
- **A credential leaked** (npm token, signing key, GitHub token):
  - revoke it first: delete the npm token or the trusted publisher, revoke the certificate, rotate the SSH signing key on GitHub;
  - then deprecate the affected versions and publish a GitHub security advisory.

## Windows

CI runs the unit tests, all three builds, the plugin assembly, the bundle smoke test and the `.mcpb` pack and unpack on `windows-latest`, with `core.autocrlf=false`. The smoke test uses a temporary home whose path has spaces (and Windows' 8.3 short names). `check-preflight-windows.mjs` runs the SessionStart hook under Windows PowerShell and Git Bash, with and without `node` on PATH. Release artifacts are built only on Linux.

Known risks, from reading the hooks, scripts, `shared/paths.ts` and the CLI. None is verified on a real Windows machine yet:

| # | Risk | Where | Suggested fix |
|---|---|---|---|
| 1 | **Slash commands use a POSIX environment prefix**: `!` + `SEARCHHOLE_SKILL=1 node "…/searchhole.mjs" …` in every `skills/*/SKILL.md`. This works when Claude Code runs it under Git Bash, but not under PowerShell (Windows without Git Bash). | `distribution/claude-plugin/skills/` | Pass a CLI flag instead of the env prefix (for example `--from-skill`), or document Git Bash as required on Windows. Check how Claude Code runs `!` commands without Git Bash |
| 2 | **The preflight needs script execution.** Without Git Bash, Claude Code runs the shell-form hook under PowerShell. Dot-sourcing `preflight.ps1` fails under the `Restricted` policy (the Windows client default), so the hook fails and `onFailure: continue` hides it. The "install Node" message never appears. CI prints this case for information. | `hooks/hooks.json`, `hooks/preflight.ps1` | Confirm on a real machine which PowerShell and flags Claude Code uses. If it uses the default policy, document `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`, or rely on `doctor` and the gateway's own Node check |
| 3 | **The preflight accepts a `node.cmd` that the MCP server can't start.** `preflight-windows.ps1` uses `Get-Command node`, which also matches `node.cmd` and `node.ps1` shims. `.mcp.json` runs `node` without a shell, which needs a real `node.exe`. With a shim-only version manager the preflight stays silent while the server fails, and Claude Code skips a failed server for 15 minutes. | `hooks/preflight-windows.ps1` | Look for `Get-Command node -CommandType Application` whose path ends in `.exe`, and say so when only a shim exists |
| 4 | **CRLF checkouts** (`core.autocrlf=true` is Git for Windows' default) turn `preflight.ps1` into CRLF. The sh half then breaks under Git Bash, silently. Golden test fixtures may also differ. Releases are unaffected, because they are built on Linux. | repository root | Add `.gitattributes` with `* text=auto eol=lf` (at least `*.ps1`, `*.sh`, `*.mjs`, `*.ts` and fixtures) |
| 5 | **`build-plugin.mjs` runs `pnpm` without a shell.** An npm or corepack install of pnpm is `pnpm.cmd`, which `spawnSync` can't find on Windows, so the script reports "Neither mise nor pnpm is on PATH". mise (`mise.exe`) and the standalone `pnpm.exe` work. CI avoids the problem with `--skip-build`. | `scripts/build-plugin.mjs` | Use `shell: true` on win32 for the pnpm fallback (the arguments are fixed), or look up `pnpm.cmd` explicitly |
| 6 | **`searchhole ui --detach`** (used by `/search-hole:dashboard`) spawns the server with `detached: true` and no `windowsHide`. On Windows this opens a visible console window, and closing it stops the dashboard. | `packages/search-hole/src/ui/run.ts` (`startDetached`) | Add `windowsHide: true` |
| 7 | **`ui --open` passes `http://127.0.0.1:7341/#c=<code>` to `explorer.exe`.** If the fragment is lost on the way to the default browser, sign-in falls back to the printed link. | `src/ui/run.ts` (`openInBrowser`) | Check on Windows. Alternative: `rundll32 url.dll,FileProtocolHandler <url>` |
| 8 | **Key storage.** search-hole's own store is a DPAPI file written through `powershell.exe -Command` (300–800 ms on a cold read, cached). PowerShell Constrained Language Mode or AppLocker, common on managed machines, can block it. Then `keys set` fails, and environment variables (`TAVILY_API_KEY`, `*_FILE`) are the fallback. Claude Code keeps the plugin's sensitive `userConfig` values in `~/.claude/.credentials.json` on Windows and Linux, not in a keychain, so never claim "keychain" there. Desktop's `.mcpb` keys use Desktop's own secure storage. | `src/shared/keys/windows.ts`, docs | Say this in the README and PRIVACY.md. `doctor` already names the env-var fallback |
| 9 | **File modes are no-ops.** `0600` and `0700` do nothing on Windows; files inherit the folder's ACL. Under `%APPDATA%` and `%LOCALAPPDATA%` that ACL is user-only. With `SEARCHHOLE_HOME` on a shared folder, the database and `ui.json` (which holds the dashboard's login secret) are readable by anyone who can read the folder. | `src/shared/paths.ts`, `src/ui/run.ts` | Document it. Later, set an explicit ACL (`icacls /inheritance:r /grant:r %USERNAME%:F`) on the data root |
| 10 | **Two data roots.** Hosts started from the GUI may lack `APPDATA` or `LOCALAPPDATA`. search-hole then falls back to `~/.searchhole`, so the CLI and the host can see different databases. `doctor` warns (`findPopulatedRoots`). | `src/shared/paths.ts` | Check Claude Desktop's environment on Windows. Setting `SEARCHHOLE_HOME` in the host config avoids it |
| 11 | **SQLite on synced or network folders.** WAL locking fails on network shares and is fragile under OneDrive. Antivirus can hold a file briefly, and atomic writes retry `EPERM`/`EBUSY` five times. | `src/store/`, `src/shared/paths.ts` | Document: keep the data root on a local disk |
| 12 | **Unit tests that assert POSIX modes** will fail on Windows: `test/ui/run.test.ts:47` (`ui.json` is 0600) and `test/plugin/build.test.ts:81` (the preflight's exec bit). The first Windows CI run may show more. | `packages/search-hole/test/` | `it.skipIf(process.platform === 'win32')`, as `test/cli/searxng.test.ts` already does |

Paths with spaces are handled throughout:

- the hook command quotes the plugin path;
- `.mcp.json` and the Desktop manifest use exec form;
- skills quote the bundle path;
- every script passes argument arrays, never a shell string.

The one exception is the env prefix in risk 1.

## Turn on pnpm's release-age check (from 2026-11-13)

Add `minimumReleaseAge: 20160` to `pnpm-workspace.yaml`, above `minimumReleaseAgeExclude`. Then `pnpm install --frozen-lockfile` must pass; if it doesn't, the error lists the entries that are still too new. Until then, Renovate's 14-day minimum release age is the gate (ADR-0024).

## Not automated yet

- **Plugin evals** (`claude plugin eval`, MASTER_PLAN §9.1): none exist in the repository yet, and they need an API key. Once they exist, add a CI job gated on an `ANTHROPIC_API_KEY` secret in a protected environment. Never run it on `pull_request` from forks.
- A `.mcpb` code-signing certificate.
