# Third-party notices

search-hole's code is Apache-2.0 (`LICENSE`) and its first-party lists are CC0-1.0 (`lists/LICENSE`). This file records the third-party material shipped in this repository, each item under its own licence (ADR-0016 point 5). Licences are read from each project's LICENSE file, not from GitHub's licence detection.

## Bundled lists

Each list below is vendored unchanged under `lists/vendor/`, after a short `#` comment header that names the source URL, the pinned upstream commit, the licence, the fetch date and the SHA-256 of the upstream bytes. The manifest is `VENDORED_LISTS` in `packages/search-hole/src/lists/catalog.ts`; `node scripts/export-lists.mjs --vendor` re-fetches and verifies them. These files are **not** covered by the CC0 grant in `lists/LICENSE`.

| File | Upstream | Licence | Copyright / dedication | SHA-256 of upstream bytes |
| --- | --- | --- | --- | --- |
| `lists/vendor/quenhus-dev-filter.txt` | [quenhus/uBlock-Origin-dev-filter](https://github.com/quenhus/uBlock-Origin-dev-filter), `dist/other_format/uBlacklist/all.txt` @ `317ca733050b46065715c0307863f741b2147873` | Unlicense | No copyright notice; released into the public domain by its author, quenhus, under the Unlicense | `43dbde8c1189f37cded66f37ff860b8b54faf485dbb4422bd920789791b7b3f7` |
| `lists/vendor/arosh-stackoverflow-translation.txt` | [arosh/ublacklist-stackoverflow-translation](https://github.com/arosh/ublacklist-stackoverflow-translation), `uBlacklist.txt` @ `10e39fd9b7250a777043e06aa976051b995197c4` | CC0-1.0 | No copyright notice; dedicated to the public domain under CC0 1.0 by Sho Iizuka (arosh) | `a63a624170089f52f06541a0c2b375cffb5531abced4ac7f9a49e37885830ee7` |
| `lists/vendor/arosh-github-translation.txt` | [arosh/ublacklist-github-translation](https://github.com/arosh/ublacklist-github-translation), `uBlacklist.txt` @ `bd0bc03be08b308f81368ecbf3919b62c9b313d5` | CC0-1.0 | No copyright notice; dedicated to the public domain under CC0 1.0 by Sho Iizuka (arosh) | `c65dd193cb810062d4f296efd31cacf032b054cf8a80d6c3683f8b0d0c08ef81` |
| `lists/vendor/rjaus-pinterest.txt` | [rjaus/ublacklist-pinterest](https://github.com/rjaus/ublacklist-pinterest), `ublacklist-pinterest.txt` @ `a8c47411f3c4640f0ea2c344853f390912538c3f` | CC0-1.0 | No copyright notice; dedicated to the public domain under CC0 1.0 by Riley James (rjaus) | `6eb10a6c5dea3276ab49c072b92d77cdab78698f0d89458f45d242228f34f557` |
| `lists/vendor/laylavish-huge-ai.txt` | [laylavish/uBlockOrigin-HUGE-AI-Blocklist](https://github.com/laylavish/uBlockOrigin-HUGE-AI-Blocklist), `list_uBlacklist.txt` @ `dad86686d247fbf9845750106f6b4e7065f56703` | CC0-1.0 | No copyright notice; dedicated to the public domain under CC0 1.0 by laylavish | `183d61171872d8556d68b0551a38ff76ec0a89566f08e83feea17408fa2401ce` |

All five were fetched on 2026-10-31. The licence texts are the unmodified Unlicense and the unmodified CC0 1.0 Universal legal code, neither of which requires attribution; the notices above are given as a courtesy.

Note on `quenhus-dev-filter`: its README names its sources as the two arosh lists above (CC0-1.0), [stroobants-dev/ublock-origin-shitty-copies-filter](https://github.com/stroobants-dev/ublock-origin-shitty-copies-filter) (MPL-2.0) and a gist by quenhus. The file vendored here is the one quenhus distributes under the Unlicense.

## First-party lists built from third-party evidence

`github-clones` (CC0-1.0) takes its domains and evidence links from the `domain-list.yml` files of the two arosh lists above, which are CC0-1.0. `ai-content-farms` (CC0-1.0) cites block requests in [popcar2/BadWebsiteBlocklist](https://github.com/popcar2/BadWebsiteBlocklist) (CC0-1.0) and names other lists only as corroboration; nothing is copied from the GPL-3.0 list it cites.

## Catalog-only lists

Lists in the catalog (`packages/search-hole/src/lists/catalog.ts`) that are not vendored are not distributed with search-hole; users subscribe to them by URL. Lists under GPL, AGPL or EUPL, lists with no licence (including Brave's public Goggles) and lists whose licence is unclear are only ever catalog entries.

## Adapted code

Adapted code fragments, with their licence and copyright line, are recorded here alongside the code that adapts them.
