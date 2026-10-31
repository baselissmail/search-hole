// SPDX-License-Identifier: Apache-2.0
/**
 * The dashboard's HTTP surface (ADR-0004, ADR-0020): the JSON API from `contract.ts`, the live
 * stream, and the built assets. A pure factory over the App, so tests drive it with
 * `fetch(new Request(...))` and no sockets; `run.ts` binds it to 127.0.0.1.
 *
 * Every response carries a strict CSP and no CORS headers. A request is refused unless its
 * Host is this server's (DNS rebinding) and, for writes, its Origin is too (CSRF). `/api/*`
 * needs a bearer session token, minted once per single-use login code; `/api/login-code` is
 * the one route that takes the `ui.json` login secret instead.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { type Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { streamSSE } from 'hono/streaming'
import type { App, DashboardApi } from '../app/types.ts'
import { isSearchHoleError } from '../shared/errors.ts'
import type { Logger } from '../shared/log.ts'
import type { ApiError, StreamEvent } from './contract.ts'

/** A login code is good for one exchange within this window (ADR-0004 point 4). */
export const LOGIN_CODE_TTL_MS = 60_000
const MAX_CODES = 32
const MAX_SESSIONS = 64
const STREAM_POLL_MS = 250
const STREAM_PING_MS = 15_000
const BODY_LIMIT_BYTES = 64 * 1024

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

export interface UiServerOptions {
  app: App & { dashboard: DashboardApi }
  port: number
  version: string
  /** Echoed by `/health`, so a second `searchhole ui` can tell this instance from a stranger. */
  nonce: string
  /** From `ui.json`; authorizes `POST /api/login-code`. */
  loginSecret: string
  /** The built dashboard (`index.html` + assets), or null when it isn't built. */
  assetsDir: string | null
  now: () => number
  logger: Logger
}

export interface UiServer {
  fetch(request: Request): Promise<Response>
  /** A fresh single-use login code (for `searchhole ui --open` in this process). */
  mintCode(): string
  /** Open live streams (the idle timer waits while any is open). */
  streams(): number
  /** Last API call or stream activity (epoch ms). */
  lastActivity(): number
  /** Ends open streams. */
  close(): void
}

const token = (bytes: number): string => randomBytes(bytes).toString('base64url')

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

const fail = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 500,
  code: string,
  message: string,
  fix?: string,
) => c.json<ApiError>({ error: { code, message, ...(fix === undefined ? {} : { fix }) } }, status)

const intParam = (raw: string | undefined): number | undefined => {
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return undefined
  return Number(raw)
}

export function createUiServer(o: UiServerOptions): UiServer {
  const codes = new Map<string, number>()
  const sessions = new Set<string>()
  const hosts = new Set([`127.0.0.1:${o.port}`, `localhost:${o.port}`])
  const origins = new Set([`http://127.0.0.1:${o.port}`, `http://localhost:${o.port}`])
  let activity = o.now()
  let open = 0
  let closed = false
  const app = o.app
  const dash = o.app.dashboard

  const mintCode = (): string => {
    const now = o.now()
    for (const [code, exp] of codes) if (exp <= now) codes.delete(code)
    while (codes.size >= MAX_CODES) {
      const oldest = codes.keys().next().value
      if (oldest === undefined) break
      codes.delete(oldest)
    }
    const code = token(16)
    codes.set(code, now + LOGIN_CODE_TTL_MS)
    return code
  }

  const bearer = (c: Context): string | undefined => {
    const h = c.req.header('authorization')
    return h?.startsWith('Bearer ') ? h.slice(7).trim() : undefined
  }

  const h = new Hono()

  // Security first: Host, Origin, headers. Errors here are plain text (no app data involved).
  h.use('*', async (c, next) => {
    const host = c.req.header('host') ?? ''
    if (!hosts.has(host.toLowerCase())) return c.text('Forbidden host', 403)
    const origin = c.req.header('origin')
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && origin !== undefined && !origins.has(origin)) {
      return c.text('Forbidden origin', 403)
    }
    await next()
    c.header('Content-Security-Policy', CSP)
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('X-Frame-Options', 'DENY')
    c.header('Cross-Origin-Opener-Policy', 'same-origin')
    c.header('Cross-Origin-Resource-Policy', 'same-origin')
  })

  h.get('/health', (c) => c.json({ nonce: o.nonce, version: o.version }))

  h.post(
    '/session',
    bodyLimit({ maxSize: 4096, onError: (c) => fail(c, 413, 'bad_request', 'Body too large.') }),
    async (c) => {
      const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null
      const code = typeof body?.code === 'string' ? body.code : ''
      const exp = codes.get(code)
      if (exp === undefined || exp <= o.now()) {
        codes.delete(code)
        return fail(
          c,
          401,
          'unauthorized',
          'This sign-in link has expired or was already used.',
          'Run `searchhole ui --open` again.',
        )
      }
      codes.delete(code)
      while (sessions.size >= MAX_SESSIONS) {
        const oldest = sessions.values().next().value
        if (oldest === undefined) break
        sessions.delete(oldest)
      }
      const t = token(32)
      sessions.add(t)
      activity = o.now()
      return c.json({ token: t, version: o.version })
    },
  )

  h.post('/api/login-code', (c) => {
    const b = bearer(c)
    if (b === undefined || !sameSecret(b, o.loginSecret))
      return fail(c, 401, 'unauthorized', 'Not authorized.')
    return c.json({ code: mintCode() })
  })

  h.use('/api/*', async (c, next) => {
    const b = bearer(c)
    if (b === undefined || !sessions.has(b)) {
      return fail(c, 401, 'unauthorized', 'Sign in again.', 'Run `searchhole ui --open` in a terminal.')
    }
    activity = o.now()
    c.header('Cache-Control', 'no-store')
    await next()
  })
  h.use(
    '/api/*',
    bodyLimit({ maxSize: BODY_LIMIT_BYTES, onError: (c) => fail(c, 413, 'bad_request', 'Body too large.') }),
  )

  const json = async <T>(c: Context): Promise<T> => {
    try {
      return (await c.req.json()) as T
    } catch {
      throw new BadRequest('The body must be JSON.')
    }
  }

  h.get('/api/overview', async (c) => c.json(await dash.overview(intParam(c.req.query('days')) ?? 7)))

  h.get('/api/searches', async (c) => {
    const before = intParam(c.req.query('before'))
    const after = intParam(c.req.query('after'))
    const limit = intParam(c.req.query('limit'))
    return c.json(
      await dash.page({
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
        ...(limit === undefined ? {} : { limit }),
        hiddenOnly: c.req.query('hidden') === '1',
      }),
    )
  })

  h.get('/api/searches/:id', async (c) => {
    const id = intParam(c.req.param('id'))
    const detail = id === undefined ? undefined : await app.log.detail(id)
    return detail === undefined ? fail(c, 404, 'not_found', 'No such search.') : c.json(detail)
  })

  h.get('/api/stream', (c) => {
    const resume = intParam(c.req.header('last-event-id')) ?? intParam(c.req.query('after')) ?? 0
    return streamSSE(c, async (stream) => {
      open++
      let cursor = resume
      let epoch: number | undefined
      let lastPing = o.now()
      const send = (e: StreamEvent) =>
        stream.writeSSE({
          event: e.event,
          data: JSON.stringify(e.data),
          ...(e.event === 'search' ? { id: String(e.id) } : {}),
        })
      try {
        await stream.write(': connected\n\n') // primes the stream (Firefox, MCP Inspector lesson)
        while (!stream.aborted && !closed) {
          const t = await dash.tail(cursor, 200)
          if (t.maxId < cursor || (epoch !== undefined && t.epoch !== epoch)) {
            await send({ event: 'reset', data: { reason: t.maxId < cursor ? 'pruned' : 'epoch' } })
            cursor = t.maxId
          } else {
            for (const item of t.items) {
              await send({ event: 'search', id: item.searchId, data: item })
              cursor = item.searchId
            }
          }
          epoch = t.epoch
          activity = o.now()
          if (o.now() - lastPing >= STREAM_PING_MS) {
            await stream.write(': ping\n\n')
            lastPing = o.now()
          }
          await stream.sleep(STREAM_POLL_MS)
        }
      } catch (err) {
        if (!stream.aborted) {
          o.logger.warn({ err }, 'dashboard stream failed')
          await send({
            event: 'stream-error',
            data: { message: 'The live log stopped; reconnecting.' },
          }).catch(() => undefined)
        }
      } finally {
        open--
      }
    })
  })

  h.get('/api/rules', async (c) => c.json(await app.rules.list()))
  h.post('/api/rules', async (c) => c.json(await app.rules.add(await json(c))))
  h.post('/api/rules/remove', async (c) => {
    const body = await json<{ rule?: unknown; scope?: unknown }>(c)
    if (typeof body.rule !== 'string' || body.rule.trim() === '')
      throw new BadRequest('Name the rule to remove.')
    const scope =
      body.scope === 'session' || body.scope === 'project' || body.scope === 'global' ? body.scope : undefined
    return c.json(await app.rules.remove(body.rule, scope === undefined ? {} : { scope }))
  })
  h.post('/api/rules/explain', async (c) => {
    const body = await json<{ url?: unknown; profile?: unknown }>(c)
    if (typeof body.url !== 'string' || body.url.trim() === '') throw new BadRequest('Give a URL to explain.')
    return c.json(
      await app.rules.explain(body.url, typeof body.profile === 'string' ? { profile: body.profile } : {}),
    )
  })

  h.get('/api/suggestions', async (c) => c.json(await app.suggestions.list()))
  h.post('/api/suggestions/:id/approve', async (c) => {
    const id = intParam(c.req.param('id'))
    if (id === undefined) return fail(c, 404, 'not_found', 'No such suggestion.')
    return c.json(await app.suggestions.approve(id))
  })
  h.post('/api/suggestions/:id/reject', async (c) => {
    const id = intParam(c.req.param('id'))
    if (id === undefined) return fail(c, 404, 'not_found', 'No such suggestion.')
    await app.suggestions.reject(id)
    return c.json({ ok: true })
  })

  h.get('/api/engines', async (c) => c.json(await app.engineStatus()))
  h.post('/api/engines/probe', async (c) => c.json(await app.probeEngines(3000)))
  h.get('/api/settings', async (c) => c.json(await dash.settingsView()))
  h.post('/api/settings', async (c) => c.json(await dash.patchSettings(await json(c))))
  h.get('/api/doctor', async (c) => c.json(await app.doctor()))

  h.all('/api/*', (c) => fail(c, 404, 'not_found', 'No such API route.'))

  // Built assets, with the SPA fallback to index.html for client routes.
  const root = o.assetsDir === null ? null : resolve(o.assetsDir)
  h.get('*', (c) => {
    if (root === null || !existsSync(join(root, 'index.html'))) {
      return c.text(
        'The dashboard is not built. Run `pnpm build` in the repository, then `searchhole ui` again.',
        404,
      )
    }
    let path: string
    try {
      path = decodeURIComponent(new URL(c.req.url).pathname)
    } catch {
      return c.text('Bad request', 400)
    }
    const file = normalize(join(root, path))
    const inside = file === root || file.startsWith(root + sep)
    const isFile = inside && existsSync(file) && statSync(file).isFile()
    const target = isFile ? file : join(root, 'index.html')
    if (!isFile && extname(path) !== '') return c.text('Not found', 404)
    const type = CONTENT_TYPES[extname(target)] ?? 'application/octet-stream'
    const immutable = isFile && target.includes(`${sep}assets${sep}`)
    c.header('Content-Type', type)
    c.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
    return c.body(readFileSync(target))
  })

  h.onError((err, c) => {
    if (err instanceof BadRequest) return fail(c, 400, 'bad_request', err.message)
    if (isSearchHoleError(err)) {
      const status = err.code === 'config_locked' ? 409 : err.code === 'internal' ? 500 : 400
      return fail(c, status, err.code, err.why, err.fix)
    }
    o.logger.error({ err, path: c.req.path }, 'dashboard request failed')
    return fail(
      c,
      500,
      'internal',
      'Something went wrong.',
      'Run `searchhole doctor`; details are in the log.',
    )
  })

  return {
    fetch: (request) => Promise.resolve(h.fetch(request)),
    mintCode,
    streams: () => open,
    lastActivity: () => activity,
    close: () => {
      closed = true
    },
  }
}

class BadRequest extends Error {}
