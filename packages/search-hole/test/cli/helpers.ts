// SPDX-License-Identifier: Apache-2.0
import type {
  AddRuleInput,
  App,
  AppOptions,
  DoctorReport,
  EngineStatus,
  LogDetail,
  LogEntry,
  ReviewList,
  RuleListing,
  SearchArgs,
  SearchMode,
  SuggestRuleInput,
} from '../../src/app/types.ts'
import type { CliIo } from '../../src/cli/io.ts'
import { type CliDeps, runCli } from '../../src/cli/run.ts'
import type { EngineId, MergedResult, RuleDecision, SearchOutcome } from '../../src/shared/types.ts'

const ESC = String.fromCharCode(27)
/** Removes ANSI colour codes. */
export const stripAnsi = (s: string): string => {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ESC) {
      while (i < s.length && s[i] !== 'm') i++
      continue
    }
    out += s[i]
  }
  return out
}

export interface IoOptions {
  env?: Record<string, string | undefined>
  cwd?: string
  /** stdin is a terminal. Default false. */
  tty?: boolean
  stdoutTTY?: boolean
  stdin?: string
  hiddenAnswer?: string
  confirmAnswer?: boolean
  signal?: AbortSignal
  /** argv[1] as main.ts would pass it. */
  entry?: string
}

export interface FakeIo extends CliIo {
  out: () => string
  err: () => string
  prompts: string[]
  confirms: string[]
  stdinReads: number
}

/** A capturing CliIo. Colour is off unless `stdoutTTY` is set. */
export function makeIo(opts: IoOptions = {}): FakeIo {
  let out = ''
  let err = ''
  const io: FakeIo = {
    stdout: {
      write: (t) => {
        out += t
      },
      isTTY: opts.stdoutTTY ?? false,
    },
    stderr: {
      write: (t) => {
        err += t
      },
      isTTY: false,
    },
    stdinIsTTY: opts.tty ?? false,
    env: opts.env ?? {},
    cwd: opts.cwd ?? '/work/project',
    ...(opts.entry === undefined ? {} : { entry: opts.entry }),
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    readStdin: async () => {
      io.stdinReads++
      return opts.stdin ?? ''
    },
    promptHidden: async (p) => {
      io.prompts.push(p)
      return opts.hiddenAnswer ?? ''
    },
    confirm: async (q) => {
      io.confirms.push(q)
      return opts.confirmAnswer ?? true
    },
    out: () => out,
    err: () => err,
    prompts: [],
    confirms: [],
    stdinReads: 0,
  }
  return io
}

// ── Fixtures ─────────────────────────────────────────────────────────────

const NO_DECISION: RuleDecision = {
  visibility: 'kept',
  weight: { factor: 1 },
  preferFactor: 1,
  matches: [],
}

export function merged(over: Partial<MergedResult> & { url: string; title: string }): MergedResult {
  const host = new URL(over.url).hostname
  return {
    canonicalKey: host,
    urls: [over.url],
    snippet: '',
    engines: ['searxng'],
    positions: { searxng: 1 },
    dates: [],
    sourceType: 'unknown',
    registrableDomain: host,
    fused: 1,
    adjusted: 1,
    decision: NO_DECISION,
    flags: [],
    ...over,
  }
}

export function sampleOutcome(): SearchOutcome {
  const pinRule = { ruleId: 'r_pin0000001', tier: 'T3' as const, text: 'react.dev', source: 'rules.yaml:4' }
  const blockRule = {
    ruleId: 'r_blk0000002',
    tier: 'T3' as const,
    text: 'pinterest.com',
    source: 'rules.yaml:9',
  }
  const listRule = {
    ruleId: 'r_lst0000003',
    tier: 'T4' as const,
    listId: 'dev-filter',
    text: '||w3schools.com^',
  }
  const kept: MergedResult[] = [
    merged({
      url: 'https://react.dev/learn/react-compiler',
      title: 'React Compiler – React',
      snippet: 'The React Compiler is a build-time tool that automatically memoizes your components.',
      engines: ['searxng', 'brave'],
      positions: { searxng: 1, brave: 3 },
      sourceType: 'official',
      effectiveDate: {
        value: '2025-10-07T00:00:00.000Z',
        kind: 'modified',
        method: 'engine:brave.page_age',
        confidence: 'high',
        tzAssumed: false,
      },
      dates: [],
      flags: ['pinned', 'updated'],
      decision: {
        ...NO_DECISION,
        visibilityRule: pinRule,
        pin: { rule: pinRule, order: 1 },
        matches: [pinRule],
      },
    }),
    merged({
      url: 'https://github.com/facebook/react/issues/1',
      title: 'Compiler tracking issue',
      snippet: 'Tracking issue',
      sourceType: 'repo',
      positions: { searxng: 2 },
      flags: ['date_unknown', 'raised'],
      decision: {
        ...NO_DECISION,
        weight: { factor: 1.5, rule: { ruleId: 'r_rai0000004', tier: 'T1', text: 'github.com' } },
        preferFactor: 1.2,
        audit: { wouldBe: 'hidden', rule: listRule },
      },
    }),
  ]
  const hidden: MergedResult[] = [
    merged({
      url: 'https://pinterest.com/pin/123',
      title: 'Pin 123',
      hiddenReason: 'rule',
      decision: {
        ...NO_DECISION,
        visibility: 'hidden',
        hiddenReason: 'rule',
        visibilityRule: blockRule,
        matches: [blockRule],
      },
    }),
    merged({
      url: 'https://www.w3schools.com/react/',
      title: 'React Tutorial',
      hiddenReason: 'list',
      decision: {
        ...NO_DECISION,
        visibility: 'hidden',
        hiddenReason: 'list',
        visibilityRule: listRule,
        matches: [listRule],
      },
    }),
    merged({
      url: 'https://old.example.org/post',
      title: 'Old post',
      hiddenReason: 'stale',
      effectiveDate: {
        value: '2019-02-01T00:00:00.000Z',
        kind: 'published',
        method: 'jsonld:datePublished',
        confidence: 'medium',
        tzAssumed: true,
      },
    }),
  ]
  return {
    receiptId: 'rcpt_abc123',
    query: 'react compiler',
    profile: 'coding',
    depth: 'standard',
    results: kept,
    hidden,
    hiddenSummary: {
      count: 3,
      byReason: { rule: 1, list: 1, stale: 1 },
      topDomains: ['pinterest.com', 'w3schools.com'],
    },
    engines: [
      {
        engine: 'searxng',
        status: 'ok',
        latencyMs: 690,
        returned: 12,
        upstream: [{ name: 'wikipedia', errorClass: 'timeout', message: 'timeout', suspended: true }],
      },
      { engine: 'brave', status: 'error', errorClass: 'rate_limited', detail: 'HTTP 429', returned: 0 },
      { engine: 'tavily', status: 'skipped', inactiveReason: 'missing_key', returned: 0 },
    ],
    warnings: [{ code: 'no_official_source' }, { code: 'engine_fallback', from: 'brave', to: 'searxng' }],
    tookMs: 812,
    pushedRuleIds: ['r_blk0000002'],
    fallbackTrail: [{ from: 'brave', to: 'searxng', errorClass: 'rate_limited' }],
  }
}

export function sampleRules(): RuleListing[] {
  return [
    {
      id: 'r_blk0000002',
      scope: 'global',
      match: 'pinterest.com',
      action: 'block',
      weight: 1,
      important: false,
      source: 'rules.yaml:9',
    },
    {
      id: 'r_rai0000004',
      scope: 'project',
      match: 'github.com/orgname/',
      action: 'raise',
      weight: 2,
      important: false,
      profiles: ['coding'],
      until: '2026-12-31',
      note: 'our org',
      source: 'cli',
    },
    {
      id: 'r_imp0000005',
      scope: 'session',
      match: '*.medium.com',
      action: 'lower',
      weight: 3,
      important: true,
      source: 'cli',
    },
  ]
}

export function sampleLog(): LogEntry[] {
  return [
    {
      searchId: 12,
      receiptId: 'rcpt_b',
      at: '2026-10-30T14:02:11.000Z',
      query: 'react compiler',
      profile: 'coding',
      depth: 'standard',
      mode: 'engines',
      client: 'claude-code',
      engines: ['searxng', 'brave'],
      kept: 8,
      hidden: 3,
      latencyMs: 812,
      opened: 1,
    },
    {
      searchId: 11,
      receiptId: 'rcpt_a',
      at: '2026-10-30T13:40:00.000Z',
      query: 'node sqlite DatabaseSync',
      profile: 'coding',
      depth: 'quick',
      mode: 'builtin',
      engines: [],
      kept: 6,
      hidden: 0,
      latencyMs: 40,
      opened: 0,
    },
  ]
}

export function sampleLogDetail(): LogDetail {
  const [first] = sampleLog()
  if (first === undefined) throw new Error('fixture')
  return {
    ...first,
    results: [
      {
        rank: 1,
        engine: 'searxng',
        url: 'https://react.dev/learn/react-compiler',
        domain: 'react.dev',
        title: 'React Compiler',
        decision: 'pinned',
        opened: true,
        sourceType: 'official',
      },
      {
        rank: 2,
        engine: 'searxng',
        url: 'https://www.geeksforgeeks.org/react-compiler/',
        domain: 'geeksforgeeks.org',
        title: 'React Compiler explained',
        decision: 'kept',
        opened: false,
        sourceType: 'blog',
      },
      {
        rank: 2,
        engine: 'brave',
        url: 'https://pinterest.com/pin/123',
        domain: 'pinterest.com',
        title: 'Pin 123',
        decision: 'hidden',
        opened: false,
        reason: 'rule',
        rule: { ruleId: 'r_blk0000002', text: 'pinterest.com', tier: 'T3' },
      },
      {
        rank: 3,
        engine: 'searxng',
        domain: 'old.example.org',
        decision: 'hidden',
        opened: false,
        reason: 'stale',
      },
    ],
  }
}

export function sampleReview(): ReviewList {
  return {
    days: 30,
    minSearches: 3,
    total: 3,
    sites: [
      {
        domain: 'geeksforgeeks.org',
        searches: 9,
        results: 14,
        lastSeen: '2026-10-30T09:15:00.000Z',
        sourceType: 'blog',
        examples: [
          { url: 'https://www.geeksforgeeks.org/react-compiler/', title: 'React Compiler explained' },
          { url: 'https://www.geeksforgeeks.org/node-sqlite/' },
        ],
      },
      {
        domain: 'brave-only.example',
        searches: 5,
        results: 5,
        lastSeen: '2026-10-29T18:00:00.000Z',
        sourceType: 'unknown',
        examples: [],
      },
    ],
    dismissed: [{ domain: 'stackoverflow.com', at: '2026-10-28T10:00:00.000Z' }],
  }
}

export function sampleDoctor(): DoctorReport {
  return {
    version: '0.1.0',
    checks: [
      { id: 'node', status: 'ok', title: 'Node 26.13.0', detail: 'meets >=22.19' },
      {
        id: 'engines',
        status: 'warn',
        title: 'No search engine is set up',
        detail: "Claude Code's own search is used",
        fix: 'searchhole searxng up',
      },
      {
        id: 'store',
        status: 'fail',
        title: 'Database cannot be opened',
        fix: 'Check permissions on ~/.searchhole',
      },
    ],
    engines: [
      {
        engine: 'searxng',
        configured: true,
        active: false,
        inactiveReason: 'unhealthy',
        health: 'unhealthy',
        lastError: 'unreachable',
      },
      {
        engine: 'tavily',
        configured: false,
        active: false,
        inactiveReason: 'missing_key',
        health: 'unknown',
      },
    ],
    paths: {
      config: '/home/u/.searchhole',
      data: '/home/u/.searchhole',
      run: '/home/u/.searchhole/run',
      source: 'dot-dir',
    },
  }
}

// ── Fake App ─────────────────────────────────────────────────────────────

export interface Call {
  method: string
  args: unknown[]
}

export interface FakeApp extends App {
  calls: Call[]
  closed: number
  opened: AppOptions[]
}

export interface FakeAppOptions {
  outcome?: SearchOutcome
  rules?: RuleListing[]
  logs?: LogEntry[]
  detail?: LogDetail | undefined
  doctor?: DoctorReport
  mode?: { configured: SearchMode; effective: 'engines' | 'builtin' }
  suggestions?: Array<{ id: number; input: SuggestRuleInput; createdAt: string; status: string }>
  keyStatus?: Array<{ engine: EngineId; present: boolean; source: string }>
  removeResult?: RuleListing[]
  review?: ReviewList
  /** What `review.dismiss` / `review.restore` report as `changed` (default true). */
  reviewChanged?: boolean
  failWith?: Error
}

const notUsed = (name: string) => (): never => {
  throw new Error(`the CLI must not call App.${name}`)
}

export function makeFakeApp(o: FakeAppOptions = {}): FakeApp {
  const calls: Call[] = []
  const rec = <T>(method: string, args: unknown[], value: T): T => {
    calls.push({ method, args })
    if (o.failWith !== undefined) throw o.failWith
    return value
  }
  const ruleFrom = (input: AddRuleInput): RuleListing => ({
    id: 'r_new0000001',
    scope: input.scope ?? 'global',
    match: input.match,
    action: input.action,
    weight: input.weight ?? 1,
    ...(input.profile === undefined ? {} : { profiles: [input.profile] }),
    important: input.important ?? false,
    ...(input.until === undefined ? {} : { until: input.until }),
    ...(input.note === undefined ? {} : { note: input.note }),
    source: 'cli',
  })
  const app: FakeApp = {
    calls,
    closed: 0,
    opened: [],
    version: '0.1.0',
    host: 'cli',
    search: async (args: SearchArgs, ctx) => rec('search', [args, ctx], o.outcome ?? sampleOutcome()),
    fetch: notUsed('fetch'),
    receipt: notUsed('receipt'),
    suggestRule: notUsed('suggestRule'),
    searchMode: async () => rec('searchMode', [], o.mode ?? { configured: 'auto', effective: 'builtin' }),
    builtinBlockedDomains: notUsed('builtinBlockedDomains'),
    filterBuiltinResults: notUsed('filterBuiltinResults'),
    checkUrl: notUsed('checkUrl'),
    recordBuiltinFetch: notUsed('recordBuiltinFetch'),
    checkQuery: notUsed('checkQuery'),
    engineStatus: notUsed('engineStatus') as () => Promise<EngineStatus[]>,
    probeEngines: notUsed('probeEngines'),
    openTurn: notUsed('openTurn'),
    closeTurn: notUsed('closeTurn'),
    rules: {
      list: async (opts) => rec('rules.list', [opts], o.rules ?? sampleRules()),
      add: async (input, ctx) => rec('rules.add', [input, ctx], ruleFrom(input)),
      remove: async (id, opts) =>
        rec('rules.remove', [id, opts], o.removeResult ?? sampleRules().slice(0, 1)),
      explain: async (url, opts) =>
        rec('rules.explain', [url, opts], {
          decision: 'hidden by rule',
          lines: ['T3 global: block pinterest.com'],
        }),
      trust: async (dir) =>
        rec('rules.trust', [dir], { path: `${dir}/.searchhole.yaml`, sha256: 'a'.repeat(64) }),
    },
    keys: {
      set: async (engine, value) => rec('keys.set', [engine, value], { backend: 'macOS Keychain' }),
      status: async () =>
        rec(
          'keys.status',
          [],
          o.keyStatus ?? [
            { engine: 'tavily', present: true, source: 'keychain' },
            { engine: 'brave', present: false, source: 'missing' },
          ],
        ),
      remove: async (engine) => rec('keys.remove', [engine], undefined),
    },
    suggestions: {
      list: async () => rec('suggestions.list', [], o.suggestions ?? []),
      approve: async (id) =>
        rec('suggestions.approve', [id], ruleFrom({ match: 'spam.example', action: 'block' })),
      reject: async (id) => rec('suggestions.reject', [id], undefined),
    },
    log: {
      recent: async (opts) => rec('log.recent', [opts], o.logs ?? sampleLog()),
      detail: async (id) => rec('log.detail', [id], 'detail' in o ? o.detail : sampleLogDetail()),
    },
    review: {
      list: async (opts) => rec('review.list', [opts], o.review ?? sampleReview()),
      dismiss: async (site) =>
        rec('review.dismiss', [site], { domain: site.toLowerCase(), changed: o.reviewChanged ?? true }),
      restore: async (site) =>
        rec('review.restore', [site], { domain: site.toLowerCase(), changed: o.reviewChanged ?? true }),
    },
    settings: {
      get: async () => rec('settings.get', [], {}),
      setMode: async (mode) => rec('settings.setMode', [mode], undefined),
    },
    doctor: async (opts) => rec('doctor', [opts], o.doctor ?? sampleDoctor()),
    close: async () => {
      app.closed++
    },
  }
  return app
}

export interface Run {
  code: number
  keepAlive: boolean
  out: string
  err: string
  io: FakeIo
  app: FakeApp
}

/** Runs the CLI against a fake app and returns what it printed. */
export async function run(
  argv: string[],
  ioOpts: IoOptions = {},
  appOpts: FakeAppOptions = {},
  depsOver: Partial<CliDeps> = {},
): Promise<Run> {
  const app = makeFakeApp(appOpts)
  const io = makeIo(ioOpts)
  const deps: CliDeps = {
    openApp: async (opts) => {
      app.opened.push(opts)
      return app
    },
    startGateway: async () => {
      throw new Error('gateway not expected')
    },
    timeZone: 'UTC',
    now: () => Date.UTC(2026, 9, 30, 12, 0, 0),
    ...depsOver,
  }
  const outcome = await runCli(argv, io, deps)
  return { ...outcome, out: io.out(), err: io.err(), io, app }
}
