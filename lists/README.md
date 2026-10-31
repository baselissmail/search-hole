# First-party lists

Lists written and maintained by search-hole, licensed CC0-1.0 (see `LICENSE` here; ADR-0016). The source of truth is the TypeScript module named below, which keeps every entry's evidence; the `.txt` files here are generated copies for other tools.

| List | Kind | Default mode | Entries | Source | What it does |
| --- | --- | --- | --- | --- | --- |
| `official-docs` | official | enforce (annotation) | 96 | `packages/search-hole/src/lists/bundled/official-docs.ts` | Marks official documentation sites as `official` in results and receipts; the default profile ranks them higher. Never hides anything. |
| `official-health` | official | enforce (annotation) | 111 | `packages/search-hole/src/lists/bundled/official-health.ts` | Marks health ministries, public-health agencies, medicines regulators and a few clinical reference sites (Mayo Clinic, Cleveland Clinic, Johns Hopkins, MSD Manuals, Cochrane) as `official`. Never hides anything. |
| `github-clones` | clone | enforce | 172 | `packages/search-hole/src/lists/bundled/github-clones.ts` | Hides sites that republish Stack Exchange or GitHub content wholesale. |
| `ai-content-farms` | content-farm | audit | 21 | `packages/search-hole/src/lists/bundled/ai-content-farms.ts` | Records "would hide" for sites that mass-publish machine-generated articles; the user can enforce it after trying it. |

## Text files

`<id>.txt` is the list in a form other blockers read:

- It starts with `! License: CC0-1.0`, then `! Title`, `! Description`, `! Homepage`, `! Expires` and a pointer to the source module. `!` lines are comments.
- A host entry is a plain domain line (`example.com` covers the domain and its subdomains). uBlacklist reads it as a subscription of type "domains"; AdGuard Home, Pi-hole and search-hole's `domains` format read it as is.
- A host + path entry is a uBlacklist match pattern (`*://*.lightrun.com/answers/*`). Plain-domain readers skip that line, which errs on the side of not blocking the whole host.
- In the block lists, the `!` line above each entry gives its evidence.

Don't edit the `.txt` files by hand. Change the module, then run `node scripts/export-lists.mjs` (`--check` verifies they are in sync; the test suite checks it too).

## Vendored third-party lists

`vendor/` holds unchanged copies of the third-party starter lists whose licences permit it (ADR-0017 point 7). **They are not CC0**: each keeps its own licence, named in its header and in `THIRD_PARTY_NOTICES.md`. The catalog of lists you can subscribe to is `packages/search-hole/src/lists/catalog.ts`.

## Contributing

Contributions are accepted under CC0-1.0 only, and every entry needs public evidence:

- **official-docs / official-health:** a link showing the site belongs to the project or the health authority (its Wikidata "official website", or a page of the project or authority naming the domain). When a domain is shared by a whole government (`canada.ca`, `gov.br`), list only the health section's path.
- **github-clones:** the URL of a copied page and the original it copies. Where only one section of an ordinary business's site republishes, list that path, not the host. Whole platforms that merely host some copied posts don't belong here.
- **ai-content-farms:** a public report with example pages and what shows they are generated (the same article on several domains, invented authors, false facts), or listings in independent community lists. A site that merely uses AI somewhere doesn't belong here.

Prefer the narrowest match that covers the problem, and don't add an entry that another entry in the same list already covers.
