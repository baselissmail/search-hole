// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config'

// Logic tests (SSE parsing, the log reducer, URL and text helpers, actions against the dev mock)
// and components rendered to static markup with react-dom/server: no DOM, no plugins. What needs
// a browser (clicks, focus, axe) is in e2e/.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
