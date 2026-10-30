// SPDX-License-Identifier: Apache-2.0
import {
  type DockerResult,
  type DockerRunner,
  SEARXNG_CONTAINER,
  SEARXNG_IMAGE,
} from '../../src/cli/searxng.ts'

export interface FakeContainer {
  running: boolean
  image: string
  hostIp: string
  hostPort: number
}

export interface FakeDockerState {
  /** No `docker` binary on PATH. */
  missing?: boolean
  /** The CLI exists but the daemon does not answer. */
  daemonDown?: boolean
  imagePresent?: boolean
  pullFails?: boolean
  /** `docker run` fails with this stderr. */
  runFails?: string
  /** `docker start` fails (the old container is replaced instead). */
  startFails?: boolean
  container?: FakeContainer | undefined
  /** The container exits right after `run` (for the early-exit path). */
  dieAfterRun?: boolean
}

export interface FakeDocker {
  runner: DockerRunner
  state: FakeDockerState
  /** Every invocation, in order. */
  calls: string[][]
  /** Invocations whose first word is `verb`. */
  verb(verb: string): string[][]
  /** Takes a different amount of probe/inspect rounds before `healthy` flips. */
  healthy: { value: boolean }
}

const ok = (stdout = ''): DockerResult => ({ code: 0, stdout, stderr: '' })
const fail = (stderr: string, code = 1): DockerResult => ({ code, stdout: '', stderr })

/** A tiny in-memory docker: enough of version, image, container, run, start, rm, logs and pull. */
export function makeFakeDocker(initial: FakeDockerState = {}): FakeDocker {
  const state: FakeDockerState = { ...initial }
  const calls: string[][] = []
  const healthy = { value: true }

  const runner: DockerRunner = async (args, opts) => {
    calls.push([...args])
    const [verb, ...rest] = args
    if (state.missing) return { code: null, stdout: '', stderr: '', error: 'ENOENT' }
    if (verb === 'version') {
      return state.daemonDown
        ? fail(
            'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
          )
        : ok('27.3.1\n')
    }
    if (state.daemonDown) return fail('Cannot connect to the Docker daemon')
    switch (verb) {
      case 'image':
        return state.imagePresent ? ok('sha256:abc\n') : fail(`Error: No such image: ${rest.at(-1)}`)
      case 'pull':
        opts?.onOutput?.('c4e8448: Pulling fs layer\n')
        if (state.pullFails) return fail('error pulling image configuration: connection reset')
        state.imagePresent = true
        return ok()
      case 'container': {
        const c = state.container
        if (c === undefined) return fail(`Error: No such container: ${rest.at(-1)}`)
        return ok(
          JSON.stringify([
            {
              State: { Running: c.running, Status: c.running ? 'running' : 'exited' },
              Config: { Image: c.image },
              HostConfig: {
                PortBindings: { '8080/tcp': [{ HostIp: c.hostIp, HostPort: String(c.hostPort) }] },
              },
            },
          ]),
        )
      }
      case 'start':
        if (state.startFails || state.container === undefined)
          return fail('Error response from daemon: cannot start')
        state.container.running = true
        return ok(SEARXNG_CONTAINER)
      case 'rm':
        state.container = undefined
        return ok(SEARXNG_CONTAINER)
      case 'run': {
        if (state.runFails !== undefined) return fail(state.runFails, 125)
        const p = rest[rest.indexOf('-p') + 1] ?? ''
        const [hostIp, hostPort] = p.split(':')
        state.container = {
          running: !state.dieAfterRun,
          image: rest.at(-1) ?? '',
          hostIp: hostIp ?? '',
          hostPort: Number(hostPort),
        }
        return ok('f3a9c0e1d2b4\n')
      }
      case 'logs':
        return { code: 0, stdout: 'granian: failed to bind\n', stderr: '' }
      default:
        return fail(`unexpected docker command: ${args.join(' ')}`)
    }
  }
  return {
    runner,
    state,
    calls,
    healthy,
    verb: (v) => calls.filter((c) => c[0] === v),
  }
}

export const MATCHING: FakeContainer = {
  running: true,
  image: SEARXNG_IMAGE,
  hostIp: '127.0.0.1',
  hostPort: 8888,
}
