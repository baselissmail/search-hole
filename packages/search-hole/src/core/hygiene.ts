// SPDX-License-Identifier: Apache-2.0
/**
 * Query hygiene (ADR-0015 point 4, MASTER_PLAN §12.4). Pure: a query is scanned for
 * secrets and internal hostnames before any engine sees it, and the same redactor runs
 * before anything is logged.
 *
 * Design notes (decisions the ADR left open):
 * - Detectors are data (`DETECTORS`); every regex is RE2 syntax and runs through re2js,
 *   so scanning is linear-time on any input. Extra validation is by named checks.
 * - Findings carry class and offsets only. The matched text is never copied into a
 *   finding, an error or a log line.
 * - Thresholds. A long token is "clearly secret-like" only when it has a digit and a
 *   letter, at least 32 characters, Shannon entropy of 3.5 bits per character or more,
 *   and few separators. Hex of standard digest length (32, 40, 56, 64, 96, 128), UUIDs,
 *   `sha512-` style integrity strings and a lone JWT header or payload segment are
 *   hashes or identifiers, never blocked as tokens.
 *   Prefixed keys (`sk-`, `ghp_`, ...) need a digit and the same entropy floor, so
 *   `sk-learn-pipeline-column-transformer` passes. Documented placeholders pass too
 *   (`AKIA...EXAMPLE`, `user:password@`).
 * - Hosts are deliberately lenient, because a blocked query costs more than a leaked
 *   service name: loopback (`localhost`, 127.0.0.0/8, ::1) is exempt by default, since
 *   `ECONNREFUSED 127.0.0.1:5432` is one of the most common developer queries and leaks
 *   nothing (`flagLoopback` turns it on). A single-label host counts only inside a
 *   network URL (`http://jenkins/...`), never as a bare word or `host:port`. Generic
 *   compose and placeholder names (`db`, `redis`, `example`), container and cluster
 *   DNS names (`host.docker.internal`, `*.cluster.local`) and Java package names
 *   (`com.acme.internal`) are not hosts. Anything else on an internal suffix
 *   (`.internal .local .lan .corp .intranet .home.arpa .localdomain`) or in a private
 *   IPv4/IPv6 range is.
 */
import { RE2JS } from 're2js'
import { SearchHoleError } from '../shared/errors.ts'

export type HygieneMode = 'block' | 'redact' | 'off'

/** Stable codes naming what a finding looked like. Never carries the matched text. */
export type FindingClass =
  | 'api_key'
  | 'jwt'
  | 'private_key'
  | 'connection_string'
  | 'secret_assignment'
  | 'high_entropy'
  | 'internal_host'
  | 'private_ip'

export interface Finding {
  class: FindingClass
  /** Id of the detector that matched, e.g. 'github-token'. */
  detector: string
  /** UTF-16 offsets into the scanned text, end exclusive. */
  start: number
  end: number
}

export interface HygieneOptions {
  /** For secrets (and for every class when `hosts` is not given). */
  mode: HygieneMode
  /**
   * For internal hostnames and private addresses. Default: `mode`. Removed matches are cut out
   * of the query (no `[redacted]` placeholder for an engine to search for).
   */
  hosts?: HygieneMode
  /** RE2 patterns; a finding whose matched text is fully matched by one is allowed. */
  allow?: readonly string[]
  /** Extra internal host suffixes, e.g. 'corp.example.com' (matches itself and subdomains). */
  internalHosts?: readonly string[]
  /** Also flag localhost and loopback addresses. Default false. */
  flagLoopback?: boolean
}

export interface HygieneResult {
  action: 'ok' | 'block' | 'redact'
  /** The original query for ok and block; the redacted query for redact. */
  query: string
  findings: Finding[]
}

export const REDACTED = '[redacted]'

/** Address classes: low risk, and the common false positive ("192.168.1.1 router admin page"). */
const HOST_CLASSES: ReadonlySet<FindingClass> = new Set<FindingClass>(['internal_host', 'private_ip'])

// ── Detector data ────────────────────────────────────────────────────────

type CheckName =
  | 'keyLike'
  | 'notPlaceholderValue'
  | 'notAwsExample'
  | 'pemBody'
  | 'passwordNotPlaceholder'
  | 'tokenShape'
  | 'awsSecretShape'
  | 'internalHostName'
  | 'hostBounds'
  | 'singleLabelHost'
  | 'ipv4Private'
  | 'ipv6Private'
  | 'ipv6Loopback'

interface DetectorSpec {
  id: string
  kind: 'secret' | 'host'
  class: FindingClass
  /** RE2 syntax. */
  pattern: string
  ignoreCase?: boolean
  /** Capture group whose range is the finding (default 0). */
  group?: number
  /** Capture group the checks look at (default: `group`). */
  checkGroup?: number
  checks?: readonly CheckName[]
}

const INTERNAL_SUFFIXES = String.raw`(?:localdomain|internal|local|lan|corp|intranet|home\.arpa)`
const HOST_LABEL = String.raw`[A-Za-z0-9](?:[A-Za-z0-9\-]*[A-Za-z0-9])?`
const NETWORK_SCHEMES =
  '(?:https?|ftps?|sftp|ssh|smb|ldaps?|rdp|vnc|wss?|git|rsync|telnet|nfs|imaps?|pop3s?|smtps?)'

/** All detectors. Order is irrelevant; class priority decides overlaps. */
export const DETECTORS: readonly DetectorSpec[] = [
  {
    id: 'pem-private-key',
    kind: 'secret',
    class: 'private_key',
    pattern: String.raw`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)`,
    checks: ['pemBody'],
  },
  {
    id: 'jwt',
    kind: 'secret',
    class: 'jwt',
    pattern: String.raw`eyJ[A-Za-z0-9_\-]{8,}\.ey[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}`,
  },
  {
    id: 'connection-string',
    kind: 'secret',
    class: 'connection_string',
    pattern: String.raw`\b[A-Za-z][A-Za-z0-9+.\-]{1,24}://([^\s:/@?#]{0,64}):([^\s/@?#]{3,})@[^\s/?#]+`,
    checkGroup: 2,
    checks: ['passwordNotPlaceholder'],
  },
  {
    id: 'openai-style',
    kind: 'secret',
    class: 'api_key',
    pattern: String.raw`\bsk-[A-Za-z0-9_\-]{20,}`,
    checks: ['keyLike'],
  },
  {
    id: 'github-token',
    kind: 'secret',
    class: 'api_key',
    pattern: String.raw`\bgh[pousr]_[A-Za-z0-9]{30,}`,
    checks: ['keyLike'],
  },
  {
    id: 'github-fine-grained',
    kind: 'secret',
    class: 'api_key',
    pattern: String.raw`\bgithub_pat_[A-Za-z0-9_]{30,}`,
    checks: ['keyLike'],
  },
  {
    id: 'slack-token',
    kind: 'secret',
    class: 'api_key',
    pattern: String.raw`\b(?:xox[bpars]|xapp)-[A-Za-z0-9\-]{10,}`,
    checks: ['keyLike'],
  },
  {
    id: 'aws-access-key',
    kind: 'secret',
    class: 'api_key',
    pattern: String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`,
    checks: ['notAwsExample'],
  },
  {
    id: 'google-api-key',
    kind: 'secret',
    class: 'api_key',
    pattern: String.raw`\bAIza[A-Za-z0-9_\-]{35}`,
  },
  {
    id: 'gitlab-token',
    kind: 'secret',
    class: 'api_key',
    pattern: String.raw`\bglpat-[A-Za-z0-9_\-]{20,}`,
  },
  {
    id: 'npm-token',
    kind: 'secret',
    class: 'api_key',
    pattern: String.raw`\bnpm_[A-Za-z0-9]{36}\b`,
    checks: ['keyLike'],
  },
  {
    id: 'stripe-key',
    kind: 'secret',
    class: 'api_key',
    pattern: String.raw`\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}`,
  },
  {
    id: 'sendgrid-key',
    kind: 'secret',
    class: 'api_key',
    pattern: String.raw`\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}`,
  },
  {
    id: 'huggingface-token',
    kind: 'secret',
    class: 'api_key',
    pattern: String.raw`\bhf_[A-Za-z0-9]{30,}`,
    checks: ['keyLike'],
  },
  {
    id: 'tavily-key',
    kind: 'secret',
    class: 'api_key',
    pattern: String.raw`\btvly-[A-Za-z0-9_\-]{16,}`,
    checks: ['keyLike'],
  },
  {
    id: 'brave-key',
    kind: 'secret',
    class: 'api_key',
    pattern: String.raw`\bBSA[A-Za-z0-9_\-]{20,}`,
    checks: ['keyLike'],
  },
  {
    id: 'auth-header-token',
    kind: 'secret',
    class: 'api_key',
    pattern: String.raw`\b(?:bearer|basic)\s+([A-Za-z0-9._~+/=\-]{20,})`,
    ignoreCase: true,
    group: 1,
    checks: ['keyLike'],
  },
  {
    id: 'secret-assignment',
    kind: 'secret',
    class: 'secret_assignment',
    pattern: String.raw`(?:api[_\-]?key|secret(?:[_\-]?key)?|client[_\-]?secret|(?:access|auth|refresh|session)[_\-]?token|token|passwd|password|pwd)["']?\s*[=:]\s*["']?([^\s"'&;,)}\]>]{12,})`,
    ignoreCase: true,
    group: 1,
    checks: ['notPlaceholderValue', 'keyLike'],
  },
  {
    id: 'high-entropy-token',
    kind: 'secret',
    class: 'high_entropy',
    pattern: String.raw`[A-Za-z0-9][A-Za-z0-9_\-+]{31,}={0,2}`,
    checks: ['tokenShape'],
  },
  {
    // 40 characters of base64 containing '/' or '+': the shape of an AWS secret access key.
    // (Without '/' or '+' the high-entropy detector sees it; '/' splits runs there so URLs and paths pass.)
    id: 'aws-secret-key',
    kind: 'secret',
    class: 'api_key',
    pattern: '[A-Za-z0-9/+]{40}',
    checks: ['awsSecretShape'],
  },
  {
    id: 'internal-suffix-host',
    kind: 'host',
    class: 'internal_host',
    pattern: String.raw`(?:${HOST_LABEL}\.)+${INTERNAL_SUFFIXES}`,
    ignoreCase: true,
    checks: ['hostBounds', 'internalHostName'],
  },
  {
    id: 'single-label-url-host',
    kind: 'host',
    class: 'internal_host',
    pattern: String.raw`\b${NETWORK_SCHEMES}://(?:[^\s/?#@]*@)?([A-Za-z][A-Za-z0-9\-]*)`,
    ignoreCase: true,
    group: 1,
    checks: ['singleLabelHost'],
  },
  {
    id: 'private-ipv4',
    kind: 'host',
    class: 'private_ip',
    pattern: String.raw`[0-9]{1,3}(?:\.[0-9]{1,3}){3}`,
    checks: ['ipv4Private'],
  },
  {
    id: 'private-ipv6',
    kind: 'host',
    class: 'private_ip',
    pattern: 'f(?:e80|[cd][0-9a-f]{2}):[0-9a-f:]{2,}',
    ignoreCase: true,
    checks: ['ipv6Private'],
  },
  {
    id: 'ipv6-loopback',
    kind: 'host',
    class: 'private_ip',
    pattern: '::1',
    checks: ['ipv6Loopback'],
  },
]

/** Priority when findings overlap: lower wins the class of the merged span. */
const CLASS_PRIORITY: Readonly<Record<FindingClass, number>> = {
  private_key: 0,
  connection_string: 1,
  jwt: 2,
  api_key: 3,
  secret_assignment: 4,
  high_entropy: 5,
  internal_host: 6,
  private_ip: 7,
}

const CLASS_LABEL: Readonly<Record<FindingClass, string>> = {
  api_key: 'an API key or access token',
  jwt: 'a JSON Web Token',
  private_key: 'a private key',
  connection_string: 'a connection string with credentials',
  secret_assignment: 'a password or secret assignment',
  high_entropy: 'a long random-looking token',
  internal_host: 'an internal hostname',
  private_ip: 'a private network address',
}

// ── Helpers ──────────────────────────────────────────────────────────────

const compiled = new Map<string, RE2JS>()

/** Compiles and memoises an RE2 pattern; throws on invalid syntax. */
function compile(pattern: string, flags: number): RE2JS {
  const key = `${flags}:${pattern}`
  let re = compiled.get(key)
  if (re === undefined) {
    re = RE2JS.compile(pattern, flags)
    compiled.set(key, re)
  }
  return re
}

/** Returns a compiled pattern, or null when the pattern is not valid RE2. */
function tryCompile(pattern: string, flags: number): RE2JS | null {
  try {
    return compile(pattern, flags)
  } catch {
    return null
  }
}

/** True when `pattern` is valid RE2 syntax (for validating `queryHygiene.allow`). */
export function isValidAllowPattern(pattern: string): boolean {
  return tryCompile(pattern, RE2JS.CASE_INSENSITIVE) !== null
}

const isAlnum = (ch: string | undefined): boolean =>
  ch !== undefined && ((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'))
const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9'
const isLetter = (ch: string | undefined): boolean =>
  ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'))
const isUpper = (ch: string | undefined): boolean => ch !== undefined && ch >= 'A' && ch <= 'Z'
const isLower = (ch: string | undefined): boolean => ch !== undefined && ch >= 'a' && ch <= 'z'

/** Shannon entropy in bits per character. */
function entropy(s: string): number {
  if (s.length === 0) return 0
  const counts = new Map<string, number>()
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1)
  let h = 0
  const n = [...s].length
  for (const c of counts.values()) {
    const p = c / n
    h -= p * Math.log2(p)
  }
  return h
}

const hasDigit = (s: string): boolean => [...s].some(isDigit)
const hasLetter = (s: string): boolean => [...s].some(isLetter)

/** Minimum entropy for a string of this length: 3.5 bits, relaxed for short values. */
const entropyFloor = (len: number): number => Math.min(3.5, Math.log2(Math.max(len, 2)) - 0.5)

/** A digit, a letter and enough entropy: random-looking rather than a word. */
function randomLooking(value: string): boolean {
  return hasDigit(value) && hasLetter(value) && entropy(value) >= entropyFloor(value.length)
}

const HEX_ONLY = RE2JS.compile('[0-9a-fA-F]+')
const UUID_SHAPE = RE2JS.compile(
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
)
const NON_BASE64 = RE2JS.compile('[^A-Za-z0-9+/=]')
const DIGEST_HEX_LENGTHS = new Set([32, 40, 56, 64, 96, 128])
const INTEGRITY_PREFIXES = ['sha1-', 'sha256-', 'sha384-', 'sha512-', 'md5-']

const PLACEHOLDER_WORDS = new Set([
  'pass',
  'password',
  'passwd',
  'pwd',
  'secret',
  'changeme',
  'example',
  'test',
  'testing',
  'admin',
  'root',
  'user',
  'username',
  'postgres',
  'mysql',
  'guest',
  'demo',
  'redacted',
  'anonymous',
  'anon',
  'key',
  'token',
])
const SSH_KEY_PREFIXES = ['AAAAB3NzaC1', 'AAAAC3NzaC1', 'AAAAE2VjZHNh']
const DIGEST_LABELS = ['sha1:', 'sha256:', 'sha384:', 'sha512:', 'md5:']

/** Identifiers and slugs: mostly lower-case letters, few digits, or several plain words joined by - or _. */
function proseLike(v: string): boolean {
  const chars = [...v]
  const lower = chars.filter(isLower).length / chars.length
  const digits = chars.filter(isDigit).length / chars.length
  if (lower >= 0.6 && digits < 0.15) return true
  const words = v
    .replaceAll('_', '-')
    .split('-')
    .filter((part) => part.length >= 3 && part.length <= 16 && [...part].every(isLetter))
  return words.length >= 2
}

const PLACEHOLDER_PREFIXES = ['my', 'your', 'the', 'some', 'new', 'old']
const PLACEHOLDER_FILL = RE2JS.compile('[x*._\\-\u2022]+')

/** True for documentation placeholders such as `password`, `<token>`, `${TOKEN}`, `xxxxxx`, `****`. */
function looksLikePlaceholder(value: string): boolean {
  const v = value.toLowerCase()
  if (PLACEHOLDER_WORDS.has(v)) return true
  for (const prefix of PLACEHOLDER_PREFIXES) {
    if (!v.startsWith(prefix)) continue
    const tail = v.slice(prefix.length)
    const rest = tail.startsWith('_') || tail.startsWith('-') ? tail.slice(1) : tail
    if (PLACEHOLDER_WORDS.has(rest)) return true
  }
  const first = v[0]
  if (first === '<' || first === '$' || first === '{' || first === '%' || first === '[') return true
  if (PLACEHOLDER_FILL.testExact(v)) return true
  return v.includes('your') || v.includes('example') || v.includes('placeholder') || v.includes('changeme')
}

/** URLs and file paths next to a secret-like name are references, not credentials. */
function looksLikeReference(value: string): boolean {
  const first = value[0]
  return value.includes('://') || first === '/' || first === '.' || first === '~'
}

const GENERIC_HOST_LABELS = new Set([
  'localhost',
  'db',
  'database',
  'postgres',
  'postgresql',
  'mysql',
  'mariadb',
  'mongo',
  'mongodb',
  'redis',
  'memcached',
  'rabbitmq',
  'kafka',
  'zookeeper',
  'elasticsearch',
  'opensearch',
  'minio',
  'nginx',
  'web',
  'app',
  'api',
  'backend',
  'frontend',
  'worker',
  'mailhog',
  'localstack',
  'example',
  'host',
  'hostname',
  'server',
  'domain',
  'site',
  'foo',
  'bar',
  'test',
])

const EXEMPT_HOSTS = new Set([
  'host.docker.internal',
  'gateway.docker.internal',
  'kubernetes.docker.internal',
  'host.containers.internal',
  'host.minikube.internal',
  'host.lima.internal',
  'cluster.local',
])
const EXEMPT_HOST_SUFFIXES = [
  '.cluster.local',
  '.docker.internal',
  '.containers.internal',
  '.minikube.internal',
]
const JAVA_PACKAGE_ROOTS = new Set([
  'com',
  'org',
  'net',
  'io',
  'edu',
  'gov',
  'java',
  'javax',
  'jdk',
  'sun',
  'android',
  'androidx',
  'kotlin',
  'kotlinx',
  'scala',
  'akka',
])

interface ScanOptions {
  secrets: boolean
  hosts: boolean
  flagLoopback: boolean
  extraHosts: readonly string[]
}

interface CheckCtx {
  text: string
  start: number
  end: number
  /** Text of the check group. */
  value: string
  opts: ScanOptions
}

function parseIpv4(value: string): [number, number, number, number] | null {
  const parts = value.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    if (part.length > 1 && part.startsWith('0')) return null
    out.push(n)
  }
  return out as [number, number, number, number]
}

/** True when the text just outside [start, end) does not extend the dotted/hex run. */
function ipBounds(
  text: string,
  start: number,
  end: number,
  extra: (ch: string | undefined) => boolean,
): boolean {
  const before = text[start - 1]
  const after = text[end]
  if (isDigit(before) || extra(before)) return false
  if (before === '.' && isDigit(text[start - 2])) return false
  if (isDigit(after) || extra(after)) return false
  if (after === '.' && isDigit(text[end + 1])) return false
  return true
}

const CHECKS: Readonly<Record<CheckName, (c: CheckCtx) => boolean>> = {
  keyLike: (c) => randomLooking(c.value),

  notPlaceholderValue: (c) => !looksLikePlaceholder(c.value) && !looksLikeReference(c.value),

  notAwsExample: (c) => !c.value.endsWith('EXAMPLE'),

  pemBody: (c) => {
    const headerEnd = c.value.indexOf('-----', 5) + 5
    const endAt = c.value.lastIndexOf('-----END')
    const inner = c.value.slice(headerEnd, endAt > headerEnd ? endAt : undefined)
    return NON_BASE64.matcher(inner).replaceAll('').length >= 32
  },

  passwordNotPlaceholder: (c) => c.value.length >= 6 && !looksLikePlaceholder(c.value),

  tokenShape: (c) => {
    const v = c.value
    if (HEX_ONLY.testExact(v) && DIGEST_HEX_LENGTHS.has(v.length)) return false
    if (UUID_SHAPE.testExact(v)) return false
    // A lone base64url JSON segment (JWT header or payload) is not a credential; a full JWT is caught by `jwt`.
    if (v.startsWith('eyJ')) return false
    // Public key blobs, fingerprints and multipart boundaries are not secrets.
    if (v.includes('WebKitFormBoundary') || SSH_KEY_PREFIXES.some((p) => v.startsWith(p))) return false
    const label = c.text.slice(Math.max(0, c.start - 7), c.start).toLowerCase()
    if (DIGEST_LABELS.some((l) => label.endsWith(l))) return false
    const lower = v.toLowerCase()
    if (INTEGRITY_PREFIXES.some((p) => lower.startsWith(p))) return false
    let separators = 0
    for (const ch of v) if (ch === '-' || ch === '_') separators++
    if (separators / v.length > 0.1) return false
    if (proseLike(v)) return false
    return randomLooking(v)
  },

  awsSecretShape: (c) => {
    const v = c.value
    const token = (ch: string | undefined): boolean =>
      isAlnum(ch) || ch === '/' || ch === '+' || ch === '_' || ch === '-'
    if (token(c.text[c.start - 1]) || token(c.text[c.end])) return false
    if (!(v.includes('/') || v.includes('+'))) return false
    if (v.endsWith('EXAMPLEKEY')) return false // the documented AWS example secret
    const slashes = [...v].filter((ch) => ch === '/').length
    const upper = [...v].some(isUpper)
    return slashes <= 3 && upper && [...v].some(isLower) && hasDigit(v) && entropy(v) >= 4.2
  },

  hostBounds: (c) => {
    const before = c.text[c.start - 1]
    const after = c.text[c.end]
    if (isAlnum(before) || before === '_' || before === '.' || before === '-') return false
    if (isAlnum(after) || after === '_' || after === '-') return false
    if (after === '.' && isAlnum(c.text[c.end + 1])) return false
    return true
  },

  internalHostName: (c) => {
    const host = c.value.toLowerCase()
    if (EXEMPT_HOSTS.has(host)) return false
    if (EXEMPT_HOST_SUFFIXES.some((s) => host.endsWith(s))) return false
    const labels = host.split('.')
    if (JAVA_PACKAGE_ROOTS.has(labels[0] ?? '')) return false
    // `threading.local` is code; `nas-01.local`, `printer.local:631`, `http://x.local` are hosts.
    if (labels[labels.length - 1] === 'local') {
      const before = c.text.slice(0, c.start)
      const hostContext =
        before.endsWith('//') ||
        before.endsWith('@') ||
        (c.text[c.end] === ':' && isDigit(c.text[c.end + 1])) ||
        labels.length >= 3 ||
        [...host].some((ch) => ch === '-' || isDigit(ch))
      if (!hostContext) return false
    }
    return true
  },

  singleLabelHost: (c) => {
    const label = c.value.toLowerCase()
    const after = c.text[c.end]
    // `.`/`-`/`_`/`$`/`{`/`<`/`%`/`@` continue a longer or templated host: not our case.
    if (after !== undefined && (isAlnum(after) || '.-_${<%@'.includes(after))) return false
    if (label === 'localhost') return c.opts.flagLoopback
    return !GENERIC_HOST_LABELS.has(label)
  },

  ipv4Private: (c) => {
    if (!ipBounds(c.text, c.start, c.end, () => false)) return false
    const o = parseIpv4(c.value)
    if (o === null) return false
    const [a, b] = o
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    return a === 127 && c.opts.flagLoopback
  },

  ipv6Private: (c) => ipBounds(c.text, c.start, c.end, (ch) => isAlnum(ch) || ch === ':'),

  ipv6Loopback: (c) =>
    c.opts.flagLoopback && ipBounds(c.text, c.start, c.end, (ch) => isAlnum(ch) || ch === ':'),
}

// ── Scanning ─────────────────────────────────────────────────────────────

function runDetector(d: DetectorSpec, text: string, opts: ScanOptions, out: Finding[]): void {
  const mt = compile(d.pattern, d.ignoreCase === true ? RE2JS.CASE_INSENSITIVE : 0).matcher(text)
  const g = d.group ?? 0
  const cg = d.checkGroup ?? g
  while (mt.find()) {
    const start = mt.start(g)
    const end = mt.end(g)
    if (start < 0 || end <= start) continue
    const value = mt.group(cg) ?? ''
    const ctx: CheckCtx = { text, start, end, value, opts }
    if (d.checks !== undefined && !d.checks.every((name) => CHECKS[name](ctx))) continue
    out.push({ class: d.class, detector: d.id, start, end })
  }
}

const RE2_SPECIAL = '\\.^$|?*+()[]{}-'
const escapeRe2 = (s: string): string =>
  [...s].map((ch) => (RE2_SPECIAL.includes(ch) ? `\\${ch}` : ch)).join('')

/** Detector for user-configured internal host suffixes, or null when there are none. */
function extraHostDetector(suffixes: readonly string[]): DetectorSpec | null {
  const clean = suffixes
    .map((s) =>
      s
        .trim()
        .replace(/^[*.]+/, '')
        .toLowerCase(),
    )
    .filter((s) => s.length > 0)
  if (clean.length === 0) return null
  return {
    id: 'configured-internal-host',
    kind: 'host',
    class: 'internal_host',
    pattern: String.raw`(?:${HOST_LABEL}\.)*(?:${clean.map(escapeRe2).join('|')})`,
    ignoreCase: true,
    checks: ['hostBounds'],
  }
}

/** Sorts findings, merges overlaps (the stronger class wins) and drops empties. */
function mergeFindings(found: Finding[]): Finding[] {
  const sorted = [...found].sort((a, b) => a.start - b.start || b.end - a.end)
  const out: Finding[] = []
  for (const f of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && f.start < last.end) {
      last.end = Math.max(last.end, f.end)
      if (CLASS_PRIORITY[f.class] < CLASS_PRIORITY[last.class]) {
        last.class = f.class
        last.detector = f.detector
      }
    } else {
      out.push({ ...f })
    }
  }
  return out
}

function scan(text: string, opts: ScanOptions): Finding[] {
  const found: Finding[] = []
  const extra = opts.hosts ? extraHostDetector(opts.extraHosts) : null
  for (const d of DETECTORS) {
    if (d.kind === 'secret' ? opts.secrets : opts.hosts) runDetector(d, text, opts, found)
  }
  if (extra !== null) runDetector(extra, text, opts, found)
  return mergeFindings(found)
}

/** Drops findings whose matched text is fully matched by an `allow` pattern. */
function dropAllowed(findings: Finding[], text: string, allow: readonly string[]): Finding[] {
  const patterns = allow
    .map((p) => tryCompile(p, RE2JS.CASE_INSENSITIVE))
    .filter((p): p is RE2JS => p !== null)
  if (patterns.length === 0) return findings
  return findings.filter((f) => {
    const matched = text.slice(f.start, f.end)
    return !patterns.some((p) => p.testExact(matched))
  })
}

/**
 * Replaces each finding's range with `[redacted]`, or with nothing for the classes in
 * `remove`. Findings must be sorted and non-overlapping.
 */
function applyRedaction(
  text: string,
  findings: readonly Finding[],
  remove: ReadonlySet<FindingClass> = new Set(),
): string {
  let out = ''
  let pos = 0
  for (const f of findings) {
    out += text.slice(pos, f.start) + (remove.has(f.class) ? '' : REDACTED)
    pos = f.end
  }
  out += text.slice(pos)
  return remove.size === 0 ? out : out.replace(/\s{2,}/g, ' ').trim()
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Scans a query per ADR-0015 point 4. Each class follows its mode (`hosts` for addresses,
 * `mode` for secrets): any `block` finding blocks, leaving the query untouched; otherwise
 * `redact` findings are replaced by `[redacted]` (secrets) or cut out (addresses); `off`
 * skips the class, and `mode: off` skips scanning. A query that cutting leaves empty is blocked.
 * Never throws and never copies a match into the result.
 */
export function checkQuery(query: string, options: HygieneOptions): HygieneResult {
  if (options.mode === 'off') return { action: 'ok', query, findings: [] }
  const hostMode = options.hosts ?? options.mode
  const found = scan(query, {
    secrets: true,
    hosts: hostMode !== 'off',
    flagLoopback: options.flagLoopback === true,
    extraHosts: options.internalHosts ?? [],
  })
  const findings = dropAllowed(found, query, options.allow ?? [])
  if (findings.length === 0) return { action: 'ok', query, findings }
  const modeOf = (f: Finding): HygieneMode => (HOST_CLASSES.has(f.class) ? hostMode : options.mode)
  if (findings.some((f) => modeOf(f) === 'block')) return { action: 'block', query, findings }
  const remove = options.hosts === undefined ? new Set<FindingClass>() : HOST_CLASSES
  const redacted = applyRedaction(query, findings, remove)
  if (redacted.trim() === '') return { action: 'block', query, findings }
  return { action: 'redact', query: redacted, findings }
}

/**
 * Redacts secrets from text before it is logged. Internal hostnames are redacted only
 * when `hosts` is true, because log lines legitimately mention local engine URLs.
 */
export function redact(text: string, opts: { hosts?: boolean } = {}): string {
  const findings = scan(text, {
    secrets: true,
    hosts: opts.hosts === true,
    flagLoopback: false,
    extraHosts: [],
  })
  return findings.length === 0 ? text : applyRedaction(text, findings)
}

/** Detects secrets only (no hostnames). Used for strings that must never hold a credential. */
export function detectSecrets(text: string): Finding[] {
  return scan(text, { secrets: true, hosts: false, flagLoopback: false, extraHosts: [] })
}

/** "an API key or access token and a private network address": names classes, never matches. */
export function describeFindings(findings: readonly Finding[]): string {
  const classes = [...new Set(findings.map((f) => f.class))].sort(
    (a, b) => CLASS_PRIORITY[a] - CLASS_PRIORITY[b],
  )
  const labels = classes.map((c) => CLASS_LABEL[c])
  if (labels.length <= 1) return labels[0] ?? 'sensitive text'
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

const KNOWN_CLASSES: ReadonlySet<string> = new Set<FindingClass>([
  'api_key',
  'jwt',
  'private_key',
  'connection_string',
  'secret_assignment',
  'high_entropy',
  'internal_host',
  'private_ip',
])

/** "an API key or access token and a private network address" from stored class codes. */
export function describeClasses(classes: readonly string[]): string {
  const findings: Finding[] = classes
    .filter((c): c is FindingClass => KNOWN_CLASSES.has(c))
    .map((c) => ({ class: c, detector: c, start: 0, end: 0 }))
  return describeFindings(findings)
}

/** Hint for the user-facing surfaces (CLI, dashboard, doctor); not for model-facing errors. */
export const HYGIENE_USER_HINT =
  'To allow a known-safe pattern, add it to queryHygiene.allow in settings.yaml; to send a redacted query instead of blocking, set queryHygiene.mode to redact.'

/** The `query_blocked` error for a blocked query: names the class, never echoes the match. */
export function queryBlockedError(findings: readonly Finding[]): SearchHoleError {
  return new SearchHoleError(
    'query_blocked',
    `Query not sent: it looks like ${describeFindings(findings)}.`,
    {
      fix: 'Remove it from the query and search again.',
      details: { classes: [...new Set(findings.map((f) => f.class))] },
    },
  )
}

// ── Config scanning (ADR-0007 point 6) ───────────────────────────────────

export interface ConfigSecretFinding {
  /** Dotted path of the offending field, e.g. 'engines.brave.api_key'. */
  path: string
  reason: 'secret_field_name' | 'token_pattern' | 'key_like_value'
}

/** Splits `apiKey`, `API_KEY`, `x-api-key` and `AuthToken` into lower-case words. */
function nameWords(name: string): string[] {
  const words: string[] = []
  let cur = ''
  const chars = [...name]
  chars.forEach((ch, i) => {
    if (!isAlnum(ch)) {
      if (cur) words.push(cur)
      cur = ''
      return
    }
    const prev = chars[i - 1]
    const next = chars[i + 1]
    const boundary =
      cur !== '' && isUpper(ch) && (isLower(prev) || isDigit(prev) || (isUpper(prev) && isLower(next)))
    if (boundary) {
      words.push(cur)
      cur = ''
    }
    cur += ch.toLowerCase()
  })
  if (cur) words.push(cur)
  return words
}

const SECRET_LAST_WORDS = new Set([
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'apikey',
  'credential',
  'credentials',
])
const SECRET_KEY_PREFIXES = new Set(['api', 'secret', 'private', 'access', 'auth', 'signing', 'client'])

/** True for field names like `api_key`, `apiKey`, `token`, `password`, `client_secret`. */
export function looksLikeSecretFieldName(name: string): boolean {
  const words = nameWords(name)
  const last = words[words.length - 1]
  if (last === undefined) return false
  if (SECRET_LAST_WORDS.has(last)) return true
  const before = words[words.length - 2]
  return last === 'key' && before !== undefined && SECRET_KEY_PREFIXES.has(before)
}

const isUnsetPlaceholder = (v: string): boolean => v.trim() === '' || (v.startsWith('${') && v.endsWith('}'))

/**
 * Finds secrets in a parsed config value: fields named like secrets that hold a non-empty
 * string, strings matching token patterns, and key-like random strings next to a field
 * named `key`. Returns paths and reasons only, never values.
 */
export function scanConfigForSecrets(value: unknown, basePath = ''): ConfigSecretFinding[] {
  const out: ConfigSecretFinding[] = []
  const visit = (v: unknown, path: string, name: string, depth: number): void => {
    if (depth > 24) return
    if (typeof v === 'string') {
      if (isUnsetPlaceholder(v)) return
      if (looksLikeSecretFieldName(name)) out.push({ path, reason: 'secret_field_name' })
      else if (detectSecrets(v).some((f) => f.class !== 'high_entropy'))
        out.push({ path, reason: 'token_pattern' })
      else if (nameWords(name).at(-1) === 'key' && v.length >= 16 && randomLooking(v)) {
        out.push({ path, reason: 'key_like_value' })
      }
    } else if (Array.isArray(v)) {
      for (const [i, item] of v.entries()) visit(item, `${path}[${i}]`, name, depth + 1)
    } else if (v !== null && typeof v === 'object') {
      for (const [k, item] of Object.entries(v)) visit(item, path === '' ? k : `${path}.${k}`, k, depth + 1)
    }
  }
  visit(value, basePath, '', 0)
  return out
}
