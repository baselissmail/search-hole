// SPDX-License-Identifier: Apache-2.0
/**
 * The MCP gateway entry (`searchhole mcp --host <profile>`). The App module (store, engines,
 * fetcher) is imported only when the first tool call needs it, so a `server/discover` probe or
 * a `tools/list` from a cold process stays fast and leaves no trace (ADR-0013 point 3).
 */
import type { CreateApp } from '../app/types.ts'
import { Gateway, type GatewayHandle, type GatewayOptions, serveGatewayStdio } from './gateway.ts'

export { Gateway, type GatewayHandle, type GatewayOptions, SERVER_NAME } from './gateway.ts'
export { refineHostProfile } from './host.ts'
export { SERVER_INSTRUCTIONS } from './instructions.ts'

/** Loads the App module on first use (see the file header). */
const lazyCreateApp: CreateApp = async (opts) => {
  const mod = await import('../app/index.ts')
  const create: CreateApp = mod.createApp
  return create(opts)
}

/**
 * Starts the stdio gateway for a host profile (refined from the environment, ADR-0012) and
 * returns once it is serving. It never writes to stdout outside the protocol; logs go to
 * stderr. `closed` resolves after stdin EOF, once resources are released.
 */
export async function startGateway(opts: GatewayOptions): Promise<GatewayHandle> {
  const gateway = new Gateway(opts, { createApp: lazyCreateApp })
  return serveGatewayStdio(gateway)
}
