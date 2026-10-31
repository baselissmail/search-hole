// SPDX-License-Identifier: Apache-2.0
// A stdio gateway over the fake App, spawned by stdio.test.ts (run by Node's type stripping).
// STDIO_HOST and STDIO_FAKE (JSON FakeAppOptions) let a test pick the host profile and fake data.
import type { HostProfile } from '../../../src/app/types.ts'
import { Gateway, serveGatewayStdio } from '../../../src/gateway/gateway.ts'
import { FakeApp, type FakeAppOptions } from '../fake-app.ts'

const host = (process.env.STDIO_HOST ?? 'generic') as HostProfile
const fake = JSON.parse(process.env.STDIO_FAKE ?? '{}') as FakeAppOptions
const gateway = new Gateway(
  { host, version: '0.1.0', env: process.env, cwd: process.cwd() },
  { createApp: async (opts) => new FakeApp(opts, fake) },
)
const handle = serveGatewayStdio(gateway)
await handle.closed
process.stderr.write('stdio-entry: closed\n')
