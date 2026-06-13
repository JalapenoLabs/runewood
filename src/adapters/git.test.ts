// Copyright © 2026 Jalapeno Labs

import type { RunewoodEvent } from '../types'

// Core
import { describe, expect, it } from 'vitest'

import { GIT_LOG_FORMAT, parseGitLog } from './git'
import { sampleGitLog } from './__fixtures__/sample.gitlog'

/**
 * Convenience: find every event whose path ends with the given suffix, in order.
 * Keeps assertions readable without hard-coding array indices.
 */
function eventsForPath(events: RunewoodEvent[], pathSuffix: string): RunewoodEvent[] {
  return events.filter((event) => event.path?.endsWith(pathSuffix))
}

describe('parseGitLog', () => {
  it('exposes the exact git log format string it parses', () => {
    expect(GIT_LOG_FORMAT).toBe('C|%H|%an|%aI')
  })

  it('maps A/M/D statuses to create/modify/delete', () => {
    const events = parseGitLog(sampleGitLog, { repoRoot: 'runewood' })

    const readmeEvents = eventsForPath(events, 'README.md')
    expect(readmeEvents.map((event) => event.action)).toEqual([ 'create', 'delete' ])

    const treeEvents = eventsForPath(events, 'core/tree.ts')
    // tree.ts: created in commit 1, modified in commit 2, copied-from in commit 5
    // (the copy emits a create on the destination, not on the source).
    expect(treeEvents.map((event) => event.action)).toEqual([ 'create', 'modify' ])
  })

  it('parses the author into actor and the ISO date into epoch-ms at', () => {
    const events = parseGitLog(sampleGitLog, { repoRoot: 'runewood' })

    const firstEvent = events[0]
    expect(firstEvent.actor).toBe('Ada Lovelace')
    expect(firstEvent.at).toBe(Date.parse('2026-01-04T09:12:30+00:00'))

    const hopperEvent = events.find((event) => event.actor === 'Grace Hopper')
    expect(hopperEvent?.at).toBe(Date.parse('2026-01-06T11:45:00-05:00'))
  })

  it('emits events in non-decreasing time order (matching --reverse)', () => {
    const events = parseGitLog(sampleGitLog, { repoRoot: 'runewood' })

    for (let index = 1; index < events.length; index++) {
      expect(events[index].at).toBeGreaterThanOrEqual(events[index - 1].at)
    }
  })

  it('prefixes every path with the supplied repo root', () => {
    const events = parseGitLog(sampleGitLog, { repoRoot: 'runewood' })

    for (const event of events) {
      expect(event.path?.startsWith('runewood/')).toBe(true)
    }
  })

  it('trims slashes off the repo root before prefixing', () => {
    const events = parseGitLog(sampleGitLog, { repoRoot: '/runewood/' })

    expect(events[0].path?.startsWith('runewood/')).toBe(true)
    expect(events[0].path?.startsWith('/')).toBe(false)
  })

  it('emits paths unchanged when no repo root is given', () => {
    const events = parseGitLog(sampleGitLog)

    expect(events[0].path).toBe('src/index.ts')
  })

  it('models a rename as a delete of the old path and a create of the new path', () => {
    const events = parseGitLog(sampleGitLog, { repoRoot: 'runewood' })

    // Commit 4 renames src/core/layout.ts -> src/core/physics.ts (R096).
    const layoutDelete = events.find((event) => {
      return event.path === 'runewood/src/core/layout.ts' && event.action === 'delete'
    })
    const physicsCreate = events.find((event) => {
      return event.path === 'runewood/src/core/physics.ts' && event.action === 'create'
    })

    expect(layoutDelete).toBeDefined()
    expect(physicsCreate).toBeDefined()
    // Both halves of the rename share the commit's timestamp and author.
    expect(layoutDelete?.at).toBe(physicsCreate?.at)
    expect(layoutDelete?.actor).toBe('Grace Hopper')
  })

  it('models a copy as a single create of the destination, leaving the source untouched', () => {
    const events = parseGitLog(sampleGitLog, { repoRoot: 'runewood' })

    // Commit 5 copies src/core/tree.ts -> src/core/forest.ts (C078).
    const forestEvents = eventsForPath(events, 'core/forest.ts')
    expect(forestEvents.map((event) => event.action)).toEqual([ 'create' ])

    // The copy must NOT have emitted any extra event for the source tree.ts.
    const treeCopyArtifacts = events.filter((event) => {
      return event.path === 'runewood/src/core/tree.ts' && event.actor === 'Linus Torvalds'
    })
    expect(treeCopyArtifacts).toHaveLength(0)
  })

  it('returns an empty array for empty input', () => {
    expect(parseGitLog('')).toEqual([])
    expect(parseGitLog('   \n\n  ')).toEqual([])
  })

  it('skips a commit whose date cannot be parsed rather than emitting bad events', () => {
    const broken = 'C|deadbeef|Nobody|not-a-date\nA\tsrc/oops.ts'
    expect(parseGitLog(broken)).toEqual([])
  })

  it('tolerates CRLF line endings', () => {
    const crlf = sampleGitLog.replace(/\n/g, '\r\n')
    const events = parseGitLog(crlf, { repoRoot: 'runewood' })

    expect(events.length).toBeGreaterThan(0)
    expect(events[0].path).toBe('runewood/src/index.ts')
  })
})
