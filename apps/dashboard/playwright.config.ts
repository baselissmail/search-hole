// SPDX-License-Identifier: Apache-2.0
// End-to-end checks against the real `searchhole ui` (P4 acceptance, MASTER_PLAN §11).
import { defineConfig } from '@playwright/test'
import { BASE } from './e2e/env.ts'

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  reporter: 'list',
  outputDir: 'test-results',
  use: { baseURL: BASE, channel: 'chrome', headless: true, viewport: { width: 1360, height: 860 } },
})
