// Copyright © 2026 Jalapeno Labs

import type { Hsl } from './theme'

// Core
import { describe, expect, it } from 'vitest'

import { HighlightRegistry, highlightPulse } from './highlight'

const AMBER: Hsl = { h: 38, s: 0.9, l: 0.55 }
const CYAN: Hsl = { h: 190, s: 0.9, l: 0.55 }

describe('HighlightRegistry', () => {
  it('adds a group and resolves its member paths to that group', () => {
    const registry = new HighlightRegistry()
    registry.set('pr-1', [ 'api/main.rs', 'api/lib.rs' ], AMBER)

    expect(registry.highlightFor('api/main.rs')).toEqual({ color: AMBER, groupId: 'pr-1' })
    expect(registry.highlightFor('api/lib.rs')).toEqual({ color: AMBER, groupId: 'pr-1' })
    expect(registry.isEmpty).toBe(false)
  })

  it('returns null for a path no group contains', () => {
    const registry = new HighlightRegistry()
    registry.set('pr-1', [ 'api/main.rs' ], AMBER)

    expect(registry.highlightFor('frontend/app.ts')).toBeNull()
  })

  it('updates a group\'s paths in place, keeping its color and dropping departed paths', () => {
    const registry = new HighlightRegistry()
    registry.set('pr-1', [ 'api/main.rs' ], AMBER)
    registry.updatePaths('pr-1', [ 'api/main.rs', 'api/router.rs' ])

    expect(registry.highlightFor('api/router.rs')).toEqual({ color: AMBER, groupId: 'pr-1' })
    expect(registry.highlightFor('api/main.rs')).toEqual({ color: AMBER, groupId: 'pr-1' })

    registry.updatePaths('pr-1', [ 'api/router.rs' ])
    // The original path is no longer in the set after the second update.
    expect(registry.highlightFor('api/main.rs')).toBeNull()
    expect(registry.highlightFor('api/router.rs')).toEqual({ color: AMBER, groupId: 'pr-1' })
  })

  it('ignores updatePaths for an unknown group rather than creating one', () => {
    const registry = new HighlightRegistry()
    registry.updatePaths('ghost', [ 'api/main.rs' ])

    expect(registry.highlightFor('api/main.rs')).toBeNull()
    expect(registry.isEmpty).toBe(true)
  })

  it('removes a group by id and reports whether it removed anything', () => {
    const registry = new HighlightRegistry()
    registry.set('pr-1', [ 'api/main.rs' ], AMBER)

    expect(registry.remove('pr-1')).toBe(true)
    expect(registry.highlightFor('api/main.rs')).toBeNull()
    expect(registry.isEmpty).toBe(true)
    // A second remove of the same id finds nothing.
    expect(registry.remove('pr-1')).toBe(false)
  })

  it('clears every group at once', () => {
    const registry = new HighlightRegistry()
    registry.set('pr-1', [ 'api/main.rs' ], AMBER)
    registry.set('pr-2', [ 'frontend/app.ts' ], CYAN)

    registry.clear()

    expect(registry.isEmpty).toBe(true)
    expect(registry.highlightFor('api/main.rs')).toBeNull()
    expect(registry.highlightFor('frontend/app.ts')).toBeNull()
  })

  describe('overlap resolution', () => {
    it('lets the most-recently-added group win an overlapping path', () => {
      const registry = new HighlightRegistry()
      registry.set('pr-1', [ 'api/main.rs' ], AMBER)
      registry.set('pr-2', [ 'api/main.rs' ], CYAN)

      // pr-2 was added last, so it owns the shared path.
      expect(registry.highlightFor('api/main.rs')).toEqual({ color: CYAN, groupId: 'pr-2' })
    })

    it('makes a re-added group win the overlap, since re-adding moves it to the front of priority', () => {
      const registry = new HighlightRegistry()
      registry.set('pr-1', [ 'api/main.rs' ], AMBER)
      registry.set('pr-2', [ 'api/main.rs' ], CYAN)
      // Re-add pr-1: it should now be the newest and win the shared path.
      registry.set('pr-1', [ 'api/main.rs' ], AMBER)

      expect(registry.highlightFor('api/main.rs')).toEqual({ color: AMBER, groupId: 'pr-1' })
    })

    it('only the overlapping path changes owner, not the group\'s exclusive paths', () => {
      const registry = new HighlightRegistry()
      registry.set('pr-1', [ 'api/main.rs', 'api/only-1.rs' ], AMBER)
      registry.set('pr-2', [ 'api/main.rs', 'api/only-2.rs' ], CYAN)

      expect(registry.highlightFor('api/only-1.rs')).toEqual({ color: AMBER, groupId: 'pr-1' })
      expect(registry.highlightFor('api/only-2.rs')).toEqual({ color: CYAN, groupId: 'pr-2' })
      expect(registry.highlightFor('api/main.rs')).toEqual({ color: CYAN, groupId: 'pr-2' })
    })
  })

  describe('highlightedPaths', () => {
    it('returns the union across groups with no duplicates', () => {
      const registry = new HighlightRegistry()
      registry.set('pr-1', [ 'api/main.rs', 'api/shared.rs' ], AMBER)
      registry.set('pr-2', [ 'api/shared.rs', 'frontend/app.ts' ], CYAN)

      const paths = registry.highlightedPaths()

      expect(paths).toEqual(new Set([ 'api/main.rs', 'api/shared.rs', 'frontend/app.ts' ]))
    })

    it('is empty when no groups are registered', () => {
      const registry = new HighlightRegistry()
      expect(registry.highlightedPaths().size).toBe(0)
    })
  })
})

describe('highlightPulse', () => {
  it('stays within [floor, 1] across a full cycle', () => {
    const periodMs = 1000
    const floor = 0.35
    for (let timeMs = 0; timeMs <= periodMs * 3; timeMs += 25) {
      const intensity = highlightPulse(timeMs, { periodMs, floor })
      expect(intensity).toBeGreaterThanOrEqual(floor - 1e-9)
      expect(intensity).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  it('rests at the floor at phase 0 and peaks at full at the half cycle', () => {
    const periodMs = 1000
    const floor = 0.3

    expect(highlightPulse(0, { periodMs, floor })).toBeCloseTo(floor, 6)
    expect(highlightPulse(periodMs / 2, { periodMs, floor })).toBeCloseTo(1, 6)
  })

  it('is periodic: the same phase one period later yields the same intensity', () => {
    const periodMs = 1600
    const sampleMs = 437

    expect(highlightPulse(sampleMs, { periodMs })).toBeCloseTo(
      highlightPulse(sampleMs + periodMs, { periodMs }),
      6,
    )
  })

  it('breathes smoothly rather than jumping (small time step -> small change)', () => {
    const periodMs = 1600
    const previous = highlightPulse(400, { periodMs })
    const next = highlightPulse(410, { periodMs })

    expect(Math.abs(next - previous)).toBeLessThan(0.1)
  })
})
