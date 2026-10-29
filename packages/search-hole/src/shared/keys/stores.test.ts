// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isSearchHoleError } from '../errors.ts'
import type { EngineId } from '../types.ts'
import { createInsecureFileStore } from './file.ts'
import { createKeyStores, createOsKeyStore } from './index.ts'
import { createSecretToolStore } from './linux.ts'
import { createMacosKeychainStore } from './macos.ts'
import { resolveKey } from './resolve.ts'
import { nodeKeyFs, nodeRunCommand } from './spawn.ts'
import type { CommandOptions, CommandResult, KeyFs, RunCommand } from './types.ts'
import { createDpapiStore, DPAPI_READ_SCRIPT, DPAPI_WRITE_SCRIPT } from './windows.ts'

const KEY = 'tvly-Zq3w9X7c1Vb5Nm8Lk2Jh4Gf6Ds0Pa'

interface Call {
  cmd: string
  args: readonly string[]
  opts: CommandOptions
}

/** A scripted `RunCommand` that records every call. */
function fakeRun(handler: (call: Call, n: number) => Partial<CommandResult>): {
  run: RunCommand
  calls: Call[]
} {
  const calls: Call[] = []
  const run: RunCommand = async (cmd, args, opts = {}) => {
    const call = { cmd, args, opts }
    calls.push(call)
    return { code: 0, stdout: '', stderr: '', ...handler(call, calls.length - 1) }
  }
  return { run, calls }
}

async function thrown(p: Promise<unknown>) {
  try {
    await p
  } catch (e) {
    if (isSearchHoleError(e)) return e
    throw e
  }
  throw new Error('expected a SearchHoleError')
}

/** No secret may appear in argv or in the environment handed to a child. */
function expectSecretOnlyInStdin(calls: readonly Call[], secret: string) {
  for (const c of calls) {
    expect(c.cmd).not.toContain(secret)
    expect(c.args.join('\u0000')).not.toContain(secret)
    expect(JSON.stringify(c.opts.env ?? {})).not.toContain(secret)
  }
}

describe('macOS Keychain store', () => {
  /** Simulates `security`: add via -i stores, find returns, delete removes. */
  function fakeSecurity() {
    const items = new Map<string, string>()
    return fakeRun((c) => {
      if (c.args[0] === '-i') {
        const m = /^add-generic-password -U -s (\S+) -a (\S+) -w (.+)\n$/.exec(c.opts.stdin ?? '')
        if (!m) return { code: 1 }
        items.set(`${m[1]}/${m[2]}`, m[3] ?? '')
        return {}
      }
      const at = `${c.args[c.args.indexOf('-s') + 1]}/${c.args[c.args.indexOf('-a') + 1]}`
      if (c.args[0] === 'find-generic-password')
        return items.has(at) ? { stdout: `${items.get(at)}\n` } : { code: 44 }
      if (c.args[0] === 'delete-generic-password') return items.delete(at) ? {} : { code: 44 }
      if (c.args[0] === 'list-keychains') return { stdout: '"/login.keychain-db"\n' }
      return { code: 1 }
    })
  }

  it('writes through `security -i` with the command on stdin, then reads it back', async () => {
    const { run, calls } = fakeSecurity()
    const store = createMacosKeychainStore({ run })
    await store.set('tavily', `  ${KEY}\n`)
    expect(calls[0]).toMatchObject({
      cmd: 'security',
      args: ['-i'],
      opts: { stdin: `add-generic-password -U -s search-hole -a tavily -w ${KEY}\n` },
    })
    expect(calls[1]?.args).toEqual(['find-generic-password', '-s', 'search-hole', '-a', 'tavily', '-w'])
    expectSecretOnlyInStdin(calls, KEY)
    expect(await store.get('tavily')).toBe(KEY)
    expect(store.kind).toBe('keychain')
  })

  it.each([
    ['a space', 'abc def'],
    ['a tab', 'abc\tdef'],
    ['a double quote', 'abc"def'],
    ['a backslash', 'abc\\def'],
    ['a newline inside', 'abc\ndef'],
    ['nothing', '   '],
  ])('rejects a key with %s before spawning anything', async (_what, key) => {
    const { run, calls } = fakeSecurity()
    const err = await thrown(createMacosKeychainStore({ run }).set('exa', key))
    expect(err.code).toBe('invalid_argument')
    expect(err.why).not.toContain('def')
    expect(calls).toHaveLength(0)
  })

  it('accepts keys with other punctuation', async () => {
    const { run } = fakeSecurity()
    const store = createMacosKeychainStore({ run })
    await store.set('exa', "k'ey#with!chars$&;|`()<>")
    expect(await store.get('exa')).toBe("k'ey#with!chars$&;|`()<>")
  })

  it('fails when the read-back does not match (keychain locked), without echoing the key', async () => {
    const { run } = fakeRun((c) => (c.args[0] === '-i' ? {} : { code: 44 }))
    const err = await thrown(createMacosKeychainStore({ run }).set('exa', KEY))
    expect(err.code).toBe('store_unavailable')
    expect(err.why).not.toContain(KEY)
  })

  it('scrubs the key from security error output', async () => {
    const { run } = fakeRun(() => ({ code: 1, stderr: `security: bad input ${KEY} here` }))
    const err = await thrown(createMacosKeychainStore({ run }).set('exa', KEY))
    expect(err.why).toContain('[redacted]')
    expect(err.why).not.toContain(KEY)
  })

  it('maps exit 44 to "not found", other failures to store_unavailable', async () => {
    const store = createMacosKeychainStore({ run: fakeSecurity().run })
    expect(await store.get('kagi')).toBeNull()
    expect(await store.delete('kagi')).toBe(false)
    const failing = createMacosKeychainStore({ run: fakeRun(() => ({ code: 36 })).run })
    expect((await thrown(failing.get('kagi'))).code).toBe('store_unavailable')
    const missing = createMacosKeychainStore({ run: fakeRun(() => ({ code: null, error: 'ENOENT' })).run })
    expect((await thrown(missing.get('kagi'))).code).toBe('store_unavailable')
    expect(await missing.probe()).toMatchObject({ ok: false })
  })

  it('deletes, probes, and honours a custom service name', async () => {
    const { run, calls } = fakeSecurity()
    const store = createMacosKeychainStore({ run, service: 'search-hole-test' })
    await store.set('mojeek', KEY)
    expect(calls[0]?.opts.stdin).toContain('-s search-hole-test -a mojeek')
    expect(await store.delete('mojeek')).toBe(true)
    expect(await store.get('mojeek')).toBeNull()
    expect(await store.probe()).toEqual({ ok: true })
    expect(() => createMacosKeychainStore({ run, service: 'has space' })).toThrow()
  })
})

describe('Secret Service store (Linux secret-tool)', () => {
  function fakeSecretTool(opts: { broken?: string } = {}) {
    const items = new Map<string, string>()
    return fakeRun((c) => {
      if (opts.broken !== undefined)
        return opts.broken === 'ENOENT' ? { code: null, error: 'ENOENT' } : { code: 1 }
      const account = c.args[c.args.indexOf('account') + 1] ?? ''
      if (c.args[0] === 'store') {
        items.set(account, c.opts.stdin ?? '')
        return {}
      }
      if (c.args[0] === 'lookup')
        return items.has(account) ? { stdout: items.get(account) ?? '' } : { code: 1 }
      if (c.args[0] === 'clear') {
        items.delete(account)
        return {}
      }
      return { code: 1 }
    })
  }

  it('proves a write-and-read-back probe, then stores the key on stdin only', async () => {
    const { run, calls } = fakeSecretTool()
    const store = createSecretToolStore({ run, randomToken: () => 'tok' })
    await store.set('tavily', ` ${KEY} `)
    const verbs = calls.map((c) => c.args[0])
    expect(verbs).toEqual(['store', 'lookup', 'clear', 'store', 'lookup'])
    expect(calls[0]).toMatchObject({ cmd: 'secret-tool', opts: { stdin: 'probe-tok' } })
    expect(calls[0]?.args).toEqual([
      'store',
      '--label=search-hole __probe__',
      'service',
      'search-hole',
      'account',
      '__probe__',
    ])
    expect(calls[3]).toMatchObject({
      cmd: 'secret-tool',
      args: ['store', '--label=search-hole tavily', 'service', 'search-hole', 'account', 'tavily'],
      opts: { stdin: KEY },
    })
    expectSecretOnlyInStdin(calls, KEY)
    expect(await store.get('tavily')).toBe(KEY)
    expect(store.kind).toBe('keychain')
  })

  it('probes once per store instance', async () => {
    const { run, calls } = fakeSecretTool()
    const store = createSecretToolStore({ run })
    await store.set('exa', KEY)
    const first = calls.length
    await store.set('kagi', KEY)
    expect(calls.length - first).toBe(2)
  })

  it.each([
    ['not installed', 'ENOENT', /not installed/],
    ['no Secret Service', 'exit1', /did not return|exit 1/],
  ])(
    'refuses to store (%s) and points to the env-var options, writing nothing',
    async (_name, broken, reason) => {
      const { run, calls } = fakeSecretTool({ broken })
      const err = await thrown(createSecretToolStore({ run }).set('tavily', KEY))
      expect(err.code).toBe('store_unavailable')
      expect(err.why).toMatch(reason)
      expect(err.fix).toContain('TAVILY_API_KEY_FILE')
      expect(err.fix).toContain('--insecure-file')
      expect(calls.some((c) => c.opts.stdin === KEY)).toBe(false)
    },
  )

  it('reports a timeout as a headless session', async () => {
    const { run } = fakeRun(() => ({ code: null, error: 'timeout' }))
    const probe = await createSecretToolStore({ run }).probe()
    expect(probe).toMatchObject({ ok: false })
    expect(JSON.stringify(probe)).toContain('headless')
  })

  it('get returns null for a missing item or a missing binary, and delete reports whether it existed', async () => {
    const store = createSecretToolStore({ run: fakeSecretTool().run })
    expect(await store.get('kagi')).toBeNull()
    expect(await store.delete('kagi')).toBe(false)
    await store.set('kagi', KEY)
    expect(await store.delete('kagi')).toBe(true)
    expect(
      await createSecretToolStore({ run: fakeRun(() => ({ code: null, error: 'ENOENT' })).run }).get('kagi'),
    ).toBeNull()
  })

  it('rejects keys with control characters', async () => {
    const { run, calls } = fakeSecretTool()
    expect((await thrown(createSecretToolStore({ run }).set('exa', 'a\nb'))).code).toBe('invalid_argument')
    expect(calls).toHaveLength(0)
  })
})

describe('Windows DPAPI store', () => {
  const dir = join('C:', 'data', 'secrets')

  function memoryFs(): { fs: KeyFs; files: Map<string, string>; dirs: string[] } {
    const files = new Map<string, string>()
    const dirs: string[] = []
    const fs: KeyFs = {
      exists: (p) => files.has(p),
      readText: (p) => files.get(p) ?? '',
      writeText: (p, t) => void files.set(p, t),
      remove: (p) => files.delete(p),
      ensureDir: (p) => void dirs.push(p),
    }
    return { fs, files, dirs }
  }

  it('uses the exact write script from ADR-0007', () => {
    expect(DPAPI_WRITE_SCRIPT).toBe(
      '$k=[Console]::In.ReadLine(); ConvertTo-SecureString -String $k -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath $env:SEARCHHOLE_DPAPI_OUT',
    )
  })

  it('writes with the key on stdin as data: not in argv, script text or env', async () => {
    const { fs, files, dirs } = memoryFs()
    const { run, calls } = fakeRun((c) => {
      files.set(c.opts.env?.SEARCHHOLE_DPAPI_OUT ?? '', '01000000d08c9ddf0115d1118c7a00c04fc297eb')
      return {}
    })
    await createDpapiStore({ run, fs, dir }).set('tavily', ` ${KEY} `)
    expect(dirs).toEqual([dir])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      cmd: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', DPAPI_WRITE_SCRIPT],
      opts: { stdin: `${KEY}\n`, env: { SEARCHHOLE_DPAPI_OUT: join(dir, 'tavily.dpapi') } },
    })
    expectSecretOnlyInStdin(calls, KEY)
  })

  it('does not start PowerShell when there is no protected file', async () => {
    const { fs } = memoryFs()
    const { run, calls } = fakeRun(() => ({}))
    expect(await createDpapiStore({ run, fs, dir }).get('brave')).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('reads an existing file through the read script and strips the line ending', async () => {
    const { fs, files } = memoryFs()
    files.set(join(dir, 'brave.dpapi'), 'cipher')
    const { run, calls } = fakeRun(() => ({ stdout: `${KEY}\r\n` }))
    const store = createDpapiStore({ run, fs, dir })
    expect(await store.get('brave')).toBe(KEY)
    expect(calls[0]).toMatchObject({
      cmd: 'powershell',
      args: ['-NoProfile', '-NonInteractive', '-Command', DPAPI_READ_SCRIPT],
      opts: { env: { SEARCHHOLE_DPAPI_IN: join(dir, 'brave.dpapi') } },
    })
    expect(store.kind).toBe('dpapi')
  })

  it('fails clearly when PowerShell fails or writes nothing, and when decryption fails', async () => {
    const { fs, files } = memoryFs()
    expect(
      (await thrown(createDpapiStore({ run: fakeRun(() => ({ code: 1 })).run, fs, dir }).set('exa', KEY)))
        .code,
    ).toBe('store_unavailable')
    expect(
      (await thrown(createDpapiStore({ run: fakeRun(() => ({})).run, fs, dir }).set('exa', KEY))).why,
    ).toContain('not written')
    files.set(join(dir, 'exa.dpapi'), 'cipher')
    const err = await thrown(createDpapiStore({ run: fakeRun(() => ({ code: 1 })).run, fs, dir }).get('exa'))
    expect(err.fix).toContain('keys set')
  })

  it('deletes the file without PowerShell, and probes PowerShell', async () => {
    const { fs, files } = memoryFs()
    files.set(join(dir, 'kagi.dpapi'), 'cipher')
    const { run, calls } = fakeRun(() => ({}))
    const store = createDpapiStore({ run, fs, dir })
    expect(await store.delete('kagi')).toBe(true)
    expect(await store.delete('kagi')).toBe(false)
    expect(calls).toHaveLength(0)
    expect(await store.probe()).toEqual({ ok: true })
  })
})

describe('insecure file store', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'searchhole-keys-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes 0600 files in a 0700 folder, reads them back trimmed, and deletes', async () => {
    const secrets = join(dir, 'secrets')
    const store = createInsecureFileStore({ dir: secrets })
    await store.set('exa', ` ${KEY}\n`)
    const file = join(secrets, 'exa.key')
    expect(readFileSync(file, 'utf8')).toBe(`${KEY}\n`)
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(statSync(secrets).mode & 0o777).toBe(0o700)
    }
    expect(await store.get('exa')).toBe(KEY)
    expect(store.kind).toBe('file')
    expect(await store.delete('exa')).toBe(true)
    expect(await store.get('exa')).toBeNull()
    expect(await store.delete('exa')).toBe(false)
  })

  it('treats an empty file as no key and rejects control characters', async () => {
    const store = createInsecureFileStore({ dir })
    writeFileSync(join(dir, 'kagi.key'), '\n')
    expect(await store.get('kagi')).toBeNull()
    expect((await thrown(store.set('kagi', 'a\tb'))).code).toBe('invalid_argument')
  })
})

describe('createKeyStores', () => {
  it('picks the OS store by platform and chains the insecure file after it', () => {
    const run: RunCommand = async () => ({ code: 0, stdout: '', stderr: '' })
    const pick = (platform: NodeJS.Platform) =>
      createOsKeyStore({ platform, secretsDir: '/s', run, fs: nodeKeyFs })
    expect(pick('darwin').label).toBe('macOS Keychain')
    expect(pick('linux').label).toContain('Secret Service')
    expect(pick('win32').kind).toBe('dpapi')
    const stores = createKeyStores({ platform: 'linux', secretsDir: '/s', run })
    expect(stores.readChain.map((s) => s.kind)).toEqual(['keychain', 'file'])
    expect(stores.file.kind).toBe('file')
  })

  it('resolves through the chain: OS store first, then the insecure file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'searchhole-chain-'))
    try {
      const run: RunCommand = async () => ({ code: 1, stdout: '', stderr: '' })
      const stores = createKeyStores({ platform: 'linux', secretsDir: dir, run })
      await stores.file.set('tavily', KEY)
      expect(await resolveKey('tavily', { env: {}, store: stores.readChain })).toMatchObject({
        key: KEY,
        source: 'file',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('nodeRunCommand', () => {
  it('feeds stdin to the child and returns its output', async () => {
    const r = await nodeRunCommand(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
      stdin: 'hello\n',
    })
    expect(r).toMatchObject({ code: 0, stdout: 'hello\n' })
  })

  it('passes extra env vars and reports exit codes', async () => {
    const r = await nodeRunCommand(
      process.execPath,
      ['-e', 'console.log(process.env.SH_TEST_VAR); process.exit(3)'],
      {
        env: { SH_TEST_VAR: 'v' },
      },
    )
    expect(r.code).toBe(3)
    expect(r.stdout.trim()).toBe('v')
  })

  it('reports a missing binary and a timeout without throwing', async () => {
    expect(await nodeRunCommand('searchhole-no-such-binary', [])).toMatchObject({
      code: null,
      error: 'ENOENT',
    })
    const slow = await nodeRunCommand(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
      timeoutMs: 100,
    })
    expect(slow).toMatchObject({ code: null, error: 'timeout' })
  })

  it('does not put stdin in the argument list the child sees', async () => {
    const r = await nodeRunCommand(process.execPath, ['-e', 'console.log(process.argv.slice(1).join(" "))'], {
      stdin: KEY,
    })
    expect(r.stdout).not.toContain(KEY)
  })
})

// The one test that touches the real macOS Keychain. Opt-in: SEARCHHOLE_TEST_KEYCHAIN=1 on darwin.
describe.skipIf(process.platform !== 'darwin' || process.env.SEARCHHOLE_TEST_KEYCHAIN !== '1')(
  'real macOS Keychain',
  () => {
    it('round-trips a key under a throwaway service name and leaves nothing behind', async () => {
      const service = `search-hole-test-${process.pid}-${Date.now()}`
      const store = createMacosKeychainStore({ run: nodeRunCommand, service })
      const engine: EngineId = 'tavily'
      try {
        await store.set(engine, KEY)
        expect(await store.get(engine)).toBe(KEY)
        await store.set(engine, `${KEY}-2`)
        expect(await store.get(engine)).toBe(`${KEY}-2`)
      } finally {
        await store.delete(engine)
      }
      expect(await store.get(engine)).toBeNull()
    })
  },
)
