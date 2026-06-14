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
    recent: overrides.recent,
    lastActiveAt: overrides.lastActiveAt ?? 1000,
    lastCentroid: overrides.lastCentroid,
  }
}

describe('actorVisualFor', () => {
  describe('anchor tracks the actor\'s recent work, not its all-time centroid', () => {
    it('places the actor at the centroid of its touched files when no recent touch is set', () => {
      const touched = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 150 }]
      const activity = makeActivity({ actor: 'agent-1', touched })

      // The raw centroid of the three points.
      const expectedCentroid = { x: 50, y: 50 }
      // With no drift and no outward margin, the actor sits exactly on the centroid
      // (the cluster's own outer radius still pushes it out, but along the centroid's
      // ray; here we assert the anchor by disabling the margin and reading the angle).
      const visual = actorVisualFor(activity, 1000, { drift: 0, outwardMargin: 0 })

      // Anchor angle is the centroid's angle from the origin.
      const expectedAngle = Math.atan2(expectedCentroid.y, expectedCentroid.x)
      const actorAngle = Math.atan2(visual.position.y, visual.position.x)
      expect(actorAngle).toBeCloseTo(expectedAngle, 5)
    })

    it('rides out toward the most-recent file even when the centroid is the tree center', () => {
      // The bug: a contributor touching files spread across the tree has a centroid
      // that averages back to the origin, so it used to sit dead-center. With a recent
      // touch out at a leaf, the anchor must lean hard toward that leaf instead.
      const touched = [{ x: -300, y: 0 }, { x: 300, y: 0 }, { x: 0, y: 300 }, { x: 0, y: -300 }]
      const recent = { x: 300, y: 0 }
      const spread = makeActivity({ actor: 'agent-1', touched, recent })

      const visual = actorVisualFor(spread, 1000, { drift: 0, outwardMargin: 0 })

      // The centroid of the four points is the origin, so the old behavior would put
      // the actor at the center. Anchoring on the recent file pushes it out to the
      // right (toward +x), nowhere near the origin.
      expect(visual.position.x).toBeGreaterThan(200)
      expect(Math.abs(visual.position.y)).toBeLessThan(50)
    })

    it('ends up near its recent file, not at the origin/center', () => {
      // The actor must float close to where it is actively working.
      const recent = { x: 400, y: 0 }
      const activity = makeActivity({ actor: 'agent-1', touched: [ recent ], recent })

      const visual = actorVisualFor(activity, 1000, { drift: 0, outwardMargin: 30 })

      const distanceFromOrigin = Math.hypot(visual.position.x, visual.position.y)
      const distanceFromRecentFile = Math.hypot(visual.position.x - recent.x, visual.position.y - recent.y)

      // Far from the origin (out where the work is)...
      expect(distanceFromOrigin).toBeGreaterThan(400)
      // ...and near its recent file (just the small outward margin past it).
      expect(distanceFromRecentFile).toBeCloseTo(30, 5)
    })

    it('holds at the last centroid when the actor is touching nothing', () => {
      const quiet = makeActivity({ touched: [], recent: undefined, lastCentroid: { x: 200, y: 90 }})
      const visual = actorVisualFor(quiet, 1000, { drift: 0, outwardMargin: 0 })

      // No touched cluster, so the push reduces to the anchor (the parked centroid).
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

  describe('actor floats outward past its work, scaled to the tree', () => {
    it('sits strictly farther from the origin than its recent file', () => {
      // The Gource-style placement: a contributor orbits the outside near its work,
      // not the dense middle. The orb must land beyond the file it is editing.
      const recent = { x: 320, y: 40 }
      const activity = makeActivity({ actor: 'agent-1', touched: [ recent ], recent })
      // Disable drift so the only displacement off the anchor is the outward push.
      const visual = actorVisualFor(activity, 1000, { drift: 0, outwardMargin: 90 })

      const recentDistance = Math.hypot(recent.x, recent.y)
      const actorDistance = Math.hypot(visual.position.x, visual.position.y)

      expect(actorDistance).toBeGreaterThan(recentDistance)
      // It floats exactly the margin past the cluster's outer radius (the recent
      // file is the only file, so that radius is the recent file's own radius).
      expect(actorDistance).toBeCloseTo(recentDistance + 90, 5)
    })

    it('scales the push to the tree: a larger cluster pushes the actor farther out', () => {
      // The fix for "actors buried in a large tree": the push clears the whole
      // touched cluster, so as the tree grows the orb floats correspondingly farther
      // out, not stranded at a tiny fixed offset.
      const recent = { x: 100, y: 0 }
      // Same anchor and margin; only the cluster's outer radius differs.
      const small = makeActivity({ actor: 'agent-1', touched: [ recent, { x: 150, y: 0 }], recent })
      const large = makeActivity({ actor: 'agent-1', touched: [ recent, { x: 900, y: 0 }], recent })

      const smallVisual = actorVisualFor(small, 1000, { drift: 0, outwardMargin: 40 })
      const largeVisual = actorVisualFor(large, 1000, { drift: 0, outwardMargin: 40 })

      const smallDistance = Math.hypot(smallVisual.position.x, smallVisual.position.y)
      const largeDistance = Math.hypot(largeVisual.position.x, largeVisual.position.y)
      // The bigger cluster floats the actor much farther out, past its farthest file.
      expect(largeDistance).toBeGreaterThan(smallDistance + 700)
    })

    it('pushes farther out for a larger margin', () => {
      const recent = { x: 200, y: 200 }
      const activity = makeActivity({ actor: 'agent-1', touched: [ recent ], recent })

      const near = actorVisualFor(activity, 1000, { drift: 0, outwardMargin: 40 })
      const far = actorVisualFor(activity, 1000, { drift: 0, outwardMargin: 160 })

      const nearDistance = Math.hypot(near.position.x, near.position.y)
      const farDistance = Math.hypot(far.position.x, far.position.y)
      expect(farDistance).toBeCloseTo(nearDistance + 120, 5)
    })

    it('keeps the actor on the same outward ray as its anchor', () => {
      // The push is purely radial, so the actor's direction from the origin matches
      // its anchor's direction (it just sits farther along the same line).
      const recent = { x: 100, y: 50 }
      const activity = makeActivity({ actor: 'agent-1', touched: [ recent ], recent })
      const visual = actorVisualFor(activity, 1000, { drift: 0, outwardMargin: 70 })

      const anchorAngle = Math.atan2(50, 100)
      const actorAngle = Math.atan2(visual.position.y, visual.position.x)
      expect(actorAngle).toBeCloseTo(anchorAngle, 5)
    })

    it('still escapes the origin when the anchor is dead-center', () => {
      // A contributor whose anchor is the tree center has no outward ray; it must not
      // stay pinned at the origin. The hashed fallback direction pushes it out by the
      // full margin deterministically.
      const activity = makeActivity({ actor: 'agent-1', touched: [{ x: 0, y: 0 }], recent: { x: 0, y: 0 }})
      const visual = actorVisualFor(activity, 1000, { drift: 0, outwardMargin: 90 })

      const distance = Math.hypot(visual.position.x, visual.position.y)
      expect(distance).toBeCloseTo(90, 5)
    })

    it('respects a custom origin the actor is pushed away from', () => {
      // The push is measured from the supplied origin, not a hardcoded (0,0).
      const origin = { x: 500, y: 500 }
      const recent = { x: 600, y: 500 }
      const activity = makeActivity({ actor: 'agent-1', touched: [ recent ], recent })
      const visual = actorVisualFor(activity, 1000, { drift: 0, outwardMargin: 50, origin })

      // The recent file is 100 to the right of the origin; pushing 50 further out
      // lands 150 to the right of the origin along the same ray.
      expect(visual.position.x).toBeCloseTo(650, 5)
      expect(visual.position.y).toBeCloseTo(500, 5)
    })
  })

  describe('lingers on its last node through idle gaps (Part C)', () => {
    it('stays fully present through a brief idle gap, well past the old short fade', () => {
      // The bug: an LLM agent edits a file then pauses, and the actor used to fade out
      // after a few seconds. With a long linger it must STAY parked at full presence.
      const lastActiveAt = 5_000
      const activity = makeActivity({ lastActiveAt })

      // Eight seconds idle (past the old 3s fade) but well inside a long linger:
      // still fully present (no idle pulse configured, so exactly 1).
      const visual = actorVisualFor(activity, lastActiveAt + 8_000, {
        lingerMs: 60_000,
        idlePulseDepth: 0,
      })
      expect(visual.alpha).toBe(1)
    })

    it('only begins fading after the configured long linger, not the fade window', () => {
      const lastActiveAt = 0
      const lingerMs = 10_000
      const fadeMs = 2_000
      const activity = makeActivity({ lastActiveAt })

      // At the end of the linger it is still full; the fade has not started.
      const atLingerEnd = actorVisualFor(activity, lingerMs, { lingerMs, fadeMs, idlePulseDepth: 0 })
      expect(atLingerEnd.alpha).toBe(1)

      // Halfway through the fade (which starts only after the linger): half present.
      const midFade = actorVisualFor(activity, lingerMs + fadeMs / 2, { lingerMs, fadeMs, idlePulseDepth: 0 })
      expect(midFade.alpha).toBeCloseTo(0.5, 5)

      // Past the linger + fade: fully gone.
      const afterFade = actorVisualFor(activity, lingerMs + fadeMs, { lingerMs, fadeMs, idlePulseDepth: 0 })
      expect(afterFade.alpha).toBe(0)
    })

    it('breathes a gentle, bounded idle pulse once parked (size and alpha dip together)', () => {
      const lastActiveAt = 0
      const idleAfterMs = 500
      const idlePulseMs = 2_000
      const idlePulseDepth = 0.2
      const lingerMs = 60_000
      const baseSize = 10
      const activity = makeActivity({ lastActiveAt })
      const tuning = { lingerMs, idleAfterMs, idlePulseMs, idlePulseDepth, size: baseSize }

      // Still active (under idleAfterMs): no breathing, full size and alpha.
      const fresh = actorVisualFor(activity, idleAfterMs, tuning)
      expect(fresh.alpha).toBe(1)
      expect(fresh.size).toBeCloseTo(baseSize, 6)

      // At the trough of the first breath (half a period after idling starts): the
      // size and alpha dip by exactly the depth, never more.
      const trough = actorVisualFor(activity, idleAfterMs + idlePulseMs / 2, tuning)
      expect(trough.alpha).toBeCloseTo(1 - idlePulseDepth, 5)
      expect(trough.size).toBeCloseTo(baseSize * (1 - idlePulseDepth), 5)

      // Back at the top of the breath one full period later: returned to full.
      const peak = actorVisualFor(activity, idleAfterMs + idlePulseMs, tuning)
      expect(peak.alpha).toBeCloseTo(1, 5)
      expect(peak.size).toBeCloseTo(baseSize, 5)
    })

    it('keeps the idle breath bounded within [1 - depth, 1] across the whole cycle', () => {
      const idlePulseDepth = 0.3
      const tuning = { lingerMs: 60_000, idleAfterMs: 0, idlePulseMs: 1_000, idlePulseDepth, size: 10 }
      const activity = makeActivity({ lastActiveAt: 0 })

      // Sample the breath densely over two full cycles; it must never brighten past
      // full nor dim below the configured depth.
      for (let nowMs = 0; nowMs <= 2_000; nowMs += 37) {
        const visual = actorVisualFor(activity, nowMs, tuning)
        expect(visual.alpha).toBeLessThanOrEqual(1 + 1e-9)
        expect(visual.alpha).toBeGreaterThanOrEqual(1 - idlePulseDepth - 1e-9)
      }
    })

    it('parks at its last centroid while lingering quiet, pushed just outside it', () => {
      // After the recency window clears the touched files, a lingering actor falls
      // back to its parked last-centroid (still pushed outward by the margin), so it
      // stays floating outside its last work rather than snapping to the origin.
      const quiet = makeActivity({ touched: [], recent: undefined, lastCentroid: { x: 300, y: 0 }})
      const visual = actorVisualFor(quiet, 1_000, { drift: 0, outwardMargin: 40, lingerMs: 60_000 })

      const distanceFromOrigin = Math.hypot(visual.position.x, visual.position.y)
      // Parked outside its last centroid: the centroid radius (300) plus the margin.
      expect(distanceFromOrigin).toBeCloseTo(340, 5)
    })
  })

  describe('fade decays after the linger window elapses', () => {
    // These exercise the raw fade with linger disabled (lingerMs: 0) and no idle
    // pulse, so the fade is measured straight from lastActiveAt as before Part C. The
    // lingering behavior itself is covered in its own describe above.
    const noLinger = { lingerMs: 0, idlePulseDepth: 0 } as const

    it('is full at the instant of activity', () => {
      const activity = makeActivity({ lastActiveAt: 5000 })
      const visual = actorVisualFor(activity, 5000, { ...noLinger, fadeMs: 3000 })
      expect(visual.alpha).toBe(1)
    })

    it('decays linearly to zero over the fade window since the last activity', () => {
      const lastActiveAt = 5000
      const fadeMs = 3000
      const activity = makeActivity({ lastActiveAt })

      const atActivity = actorVisualFor(activity, lastActiveAt, { ...noLinger, fadeMs })
      const midFade = actorVisualFor(activity, lastActiveAt + fadeMs / 2, { ...noLinger, fadeMs })
      const afterFade = actorVisualFor(activity, lastActiveAt + fadeMs, { ...noLinger, fadeMs })

      expect(atActivity.alpha).toBeCloseTo(1, 5)
      expect(midFade.alpha).toBeCloseTo(0.5, 5)
      expect(afterFade.alpha).toBe(0)
    })

    it('clamps a long-idle actor to zero, never negative', () => {
      const activity = makeActivity({ lastActiveAt: 1000 })
      const visual = actorVisualFor(activity, 1000 + 100_000, { ...noLinger, fadeMs: 3000 })
      expect(visual.alpha).toBe(0)
    })

    it('treats an actor active again as fully present (alpha back to 1)', () => {
      const stale = makeActivity({ lastActiveAt: 1000 })
      const refreshed = makeActivity({ lastActiveAt: 9000 })

      const staleVisual = actorVisualFor(stale, 9500, { ...noLinger, fadeMs: 3000 })
      const refreshedVisual = actorVisualFor(refreshed, 9500, { ...noLinger, fadeMs: 3000 })

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
