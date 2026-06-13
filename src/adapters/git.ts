// Copyright © 2026 Jalapeno Labs

import type { RunewoodAction, RunewoodEvent } from '../types'

/**
 * Options for {@link parseGitLog}.
 */
export type ParseGitLogOptions = {
  /**
   * Repo root segment to prefix every emitted path with, so the events slot into
   * the forest as `repoRoot/<path>`. The engine treats the first path segment as
   * the tree root (one tree per repo), so this is what places a repo's history in
   * its own tree. Leading/trailing slashes are trimmed; an empty/whitespace value
   * means "no prefix" (paths are emitted as-is).
   */
  repoRoot?: string
}

/**
 * The exact `git log` invocation whose output {@link parseGitLog} expects.
 *
 * ```sh
 * git log --reverse --name-status --pretty=format:'C|%H|%an|%aI'
 * ```
 *
 * Field by field:
 * - `--reverse` emits commits oldest-first, so the resulting events arrive in
 *   ascending `at` order, matching the timeline's requirement that events be
 *   ingested in non-decreasing time order.
 * - `--name-status` prints one `STATUS\tpath` line per changed file (and the
 *   three-column `STATUS\told\tnew` form for renames/copies).
 * - `--pretty=format:'C|%H|%an|%aI'` is a delimiter-based header line we parse:
 *   a literal `C|` marker, the commit hash (`%H`, currently unused but kept so
 *   the format is unambiguous and future-proof), the author name (`%an`), and the
 *   author date in strict ISO-8601 (`%aI`, parsed to epoch milliseconds for `at`).
 *
 * The pipe (`|`) is the field delimiter; author names containing a pipe would
 * break parsing, which is vanishingly rare and not worth a heavier format.
 */
export const GIT_LOG_FORMAT = 'C|%H|%an|%aI'

/**
 * The header line marker emitted by {@link GIT_LOG_FORMAT}. A line starting with
 * this begins a new commit; everything until the next marker is that commit's
 * `--name-status` body.
 */
const COMMIT_MARKER = 'C|'

/**
 * Maps a single-letter `git` status to a {@link RunewoodAction}. Renames (`R`)
 * and copies (`C`) are multi-path and handled separately, so they are absent here.
 */
const ACTION_BY_STATUS = {
  A: 'create',
  M: 'modify',
  D: 'delete',
} as const satisfies Record<string, RunewoodAction>

/**
 * Parse the output of the documented `git log` invocation (see
 * {@link GIT_LOG_FORMAT}) into a stream of {@link RunewoodEvent}s.
 *
 * This is a pure text-in -> events-out transform: it never shells out, reads the
 * clock, or touches any I/O, so it runs in any runtime or the browser. The host
 * is responsible for actually running `git` and handing the captured stdout here.
 *
 * Status mapping:
 * - `A` -> `create`, `M` -> `modify`, `D` -> `delete` (one event each).
 * - `R<score>\told\tnew` (rename) -> a `delete` of the old path **and** a `create`
 *   of the new path. A rename moves a file in the tree, so modelling it as the old
 *   node disappearing and the new node appearing keeps the folded tree honest
 *   (the old path must not linger).
 * - `C<score>\told\tnew` (copy) -> a single `create` of the new path. A copy leaves
 *   the source in place, so only the destination is new; the source is untouched
 *   and emits nothing.
 *
 * Unrecognized status letters are skipped (with a debug log) rather than guessed
 * at, so a future git status type never silently produces a wrong action.
 */
export function parseGitLog(text: string, options: ParseGitLogOptions = {}): RunewoodEvent[] {
  const repoRoot = options.repoRoot?.trim().replace(/^\/+|\/+$/g, '') ?? ''

  const events: RunewoodEvent[] = []
  let actor = ''
  let at = 0
  let haveCommit = false

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim()) {
      continue
    }

    if (line.startsWith(COMMIT_MARKER)) {
      // Header: `C|<hash>|<author>|<iso-date>`. Split on the first three pipes so
      // an author name containing a pipe would only corrupt the date, not the cut.
      const [ , , author, isoDate ] = line.split('|')
      const parsedAt = Date.parse(isoDate ?? '')
      if (Number.isNaN(parsedAt)) {
        console.debug('parseGitLog could not parse commit date, skipping commit', line)
        haveCommit = false
        continue
      }

      actor = author ?? ''
      at = parsedAt
      haveCommit = true
      continue
    }

    if (!haveCommit) {
      // A body line before any valid header (or after a skipped one) has no actor
      // or timestamp to attach to, so it cannot become an event.
      console.debug('parseGitLog encountered a file line with no active commit, skipping', line)
      continue
    }

    // Body: `STATUS\tpath` (A/M/D) or `STATUS\told\tnew` (R<score>/C<score>).
    const columns = line.split('\t')
    const status = columns[0]
    const statusLetter = status?.[0]

    if (statusLetter === 'R') {
      const oldPath = columns[1]
      const newPath = columns[2]
      if (!oldPath || !newPath) {
        console.debug('parseGitLog saw a rename line without both paths, skipping', line)
        continue
      }
      events.push({ at, actor, action: 'delete', path: prefixPath(repoRoot, oldPath) })
      events.push({ at, actor, action: 'create', path: prefixPath(repoRoot, newPath) })
      continue
    }

    if (statusLetter === 'C') {
      const newPath = columns[2]
      if (!newPath) {
        console.debug('parseGitLog saw a copy line without a destination path, skipping', line)
        continue
      }
      events.push({ at, actor, action: 'create', path: prefixPath(repoRoot, newPath) })
      continue
    }

    const action = ACTION_BY_STATUS[statusLetter as keyof typeof ACTION_BY_STATUS]
    if (!action) {
      console.debug('parseGitLog saw an unrecognized git status, skipping', line)
      continue
    }

    const path = columns[1]
    if (!path) {
      console.debug('parseGitLog saw a status line without a path, skipping', line)
      continue
    }

    events.push({ at, actor, action, path: prefixPath(repoRoot, path) })
  }

  return events
}

/**
 * Join the repo root to a file path with a single slash, or return the path
 * unchanged when no root was supplied.
 */
function prefixPath(repoRoot: string, path: string): string {
  if (!repoRoot) {
    return path
  }
  return `${repoRoot}/${path}`
}
