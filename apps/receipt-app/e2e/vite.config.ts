// SPDX-License-Identifier: Apache-2.0
// Serves the test host page; the built panel (dist/receipt.html) is its public file.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: fileURLToPath(new URL('../dist', import.meta.url)),
  server: { port: 5180, strictPort: true },
})
