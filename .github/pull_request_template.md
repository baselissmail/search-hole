<!-- Thanks for contributing to search-hole. See CONTRIBUTING.md. -->

## What and why

<!-- One or two sentences. Link the issue or ADR if there is one. -->

## How I checked it

<!-- Commands you ran and what you saw. For UI changes, a screenshot in light and dark. -->

## Checklist

- [ ] Every commit is signed off (`git commit -s`, DCO), with the same email as the commit author.
- [ ] `pnpm check` passes (Biome, typecheck, layer check, unit tests).
- [ ] New code files start with `// SPDX-License-Identifier: Apache-2.0` (`pnpm check:spdx`).
- [ ] After a build, `pnpm check:size` is within budget (dashboard, receipt panel, CLI).
- [ ] A non-obvious decision has an ADR in `docs/adr/` (or this PR amends one).
- [ ] User-visible changes are under `## [Unreleased]` in CHANGELOG.md.
- [ ] No API keys, tokens, private hostnames or personal data in code, tests, fixtures or logs.
- [ ] List changes only: each site has public evidence, and I contribute it under CC0-1.0.
