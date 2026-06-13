// Copyright © 2026 Jalapeno Labs

import type { RunewoodEvent } from '../types'
import type { TreeNode } from './tree'
import type { AdvanceResult } from './timeline'
import type { SeekResult } from './frameStep'

// Core
import { describe, expect, it } from 'vitest'

import { createFrameState, stepFrame } from './frameStep'

function event(overrides: Partial<RunewoodEvent>): RunewoodEvent {
  return {
    at: 1000,
    actor: 'agent-1',
    action: 'modify',
    path: 'repo/src/main.rs',
    ...overrides,
  }
}

/** A forward advance result, as `Timeline.advance` would hand back. */
function forward(playhead: number, crossed: RunewoodEvent[]): AdvanceResult {
  return { playhead, crossed, rebuild: false }
}

/** A backward seek result, as the controller adapts `Timeline.seek` into for the reducer. */
function rewind(playhead: number): SeekResult {
  return { playhead, crossed: [], rebuild: true }
}

/** Looks a node up by its full path in a folded tree, or returns null. */
function nodeAt(tree: TreeNode, path: string): TreeNode | null {
  const segments = path.split('/')
  let current: TreeNode | undefined = tree
  for (const segment of segments) {
    current = current?.children.get(segment)
  }
  return current ?? null
}

describe('stepFrame', () => {
  describe('forward advance', () => {
    it('applies each crossed event to the tree', () => {
      const state = createFrameState()
      const events = [
        event({ at: 1000, action: 'create', path: 'repo/a.ts' }),
        event({ at: 1500, action: 'create', path: 'repo/lib/b.ts' }),
      ]

      const step = stepFrame(state, forward(1500, events), events)

      expect(nodeAt(step.state.tree, 'repo/a.ts')?.status).toBe('discovered')
      expect(nodeAt(step.state.tree, 'repo/lib/b.ts')?.status).toBe('discovered')
      expect(step.state.playhead).toBe(1500)
    })

    it('emits a beam for a path-targeting event and a pulse for a pathless one', () => {
      const state = createFrameState()
      const events = [
        event({ at: 1000, action: 'modify', path: 'repo/a.ts' }),
        event({ at: 1100, action: 'pulse', path: undefined, actor: 'agent-2' }),
      ]

      const step = stepFrame(state, forward(1100, events), events)

      expect(step.beams).toEqual([
        { at: 1000, actor: 'agent-1', action: 'modify', path: 'repo/a.ts' },
      ])
      expect(step.pulses).toEqual([
        { at: 1100, actor: 'agent-2', action: 'pulse' },
      ])
      expect(step.clearParticles).toBe(false)
    })

    it('spawns nothing for a malformed pathless non-pulse event', () => {
      const state = createFrameState()
      // A `modify` with no path targets the tree but cannot land anywhere; tree.ts
      // drops it. The reducer must not invent a beam or a pulse for it.
      const events = [ event({ at: 1000, action: 'modify', path: undefined }) ]

      const step = stepFrame(state, forward(1000, events), events)

      expect(step.beams).toEqual([])
      expect(step.pulses).toEqual([])
      expect(step.state.tree.children.size).toBe(0)
    })

    it('reads time from the playhead, never the wall clock', () => {
      const state = createFrameState([], 5000)
      // The crossed event carries at=1000, but the playhead the reducer reports is
      // whatever the timeline supplies, proving it never substitutes Date.now().
      const events = [ event({ at: 1000, action: 'create', path: 'repo/a.ts' }) ]

      const step = stepFrame(state, forward(7777, events), events)

      expect(step.state.playhead).toBe(7777)
    })

    it('accumulates touched-file paths and advances lastActiveAt per actor', () => {
      const state = createFrameState()
      const events = [
        event({ at: 1000, actor: 'agent-1', action: 'modify', path: 'repo/a.ts' }),
        event({ at: 1200, actor: 'agent-1', action: 'modify', path: 'repo/b.ts' }),
        event({ at: 1300, actor: 'agent-1', action: 'modify', path: 'repo/a.ts' }),
      ]

      const step = stepFrame(state, forward(1300, events), events)

      const track = step.state.actors.get('agent-1')
      expect(track?.lastActiveAt).toBe(1300)
      // Both files are in the window, de-duplicated despite a.ts being touched twice.
      expect(track?.touchedPaths.sort()).toEqual([ 'repo/a.ts', 'repo/b.ts' ])
    })

    it('tracks each actor separately', () => {
      const state = createFrameState()
      const events = [
        event({ at: 1000, actor: 'alice', path: 'repo/a.ts' }),
        event({ at: 1100, actor: 'bob', path: 'repo/b.ts' }),
      ]

      const step = stepFrame(state, forward(1100, events), events)

      expect(step.state.actors.get('alice')?.touchedPaths).toEqual([ 'repo/a.ts' ])
      expect(step.state.actors.get('bob')?.touchedPaths).toEqual([ 'repo/b.ts' ])
    })

    it('forgets an actor\'s touched files once it has been quiet past the window', () => {
      const state = createFrameState()
      // First tick: agent touches a file at t=1000.
      const first = stepFrame(
        state,
        forward(1000, [ event({ at: 1000, actor: 'agent-1', path: 'repo/a.ts' }) ]),
        [],
        { activityWindowMs: 2000 },
      )
      expect(first.state.actors.get('agent-1')?.touchedPaths).toEqual([ 'repo/a.ts' ])

      // Second tick much later with no new events: the window has elapsed, so the
      // touched set is pruned even though the actor record (still fading) remains.
      const second = stepFrame(first.state, forward(9000, []), [], { activityWindowMs: 2000 })
      expect(second.state.actors.get('agent-1')?.touchedPaths).toEqual([])
      expect(second.state.actors.get('agent-1')?.lastActiveAt).toBe(1000)
    })
  })

  describe('backward seek rebuild', () => {
    it('re-folds the tree to the sought time and clears particles without spawning', () => {
      const log = [
        event({ at: 1000, action: 'create', path: 'repo/a.ts' }),
        event({ at: 2000, action: 'create', path: 'repo/b.ts' }),
        event({ at: 3000, action: 'create', path: 'repo/c.ts' }),
      ]
      // Fold the whole log forward first.
      const forwarded = stepFrame(createFrameState(), forward(3000, log), log)
      expect(nodeAt(forwarded.state.tree, 'repo/c.ts')).not.toBeNull()

      // Now seek back to t=1500: only a.ts should survive the re-fold.
      const rebuilt = stepFrame(forwarded.state, rewind(1500), log)

      expect(nodeAt(rebuilt.state.tree, 'repo/a.ts')).not.toBeNull()
      expect(nodeAt(rebuilt.state.tree, 'repo/b.ts')).toBeNull()
      expect(nodeAt(rebuilt.state.tree, 'repo/c.ts')).toBeNull()
      expect(rebuilt.state.playhead).toBe(1500)
      // A rewind clears transient particles and replays no forward effects.
      expect(rebuilt.clearParticles).toBe(true)
      expect(rebuilt.beams).toEqual([])
      expect(rebuilt.pulses).toEqual([])
    })

    it('rebuilds the actor window from the sought slice only', () => {
      const log = [
        event({ at: 1000, actor: 'alice', path: 'repo/a.ts' }),
        event({ at: 2000, actor: 'bob', path: 'repo/b.ts' }),
      ]
      const forwarded = stepFrame(createFrameState(), forward(2000, log), log)
      expect(forwarded.state.actors.has('bob')).toBe(true)

      // Seek back before bob ever acted: the rebuilt window must not know bob.
      const rebuilt = stepFrame(forwarded.state, rewind(1500), log)
      expect(rebuilt.state.actors.has('alice')).toBe(true)
      expect(rebuilt.state.actors.has('bob')).toBe(false)
    })

    it('preserves seeded structure across a rewind', () => {
      const log = [ event({ at: 2000, action: 'modify', path: 'repo/seen.ts' }) ]
      const seeded = createFrameState([ 'repo/dim.ts' ])

      // Fold forward so seen.ts becomes discovered while dim.ts stays seeded.
      const forwarded = stepFrame(seeded, forward(2000, log), log)
      expect(nodeAt(forwarded.state.tree, 'repo/dim.ts')?.status).toBe('seeded')

      // Rewind before the event: the re-fold must keep the seeded dim.ts.
      const rebuilt = stepFrame(forwarded.state, rewind(0), log)
      expect(nodeAt(rebuilt.state.tree, 'repo/dim.ts')?.status).toBe('seeded')
      expect(nodeAt(rebuilt.state.tree, 'repo/seen.ts')).toBeNull()
    })

    it('converts a seeded path to discovered once an event hits it, and back on rewind', () => {
      const log = [ event({ at: 2000, action: 'modify', path: 'repo/file.ts' }) ]
      const seeded = createFrameState([ 'repo/file.ts' ])
      expect(nodeAt(seeded.tree, 'repo/file.ts')?.status).toBe('seeded')

      const forwarded = stepFrame(seeded, forward(2000, log), log)
      expect(nodeAt(forwarded.state.tree, 'repo/file.ts')?.status).toBe('discovered')

      // Rewind before the touch: the file folds back to its seeded (dim) state.
      const rebuilt = stepFrame(forwarded.state, rewind(0), log)
      expect(nodeAt(rebuilt.state.tree, 'repo/file.ts')?.status).toBe('seeded')
    })
  })

  describe('still frame', () => {
    it('emits no spawns and no rebuild when no events were crossed', () => {
      const state = createFrameState()
      const step = stepFrame(state, forward(1000, []), [])

      expect(step.beams).toEqual([])
      expect(step.pulses).toEqual([])
      expect(step.clearParticles).toBe(false)
      expect(step.state.playhead).toBe(1000)
    })
  })
})
