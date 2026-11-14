// SPDX-License-Identifier: Apache-2.0
/**
 * Human output for every command. Each function turns data into a string (no I/O), so the
 * output is easy to snapshot. Colour comes only from the `Style` passed in.
 */
import type {
  DoctorReport,
  EngineStatus,
  ListCatalogEntry,
  ListStatus,
  ListUpdateResult,
  LogDetail,
  LogEntry,
  RuleListing,
  SearchMode,
  SuggestRuleInput,
} from '../app/types.ts'
import { describeClasses } from '../core/hygiene.ts'
import type {
  EngineRun,
  HiddenReason,
  MergedResult,
  RuleRef,
  SearchOutcome,
  Tier,
  Warning,
} from '../shared/types.ts'
import type { SearxngStatus } from './searxng.ts'
import type { Style } from './style.ts'

export interface RenderOpts {
  style: Style
  /** IANA zone for times; the machine's local zone when omitted. */
  timeZone?: string
}

// ── Small helpers ────────────────────────────────────────────────────────

/** Length of a string as displayed, ignoring ANSI colour codes. */
export function visibleLength(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\u001b') {
      while (i < text.length && text[i] !== 'm') i++
      continue
    }
    n++
  }
  return n
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)))
}

/** Lays out rows as aligned columns (the last column is not padded). */
export function renderTable(rows: readonly (readonly string[])[], indent = '', gap = 2): string[] {
  const widths: number[] = []
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, visibleLength(cell))
    })
  }
  return rows.map((row) => {
    const last = row.length - 1
    const cells = row.map((cell, i) => (i === last ? cell : pad(cell, widths[i] ?? 0)))
    return `${indent}${cells.join(' '.repeat(gap))}`.trimEnd()
  })
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** `YYYY-MM-DD HH:MM` in the given zone (or local time). */
export function formatTime(iso: string, timeZone?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).formatToParts(d)
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

const day = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso)
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const factorText = (f: number): string => String(Number(f.toFixed(2)))

const TIER_NAMES: Readonly<Record<Tier, string>> = {
  T0s: 'important, session',
  T0g: 'important, global',
  T1: 'session',
  T2: 'project',
  T3: 'global',
  T4: 'list',
}

/** `r_ab12 (global) "pinterest.com"`: which rule, from where, and its text. */
export function ruleLabel(ref: Pick<RuleRef, 'ruleId' | 'tier' | 'text'> & Partial<RuleRef>): string {
  const where = ref.listId === undefined ? TIER_NAMES[ref.tier] : `list ${ref.listId}`
  const source = ref.source === undefined ? '' : ` @ ${ref.source}`
  return `${ref.ruleId} (${where}) "${ref.text}"${source}`
}

const HIDDEN_WORDS: Readonly<Record<HiddenReason, string>> = {
  rule: 'rule',
  list: 'list',
  stale: 'stale',
  date_required: 'no date',
  allowlist_mode: 'allowlist',
}

const hiddenWord = (r: HiddenReason): string => HIDDEN_WORDS[r]

function byReasonText(byReason: Partial<Record<HiddenReason, number>>): string {
  return Object.entries(byReason)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([reason, n]) => `${n} ${hiddenWord(reason as HiddenReason)}`)
    .join(', ')
}

/** One sentence for a search warning. */
export function describeWarning(w: Warning): string {
  switch (w.code) {
    case 'no_official_source':
      return 'No official or docs source among the results.'
    case 'single_source':
      return 'All kept results come from one site.'
    case 'all_stale':
      return 'Every result is older than the freshness limit.'
    case 'coverage_skipped':
      return 'The deep-coverage swap was skipped: no slot was free to swap into.'
    case 'receipt_expired':
      return `Receipt ${w.previous} had expired, so a new receipt was started.`
    case 'engine_fallback':
      return `${w.from} could not answer; ${w.to} was used instead.`
    case 'spend_cap_local':
      return `${w.engine} reached its local spend cap and was skipped.`
    case 'logging_unavailable':
      return `This search was not logged: ${w.detail}`
    case 'list_compiling':
      return `List ${w.listId} is still compiling, so its rules were not applied yet.`
    case 'query_redacted':
      return `Removed ${describeClasses(w.classes)} from the query before sending it.`
  }
}

function engineSummary(run: EngineRun): string {
  const ms = run.latencyMs === undefined ? '' : ` ${Math.round(run.latencyMs)}ms`
  switch (run.status) {
    case 'ok':
      return `${run.engine}${ms}`
    case 'empty':
      return `${run.engine} 0 results${ms}`
    case 'error':
      return `${run.engine} failed (${run.errorClass ?? 'error'})`
    case 'skipped':
      return `${run.engine} skipped (${run.inactiveReason ?? 'inactive'})`
  }
}

function engineDetail(run: EngineRun): string {
  switch (run.status) {
    case 'ok':
      return `${plural(run.returned, 'result')}${run.latencyMs === undefined ? '' : `, ${Math.round(run.latencyMs)} ms`}`
    case 'empty':
      return `no results${run.latencyMs === undefined ? '' : `, ${Math.round(run.latencyMs)} ms`}`
    case 'error':
      return `${run.errorClass ?? 'error'}${run.detail === undefined ? '' : `: ${clip(run.detail, 120)}`}`
    case 'skipped':
      return `${run.inactiveReason ?? 'inactive'}${run.detail === undefined ? '' : `: ${clip(run.detail, 120)}`}`
  }
}

function dateText(r: MergedResult): string {
  const d = r.effectiveDate
  return d === undefined ? 'no date' : day(d.value)
}

// ── search ───────────────────────────────────────────────────────────────

function badges(r: MergedResult): string {
  const parts: string[] = [r.sourceType, dateText(r)]
  for (const f of r.flags) if (f !== 'date_unknown') parts.push(f.replace('_', ' '))
  return `[${parts.join(' · ')}]`
}

function headline(o: SearchOutcome): string {
  const hidden = o.hiddenSummary.count
  const bits = [
    'search-hole',
    plural(o.results.length, 'result'),
    ...(hidden > 0 ? [`${hidden} hidden (${byReasonText(o.hiddenSummary.byReason)})`] : []),
    o.engines.map(engineSummary).join(', '),
    `receipt ${o.receiptId}`,
  ]
  return bits.filter((b) => b !== '').join(' · ')
}

/** The default `search` output: a compact list the way a person reads it. */
function renderSearchCompact(o: SearchOutcome, { style }: RenderOpts): string {
  const lines: string[] = [style.bold(headline(o))]
  o.results.forEach((r, i) => {
    lines.push('', `${style.bold(`${i + 1}.`)} ${style.bold(r.title || r.url)}  ${style.dim(badges(r))}`)
    lines.push(`   ${style.cyan(r.url)}`)
    if (r.snippet.trim() !== '') lines.push(`   ${clip(r.snippet, 200)}`)
  })
  if (o.results.length === 0) lines.push('', 'No results.')
  if (o.alteredQuery !== undefined) lines.push('', `Engine corrected the query to "${o.alteredQuery}".`)
  if (o.warnings.length > 0) lines.push('')
  for (const w of o.warnings) lines.push(style.yellow(`⚠ ${describeWarning(w)}`))
  if (o.hiddenSummary.count > 0) {
    const where = o.hiddenSummary.topDomains.length > 0 ? ` (${o.hiddenSummary.topDomains.join(', ')})` : ''
    lines.push(
      '',
      style.dim(`${plural(o.hiddenSummary.count, 'result')} hidden${where}. Add --explain to see why.`),
    )
  }
  return lines.join('\n')
}

function resultReasons(r: MergedResult): string[] {
  const d = r.decision
  const out: string[] = []
  if (d.pin !== undefined) out.push(`pinned (order ${d.pin.order}) by ${ruleLabel(d.pin.rule)}`)
  else if (d.visibilityRule !== undefined) out.push(`kept by ${ruleLabel(d.visibilityRule)}`)
  if (d.weight.rule !== undefined && d.weight.factor !== 1) {
    out.push(
      `${d.weight.factor > 1 ? 'raised' : 'lowered'} ×${factorText(d.weight.factor)} by ${ruleLabel(d.weight.rule)}`,
    )
  }
  if (d.preferFactor !== 1) out.push(`profile prefers this source (×${factorText(d.preferFactor)})`)
  if (d.audit !== undefined) out.push(`audit: would be ${d.audit.wouldBe} by ${ruleLabel(d.audit.rule)}`)
  if (r.keptReason === 'coverage') out.push('kept so every engine that answered is represented (deep)')
  return out
}

function dateDetail(r: MergedResult): string {
  const d = r.effectiveDate
  if (d === undefined) return 'date unknown'
  return `date ${day(d.value)} (${d.kind}, ${d.confidence}, ${d.method}${d.tzAssumed ? ', time zone assumed' : ''})`
}

function positionsText(r: MergedResult): string {
  const hits = Object.entries(r.positions).map(([engine, rank]) => `${engine} #${rank}`)
  return hits.length > 0 ? hits.join(', ') : r.engines.join(', ')
}

function hiddenWhy(r: MergedResult): string[] {
  const reason = r.hiddenReason ?? 'rule'
  const rule = r.decision.visibilityRule
  switch (reason) {
    case 'rule':
    case 'list':
      return [rule === undefined ? 'rule not recorded' : ruleLabel(rule)]
    case 'allowlist_mode':
      return [`profile allows only listed sites${rule === undefined ? '' : `; ${ruleLabel(rule)}`}`]
    case 'stale':
      return [`older than the freshness limit; ${dateDetail(r)}`]
    case 'date_required':
      return ['the profile requires a date and none was found']
  }
}

/** `search --explain`: kept results with reasons, hidden results with the deciding rule, engines, warnings. */
function renderSearchExplain(o: SearchOutcome, { style }: RenderOpts): string {
  const lines: string[] = []
  lines.push(
    style.bold(`Search: ${o.query}`),
    `profile ${o.profile} · depth ${o.depth} · ${o.tookMs} ms · receipt ${o.receiptId}`,
  )
  if (o.alteredQuery !== undefined) lines.push(`engine corrected the query to "${o.alteredQuery}"`)

  lines.push('', style.bold(`Kept (${o.results.length})`))
  if (o.results.length === 0) lines.push('  none')
  o.results.forEach((r, i) => {
    lines.push(`${String(i + 1).padStart(3)}. ${style.bold(r.title || r.url)}`)
    lines.push(`     ${style.cyan(r.url)}`)
    lines.push(`     ${dateDetail(r)} · ${r.sourceType} · ${positionsText(r)}`)
    if (r.flags.length > 0) lines.push(`     flags: ${r.flags.join(', ')}`)
    for (const why of resultReasons(r)) lines.push(`     ${style.green('why:')} ${why}`)
  })

  lines.push('', style.bold(`Hidden (${o.hidden.length})`))
  if (o.hidden.length === 0) lines.push('  none')
  for (const r of o.hidden) {
    const reason = r.hiddenReason ?? 'rule'
    lines.push(`  - ${style.red(`[${hiddenWord(reason)}]`)} ${r.title || r.url}`)
    lines.push(`    ${style.cyan(r.url)}`)
    for (const why of hiddenWhy(r)) lines.push(`    ${style.yellow('why:')} ${why}`)
    if (reason !== 'stale' && r.effectiveDate !== undefined) lines.push(`    ${dateDetail(r)}`)
  }
  if (o.hiddenSummary.count > o.hidden.length) {
    const more = o.hiddenSummary.count - o.hidden.length
    lines.push(`  (${more} more hidden ${more === 1 ? 'result is' : 'results are'} not listed)`)
  }
  if (o.pushedRuleIds !== undefined && o.pushedRuleIds.length > 0) {
    lines.push(
      `  ${plural(o.pushedRuleIds.length, 'block rule')} (${o.pushedRuleIds.join(', ')}) ran inside the engines; their hits are not observable.`,
    )
  }

  lines.push('', style.bold('Engines'))
  const rows = o.engines.map((run) => [
    `  ${run.engine}`,
    run.status === 'ok' || run.status === 'empty' ? style.green(run.status) : style.red(run.status),
    engineDetail(run),
  ])
  lines.push(...renderTable(rows))
  for (const run of o.engines) {
    for (const u of run.upstream ?? []) {
      lines.push(`    ${run.engine}/${u.name}: ${u.errorClass}${u.suspended ? ' (suspended)' : ''}`)
    }
    if (run.pushedRuleCount !== undefined && run.pushedRuleCount > 0) {
      lines.push(`    ${run.engine}: ${plural(run.pushedRuleCount, 'block rule')} pushed to the engine`)
    }
    if (run.attribution !== undefined) lines.push(`    ${run.engine}: ${run.attribution}`)
  }
  for (const hop of o.fallbackTrail ?? [])
    lines.push(`  fallback: ${hop.from} → ${hop.to} (${hop.errorClass})`)

  lines.push('', style.bold('Warnings'))
  if (o.warnings.length === 0) lines.push('  none')
  for (const w of o.warnings) lines.push(style.yellow(`  ⚠ ${describeWarning(w)}`))
  return lines.join('\n')
}

/** Renders a search outcome; `explain` adds the rule-by-rule account. */
export function renderSearch(outcome: SearchOutcome, opts: RenderOpts, explain: boolean): string {
  return explain ? renderSearchExplain(outcome, opts) : renderSearchCompact(outcome, opts)
}

// ── rules ────────────────────────────────────────────────────────────────

function ruleExtras(rule: RuleListing): string {
  const bits: string[] = []
  if (rule.important) bits.push('important')
  if (rule.profiles !== undefined && rule.profiles.length > 0) bits.push(`profile ${rule.profiles.join(',')}`)
  if (rule.until !== undefined) bits.push(`until ${rule.until}`)
  if (rule.note !== undefined && rule.note !== '') bits.push(`"${clip(rule.note, 60)}"`)
  if (rule.source !== '' && rule.source !== 'cli') bits.push(`from ${rule.source}`)
  return bits.join(' · ')
}

const actionText = (rule: RuleListing): string =>
  rule.action === 'raise' || rule.action === 'lower' ? `${rule.action} ${rule.weight}` : rule.action

/** The `rules` listing: one aligned row per rule. */
export function renderRules(rules: readonly RuleListing[], { style }: RenderOpts): string {
  if (rules.length === 0) return 'No rules yet. Try `searchhole block <domain>`.'
  const rows: string[][] = [
    [style.dim('ID'), style.dim('SCOPE'), style.dim('ACTION'), style.dim('MATCH'), style.dim('NOTES')],
  ]
  for (const r of rules) {
    const notes = [ruleExtras(r), r.needsTrust ? 'not trusted yet' : ''].filter((x) => x !== '').join(' · ')
    rows.push([r.id, r.scope, actionText(r), r.match, notes])
  }
  const out = [...renderTable(rows), '', style.dim(plural(rules.length, 'rule'))]
  if (rules.some((r) => r.needsTrust)) out.push(NEEDS_TRUST)
  return out.join('\n')
}

/** Shown wherever a project rule is saved but not applied (ADR-0008: project files need trust). */
const NEEDS_TRUST =
  "This project's rules don't apply until you trust its .searchhole.yaml: run `searchhole trust` in the project."

/** Confirmation after a rule verb. */
export function renderRuleAdded(rule: RuleListing, { style }: RenderOpts): string {
  const extras = ruleExtras(rule)
  return [
    `${style.green('✓')} ${actionText(rule)} ${style.bold(rule.match)} (${rule.scope}) as ${rule.id}${extras === '' ? '' : ` · ${extras}`}`,
    ...(rule.needsTrust ? [style.yellow(`  Saved, not applied yet. ${NEEDS_TRUST}`)] : []),
    style.dim(`  Undo with: searchhole unrule ${rule.id}`),
  ].join('\n')
}

/** Confirmation after `unrule`. */
export function renderRulesRemoved(removed: readonly RuleListing[], { style }: RenderOpts): string {
  return removed
    .map((r) => `${style.green('✓')} removed ${r.id}: ${actionText(r)} ${r.match} (${r.scope})`)
    .join('\n')
}

/** `explain <url>`: the decision and the matching rules, as the app words them. */
export function renderUrlExplain(
  url: string,
  result: { decision: string; lines: string[] },
  { style }: RenderOpts,
): string {
  return [style.bold(url), result.decision, ...result.lines.map((l) => `  ${l}`)].join('\n')
}

// ── log ──────────────────────────────────────────────────────────────────

/** The `log` listing: newest first. */
export function renderLog(entries: readonly LogEntry[], { style, timeZone }: RenderOpts): string {
  if (entries.length === 0) return 'Nothing logged yet.'
  const rows = entries.map((e) => [
    style.bold(`#${e.searchId}`),
    formatTime(e.at, timeZone),
    `"${clip(e.query, 60)}"`,
    `${e.profile}/${e.depth}${e.mode === 'builtin' ? ' (built-in)' : ''}`,
    `${e.kept} kept${e.hidden > 0 ? style.red(` · ${e.hidden} hidden`) : ''}`,
    e.engines.length > 0 ? e.engines.join('+') : '-',
    `${e.latencyMs} ms`,
  ])
  return [...renderTable(rows), '', style.dim('Details: searchhole log show <id>')].join('\n')
}

/** `log show <id>`: one search with every result's decision. */
export function renderLogDetail(d: LogDetail, { style, timeZone }: RenderOpts): string {
  const lines = [
    style.bold(`Search #${d.searchId}: ${d.query}`),
    `${formatTime(d.at, timeZone)} · ${d.profile}/${d.depth}${d.mode === 'builtin' ? ' · built-in WebSearch' : ''} · ${d.engines.join('+') || 'no engines'} · ${d.latencyMs} ms${d.client === undefined ? '' : ` · ${d.client}`}`,
    `receipt ${d.receiptId} · ${d.kept} kept · ${d.hidden} hidden`,
    '',
  ]
  const rows = d.results.map((r) => {
    const mark =
      r.decision === 'hidden' ? style.red('hidden') : r.decision === 'pinned' ? style.green('pinned') : 'kept'
    const why = r.rule !== undefined ? ruleLabel(r.rule) : r.reason !== undefined ? hiddenWord(r.reason) : ''
    return [String(r.rank).padStart(3), r.engine, mark, r.url ?? r.domain, r.sourceType ?? '', why]
  })
  const table = renderTable(rows)
  d.results.forEach((r, i) => {
    lines.push(table[i] ?? '')
    if (r.title !== undefined && r.title !== '') lines.push(style.dim(`      ${clip(r.title, 100)}`))
  })
  return lines.join('\n')
}

// ── suggestions, keys, mode ──────────────────────────────────────────────

/** The `suggestions` queue. */
export function renderSuggestions(
  items: ReadonlyArray<{ id: number; input: SuggestRuleInput; createdAt: string; status: string }>,
  { style, timeZone }: RenderOpts,
): string {
  if (items.length === 0) return 'No suggestions waiting.'
  const rows = items.map((s) => [
    style.bold(`#${s.id}`),
    s.status,
    `${s.input.action} ${s.input.match}`,
    `(${s.input.scope ?? 'global'}${s.input.profile === undefined ? '' : `, ${s.input.profile}`})`,
    `"${clip(s.input.reason, 80)}"`,
    formatTime(s.createdAt, timeZone),
  ])
  return [
    ...renderTable(rows),
    '',
    style.dim('Approve: searchhole approve <id>   Reject: searchhole reject <id>'),
  ].join('\n')
}

/** `keys status`: presence and source, never a value. */
export function renderKeysStatus(
  rows: ReadonlyArray<{ engine: string; present: boolean; source: string }>,
  { style }: RenderOpts,
): string {
  const table = rows.map((r) => [
    r.engine,
    r.present ? style.green('set') : style.dim('not set'),
    r.present ? r.source : '',
  ])
  return renderTable(table).join('\n')
}

/** `mode` with no argument. */
export function renderMode(
  info: { configured: SearchMode; effective: 'engines' | 'builtin' },
  { style }: RenderOpts,
): string {
  const how =
    info.effective === 'builtin'
      ? "Claude Code's own WebSearch runs, with your rules applied to it"
      : 'search-hole searches with your engines and steers Claude Code to it'
  return `${style.bold(info.configured)} (working as ${info.effective}): ${how}.`
}

// ── doctor ───────────────────────────────────────────────────────────────

function engineStatusRow(s: EngineStatus, style: Style): string[] {
  const state =
    s.reachable === false
      ? style.dim('not running')
      : s.active
        ? style.green('active')
        : style.dim('inactive')
  const why = [
    ...new Set(
      [
        s.active ? '' : (s.inactiveReason ?? ''),
        s.health === 'unknown' ? '' : s.health,
        s.lastError === undefined ? '' : `last error ${s.lastError}`,
        s.keySource === undefined ? '' : `key from ${s.keySource}`,
        s.suspendedUntil === undefined ? '' : `suspended until ${s.suspendedUntil}`,
      ].filter((x) => x !== ''),
    ),
  ].join(' · ')
  return [`  ${s.engine}`, state, why]
}

const CHECK_MARK = { ok: '✓', warn: '!', fail: '✗', info: 'i' } as const

/** The `doctor` report. */
export function renderDoctor(report: DoctorReport, { style }: RenderOpts): string {
  const lines = [style.bold(`search-hole ${report.version} doctor`), '']
  for (const c of report.checks) {
    const mark = CHECK_MARK[c.status]
    const painted =
      c.status === 'ok'
        ? style.green(mark)
        : c.status === 'fail'
          ? style.red(mark)
          : c.status === 'warn'
            ? style.yellow(mark)
            : style.dim(mark)
    lines.push(`${painted} ${c.title}${c.detail === undefined ? '' : style.dim(` — ${c.detail}`)}`)
    if (c.fix !== undefined && c.status !== 'ok') lines.push(`    → ${c.fix}`)
  }
  lines.push('', style.bold('Engines'))
  if (report.engines.length === 0) lines.push('  none configured')
  else lines.push(...renderTable(report.engines.map((e) => engineStatusRow(e, style))))
  lines.push('', style.bold('Paths'))
  lines.push(
    ...renderTable([
      ['  config', report.paths.config],
      ['  data', report.paths.data],
      ['  run', report.paths.run],
      ['  chosen by', report.paths.source],
    ]),
  )
  const fails = report.checks.filter((c) => c.status === 'fail').length
  const warns = report.checks.filter((c) => c.status === 'warn').length
  const usable = report.engines.some((e) => e.active && e.reachable !== false && e.health !== 'unhealthy')
  lines.push(
    '',
    fails > 0
      ? style.red(`${plural(fails, 'problem')} to fix${warns > 0 ? `, ${plural(warns, 'warning')}` : ''}.`)
      : warns > 0
        ? style.yellow(`No problems; ${plural(warns, 'warning')}.`)
        : usable
          ? style.green('Everything looks good.')
          : style.green(
              'Ready, with no engine: in Claude Code your rules filter its built-in search. Optional: add an engine for snippets, dates and better ranking (`searchhole searxng up`, or a free Tavily key).',
            ),
  )
  return lines.join('\n')
}

// ── searxng ──────────────────────────────────────────────────────────────

/** `searxng status`. */
export function renderSearxngStatus(s: SearxngStatus, { style }: RenderOpts): string {
  const lines: string[] = []
  const docker =
    s.docker === 'ok'
      ? style.green('available')
      : s.docker === 'missing'
        ? style.red('not installed')
        : style.red('installed, but the daemon is not running')
  lines.push(`docker      ${docker}`)
  if (s.docker === 'ok') {
    const state =
      s.container === 'running'
        ? style.green('running')
        : s.container === 'stopped'
          ? style.yellow('stopped')
          : style.dim('not created')
    lines.push(`container   ${s.name} ${state}`)
    if (s.container !== 'absent') {
      lines.push(
        `image       ${s.imageMatches ? 'pinned image' : style.yellow('a different image than this version pins')}`,
      )
      lines.push(
        `port        ${s.portMatches ? `127.0.0.1:${s.port}` : style.yellow(`not 127.0.0.1:${s.port} (settings changed? run: searchhole searxng apply)`)}`,
      )
    }
    if (s.container === 'running') {
      lines.push(
        `health      ${s.healthy ? style.green('healthy') : style.red('not answering /healthz yet')}`,
      )
    }
  }
  lines.push(`url         ${s.url}`)
  lines.push(`files       ${s.dataDir}`)
  if (!s.managed)
    lines.push(style.yellow('settings.yaml has searxng.managed: false; up and apply are disabled.'))
  if (s.docker !== 'ok')
    lines.push(
      '',
      `→ ${s.docker === 'missing' ? 'Install Docker, or use a free Tavily key: searchhole keys set tavily' : 'Start Docker, then run: searchhole searxng up'}`,
    )
  else if (s.container !== 'running') lines.push('', '→ Start it with: searchhole searxng up')
  return lines.join('\n')
}

// ── Lists (ADR-0022) ─────────────────────────────────────────────────────

const num = (n: number): string => n.toLocaleString('en-US')

function modeText(mode: ListStatus['mode'], style: Style): string {
  if (mode === 'enforce') return style.green('enforce')
  if (mode === 'audit') return style.yellow('audit')
  return style.dim('off')
}

/** What a list did in the last 7 days: hid (enforce) or would hide (audit). */
function contributionText(s: ListStatus): string {
  if (s.mode === 'disabled') return '-'
  const { hidden7d, wouldHide7d } = s.contribution
  if (s.mode === 'audit') return wouldHide7d > 0 ? `would hide ${num(wouldHide7d)}` : '-'
  return hidden7d > 0 ? `hid ${num(hidden7d)}` : '-'
}

function listNote(s: ListStatus, style: Style): string {
  if (s.lastError !== null) return style.yellow(`⚠ ${s.lastError.code}`)
  if (s.copy === 'none') return style.yellow('not downloaded yet')
  if (s.kind === 'official') return style.dim('annotates')
  return ''
}

/** `searchhole lists`: one row per list. */
export function renderLists(lists: readonly ListStatus[], { style, timeZone }: RenderOpts): string {
  const rows: string[][] = [
    [
      style.dim('ID'),
      style.dim('MODE'),
      style.dim('SOURCE'),
      style.dim('KIND'),
      style.dim('RULES'),
      style.dim('7 DAYS'),
      style.dim('UPDATED'),
      style.dim('NOTES'),
    ],
  ]
  for (const s of lists) {
    const updated =
      s.lastUpdate === null
        ? s.source === 'bundled'
          ? 'built in'
          : '-'
        : formatTime(s.lastUpdate, timeZone).slice(0, 10)
    rows.push([
      s.id,
      modeText(s.mode, style),
      s.source,
      s.kind,
      num(s.ruleCount),
      contributionText(s),
      updated,
      listNote(s, style),
    ])
  }
  const lines = [...renderTable(rows)]
  const failing = lists.filter((s) => s.lastError !== null && s.mode !== 'disabled')
  for (const s of failing) lines.push('', `${style.yellow('⚠')} ${s.id}: ${s.lastError?.message ?? ''}`)
  lines.push(
    '',
    style.dim(
      `${plural(lists.length, 'list')}. Change one: searchhole lists enforce|audit|disable <id> · more: searchhole lists catalog`,
    ),
  )
  return lines.join('\n')
}

/** `searchhole lists catalog`. */
export function renderCatalog(entries: readonly ListCatalogEntry[], { style }: RenderOpts): string {
  const rows: string[][] = [
    [
      style.dim('ID'),
      style.dim('KIND'),
      style.dim('RULES'),
      style.dim('LICENSE'),
      style.dim('HERE'),
      style.dim('NAME'),
    ],
  ]
  for (const c of entries) {
    const here =
      c.mode === undefined ? '' : c.mode === 'disabled' ? style.dim('off') : modeText(c.mode, style)
    rows.push([
      c.id,
      c.kind,
      c.approxRules === undefined ? '?' : `~${num(c.approxRules)}`,
      c.license,
      `${here}${c.starter ? style.dim(' (starter)') : ''}`.trim(),
      clip(c.name, 60),
    ])
  }
  return [
    ...renderTable(rows),
    '',
    style.dim('Add one: searchhole lists add <id> [--mode audit]   Details: searchhole lists catalog --json'),
  ].join('\n')
}

/** One list after add, import or a mode change. */
export function renderListStatus(s: ListStatus, { style }: RenderOpts): string {
  const head = `${style.green('✓')} ${s.id}: ${modeText(s.mode, style)} · ${num(s.ruleCount)} rules · ${s.source}`
  const lines = [head]
  if (s.skipped > 0) lines.push(style.dim(`  ${num(s.skipped)} lines could not be used (${skipText(s)})`))
  if (s.lastError !== null) lines.push(`  ${style.yellow('⚠')} ${s.lastError.message}`)
  if (s.mode === 'audit') {
    lines.push(style.dim('  Audit: it records what it would hide and changes nothing.'))
    lines.push(
      style.dim(
        `  See its effect with \`searchhole lists\`; enforce it with \`searchhole lists enforce ${s.id}\`.`,
      ),
    )
  }
  return lines.join('\n')
}

function skipText(s: ListStatus): string {
  return Object.entries(s.skipReasons)
    .slice(0, 3)
    .map(([reason, n]) => `${num(n)} ${reason}`)
    .join(', ')
}

/** `searchhole lists update`. */
export function renderListUpdates(results: readonly ListUpdateResult[], { style }: RenderOpts): string {
  if (results.length === 0) return 'No list to refresh (built-in and imported lists are not downloaded).'
  return results
    .map((r) => {
      const mark =
        r.result === 'updated'
          ? style.green('✓')
          : r.result === 'unchanged'
            ? style.green('=')
            : r.result === 'failed'
              ? style.yellow('⚠')
              : style.dim('-')
      return `${mark} ${r.id}: ${r.result === 'failed' ? `kept the copy in force. ${r.message}` : r.message}`
    })
    .join('\n')
}

/** `searchhole lists remove`. */
export function renderListRemoved(s: ListStatus, { style }: RenderOpts): string {
  return `${style.green('✓')} removed ${s.id} (${s.source}, ${num(s.ruleCount)} rules)`
}
