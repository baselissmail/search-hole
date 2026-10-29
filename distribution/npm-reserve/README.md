# npm name reservation (manual, Basel only)

These two placeholder packages reserve `search-hole` and `searchhole` on npm (MASTER_PLAN header). Publishing needs Basel's npm account, so the build session does not do it.

```sh
npm login                      # once
cd distribution/npm-reserve/search-hole && npm publish --access public
cd ../searchhole && npm publish --access public
npm deprecate searchhole@0.0.1 "Use search-hole instead"   # optional, keeps the alias pointing to the real package
```

The first real `search-hole` release (P8) publishes from `packages/search-hole/` with a higher version and npm provenance.
