// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the ${...} strings are Claude Code placeholders, not templates
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { z } from 'zod'
import { PLUGIN_DIR, readText } from './helpers.ts'

const SKILLS_DIR = join(PLUGIN_DIR, 'skills')

const Frontmatter = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1),
    'argument-hint': z.string().optional(),
    'disable-model-invocation': z.boolean().optional(),
    'allowed-tools': z.array(z.string()).optional(),
  })
  .strict()

interface Skill {
  dir: string
  meta: z.infer<typeof Frontmatter>
  body: string
}

/** Splits SKILL.md into validated frontmatter and body. */
function loadSkill(dir: string): Skill {
  const text = readText(SKILLS_DIR, dir, 'SKILL.md')
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  if (match === null) throw new Error(`${dir}/SKILL.md has no frontmatter`)
  return { dir, meta: Frontmatter.parse(parse(match[1] ?? '')), body: match[2] ?? '' }
}

/** Slash command (skill) name → the CLI verb it runs. `unblock` maps to `unrule`; `status` is `doctor --probe`. */
const USER_SKILLS: Record<string, string> = {
  block: 'block',
  allow: 'allow',
  pin: 'pin',
  raise: 'raise',
  lower: 'lower',
  unblock: 'unrule',
  rules: 'rules',
  lists: 'lists',
  log: 'log',
  explain: 'explain',
  approve: 'approve',
  reject: 'reject',
  suggestions: 'suggestions',
  mode: 'mode',
  doctor: 'doctor',
  status: 'doctor --probe',
  dashboard: 'ui --detach --open',
  searxng: 'searxng',
}

const CLI = 'SEARCHHOLE_SKILL=1 node "${CLAUDE_PLUGIN_ROOT}/dist/searchhole.mjs"'
const ALLOWED = `Bash(SEARCHHOLE_SKILL=1 node "\${CLAUDE_PLUGIN_ROOT}/dist/searchhole.mjs" *)`

const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()
const skills = dirs.map(loadSkill)

describe('skills inventory', () => {
  it('has the eighteen user-only commands plus the research skill, nothing else', () => {
    expect(dirs).toEqual([...Object.keys(USER_SKILLS), 'research'].sort())
  })

  it('names every skill after its directory', () => {
    for (const s of skills) expect(s.meta.name, s.dir).toBe(s.dir)
  })

  it('keeps descriptions short and free of angle brackets (Claude Code shows them as entities)', () => {
    for (const s of skills) {
      expect(s.meta.description.length, s.dir).toBeLessThanOrEqual(300)
      expect(s.meta.description, s.dir).not.toMatch(/[<>]/)
    }
  })
})

describe('user-only slash command skills', () => {
  const userSkills = skills.filter((s) => s.dir !== 'research')

  it('all set disable-model-invocation: true (only research is model-invocable)', () => {
    for (const s of userSkills) expect(s.meta['disable-model-invocation'], s.dir).toBe(true)
  })

  it('each has a one-line description and an argument hint', () => {
    for (const s of userSkills) {
      expect(s.meta.description, s.dir).not.toContain('\n')
      expect(s.meta['argument-hint'], s.dir).toBeTruthy()
    }
  })

  it('each runs its CLI verb through pre-execution injection with SEARCHHOLE_SKILL=1 and $ARGUMENTS', () => {
    for (const s of userSkills) {
      const verb = USER_SKILLS[s.dir]
      expect(s.body, s.dir).toContain(`\n!\`${CLI} ${verb} $ARGUMENTS\`\n`)
      expect(s.body.startsWith(`\n!\`${CLI} ${verb} $ARGUMENTS\`\n`), `${s.dir} injects first`).toBe(true)
    }
  })

  it('inject exactly one command each', () => {
    for (const s of userSkills) expect(s.body.match(/!`/g), s.dir).toHaveLength(1)
  })

  it('pre-approve only our own CLI, by path, and nothing else', () => {
    for (const s of userSkills) expect(s.meta['allowed-tools'], s.dir).toEqual([ALLOWED])
  })

  it('tell the model to show the output verbatim and run nothing else', () => {
    for (const s of userSkills) {
      expect(s.body, s.dir).toContain('verbatim')
      expect(s.body, s.dir).toContain('Do not run any other command')
    }
  })

  it('never hand the model a command to run (no code fences, no bare CLI text outside the injection)', () => {
    for (const s of userSkills) {
      expect(s.body, s.dir).not.toContain('```')
      const outside = s.body.replace(/^\n!`[^\n]*`\n/, '')
      expect(outside, s.dir).not.toContain('searchhole.mjs')
      expect(outside, s.dir).not.toContain('SEARCHHOLE_SKILL')
    }
  })
})

describe('research skill', () => {
  const research = skills.find((s) => s.dir === 'research')

  it('is model-invocable with a description of at most 300 characters', () => {
    expect(research).toBeDefined()
    expect(research?.meta['disable-model-invocation']).toBeUndefined()
    expect(research?.meta.description.length).toBeLessThanOrEqual(300)
  })

  it('runs no commands and pre-approves no tools', () => {
    expect(research?.body).not.toContain('!`')
    expect(research?.meta['allowed-tools']).toBeUndefined()
    expect(research?.body).not.toContain('SEARCHHOLE_SKILL')
  })

  it('covers the guidance the unit requires', () => {
    const body = research?.body ?? ''
    for (const needle of [
      'search',
      'fetch',
      'quick',
      'standard',
      'deep',
      'date',
      'opened',
      'cited',
      'warnings',
      'suggest_rule',
      'Never run `searchhole`',
    ]) {
      expect(body, needle).toContain(needle)
    }
  })

  it('names the Claude Code tool ids for our plugin-bundled server', () => {
    expect(research?.body).toContain('mcp__plugin_search-hole_search-hole__search')
  })
})
