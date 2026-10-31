# ADR-0024: Release engineering — CI, provenance, supply chain

**Status:** Accepted (2026-11-01)
**Related:** [0002](0002-runtime-and-packaging.md), [0016](0016-licensing.md), MASTER_PLAN §11 P8, §12; checklist in [docs/release.md](../release.md)

## Context

P8 needs CI on Linux, macOS and Windows, releases with provenance, and supply-chain hygiene. Until Basel creates the GitHub repository, nothing is pushed or published.

## Decision

1. **CI** (`.github/workflows/ci.yml`):
   - Biome, SPDX headers, typecheck, layer check and token budgets.
   - On all three OSes: build, unit tests, a bundle smoke test (home path with spaces), plugin assembly, the Windows preflight under PowerShell and Git Bash, and `.mcpb` pack/validate.
   - Size budgets and `claude plugin validate --strict`.
   - Playwright and axe e2e on bundled Chromium.
   - A job that runs on the Node floor read from `engines.node`.
   - DCO on PRs, with a single `ci-ok` gate.
2. **Release** (`release.yml`, a `v*` tag or manual with dry run as the default):
   - **Verify:** a signed, annotated tag that matches every version string and the changelog.
   - **Build:** build and test; pack the npm tarball, plugin zip and `.mcpb`; produce a CycloneDX SBOM.
   - **Publish:** `npm publish --provenance` through trusted publishing behind an `npm` environment, then a GitHub release with attestations and `SHA256SUMS`.
   - **Limits:** top-level `permissions: {}`, and it runs only in `baselissmail/search-hole`.
3. **Supply chain:**
   - Actions are pinned to commit SHAs.
   - Renovate pins exact versions with a **14-day minimum release age**. The same two-week rule applies to versions chosen by hand, and pnpm's `minimumReleaseAge` enforces it for transitive dependencies.
   - CodeQL (security-extended) and an OpenSSF Scorecard.
4. **The runtime floor is Node 22.19** (ADR-0002 amendment). The bundled undici 8 needs zlib zstd.
5. **Notices ship with every artifact.** `LICENSE` and `THIRD_PARTY_NOTICES.md` are copied into `dist/`, so the npm package, the plugin and the `.mcpb` carry them.

## Consequences

- **What Basel must set up once:** the repository, rulesets, the `npm` and `release` environments, the npm trusted publisher and the Renovate app (docs/release.md, step 0). Signing the `.mcpb` waits for a certificate.
- **Plugin evals aren't wired yet.** They need an API key and an eval suite.
- **The dogfood gate** (two weeks, no open P0/P1 in `docs/dogfood.md`) and the launch posts (drafts in `docs/launch/`) are Basel's.
