// SPDX-License-Identifier: Apache-2.0
// A stdio gateway over the fake App, spawned by stdio.test.ts (run by Node's type stripping).
import { Gateway, serveGatewayStdio } from '../../../src/gateway/gateway.ts'
import { FakeApp } from '../fake-app.ts'

const gateway = new Gateway(
  { host: 'generic', version: '0.1.0', env: process.env, cwd: process.cwd() },
  { createApp: async (opts) => new FakeApp(opts) },
)
const handle = serveGatewayStdio(gateway)
await handle.closed
process.stderr.write('stdio-entry: closed\n')
