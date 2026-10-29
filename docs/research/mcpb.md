# modelcontextprotocol/mcpb
> Ref: `research/refs/mcpb` @ 70fe3b3 (2026-04-22) · License: the root `LICENSE` is the MCP transition text. New code is Apache-2.0; contributions not yet relicensed stay MIT ("Copyright (c) 2024-2025 Model Context Protocol a Series of LF Projects, LLC.", `LICENSE` line 188); non-spec docs are CC-BY-4.0. There are no per-directory LICENSE files and no NOTICE file. `package.json` says `"license": "MIT"`.

## Purpose
This repo defines the **MCP Bundle** (`.mcpb`, formerly `.dxt`) format: a ZIP holding a local MCP server plus `manifest.json`. It ships three things:
- the spec (`MANIFEST.md`, "Current version: `0.3`, Last updated: 2025-12-02")
- the CLI `@anthropic-ai/mcpb` **2.1.2** (`package.json`, bin `dist/cli/cli.js`)
- "the code used by Claude for macOS and Windows to load and verify MCPB bundles" (`README.md`)

For search-hole it settles the Claude Desktop extension (plan §9.2, P5): the manifest shape, how API keys flow in, the runtime choice (node or binary), and signing.

## Architecture sketch
```
dev:  dir/ (manifest.json + server files) ──mcpb validate──► zod strict schema + file checks
                                           ──mcpb pack────► ZIP (fflate, level 9) → name.mcpb
                                           ──mcpb sign────► ZIP ‖ MCPB_SIG_V1 ‖ len(u32 LE) ‖ PKCS#7 DER ‖ MCPB_SIG_END
host: .mcpb ──verify (PKCS#7 + OS trust store)──► unpack ──collect user_config (UI)──►
      getMcpConfigForManifest(manifest, extensionPath, systemDirs, userConfig) ──► spawn {command,args,env} over stdio
```
- Modules: `src/schemas/{0.1..0.4}.ts` (strict), `src/schemas_loose/*` (`.passthrough()`), `src/shared/config.ts` (substitution), `src/node/{validate,sign,files}.ts`, and `src/cli/{cli,init,pack,unpack}.ts`.
- Runtime deps: `commander`, `fflate`, `node-forge`, `ignore`, `galactus` (dev-dependency pruning), `@inquirer/prompts`, and **`zod ^3.25`**, not zod 4.

## Key modules and data flow
- **Version resolution** (`src/shared/constants.ts`):
  - `LATEST_MANIFEST_VERSION = "0.4"`
  - `DEFAULT_MANIFEST_VERSION = "0.3"`, which `mcpb init` uses (`src/cli/init.ts` line 880)
  - `getManifestVersionFromRawData` reads `manifest_version`, or the deprecated `dxt_version` (`src/shared/manifestVersionResolve.ts`)
  - **0.4 differs from 0.3 only by adding `server.type: "uv"`** (`diff src/schemas/0.3.ts src/schemas/0.4.ts`). The 0.3 source still has the header comment `// WIP: This schema is under development and not yet finalized`.
- **Substitution**, which is what Desktop runs (`src/shared/config.ts: getMcpConfigForManifest`, lines 94–182):
  - (1) If `platform_overrides[process.platform]` exists, its `command` and `args` **replace** the base values, and its `env` is **merged** into the base env.
  - (2) If any `required` user_config value is missing (`undefined`, `null`, `""`, or an empty or holed array), the function returns `undefined` and logs "has missing required configuration, skipping MCP config". The server is not launched.
  - (3) The variable set is built: `__dirname` = install dir, `pathSeparator`, `/`, the host-supplied `systemDirs`, then `user_config.<k>` from manifest `default`s overridden by user values. Booleans become `"true"`/`"false"`, numbers go through `String()`, and arrays stay arrays.
  - (4) `replaceVariables` walks the config recursively. An arg that is exactly `${user_config.X}` with an array value expands into several args. **Unknown or unset variables are left verbatim** (`test/config.test.ts` line 74, "should handle undefined variables by keeping them as-is").
- **Pack** (`src/cli/pack.ts: packExtension`):
  - It validates with the strict schema, collects files (`EXCLUDE_PATTERNS` plus `.mcpbignore` via the `ignore` package) and zips them with `zipSync(level: 9, mtime: new Date())`.
  - It preserves Unix modes and **forces +x only on a `binary` `entry_point`** (lines 228–247).
  - It prints the package and unpacked sizes plus a sha1 `shasum`.
  - Output defaults to `<basename(dir)>.mcpb`. `-m/--manifest <path>` injects a different manifest into the archive.
- **Clean** (`src/node/validate.ts: cleanMcpb`, line 418): unpack, re-serialize the manifest through the *loose* schema, prune dev dependencies from `node_modules` (`galactus` `DestroyerOfModules`), then re-pack.

## Data model and storage
n/a: the toolchain stores nothing. Hosts persist the user_config values. The repo only says `sensitive` means "mask input and store securely" (`MANIFEST.md` §User Configuration). **"Keychain" appears nowhere in the ref**; grep for `keychain|keytar|safeStorage` returns nothing. The plan's keychain claim (§3) has to be verified against Desktop docs.

## Config format
`manifest.json`, 0.3 strict schema (`src/schemas/0.3.ts`, every object is `z.strictObject`, so unknown keys are rejected):
- **Required**: `manifest_version` (or `dxt_version`) `"0.3"`, `name`, `version`, `description`, `author{name, email?, url?}`, `server`.
- **`server`** = `{type: "python"|"node"|"binary", entry_point: string, mcp_config}`. **`mcp_config` is required** = `{command: string, args?: string[], env?: Record<string,string>, platform_overrides?: Record<string, Partial<{command,args,env}>>}`. The override keys are free strings and are matched against `process.platform`.
- **`compatibility`** = `{claude_desktop?: semver-range, platforms?: ("darwin"|"win32"|"linux")[], runtimes?: {python?, node?}}`.
  - MANIFEST.md (§Compatibility) says any client name can be added, e.g. `"my_client": ">1.0.0"`. The **strict schema rejects that**, and only the loose one passes it through (`src/schemas_loose/0.3.ts` line ~41).
- **`user_config`**: `Record<key, {type: "string"|"number"|"boolean"|"directory"|"file", title, description, required?, default?: string|number|boolean|string[], multiple?, sensitive?, min?, max?}>`.
- **Optional metadata**:
  - `display_name`, `long_description` (markdown), `repository{type,url}`, `homepage`, `documentation`, `support`, `keywords`, `license`
  - `icon` (local PNG), `icons[{src, size:"WxH", theme?}]`, `screenshots[]`
  - `localization{resources: "…${locale}…", default_locale: BCP47}`; the default resources path is `mcpb-resources/${locale}.json`
  - `tools[{name, description?}]`, `tools_generated`, `prompts[{name, description?, arguments?, text}]`, `prompts_generated`
  - `privacy_policies[url]`: "Required when the extension connects to external services … that process user data" (`MANIFEST.md` §Optional Fields)
  - `_meta: Record<reverse-DNS, Record<string, any>>`, e.g. `com.microsoft.windows.package_family_name` and `static_responses.initialize` (`MANIFEST.md` lines ~175–190)
- **Variables**: MANIFEST.md lists `${__dirname}`, `${HOME}`, `${DESKTOP}`, `${DOCUMENTS}`, `${DOWNLOADS}`, `${pathSeparator}`/`${/}` and `${user_config.KEY}` for `mcp_config`. **But `mcpb validate` rejects everything except `${__dirname}`, `${pathSeparator}`, `${/}` and `${user_config.*}` in `mcp_config`** (`src/node/validate.ts: VALID_VARIABLE_PATTERN`, line 173, checked at line 204). `${HOME}` remains legal in `user_config.*.default` (`examples/hello-world-node/manifest.json`, `workspace_directory`).
- MANIFEST.md says Windows hosts "automatically append `.exe`" to binaries. That logic is **not** in `getMcpConfigForManifest` (grep for `.exe` in `src/` finds only PowerShell), so set the `win32` override explicitly.

## Extension points (plugins, hooks)
- `_meta` reverse-DNS namespaces are the only extension slot in the strict schema.
- The library exports (`src/index.ts`, `./node`, `./browser`, `./schemas`, `./schemas-loose`) expose `getMcpConfigForManifest`, `replaceVariables`, `hasRequiredConfigMissing`, `validateManifest`, `signMcpbFile`, `verifyMcpbFile` and `packExtension`. A host or CI can call them directly.
- `tools_generated` / `prompts_generated` tell the host to expect more capabilities at runtime than the manifest lists.

## Rules / lists: parsing and compilation
n/a: no rules or lists. The nearest analogue is `.mcpbignore` (gitignore syntax via `ignore`, combined with `EXCLUDE_PATTERNS`, `src/node/files.ts`). The defaults exclude `*.map`, `*.d.ts`, `tsconfig.json`, `.env*`, lockfiles, `node_modules/.bin`, `node_modules/.cache` and `*.mcpb`.

## Testing strategy
- Jest suites (`test/*.test.ts`):
  - `config.test.ts`: substitution, array expansion, `hasRequiredConfigMissing`
  - `validate.test.ts`: entry point, variables, sensitive files
  - `schemas.test.ts`: `_meta`, localization, icons
  - `icon-validation`, `mcpbignore`, `cli` (pack/unpack round trip) and `init`
  - `sign.e2e.test.ts`: real PKCS#7 sign/verify/unsign
- Validation adds static checks we get for free (`src/node/validate.ts`):
  - the icon must be a local PNG (magic-byte check) and must not use `${__dirname}`; 512×512 is recommended
  - the entry point must exist, and its extension must match `type`
  - a binary entry point needs +x on Unix
  - warnings for sensitive files (`*.pem`, `*.key`, `credentials.json`, `token.json`, `.ssh/`, …)

## UX patterns worth copying
- `user_config` fields have a `title`, a `description` and typed pickers (`directory`/`file` with `multiple`). Desktop renders them as a settings form. Booleans and numbers have `min`/`max`.
- `mcpb info` / `mcpb verify` print publisher, issuer, validity dates and the SHA-256 fingerprint, and warn when self-signed (`CLI.md`). This is a good model for a `searchhole doctor --bundle` line.
- Per-locale resource files keep the manifest lean, which leaves room for Arabic later (plan §8.1 RTL).

## Performance tricks
- `type: "uv"` (0.4) has the host install Python dependencies, so the bundle is "~100 KB vs 5-10 MB" (`MANIFEST.md` §UV Runtime). That doesn't apply to us.
- `mcpb clean` prunes dev dependencies. A single tsdown bundle makes `node_modules` unnecessary in the first place.
- **No size limit exists anywhere in the toolchain.** `pack` only reports sizes (`src/cli/pack.ts`, lines 168–270), and grep for `max|limit` in `src/` finds only `user_config` `min/max`. Any host-side cap is unknown (inferred).

## License and what it means for us
The code is Apache-2.0 or MIT. We can copy or adapt snippets, such as the substitution semantics for a test fixture, with attribution and the Apache-2.0 and MIT notices. In practice we use the CLI as a dev dependency and need to copy nothing.

## Implications for search-hole
- [runtime-packaging] **Use `type: "node"` with one bundled ESM file, `server/gateway.mjs`.**
  - `README.md` §"Language Choice Recommendation": "Node.js ships with Claude for macOS and Windows, which means your bundle will work out-of-the-box". That confirms plan §3. The Node **version is not stated** anywhere in the ref.
  - Use `mcp_config: {command: "node", args: ["${__dirname}/server/gateway.mjs", "--host", "claude-desktop"]}`.
  - Declare `compatibility.runtimes.node` honestly. Whether Desktop enforces it against its bundled Node is not in the ref (inferred).
  - At startup the gateway must check `process.versions.node` and the SQLite driver it needs, and fail with a clear MCP-visible message, not a crash.
- [sqlite-driver] Since the Desktop Node version is unknown, `node:sqlite` is a gamble here. It is experimental on Node 22/24 (plan §4), and flags like `--experimental-sqlite` could go in `args` (inferred). Prefer the option that already works with no native module (plan option b), or measure Desktop's actual `process.version` in P5 before committing (ADR).
- [runtime-packaging] **A `binary` bundle can ship per-OS binaries, but not per-arch ones.**
  - `platform_overrides` is keyed only by `process.platform` (`src/shared/config.ts` line 115), and `compatibility.platforms` has no architecture field.
  - darwin-arm64 vs darwin-x64 therefore needs one of: a universal macOS binary, one `.mcpb` per arch (built from one directory with `mcpb pack -m manifests/<target>.json`), or a launcher script (inferred).
  - Windows needs `platform_overrides.win32.command: "${__dirname}/server/searchhole.exe"`, since `.exe` is not auto-appended in this code.
  - Only `entry_point` gets a forced +x. Any other binary must already carry +x on a Unix build host (`src/cli/pack.ts` lines 228–247), so build on macOS/Linux CI.
- [key-storage] Map each engine key to an **optional** sensitive string, e.g. `brave_api_key: {type:"string", sensitive:true, required:false}` → `env.SEARCHHOLE_BRAVE_API_KEY: "${user_config.brave_api_key}"`.
  - **Never mark keys `required`.** One missing required value means Desktop launches nothing (`hasRequiredConfigMissing`), which breaks the zero-config start.
  - **An unset optional key arrives as the literal string `${user_config.brave_api_key}`** (`replaceVariables` keeps unknown variables). The key resolver must treat `/^\$\{[^}]+\}$/` as "unset" before falling through to process env and our own store (plan §4 resolution order).
  - Only Desktop's gateway process sees these values, so it must write per-engine health to the DB as plan §4 requires.
- [key-storage] The ref promises only "mask input and store securely" for `sensitive`. Keep the plan's keychain claim as "per Desktop docs" until verified. Never log `process.env` in the gateway.
- [upgrades-migrations] `README.md` lists "automatic updates" among Desktop's features. Expect a Desktop-updated gateway to run alongside an older plugin or npx gateway against the same DB. This reinforces plan §4's migration lock and the read-only-on-newer-schema rule.
- [distribution] Target **`manifest_version: "0.3"`**: it is the `init` default, we don't need `uv`, and older hosts that only know 0.3 still accept it (inferred). The strict schema allows only `claude_desktop`, `platforms` and `runtimes` under `compatibility`, so don't add other client keys.
- [distribution] Fill in `privacy_policies` with each remote engine's policy URL (Brave, Kagi, Tavily, Exa, Mojeek), because the spec requires it when the extension sends user data to external services. Add our own no-telemetry statement in `long_description`. List the model-visible tools in `tools` (`search`, `fetch`, `receipt`, `suggest_rule`) and leave out the app-only `apply_rule`.
- [distribution] Signing: `mcpb sign --cert --key [--intermediate…]` produces a detached SHA-256 PKCS#7 with signingTime and patches the ZIP EOCD comment length, so the file stays a valid ZIP (`src/node/sign.ts: signMcpbFile`).
  - **`verifyMcpbFile` reports `"unsigned"` whenever the chain fails OS trust** (line ~204). The trust tools are macOS `security verify-cert -p codeSign`, Windows `X509Chain` with online revocation plus the code-signing EKU, and Linux `openssl verify -purpose codesigning`.
  - So `--self-signed` adds nothing for users. "Signed if possible" (plan §9.2) means buying a CA code-signing certificate; otherwise ship unsigned and publish the sha256 next to the release.
- [security] Turn the validator's sensitive-file warnings into CI errors: `mcpb validate` and then `pack` must print no "Potentially sensitive file" lines. Also assert that the archive has no `.env*` and no source maps. `.env*` and `*.map` are excluded by default, but CI should still check.
- [testing] In CI: `npx @anthropic-ai/mcpb@2.1.2 validate distribution/mcpb/manifest.json`, then `pack`, then `info`. Add a vitest that imports `getMcpConfigForManifest` from `@anthropic-ai/mcpb` (a dev dependency; its internal zod 3 is isolated) and checks three cases:
  - (a) with no user config, every key env holds the literal placeholder and our resolver reports "unset"
  - (b) with a key set, it substitutes
  - (c) the `win32` override yields the `.exe` path
- [runtime-packaging] `pack` stamps `mtime: new Date()`, so archives are not byte-reproducible (inferred: the shasum changes on every pack). For provenance, publish our own sha256 from the CI artifact, and don't try to reproduce it.
- [session-definition] n/a in the ref. The plan's note that Desktop keeps one process for many chats is not documented here, so the session ADR must use process lifetime plus an idle gap for Desktop.
- [ui-ux] Use `icons` with light and dark 512×512 PNGs and a `display_name` of "search-hole". `long_description` is markdown, so put the honest-limits text from plan §2.6 there.

## Borrow / avoid
**Borrow**
- `getMcpConfigForManifest` as the oracle for Desktop's env and args in our tests.
- The `-m/--manifest` flag to build per-target bundles from one staged directory.
- The validator's sensitive-file pattern list, reused for our own release-artifact check.
- The `mcpb info`/`verify` output fields (publisher, fingerprint, validity) for `searchhole doctor`.

**Avoid**
- `${HOME}`/`${DOCUMENTS}` in `mcp_config`, which the validator rejects. Resolve `~/.searchhole` in the gateway with `os.homedir()` and the XDG/AppData logic.
- `required: true` on any key; extra `compatibility` client keys; `type: "uv"` or `manifest_version: "0.4"` without a reason.
- Shipping `node_modules`. Bundle to one file instead; the README's "npm install --production" advice inflates the bundle.
- Relying on `.exe` auto-append, on `--self-signed`, or on the `README.md` prompt template's `@modelcontextprotocol/sdk` (v1) advice.
