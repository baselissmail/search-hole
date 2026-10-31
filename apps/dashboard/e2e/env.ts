// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const E2E_PORT = 7361
export const BASE = `http://127.0.0.1:${E2E_PORT}`

/** A fresh single-use sign-in code from the running server (the CLI's own path). */
export async function loginCode(): Promise<string> {
  const home = process.env.E2E_HOME
  if (home === undefined) throw new Error('E2E_HOME is not set (global setup did not run)')
  const { loginSecret } = JSON.parse(readFileSync(join(home, 'run', 'ui.json'), 'utf8')) as {
    loginSecret: string
  }
  const res = await fetch(`${BASE}/api/login-code`, {
    method: 'POST',
    headers: { authorization: `Bearer ${loginSecret}` },
  })
  return ((await res.json()) as { code: string }).code
}
