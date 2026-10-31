// SPDX-License-Identifier: Apache-2.0
// One self-contained receipt.html (ADR-0021): hosts load MCP Apps from a single HTML resource,
// with no network, so every script and style is inlined.
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input: 'receipt.html' },
    // Fonts come from the host; nothing to inline as data: (blocked by the default app CSP).
    assetsInlineLimit: 0,
    // Browsers with native light-dark(): older targets make Lightning CSS polyfill it from the
    // OS preference, which ignores the host theme that applyDocumentTheme sets inline.
    cssTarget: ['chrome123', 'edge123', 'firefox120', 'safari17.5'],
  },
})
