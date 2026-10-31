// SPDX-License-Identifier: Apache-2.0
/**
 * Runs first (main.tsx imports it before anything else). The CSP allows no inline script, so the
 * theme is applied here, before the first render, and the single-use login code is taken out of
 * the URL before the router reads it.
 */
import { captureLoginCode } from './lib/session.ts'
import { applyStoredTheme } from './lib/theme.ts'

applyStoredTheme()
captureLoginCode()
