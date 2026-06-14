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
      // With no drift and no outward offset, the actor sits exactly on the centroid;
      // here we assert the anchor direction by reading the angle.
      const visual = actorVisualFor(activity, 1000, { drift: 0, outwardOffset: 0 })

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

      const visual = actorVisualFor(spread, 1000, { drift: 0, outwardOffset: 0 })

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

      const visual = actorVisualFor(activity, 1000, { drift: 0, outwardOffset: 30 })

      const distanceFromOrigin = Math.hypot(visual.position.x, visual.position.y)
      const distanceFromRecentFile = Math.hypot(visual.position.x - recent.x, visual.position.y - recent.y)

      // Far from the origin (out where the work is)...
      expect(distanceFromOrigin).toBeGreaterThan(400)
      // ...and right next to its recent file (just the short fixed offset past it).
      expect(distanceFromRecentFile).toBeCloseTo(30, 5)
    })

    it('holds at the last centroid when the actor is touching nothing', () => {
      const quiet = makeActivity({ touched: [], recent: undefined, lastCentroid: { x: 200, y: 90 }})
      const visual = actorVisualFor(quiet, 1000, { drift: 0, outwardOffset: 0 })

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

  describe('actor floats a SHORT fixed offset just outside its file (hugs its work)', () => {
    it('sits a short fixed distance past its recent file, with a short beam between', () => {
      // The Gource-style placement: a contributor hugs the file it is editing with a
      // short beam, not flung to the periphery. The orb lands exactly `offset` past the
      // file along the file's outward ray, so the orb-to-file gap IS that short offset.
      const recent = { x: 320, y: 40 }
      const activity = makeActivity({ actor: 'agent-1', touched: [ recent ], recent })
      // Disable drift so the only displacement off the anchor is the outward offset.
      const offset = 60
      const visual = actorVisualFor(activity, 1000, { drift: 0, outwardOffset: offset })

      const recentDistance = Math.hypot(recent.x, recent.y)
      const actorDistance = Math.hypot(visual.position.x, visual.position.y)
      const orbToFile = Math.hypot(visual.position.x - recent.x, visual.position.y - recent.y)

      // Strictly farther out than the file (it stepped outward)...
      expect(actorDistance).toBeGreaterThan(recentDistance)
      // ...by exactly the short fixed offset, so the beam is short.
      expect(actorDistance).toBeCloseTo(recentDistance + offset, 5)
      expect(orbToFile).toBeCloseTo(offset, 5)
    })

    it('does NOT scale to the tree: the orb-to-file beam stays short however far out the work is', () => {
      // The bug it fixes: the old tree-scaled push flung the orb to the periphery (a
      // huge beam) when the file sat far from center. A fixed offset keeps the orb a
      // constant short step off its file at any distance from the origin.
      const offset = 60
      const nearCenter = { x: 80, y: 0 }
      const farOut = { x: 4_000, y: 0 }
      const near = makeActivity({ actor: 'agent-1', touched: [ nearCenter ], recent: nearCenter })
      const far = makeActivity({ actor: 'agent-1', touched: [ farOut ], recent: farOut })

      const nearVisual = actorVisualFor(near, 1000, { drift: 0, outwardOffset: offset })
      const farVisual = actorVisualFor(far, 1000, { drift: 0, outwardOffset: offset })

      const nearBeam = Math.hypot(nearVisual.position.x - nearCenter.x, nearVisual.position.y - nearCenter.y)
      const farBeam = Math.hypot(farVisual.position.x - farOut.x, farVisual.position.y - farOut.y)

      // Both beams are the same short length regardless of how far the file is from center.
      expect(nearBeam).toBeCloseTo(offset, 5)
      expect(farBeam).toBeCloseTo(offset, 5)
    })

    it('keeps the orb-to-file distance bounded and small (never flung to a huge global radius)', () => {
      // A spread-out cluster used to throw the orb out past its FARTHEST file (a long
      // beam). Now the orb hugs its RECENT file by the short offset no matter the spread.
      const recent = { x: 200, y: 0 }
      const spreadCluster = [ recent, { x: 1_500, y: 0 }, { x: 0, y: 1_500 }, { x: -1_500, y: 0 }]
      const activity = makeActivity({ actor: 'agent-1', touched: spreadCluster, recent })
      const offset = 60

      const visual = actorVisualFor(activity, 1000, { drift: 0, outwardOffset: offset })

      const orbToRecent = Math.hypot(visual.position.x - recent.x, visual.position.y - recent.y)
      // The orb sits just outside its recent file, NOT pushed out past the 1500-unit
      // farthest file. The beam is short, a small multiple of the offset, never huge.
      expect(orbToRecent).toBeLessThan(offset * 2)
    })

    it('steps farther out for a larger offset', () => {
      const recent = { x: 200, y: 200 }
      const activity = makeActivity({ actor: 'agent-1', touched: [ recent ], recent })

      const near = actorVisualFor(activity, 1000, { drift: 0, outwardOffset: 40 })
      const far = actorVisualFor(activity, 1000, { drift: 0, outwardOffset: 160 })

      const nearDistance = Math.hypot(near.position.x, near.position.y)
      const farDistance = Math.hypot(far.position.x, far.position.y)
      expect(farDistance).toBeCloseTo(nearDistance + 120, 5)
    })

    it('keeps the actor on the same outward ray as its anchor', () => {
      // The offset is purely radial, so the actor's direction from the origin matches
      // its anchor's direction (it just sits a short step farther along the same line).
      const recent = { x: 100, y: 50 }
      const activity = makeActivity({ actor: 'agent-1', touched: [ recent ], recent })
      const visual = actorVisualFor(activity, 1000, { drift: 0, outwardOffset: 70 })

      const anchorAngle = Math.atan2(50, 100)
      const actorAngle = Math.atan2(visual.position.y, visual.position.x)
      expect(actorAngle).toBeCloseTo(anchorAngle, 5)
    })

    it('still escapes the origin when the anchor is dead-center', () => {
      // A contributor whose anchor is the tree center has no outward ray; it must not
      // stay pinned at the origin. The hashed fallback direction steps it out by the
      // short offset deterministically.
      const activity = makeActivity({ actor: 'agent-1', touched: [{ x: 0, y: 0 }], recent: { x: 0, y: 0 }})
      const visual = actorVisualFor(activity, 1000, { drift: 0, outwardOffset: 90 })

      const distance = Math.hypot(visual.position.x, visual.position.y)
      expect(distance).toBeCloseTo(90, 5)
    })

    it('respects a custom origin the actor steps away from', () => {
      // The outward direction is measured from the supplied origin, not a hardcoded (0,0).
      const origin = { x: 500, y: 500 }
      const recent = { x: 600, y: 500 }
      const activity = makeActivity({ actor: 'agent-1', touched: [ recent ], recent })
      const visual = actorVisualFor(activity, 1000, { drift: 0, outwardOffset: 50, origin })

      // The recent file is 100 to the right of the origin; stepping 50 further out
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

    it('parks at its last centroid while lingering quiet, stepped just outside it', () => {
      // After the recency window clears the touched files, a lingering actor falls
      // back to its parked last-centroid (still stepped outward by the short offset), so
      // it stays floating just outside its last work rather than snapping to the origin.
      const quiet = makeActivity({ touched: [], recent: undefined, lastCentroid: { x: 300, y: 0 }})
      const visual = actorVisualFor(quiet, 1_000, { drift: 0, outwardOffset: 40, lingerMs: 60_000 })

      const distanceFromOrigin = Math.hypot(visual.position.x, visual.position.y)
      // Parked just outside its last centroid: the centroid radius (300) plus the offset.
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
