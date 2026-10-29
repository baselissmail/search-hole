// SPDX-License-Identifier: Apache-2.0
/** Local 127.0.0.1 test servers and a guard policy that may reach them. */
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ALLOW_LOOPBACK_FOR_TESTS, type GuardPolicy, type ResolveAll } from '../../src/fetch/guard.ts'

export interface SeenRequest {
  method: string
  url: string
  host: string
  headers: IncomingHttpHeaders
  body: string
}

export interface TestServer {
  origin: string
  port: number
  seen: SeenRequest[]
  /** Requests currently being handled, and the most seen at once. */
  stats: { inFlight: number; maxInFlight: number }
  close(): Promise<void>
}

export type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>

/** Starts an HTTP server on 127.0.0.1 with a random port. */
export async function startServer(handler: Handler): Promise<TestServer> {
  const seen: SeenRequest[] = []
  const stats = { inFlight: 0, maxInFlight: 0 }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        host: req.headers.host ?? '',
        headers: req.headers,
        body,
      })
      stats.inFlight++
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight)
      res.on('close', () => {
        stats.inFlight--
      })
      Promise.resolve(handler(req, res, body)).catch((err: unknown) => {
        res.statusCode = 500
        res.end(String(err))
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    seen,
    stats,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** Fake DNS: maps test hostnames to addresses; anything else is NXDOMAIN. */
export function fakeDns(table: Record<string, string | string[]>): ResolveAll {
  return async (hostname) => {
    const hit = table[hostname.toLowerCase()]
    if (hit === undefined)
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })
    const list = Array.isArray(hit) ? hit : [hit]
    return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
}

/** Guard policy for tests: loopback allowed (test-only symbol), optional fake DNS. */
export function testPolicy(resolve?: ResolveAll): GuardPolicy {
  return { [ALLOW_LOOPBACK_FOR_TESTS]: true, ...(resolve ? { resolve } : {}) }
}

export const neverBlocked = (): null => null
