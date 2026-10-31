// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results',
  use: {
    baseURL: 'http://localhost:5180',
    channel: 'chrome',
    headless: true,
    viewport: { width: 700, height: 960 },
  },
  webServer: {
    command: 'vite --config e2e/vite.config.ts',
    url: 'http://localhost:5180',
    reuseExistingServer: false,
  },
})
