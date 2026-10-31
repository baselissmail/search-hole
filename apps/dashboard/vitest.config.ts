// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config'

// Pure-logic tests only (SSE parsing, the log reducer, URL and text helpers): no DOM, no plugins.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
