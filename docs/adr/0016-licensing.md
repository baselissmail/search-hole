# ADR-0016: Licensing (code, first-party lists, contributions)

- **Status:** Accepted (2026-10-30). Taken by the builder after Basel delegated the §13 calls ("be sure how we could do it as useful as possible"). Reversible free of cost until the first outside contribution lands, so Basel can still flip it.
- **Related:** MASTER_PLAN §12.5, §13 question 2; [SYNTHESIS §9](../research/SYNTHESIS.md)

## Context

§13 asks: MIT (like smart-doctor) or Apache-2.0? The plan also needs a licence for the first-party lists (`official-docs`, `official-health`, `github-clones`, `ai-content-farms`), which are the moat and the part we want others to reuse. Facts:

- **The MCP ecosystem is moving to Apache-2.0.** The spec, TypeScript SDK, Inspector, ext-apps and mcpb are all mid-transition (Apache-2.0 for new code, MIT for older contributions without consent).
- **We will adapt small amounts of Apache-2.0 code** (ToolHive's revision classifier, agentgateway's header parser) and MIT code (nightshift, uBlacklist, smart-doctor). None of those repos ships a NOTICE file. Both licences are compatible with either choice for the project.
- **Licences of the seed lists:** CC0, Unlicense, MIT, BSD-3, Apache-2.0 and WTFNMFPL are bundleable; GPL lists are subscribe-only. Most of the uBlacklist and uBO list ecosystem uses CC0 or Unlicense.
- **One persona is a team lead** rolling search-hole out across a company (§1), where legal teams prefer explicit patent terms.

## Decision

1. **Code: Apache-2.0.** This means a `LICENSE` file with the official text and SPDX headers (`// SPDX-License-Identifier: Apache-2.0`) in source files. Reasons:
   - the **patent grant and termination clause** (§3);
   - **explicit contribution terms** (§5: "inbound = outbound" without a CLA);
   - alignment with the MCP ecosystem.

   The cost over MIT is small: a longer file, and keeping attribution headers on adapted code. Basel's own smart-doctor code (MIT) can be reused freely, because he holds its copyright.
2. **First-party lists: CC0-1.0**, in `lists/LICENSE`. Every list file starts with a `! License: CC0-1.0` header line. CC0 maximises reuse by uBlacklist, uBO, AdGuard and Pi-hole users and by other tools, which is what grows the list ecosystem (the moat is maintenance and brand, not exclusivity). List contributions are accepted under CC0 only, with evidence (§12.6).
3. **Docs are Apache-2.0** along with the code, so there's one licence to explain.
4. **Contributions use the DCO** (`Signed-off-by:`, checked in CI), not a CLA. CONTRIBUTING states that code contributions are Apache-2.0 and list contributions are CC0.
5. **Third-party material:**
   - Bundled lists keep their own licences, recorded per list (from the LICENSE file, not GitHub's `spdx_id`).
   - `THIRD_PARTY_NOTICES.md` lists every bundled list and every adapted code fragment, with its licence and copyright line.
   - We never copy GPL, AGPL or EUPL code (§10).
6. **Trademarks** (§12.5): no Pi-hole, Brave or Kagi names or logos in branding. Descriptive use ("imports Brave Goggles") is fine.

## Alternatives considered

- **MIT for code.** Simpler and matches smart-doctor, but it has no patent grant. It remains a reasonable fallback if Basel prefers it, and switching before the first outside contribution costs nothing.
- **CC-BY-4.0 for lists.** Rejected: attribution requirements are awkward for blocklist consumers, who merge many lists, and most peers use CC0/Unlicense.
- **The same licence (Apache-2.0) for lists.** Rejected: code licences fit data lists poorly, and the NOTICE and attribution mechanics deter reuse by other blockers.
- **A CLA.** Rejected: friction for list contributors, who are the people we most need.

## Consequences

- The repo gets `LICENSE` (Apache-2.0), `lists/LICENSE` (CC0-1.0) and `THIRD_PARTY_NOTICES.md` at P1 start.
- `package.json` sets `"license": "Apache-2.0"`.
- CI adds a DCO check and an SPDX-header check in P8.
