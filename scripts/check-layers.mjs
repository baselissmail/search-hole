#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Layer-graph check (ADR-0001 rule 1). Fails the build when a pure layer imports
// I/O or a package outside its allowlist.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const SRC = resolve(import.meta.dirname, '../packages/search-hole/src')
const PURE_PACKAGES = new Set(['zod', 'yaml', 're2js', 'htmlparser2', 'tldts'])
// Deterministic, I/O-free builtins allowed in pure layers (rule ids hash with SHA-256).
const PURE_BUILTINS = new Set(['node:crypto'])

/** layer → which sibling layers it may import (relative), and whether packages are restricted. */
const RULES = {
  core: { layers: ['core', 'shared/types', 'shared/errors'], pure: true },
  lists: { layers: ['lists', 'core', 'shared/types', 'shared/errors'], pure: true },
  engines: { layers: ['engines', 'core', 'shared/types', 'shared/errors'], pure: true },
}

const IMPORT_RE =
  /(?:^|\s)(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) yield p
  }
}

const violations = []
for (const [layer, rule] of Object.entries(RULES)) {
  const dir = join(SRC, layer)
  let files
  try {
    files = [...walk(dir)]
  } catch {
    continue
  }
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2]
      if (!spec) continue
      const where = `${relative(SRC, file)}: '${spec}'`
      if (spec.startsWith('.')) {
        const target = relative(SRC, resolve(join(file, '..'), spec))
          .split(sep)
          .join('/')
        const ok = rule.layers.some((l) => target === l || target.startsWith(`${l}/`) || target === `${l}.ts`)
        if (!ok) violations.push(`${where} crosses into '${target}'`)
      } else if (spec.startsWith('node:')) {
        if (rule.pure && !PURE_BUILTINS.has(spec)) violations.push(`${where} is a Node builtin (pure layer)`)
      } else {
        const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
        if (rule.pure && !PURE_PACKAGES.has(pkg))
          violations.push(`${where} is not in the pure-package allowlist`)
      }
    }
  }
}

if (violations.length) {
  console.error(`Layer check failed (${violations.length}):\n  ${violations.join('\n  ')}`)
  process.exit(1)
}
console.log('Layer check passed.')
