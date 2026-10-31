// SPDX-License-Identifier: Apache-2.0
import './boot.ts'
import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.tsx'
import { signIn } from './lib/login.ts'
import { createQueryClient } from './lib/queries.ts'
import { takeLoginCode } from './lib/session.ts'

async function start(): Promise<void> {
  let code = takeLoginCode()
  // Dev only, and only with `?mock` in the URL: fixture data instead of a server. The whole
  // branch, and the mock module with it, is removed from production builds.
  if (import.meta.env.DEV) {
    const { installDevMock } = await import('./dev/mock.ts')
    code = installDevMock(code)
  }
  const root = document.getElementById('root')
  if (!root) throw new Error('index.html has no #root element')
  createRoot(root).render(
    <StrictMode>
      <App queryClient={createQueryClient()} />
    </StrictMode>,
  )
  await signIn(code)
}

void start()
