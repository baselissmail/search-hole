// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import YAML from 'yaml'
import {
  buildRunArgs,
  currentUser,
  dockerArgs,
  nodeDockerRunner,
  parseInspect,
  renderOverlay,
  SEARXNG_CONTAINER,
  SEARXNG_IMAGE,
  type SearxngContext,
  type SearxngDeps,
  searxngApply,
  searxngDown,
  searxngStatus,
  searxngUp,
  writeOverlay,
} from '../../src/cli/searxng.ts'
import { isSearchHoleError } from '../../src/shared/errors.ts'
import { type FakeDocker, MATCHING, makeFakeDocker } from './fakeDocker.ts'
import { run } from './helpers.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() ?? '', { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'searchhole-cli-'))
  dirs.push(d)
  return d
}

interface Harness {
  ctx: SearxngContext
  deps: SearxngDeps
  docker: FakeDocker
  said: string[]
  probes: string[]
  confirms: number
  dataDir: string
}

function harness(
  initial: Parameters<typeof makeFakeDocker>[0] = {},
  over: {
    port?: number
    managed?: boolean
    engineUrl?: string | null
    confirm?: boolean
    healthyAfter?: number
    user?: string
    healthTimeoutMs?: number
  } = {},
): Harness {
  const docker = makeFakeDocker(initial)
  const dataDir = join(tmp(), 'searxng')
  const said: string[] = []
  const probes: string[] = []
  let clock = 0
  const h: Harness = {
    ctx: {
      dataDir,
      port: over.port ?? 8888,
      managed: over.managed ?? true,
      engineUrl: over.engineUrl === undefined ? 'http://127.0.0.1:8888' : over.engineUrl,
    },
    deps: {
      docker: docker.runner,
      probeHealth: async (url) => {
        probes.push(url)
        return docker.healthy.value && probes.length > (over.healthyAfter ?? 0)
      },
      sleep: async (ms) => {
        clock += ms
      },
      now: () => clock,
      say: (l) => said.push(l),
      confirmPull: async () => {
        h.confirms++
        return over.confirm ?? true
      },
      newSecret: () => 'f'.repeat(64),
      ...(over.user === undefined ? {} : { user: over.user }),
      ...(over.healthTimeoutMs === undefined ? {} : { healthTimeoutMs: over.healthTimeoutMs }),
    },
    docker,
    said,
    probes,
    confirms: 0,
    dataDir,
  }
  return h
}

async function userError(
  p: Promise<unknown>,
): Promise<{ why: string; fix: string | undefined; code: string }> {
  try {
    await p
  } catch (e) {
    if (isSearchHoleError(e)) return { why: e.why, fix: e.fix, code: e.code }
    throw e
  }
  throw new Error('expected a SearchHoleError')
}

describe('command construction', () => {
  it('docker run: detached, loopback only, no implicit pull, overlay mounted, pinned digest', () => {
    expect(
      buildRunArgs({
        name: SEARXNG_CONTAINER,
        image: SEARXNG_IMAGE,
        port: 8888,
        dataDir: '/home/u/.searchhole/searxng',
      }),
    ).toEqual([
      'run',
      '-d',
      '--name',
      'search-hole-searxng',
      '--restart',
      'unless-stopped',
      '--pull',
      'never',
      '--label',
      'io.search-hole.managed=searxng',
      '-p',
      '127.0.0.1:8888:8080',
      '-v',
      '/home/u/.searchhole/searxng:/etc/searxng',
      'searxng/searxng@sha256:c4e8448495ef3b0175eb6c97a19c1ac7cc0a5c907d581ab3877f3cb430e81b86',
    ])
  })

  it('a path with spaces stays one argument, and the port comes from settings', () => {
    const args = buildRunArgs({
      name: 'n',
      image: 'i',
      port: 9999,
      dataDir: '/Users/a b/personal dev/searxng',
    })
    expect(args).toContain('/Users/a b/personal dev/searxng:/etc/searxng')
    expect(args).toContain('127.0.0.1:9999:8080')
    expect(args.some((a) => a.includes('0.0.0.0'))).toBe(false)
  })

  it('on Linux the container runs as the host user so the 0600 overlay is readable', () => {
    const args = buildRunArgs({ name: 'n', image: 'i', port: 1, dataDir: '/d', user: '1000:1000' })
    expect(args.slice(args.indexOf('--user'), args.indexOf('--user') + 2)).toEqual(['--user', '1000:1000'])
    expect(args.at(-1)).toBe('i')
    expect(currentUser('darwin')).toBeUndefined()
    expect(currentUser('win32')).toBeUndefined()
  })

  it('the other commands are plain argument arrays', () => {
    expect(dockerArgs.version).toEqual(['version', '--format', '{{.Server.Version}}'])
    expect(dockerArgs.imageInspect('img')).toEqual(['image', 'inspect', '--format', '{{.Id}}', 'img'])
    expect(dockerArgs.pull('img')).toEqual(['pull', 'img'])
    expect(dockerArgs.inspect('c')).toEqual(['container', 'inspect', 'c'])
    expect(dockerArgs.start('c')).toEqual(['start', 'c'])
    expect(dockerArgs.remove('c')).toEqual(['rm', '-f', 'c'])
    expect(dockerArgs.logs('c')).toEqual(['logs', '--tail', '8', 'c'])
  })

  it('pins the image digest from the spike', () => {
    expect(SEARXNG_IMAGE).toMatch(/^searxng\/searxng@sha256:[0-9a-f]{64}$/)
    expect(SEARXNG_CONTAINER).toBe('search-hole-searxng')
  })

  it('the real runner spawns docker without a shell and reports a missing binary', async () => {
    const saved = process.env.PATH
    process.env.PATH = join(tmp(), 'nothing-here')
    try {
      const r = await nodeDockerRunner(['version'])
      expect(r).toMatchObject({ code: null, error: 'ENOENT' })
      // A shell metacharacter in an argument is data, not syntax.
      const r2 = await nodeDockerRunner(['version; echo pwned'])
      expect(r2.stdout).not.toContain('pwned')
    } finally {
      if (saved === undefined) delete process.env.PATH
      else process.env.PATH = saved
    }
  })

  it('parses docker inspect output', () => {
    const info = parseInspect(
      JSON.stringify([
        {
          State: { Running: true },
          Config: { Image: 'x' },
          HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8888' }] } },
        },
      ]),
    )
    expect(info).toEqual({ running: true, image: 'x', hostIp: '127.0.0.1', hostPort: 8888 })
    expect(parseInspect('[]')).toBeUndefined()
    expect(parseInspect('not json')).toBeUndefined()
    expect(
      parseInspect(JSON.stringify([{ State: { Running: false }, HostConfig: { PortBindings: null } }])),
    ).toEqual({
      running: false,
      image: '',
    })
  })
})

describe('settings overlay', () => {
  it('has the keys ADR-0015 asks for and is private', () => {
    const dir = join(tmp(), 'searxng')
    const r = writeOverlay(dir, () => 'a'.repeat(64))
    expect(r).toMatchObject({ secretCreated: true, changed: true, path: join(dir, 'settings.yml') })
    const doc = YAML.parse(readFileSync(r.path, 'utf8')) as Record<string, unknown>
    expect(doc).toEqual({
      use_default_settings: true,
      server: { secret_key: 'a'.repeat(64), limiter: false, image_proxy: false },
      search: { formats: ['html', 'json'] },
    })
    if (process.platform !== 'win32') {
      expect(statSync(r.path).mode & 0o777).toBe(0o600)
      expect(statSync(dir).mode & 0o777).toBe(0o700)
    }
  })

  it('keeps the secret key across runs and leaves an unchanged file alone', () => {
    const dir = join(tmp(), 'searxng')
    writeOverlay(dir, () => 'a'.repeat(64))
    const second = writeOverlay(dir, () => {
      throw new Error('must not generate a new secret')
    })
    expect(second).toMatchObject({ secretCreated: false, changed: false })
    expect(readFileSync(second.path, 'utf8')).toBe(renderOverlay('a'.repeat(64)))
  })

  it('replaces a placeholder or short secret and repairs loose permissions', () => {
    const dir = join(tmp(), 'searxng')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'settings.yml')
    writeFileSync(file, 'use_default_settings: true\nserver:\n  secret_key: ultrasecretkey\n', {
      mode: 0o644,
    })
    const r = writeOverlay(dir, () => 'b'.repeat(64))
    expect(r.secretCreated).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('b'.repeat(64))
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('generates a real random key by default', () => {
    const a = writeOverlay(join(tmp(), 's'))
    const b = writeOverlay(join(tmp(), 's'))
    const key = (p: string): string =>
      (YAML.parse(readFileSync(p, 'utf8')) as { server: { secret_key: string } }).server.secret_key
    expect(key(a.path)).toMatch(/^[0-9a-f]{64}$/)
    expect(key(a.path)).not.toBe(key(b.path))
  })
})

describe('searxng up', () => {
  it('fresh machine: asks, pulls, runs, waits for /healthz', async () => {
    const h = harness({}, { healthyAfter: 2 })
    const r = await searxngUp(h.ctx, h.deps)
    expect(r).toMatchObject({
      kind: 'started',
      url: 'http://127.0.0.1:8888',
      pulled: true,
      secretCreated: true,
    })
    expect(h.confirms).toBe(1)
    expect(h.docker.calls.map((c) => c[0])).toEqual([
      'version',
      'container',
      'image',
      'pull',
      'run',
      'container',
      'container',
    ])
    expect(h.docker.verb('pull')).toEqual([['pull', SEARXNG_IMAGE]])
    expect(h.docker.verb('run')).toEqual([
      buildRunArgs({ name: SEARXNG_CONTAINER, image: SEARXNG_IMAGE, port: 8888, dataDir: h.dataDir }),
    ])
    expect(h.probes).toEqual(Array(3).fill('http://127.0.0.1:8888/healthz'))
    expect(h.said.join('\n')).toContain('Downloading the SearXNG image (~380 MB)')
    expect(h.said.join('\n')).toContain('Pulling fs layer')
  })

  it('does not ask when the image is already there', async () => {
    const h = harness({ imagePresent: true })
    const r = await searxngUp(h.ctx, h.deps)
    expect(r).toMatchObject({ kind: 'started', pulled: false })
    expect(h.confirms).toBe(0)
    expect(h.docker.verb('pull')).toEqual([])
  })

  it('a declined download starts nothing', async () => {
    const h = harness({}, { confirm: false })
    expect(await searxngUp(h.ctx, h.deps)).toEqual({ kind: 'declined' })
    expect(h.docker.verb('run')).toEqual([])
    expect(h.docker.state.container).toBeUndefined()
  })

  it('uses the port from settings and warns when engines.searxng.url disagrees', async () => {
    const h = harness({ imagePresent: true }, { port: 9999, engineUrl: 'http://127.0.0.1:8888' })
    const r = await searxngUp(h.ctx, h.deps)
    expect(h.docker.verb('run')[0]).toContain('127.0.0.1:9999:8080')
    expect(h.probes[0]).toBe('http://127.0.0.1:9999/healthz')
    expect(r).toMatchObject({ kind: 'started', url: 'http://127.0.0.1:9999' })
    expect((r as { notes: string[] }).notes.join(' ')).toContain('engines.searxng.url')
  })

  it('leaves a matching running container alone', async () => {
    const h = harness({ imagePresent: true })
    await searxngUp(h.ctx, h.deps)
    h.docker.calls.length = 0
    const again = await searxngUp(h.ctx, h.deps)
    expect(again).toMatchObject({ kind: 'already-running' })
    expect(h.docker.verb('run')).toEqual([])
    expect(h.docker.verb('rm')).toEqual([])
  })

  it('starts a stopped matching container instead of recreating it', async () => {
    const h = harness({ imagePresent: true })
    await searxngUp(h.ctx, h.deps)
    if (h.docker.state.container) h.docker.state.container.running = false
    h.docker.calls.length = 0
    const r = await searxngUp(h.ctx, h.deps)
    expect(r.kind).toBe('started')
    expect(h.docker.verb('start')).toEqual([['start', SEARXNG_CONTAINER]])
    expect(h.docker.verb('run')).toEqual([])
  })

  it('replaces a container with the wrong port or image', async () => {
    const h = harness({ imagePresent: true, container: { ...MATCHING, hostPort: 7777 } })
    await searxngUp(h.ctx, h.deps)
    expect(h.docker.verb('rm')).toEqual([['rm', '-f', SEARXNG_CONTAINER]])
    expect(h.docker.verb('run')).toHaveLength(1)
    const wrongImage = harness({
      imagePresent: true,
      container: { ...MATCHING, image: 'searxng/searxng:old' },
    })
    await searxngUp(wrongImage.ctx, wrongImage.deps)
    expect(wrongImage.docker.verb('rm')).toHaveLength(1)
  })

  it('replaces a container that will not start', async () => {
    const h = harness({ imagePresent: true, startFails: true })
    await searxngUp(h.ctx, h.deps)
    h.docker.state.container = { ...MATCHING, running: false }
    h.docker.calls.length = 0
    await searxngUp(h.ctx, h.deps)
    expect(h.docker.verb('start')).toHaveLength(1)
    expect(h.docker.verb('rm')).toHaveLength(1)
    expect(h.docker.verb('run')).toHaveLength(1)
  })

  it('passes --user on Linux', async () => {
    const h = harness({ imagePresent: true }, { user: '1000:1000' })
    await searxngUp(h.ctx, h.deps)
    expect(h.docker.verb('run')[0]).toContain('1000:1000')
  })

  it('explains a missing docker and a stopped daemon, touching nothing else', async () => {
    const missing = harness({ missing: true })
    const e1 = await userError(searxngUp(missing.ctx, missing.deps))
    expect(e1.why).toBe('Docker is not installed (no `docker` command found).')
    expect(e1.fix).toContain('searchhole keys set tavily')
    expect(missing.docker.calls).toHaveLength(1)
    const down = harness({ daemonDown: true })
    const e2 = await userError(searxngUp(down.ctx, down.deps))
    expect(e2.why).toContain('daemon is not answering')
    expect(e2.fix).toContain('Start Docker')
    expect(down.docker.verb('run')).toEqual([])
  })

  it('refuses when managed SearXNG is off', async () => {
    const h = harness({}, { managed: false })
    const e = await userError(searxngUp(h.ctx, h.deps))
    expect(e.code).toBe('config_invalid')
    expect(e.why).toContain('searxng.managed: false')
    expect(h.docker.calls).toEqual([])
  })

  it('names a busy port and how to move', async () => {
    const h = harness({
      imagePresent: true,
      runFails:
        'docker: Error response from daemon: Bind for 127.0.0.1:8888 failed: port is already allocated.',
    })
    const e = await userError(searxngUp(h.ctx, h.deps))
    expect(e.why).toBe('Port 8888 is already in use on 127.0.0.1.')
    expect(e.fix).toContain('searxng.port')
  })

  it('reports a failed pull and any other run failure with the last docker line', async () => {
    const pull = harness({ pullFails: true })
    const e1 = await userError(searxngUp(pull.ctx, pull.deps))
    expect(e1.why).toContain('could not download the SearXNG image')
    expect(e1.why).toContain('connection reset')
    const run = harness({ imagePresent: true, runFails: 'line one\ndocker: invalid mount' })
    const e2 = await userError(searxngUp(run.ctx, run.deps))
    expect(e2.why).toBe('Docker could not start SearXNG: docker: invalid mount.')
  })

  it('gives up with a log hint when /healthz never answers', async () => {
    const h = harness({ imagePresent: true }, { healthyAfter: 1_000_000, healthTimeoutMs: 3_000 })
    const e = await userError(searxngUp(h.ctx, h.deps))
    expect(e.why).toContain('did not answer http://127.0.0.1:8888/healthz within 3 seconds')
    expect(e.fix).toContain(`docker logs ${SEARXNG_CONTAINER}`)
  })

  it('fails fast, with the last log line, when the container exits', async () => {
    const h = harness({ imagePresent: true, dieAfterRun: true }, { healthyAfter: 1_000_000 })
    const e = await userError(searxngUp(h.ctx, h.deps))
    expect(e.why).toContain('stopped right after it started')
    expect(e.why).toContain('granian: failed to bind')
    expect(h.probes.length).toBe(1)
  })
})

describe('searxng down, status and apply', () => {
  it('down removes the container and keeps the files', async () => {
    const h = harness({ imagePresent: true })
    await searxngUp(h.ctx, h.deps)
    expect(await searxngDown(h.deps)).toEqual({ kind: 'removed' })
    expect(h.docker.verb('rm')).toEqual([['rm', '-f', SEARXNG_CONTAINER]])
    expect(statSync(join(h.dataDir, 'settings.yml')).isFile()).toBe(true)
    expect(await searxngDown(h.deps)).toEqual({ kind: 'absent' })
  })

  it('status reports each situation', async () => {
    const up = harness({ imagePresent: true })
    await searxngUp(up.ctx, up.deps)
    expect(await searxngStatus(up.ctx, up.deps)).toMatchObject({
      docker: 'ok',
      container: 'running',
      imageMatches: true,
      portMatches: true,
      healthy: true,
      url: 'http://127.0.0.1:8888',
    })
    const moved = { ...up.ctx, port: 9000 }
    expect(await searxngStatus(moved, up.deps)).toMatchObject({ container: 'running', portMatches: false })
    if (up.docker.state.container) up.docker.state.container.running = false
    expect(await searxngStatus(up.ctx, up.deps)).toMatchObject({ container: 'stopped', healthy: false })
    const none = harness()
    expect(await searxngStatus(none.ctx, none.deps)).toMatchObject({ docker: 'ok', container: 'absent' })
    expect(
      await searxngStatus(harness({ missing: true }).ctx, harness({ missing: true }).deps),
    ).toMatchObject({ docker: 'missing' })
    const dd = harness({ daemonDown: true })
    expect(await searxngStatus(dd.ctx, dd.deps)).toMatchObject({ docker: 'daemon_down' })
  })

  it('apply recreates a running container with the new settings', async () => {
    const h = harness({ imagePresent: true })
    await searxngUp(h.ctx, h.deps)
    h.docker.calls.length = 0
    const moved = { ...h.ctx, port: 9001, engineUrl: 'http://127.0.0.1:9001' }
    const r = await searxngApply(moved, h.deps)
    expect(r).toMatchObject({ kind: 'recreated', url: 'http://127.0.0.1:9001' })
    expect(h.docker.verb('rm')).toHaveLength(1)
    expect(h.docker.verb('run')[0]).toContain('127.0.0.1:9001:8080')
  })

  it('apply with no container, or no docker, only writes the files', async () => {
    const none = harness({ imagePresent: true })
    expect(await searxngApply(none.ctx, none.deps)).toMatchObject({
      kind: 'files-only',
      reason: 'not-created',
      secretCreated: true,
    })
    expect(none.docker.verb('run')).toEqual([])
    const nodocker = harness({ missing: true })
    expect(await searxngApply(nodocker.ctx, nodocker.deps)).toMatchObject({
      kind: 'files-only',
      reason: 'no-docker',
    })
    expect(statSync(join(nodocker.dataDir, 'settings.yml')).isFile()).toBe(true)
  })

  it('apply never downloads: a missing image is an error, not a surprise pull', async () => {
    const h = harness({ container: { ...MATCHING, hostPort: 1 } }, { confirm: false })
    const e = await userError(searxngApply(h.ctx, h.deps))
    expect(e.why).toContain('image is missing and was not downloaded')
  })
})

describe('searxng through the CLI', () => {
  const setup = (settings?: string) => {
    const home = tmp()
    if (settings !== undefined) writeFileSync(join(home, 'settings.yaml'), settings)
    const docker = makeFakeDocker({ imagePresent: true })
    const deps = {
      searxng: {
        docker: docker.runner,
        probeHealth: async () => true,
        sleep: async () => undefined,
        now: () => 0,
        newSecret: () => 'c'.repeat(64),
      },
    }
    return { home, docker, deps }
  }

  it('up --yes reads the port from settings.yaml, writes files under the data root, and remembers the answer', async () => {
    const { home, docker, deps } = setup('searxng:\n  port: 9321\n')
    const r = await run(['searxng', 'up', '--yes'], { env: { SEARCHHOLE_HOME: home } }, {}, deps)
    expect(r.code).toBe(0)
    expect(r.out).toContain(
      '✓ SearXNG is running at http://127.0.0.1:9321 (container search-hole-searxng, 127.0.0.1 only).',
    )
    expect(r.out).toContain('Next: searchhole doctor --probe')
    expect(docker.verb('run')[0]).toContain('127.0.0.1:9321:8080')
    expect(docker.verb('run')[0]).toContain(`${join(home, 'searxng')}:/etc/searxng`)
    expect(statSync(join(home, 'searxng', 'settings.yml')).isFile()).toBe(true)
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toContain('offer: accepted')
    expect(r.app.opened).toHaveLength(0)
  })

  it('without a terminal, an undownloaded image needs --yes', async () => {
    const home = tmp()
    const docker = makeFakeDocker({ imagePresent: false })
    const deps = {
      searxng: {
        docker: docker.runner,
        probeHealth: async () => true,
        sleep: async () => undefined,
        now: () => 0,
      },
    }
    const r = await run(['searxng', 'up'], { env: { SEARCHHOLE_HOME: home } }, {}, deps)
    expect(r.code).toBe(2)
    expect(r.err).toContain('there is no terminal to ask you')
    expect(r.err).toContain('searchhole searxng up --yes')
    expect(docker.verb('pull')).toEqual([])
    const yes = await run(['searxng', 'up', '--yes'], { env: { SEARCHHOLE_HOME: home } }, {}, deps)
    expect(yes.code).toBe(0)
    expect(docker.verb('pull')).toHaveLength(1)
  })

  it('on a terminal it asks first; no means nothing is downloaded and the answer is remembered', async () => {
    const home = tmp()
    const docker = makeFakeDocker({ imagePresent: false })
    const deps = {
      searxng: {
        docker: docker.runner,
        probeHealth: async () => true,
        sleep: async () => undefined,
        now: () => 0,
      },
    }
    const no = await run(
      ['searxng', 'up'],
      { env: { SEARCHHOLE_HOME: home }, tty: true, confirmAnswer: false },
      {},
      deps,
    )
    expect(no.code).toBe(0)
    expect(no.io.confirms).toEqual(['Download the SearXNG image (~380 MB) from Docker Hub?'])
    expect(no.out).toContain('Not started.')
    expect(docker.verb('pull')).toEqual([])
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toContain('offer: declined')
    const yes = await run(
      ['searxng', 'up'],
      { env: { SEARCHHOLE_HOME: home }, tty: true, confirmAnswer: true },
      {},
      deps,
    )
    expect(yes.code).toBe(0)
    expect(docker.verb('pull')).toHaveLength(1)
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toContain('offer: accepted')
  })

  it('down, status and apply print what happened; --json prints data', async () => {
    const { home, deps } = setup()
    const env = { SEARCHHOLE_HOME: home }
    await run(['searxng', 'up', '--yes'], { env }, {}, deps)
    const status = await run(['searxng', 'status'], { env }, {}, deps)
    expect(status.out).toContain('container   search-hole-searxng running')
    expect(JSON.parse((await run(['searxng', 'status', '--json'], { env }, {}, deps)).out)).toMatchObject({
      container: 'running',
      healthy: true,
    })
    const apply = await run(['searxng', 'apply'], { env }, {}, deps)
    expect(apply.out).toContain('Settings applied; SearXNG was recreated')
    const down = await run(['searxng', 'down'], { env }, {}, deps)
    expect(down.out).toContain('Stopped and removed search-hole-searxng.')
    const again = await run(['searxng', 'down'], { env }, {}, deps)
    expect(again.out).toContain('Nothing to stop')
  })

  it('a docker problem is a user error with a fix', async () => {
    const home = tmp()
    const docker = makeFakeDocker({ missing: true })
    const deps = { searxng: { docker: docker.runner } }
    const r = await run(['searxng', 'up', '--yes'], { env: { SEARCHHOLE_HOME: home } }, {}, deps)
    expect(r.code).toBe(2)
    expect(r.err).toContain('error: Docker is not installed')
    expect(r.err).toContain('→ Install Docker Desktop')
  })

  it('an invalid settings.yaml stops before docker is touched', async () => {
    const { home, docker, deps } = setup('searxng:\n  port: 99999\n')
    const r = await run(['searxng', 'status'], { env: { SEARCHHOLE_HOME: home } }, {}, deps)
    expect(r.code).toBe(2)
    expect(docker.calls).toEqual([])
  })
})
