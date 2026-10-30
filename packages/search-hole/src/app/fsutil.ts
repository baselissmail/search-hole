// SPDX-License-Identifier: Apache-2.0
/**
 * File helpers for the app: content hashes, and comment-preserving edits of rule files
 * (ADR-0006 point 9) through the yaml Document API, under a lock file and written
 * atomically with the shared helpers from shared/paths.ts. A file that does not parse is
 * never overwritten.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Document, isMap, isSeq, parseDocument, type YAMLSeq } from 'yaml'
import { type LoadedRules, loadRulesYaml, RULES_SCHEMA_VERSION, type RulesFileScope } from '../lists/yaml.ts'
import { SearchHoleError } from '../shared/errors.ts'
import { atomicWriteFile, ensureDir, withFileLock } from '../shared/paths.ts'

/** Hex SHA-256 of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** The file's text, or undefined when it does not exist. Other read errors throw. */
export function readTextIfExists(file: string): string | undefined {
  if (!existsSync(file)) return undefined
  return readFileSync(file, 'utf8')
}

const HEADER = {
  global: ` search-hole rules (global). Edit by hand or with \`searchhole block|allow|pin|raise|lower\`.
 Format: https://github.com/baselissmail/search-hole/blob/main/docs/rules.md`,
  project: ` search-hole project rules. They apply only after \`searchhole trust\` approves this file.`,
} as const

export interface RulesFileEdit {
  /** Text after the edit. */
  text: string
  /** Hash before the edit; undefined when the file did not exist. */
  before?: string
  after: string
  loaded: LoadedRules
}

/** The `rules:` sequence of a document, created when missing. */
export function rulesSeq(doc: Document): YAMLSeq {
  const existing = doc.get('rules', true)
  if (isSeq(existing)) return existing
  if (existing !== undefined && existing !== null) {
    throw new SearchHoleError('rules_invalid', '`rules` in the rules file is not a list.', {
      fix: 'Fix the file by hand; search-hole will not rewrite it.',
    })
  }
  const seq = doc.createNode([]) as YAMLSeq
  doc.set('rules', seq)
  return seq
}

/**
 * Edits a rules file under its lock: parses it as a yaml Document (comments and unknown
 * keys survive), applies `edit`, validates the result strictly (the same loader the search
 * path uses) and writes it atomically. A file that does not parse is refused untouched.
 */
export async function editRulesFile(
  file: string,
  lockPath: string,
  scope: RulesFileScope,
  edit: (doc: Document, current: LoadedRules | null) => void,
): Promise<RulesFileEdit> {
  return withFileLock(lockPath, () => {
    const current = readTextIfExists(file)
    let doc: Document
    let loadedBefore: LoadedRules | null = null
    if (current === undefined || current.trim() === '') {
      doc = new Document({ version: RULES_SCHEMA_VERSION })
      doc.commentBefore = HEADER[scope]
    } else {
      doc = parseDocument(current, { prettyErrors: false })
      if (doc.errors.length > 0 || (doc.contents !== null && !isMap(doc.contents))) {
        throw new SearchHoleError(
          'rules_invalid',
          `${file} does not parse, so search-hole will not change it.`,
          {
            fix: 'Fix the file by hand first (`searchhole doctor` shows the error).',
          },
        )
      }
      // Strict: a file that does not validate is the user's to fix; it is never rewritten.
      loadedBefore = loadRulesYaml(current, { scope, file })
      if (doc.get('version') === undefined) doc.set('version', RULES_SCHEMA_VERSION)
    }
    edit(doc, loadedBefore)
    const text = doc.toString()
    const loaded = loadRulesYaml(text, { scope, file })
    ensureDir(dirname(file))
    // Project files live in a repository and are shared; the global file is private.
    atomicWriteFile(file, text, { mode: scope === 'global' ? 0o600 : 0o644 })
    const result: RulesFileEdit = { text, after: sha256Hex(text), loaded }
    if (current !== undefined) result.before = sha256Hex(current)
    return result
  })
}
