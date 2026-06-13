// Copyright © 2026 Jalapeno Labs

import type { ActorActivity } from './actors'

// Core
import { describe, expect, it } from 'vitest'

import { colorForActor } from '../core/theme'
import { actorVisualFor } from './actors'

/** A baseline actor activity the tests tweak per case. */
function makeActivity(overrides: Partial<ActorActivity> = {}): ActorActivity {
  return {
    actor: overrides.actor ?? 'agent-1',
    touched: overrides.touched ?? [{ x: 0, y: 0 }],
    lastActiveAt: overrides.lastActiveAt ?? 1000,
    lastCentroid: overrides.lastCentroid,
  }
}

describe('actorVisualFor', () => {
  describe('position tracks the centroid of touched files', () => {
    it('places the actor at the mean of its touched-file positions (plus its drift)', () => {
      const touched = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 150 }]
      const activity = makeActivity({ actor: 'agent-1', touched })

      // The raw centroid of the three points.
      const expectedCentroid = { x: 50, y: 50 }
      // With no drift, the actor sits exactly on the centroid.
      const visual = actorVisualFor(activity, 1000, { drift: 0 })

      expect(visual.position.x).toBeCloseTo(expectedCentroid.x, 5)
      expect(visual.position.y).toBeCloseTo(expectedCentroid.y, 5)
    })

    it('moves with the centroid as the touched set changes', () => {
      const near = makeActivity({ touched: [{ x: 0, y: 0 }]})
      const far = makeActivity({ touched: [{ x: 400, y: 400 }]})

      const nearVisual = actorVisualFor(near, 1000, { drift: 0 })
      const farVisual = actorVisualFor(far, 1000, { drift: 0 })

      expect(farVisual.position.x).toBeGreaterThan(nearVisual.position.x)
      expect(farVisual.position.y).toBeGreaterThan(nearVisual.position.y)
    })

    it('holds at the last centroid when the actor is touching nothing', () => {
      const quiet = makeActivity({ touched: [], lastCentroid: { x: 200, y: 90 }})
      const visual = actorVisualFor(quiet, 1000, { drift: 0 })

      expect(visual.position.x).toBeCloseTo(200, 5)
      expect(visual.position.y).toBeCloseTo(90, 5)
    })

    it('gives co-located actors distinct drift so their orbs do not stack exactly', () => {
      const shared = { x: 0, y: 0 }
      const first = makeActivity({ actor: 'agent-a', touched: [ shared ]})
      const second = makeActivity({ actor: 'agent-b', touched: [ shared ]})

      const firstVisual = actorVisualFor(first, 1000)
      const secondVisual = actorVisualFor(second, 1000)

      const distance = Math.hypot(
        firstVisual.position.x - secondVisual.position.x,
        firstVisual.position.y - secondVisual.position.y,
      )
      expect(distance).toBeGreaterThan(0)
    })
  })

  describe('fade rises with activity and decays after inactivity', () => {
    it('is full at the instant of activity', () => {
      const activity = makeActivity({ lastActiveAt: 5000 })
      const visual = actorVisualFor(activity, 5000, { fadeMs: 3000 })
      expect(visual.alpha).toBe(1)
    })

    it('decays linearly to zero over the fade window since the last activity', () => {
      const lastActiveAt = 5000
      const fadeMs = 3000
      const activity = makeActivity({ lastActiveAt })

      const atActivity = actorVisualFor(activity, lastActiveAt, { fadeMs })
      const midFade = actorVisualFor(activity, lastActiveAt + fadeMs / 2, { fadeMs })
      const afterFade = actorVisualFor(activity, lastActiveAt + fadeMs, { fadeMs })

      expect(atActivity.alpha).toBeCloseTo(1, 5)
      expect(midFade.alpha).toBeCloseTo(0.5, 5)
      expect(afterFade.alpha).toBe(0)
    })

    it('clamps a long-idle actor to zero, never negative', () => {
      const activity = makeActivity({ lastActiveAt: 1000 })
      const visual = actorVisualFor(activity, 1000 + 100_000, { fadeMs: 3000 })
      expect(visual.alpha).toBe(0)
    })

    it('treats an actor active again as fully present (alpha back to 1)', () => {
      const stale = makeActivity({ lastActiveAt: 1000 })
      const refreshed = makeActivity({ lastActiveAt: 9000 })

      const staleVisual = actorVisualFor(stale, 9500, { fadeMs: 3000 })
      const refreshedVisual = actorVisualFor(refreshed, 9500, { fadeMs: 3000 })

      expect(refreshedVisual.alpha).toBeGreaterThan(staleVisual.alpha)
      expect(refreshedVisual.alpha).toBeCloseTo(1 - 500 / 3000, 5)
    })
  })

  describe('color comes from the actor identity', () => {
    it('uses colorForActor so the same actor is always the same hue', () => {
      const visual = actorVisualFor(makeActivity({ actor: 'agent-7' }), 1000)
      expect(visual.color).toEqual(colorForActor('agent-7'))
    })
  })

  describe('determinism', () => {
    it('is a pure function of its inputs', () => {
      const activity = makeActivity({ actor: 'agent-1', touched: [{ x: 10, y: 20 }], lastActiveAt: 900 })
      const first = actorVisualFor(activity, 1500)
      const second = actorVisualFor(activity, 1500)
      expect(first).toEqual(second)
    })
  })
})
