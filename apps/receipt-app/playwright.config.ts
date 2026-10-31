// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from '@playwright/test'

// Installed Google Chrome locally; CI sets E2E_CHANNEL=chromium for Playwright's bundled Chromium.
const channel = process.env.E2E_CHANNEL || 'chrome'

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    baseURL: 'http://localhost:5180',
    channel,
    headless: true,
    viewport: { width: 700, height: 960 },
  },
  webServer: {
    command: 'vite --config e2e/vite.config.ts',
    url: 'http://localhost:5180',
    reuseExistingServer: false,
  },
})
