// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs'
import babel from '@rolldown/plugin-babel'
import tailwindcss from '@tailwindcss/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import { defineConfig, type Plugin, type ProxyOptions } from 'vite'

/** Where `searchhole ui` listens (ADR-0004 point 2). Only the dev server uses it. */
const UI_SERVER = 'http://127.0.0.1:7341'

/**
 * sonner adds its stylesheet at runtime with an inline `<style>` element, which the dashboard's
 * CSP (`style-src 'self'`) refuses. The same CSS is bundled from `sonner/dist/styles.css`, so the
 * runtime injection is cut from the build. The version is pinned; the build fails loudly if the
 * call disappears.
 */
function sonnerWithoutInlineStyle(): Plugin {
  return {
    name: 'search-hole:sonner-without-inline-style',
    apply: 'build',
    transform: {
      filter: { id: /[\\/]sonner[\\/]dist[\\/]index\.mjs$/ },
      handler(code) {
        const next = code.replace(/__insertCSS\("(?:[^"\\]|\\.)*"\);?/, '')
        if (next === code) this.error('sonner no longer calls __insertCSS("…"): review this plugin')
        return { code: next, map: null }
      },
    },
  }
}

/** Ship the Geist font licence (SIL OFL 1.1) next to the bundled font files. */
function geistLicence(): Plugin {
  return {
    name: 'search-hole:geist-licence',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'assets/geist-font-LICENSE.txt',
        source: readFileSync(new URL('./node_modules/geist/LICENSE.txt', import.meta.url), 'utf8'),
      })
    },
  }
}

/**
 * Dev only: forward API calls to a running `searchhole ui`. The server checks `Host` and, on
 * writes, `Origin`, so both are rewritten to the server's own origin.
 */
const toUiServer: ProxyOptions = {
  target: UI_SERVER,
  changeOrigin: true,
  configure(proxy) {
    proxy.on('proxyReq', (req) => {
      if (req.getHeader('origin')) req.setHeader('origin', UI_SERVER)
    })
  },
}

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    sonnerWithoutInlineStyle(),
    geistLicence(),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Never inline assets as data: URIs; the CSP only allows same-origin fonts and images.
    assetsInlineLimit: 0,
    // Browsers with native light-dark(): older targets make Lightning CSS polyfill it from the
    // OS preference, so a theme chosen in Settings would be ignored.
    cssTarget: ['chrome123', 'edge123', 'firefox120', 'safari17.5'],
    modulePreload: { polyfill: false },
    sourcemap: false,
    // One bundle, served from localhost. The budget that matters is MASTER_PLAN §12.3:
    // initial JS at most ~250 KB gzipped (v1 is ~233 KB). This limit is on minified size.
    chunkSizeWarningLimit: 800,
  },
  server: {
    proxy: {
      '/api': toUiServer,
      '/session': toUiServer,
      '/health': toUiServer,
    },
  },
})
