import { defineConfig } from 'tsdown'

// One self-contained ESM bundle with no runtime node_modules (ADR-0002).
export default defineConfig({
  entry: { searchhole: 'src/cli/main.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22.13',
  outDir: 'dist',
  outExtensions: () => ({ js: '.mjs' }),
  noExternal: [/.*/],
  clean: true,
  minify: false,
  sourcemap: true,
})
