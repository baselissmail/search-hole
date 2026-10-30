// SPDX-License-Identifier: Apache-2.0
/**
 * The guard on the CLI's write verbs (ADR-0012, model-reachable write paths, point 4).
 *
 * Principle 3: the model never changes rules. A model with a shell could still run
 * `searchhole block ...`, so a verb that changes rules, trust or the search mode and is
 * not attached to a terminal must say `--yes`, and the change is marked with who made it:
 *
 * - interactive (stdin is a TTY): a person typed it; nothing extra is recorded.
 * - skill (`SEARCHHOLE_SKILL=1`, set by our own slash-command skills, which only the user
 *   can invoke): no `--yes` needed; the change is marked `actor: skill`.
 * - non-interactive (anything else, with `--yes`): marked `actor: non-interactive`, so the
 *   dashboard can say "changed by a non-interactive command" and offer Undo.
 *
 * `SEARCHHOLE_SKILL` is an honesty marker, not a security boundary: a shell can set it.
 * That is why the PreToolUse guard (ADR-0014) denies such calls in Claude Code and why
 * every change stays attributable.
 */
import { SearchHoleError } from '../shared/errors.ts'
import type { CliIo } from './io.ts'

export type Actor = 'interactive' | 'skill' | 'non-interactive'

/** The environment variable our skills set when they run the CLI for the user. */
export const SKILL_ENV = 'SEARCHHOLE_SKILL'

/**
 * Decides who is acting, or throws `invalid_argument` when a write verb runs without a
 * terminal and without `--yes`. `what` completes "This command changes ...".
 */
export function resolveActor(
  io: Pick<CliIo, 'env' | 'stdinIsTTY'>,
  yes: boolean,
  what = 'your rules',
): Actor {
  if (io.env[SKILL_ENV] === '1') return 'skill'
  if (io.stdinIsTTY) return 'interactive'
  if (!yes) {
    throw new SearchHoleError(
      'invalid_argument',
      `This command changes ${what} and was run without a terminal.`,
      {
        fix: 'Run it yourself in a terminal. A script can pass --yes; the change is then marked non-interactive and can be undone.',
      },
    )
  }
  return 'non-interactive'
}

/** The attribution suffix recorded in a rule's note; empty for an interactive user. */
export function actorMarker(actor: Actor): string {
  return actor === 'interactive' ? '' : `[actor: ${actor}]`
}

/** Appends the actor marker to a note (undefined stays undefined for an interactive user). */
export function withActorNote(note: string | undefined, actor: Actor): string | undefined {
  const marker = actorMarker(actor)
  if (marker === '') return note
  return note === undefined || note.trim() === '' ? marker : `${note.trim()} ${marker}`
}
