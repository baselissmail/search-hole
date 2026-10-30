// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest'
import { actorMarker, resolveActor, SKILL_ENV, withActorNote } from '../../src/cli/gate.ts'
import { isSearchHoleError } from '../../src/shared/errors.ts'

const io = (stdinIsTTY: boolean, env: Record<string, string | undefined> = {}) => ({ stdinIsTTY, env })

describe('resolveActor', () => {
  it('a terminal is interactive and needs no --yes', () => {
    expect(resolveActor(io(true), false)).toBe('interactive')
    expect(resolveActor(io(true), true)).toBe('interactive')
  })

  it('without a terminal, --yes makes it non-interactive; without --yes it is refused', () => {
    expect(resolveActor(io(false), true)).toBe('non-interactive')
    try {
      resolveActor(io(false), false, 'your search mode')
      expect.unreachable()
    } catch (e) {
      expect(isSearchHoleError(e)).toBe(true)
      if (isSearchHoleError(e)) {
        expect(e.code).toBe('invalid_argument')
        expect(e.why).toBe('This command changes your search mode and was run without a terminal.')
        expect(e.fix).toContain('--yes')
      }
    }
  })

  it('SEARCHHOLE_SKILL=1 (exactly) is a skill with or without a terminal, and needs no --yes', () => {
    expect(SKILL_ENV).toBe('SEARCHHOLE_SKILL')
    expect(resolveActor(io(false, { SEARCHHOLE_SKILL: '1' }), false)).toBe('skill')
    expect(resolveActor(io(true, { SEARCHHOLE_SKILL: '1' }), false)).toBe('skill')
    expect(() => resolveActor(io(false, { SEARCHHOLE_SKILL: 'true' }), false)).toThrow('without a terminal')
    expect(() => resolveActor(io(false, { SEARCHHOLE_SKILL: '' }), false)).toThrow('without a terminal')
  })
})

describe('actor notes', () => {
  it('an interactive user leaves the note alone', () => {
    expect(actorMarker('interactive')).toBe('')
    expect(withActorNote(undefined, 'interactive')).toBeUndefined()
    expect(withActorNote('why', 'interactive')).toBe('why')
  })

  it('other actors are appended or become the whole note', () => {
    expect(withActorNote(undefined, 'non-interactive')).toBe('[actor: non-interactive]')
    expect(withActorNote('  ', 'skill')).toBe('[actor: skill]')
    expect(withActorNote(' noisy ', 'non-interactive')).toBe('noisy [actor: non-interactive]')
  })
})
