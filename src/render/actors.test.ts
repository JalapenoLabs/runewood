// Copyright © 2026 Jalapeno Labs

import type { Vec2 } from '../core/layout'
import type { ActorUserOptions } from './actors'

// Core
import { describe, expect, it } from 'vitest'

import { colorForActor } from '../core/theme'
import { actorAlpha, ActorUser } from './actors'

/**
 * Drives a user's physics forward over many small fixed frames, applying the action
 * pull toward `targets` each frame, then returns the settled position. A fixed delta is
 * used so the run is deterministic. With no targets the user simply coasts to rest.
 */
function settle(user: ActorUser, targets: Vec2[], frames: number, deltaSeconds = 1 / 60): void {
  for (let frame = 0; frame < frames; frame++) {
    user.applyForceToActions(targets)
    user.step(deltaSeconds)
  }
}

describe('actorAlpha', () => {
  it('is fully present right up to the end of the idle window', () => {
    const lastActiveAt = 1_000
    expect(actorAlpha(lastActiveAt, lastActiveAt, 3_000, 1_000)).toBe(1)
    // One millisecond before the idle window closes: still full.
    expect(actorAlpha(lastActiveAt, lastActiveAt + 2_999, 3_000, 1_000)).toBe(1)
    expect(actorAlpha(lastActiveAt, lastActiveAt + 3_000, 3_000, 1_000)).toBe(1)
  })

  it('fades linearly from full to zero over the fade window once idle', () => {
    const lastActiveAt = 0
    const idleMs = 3_000
    const fadeMs = 1_000

    // Halfway through the fade (which begins only after the idle window): half present.
    expect(actorAlpha(lastActiveAt, idleMs + fadeMs / 2, idleMs, fadeMs)).toBeCloseTo(0.5, 5)
    // At the end of the fade: fully gone.
    expect(actorAlpha(lastActiveAt, idleMs + fadeMs, idleMs, fadeMs)).toBe(0)
  })

  it('clamps a long-idle actor to zero, never negative', () => {
    expect(actorAlpha(0, 100_000, 3_000, 1_000)).toBe(0)
  })

  it('honors a longer idle time (the agent-pause use case): no fade across a long pause', () => {
    // A live agent edits then pauses for ten seconds; with a long idle time it stays
    // fully present rather than fading after Gource's default three seconds.
    const lastActiveAt = 5_000
    expect(actorAlpha(lastActiveAt, lastActiveAt + 10_000, 60_000, 1_000)).toBe(1)
    // The default three-second idle WOULD have it long gone by then.
    expect(actorAlpha(lastActiveAt, lastActiveAt + 10_000, 3_000, 1_000)).toBe(0)
  })

  it('treats a future-dated activity as fully present rather than over-bright', () => {
    expect(actorAlpha(10_000, 5_000, 3_000, 1_000)).toBe(1)
  })

  it('is a pure function of its inputs (deterministic)', () => {
    const first = actorAlpha(0, 3_500, 3_000, 1_000)
    const second = actorAlpha(0, 3_500, 3_000, 1_000)
    expect(first).toBe(second)
  })
})

describe('ActorUser', () => {
  describe('accelerating toward and braking at its action target', () => {
    it('flies toward a file beyond the beam distance and ends up near it, not on it', () => {
      // The user starts far from its one file; under the action pull it flies in and,
      // after the physics settles, rests in the NEIGHBORHOOD of the file (a short beam)
      // rather than far away or stacked exactly on it. Gource's weak friction means it
      // overshoots and oscillates a little before settling, so the assertion is a bounded
      // "near, not on" rather than "stops dead at the brake radius".
      const file: Vec2 = { x: 1_000, y: 0 }
      const user = new ActorUser('agent-1', { x: 0, y: 0 }, { beamDist: 100, actionDist: 50 })

      settle(user, [ file ], 1_200)

      const distanceToFile = Math.hypot(user.position.x - file.x, user.position.y - file.y)
      // It arrived in the neighborhood of the file (within a couple beam distances), so
      // the orb-to-file beam is short...
      expect(distanceToFile).toBeLessThan(200)
      // ...but did NOT collapse onto the file's exact position (it brakes near it).
      expect(distanceToFile).toBeGreaterThan(0)
      // And it genuinely crossed most of the 1000-unit gap (it flew to its file).
      expect(user.position.x).toBeGreaterThan(800)
    })

    it('settles within the dead zone between the action and beam distances', () => {
      // The user comes to rest in the band [actionDist, beamDist] from its file: beyond
      // the brake radius but inside the pull radius, exactly Gource's resting band.
      const file: Vec2 = { x: 800, y: 0 }
      const beamDist = 100
      const actionDist = 50
      const user = new ActorUser('agent-1', { x: 0, y: 0 }, { beamDist, actionDist })

      settle(user, [ file ], 800)

      const distanceToFile = Math.hypot(user.position.x - file.x, user.position.y - file.y)
      // Comfortably inside the pull radius and outside (or at) the brake radius, so the
      // orb hugs its file with a short beam rather than sitting on it or far away.
      expect(distanceToFile).toBeLessThanOrEqual(beamDist + 1)
      expect(distanceToFile).toBeGreaterThan(actionDist - 30)
    })

    it('drives toward the AVERAGE of several action targets', () => {
      // Two files symmetric about x=500: the user should settle near their midpoint.
      const files: Vec2[] = [{ x: 500, y: 300 }, { x: 500, y: -300 }]
      const user = new ActorUser('agent-1', { x: 0, y: 0 })

      settle(user, files, 800)

      // Pulled toward the average (500, 0): out along x, and centered on y.
      expect(user.position.x).toBeGreaterThan(300)
      expect(user.position.y).toBeCloseTo(0, 0)
    })
  })

  describe('friction brings it to rest when the action ends', () => {
    it('coasts to a stop after its file is gone, moving less and less each frame', () => {
      // Give the user a strong pull to build up speed, then drop the action: friction
      // must bleed its momentum so each subsequent coasting frame moves it less.
      const user = new ActorUser('agent-1', { x: 0, y: 0 }, { friction: 1, maxUserSpeed: 500 })
      for (let frame = 0; frame < 5; frame++) {
        user.applyForceToActions([{ x: 5_000, y: 0 }])
        user.step(1 / 60)
      }

      // Now no action: it coasts. Measure the per-frame step; friction must make each
      // coasting frame move no more than the last (a monotonically decaying glide).
      let previous = user.position.x
      const firstStep = user.position.x
      let previousStep = Infinity
      for (let frame = 0; frame < 600; frame++) {
        user.step(1 / 60)
        const step = user.position.x - previous
        previous = user.position.x
        expect(step).toBeLessThanOrEqual(previousStep + 1e-9)
        previousStep = step
      }
      // It built up real momentum first (it actually traveled while coasting)...
      expect(user.position.x).toBeGreaterThan(firstStep)
      // ...and after long coasting the per-frame step has decayed to essentially nothing.
      expect(previousStep).toBeLessThan(0.01)
    })

    it('does not move at all with no action and no momentum (a fresh idle user)', () => {
      const user = new ActorUser('agent-1', { x: 200, y: 50 })
      const before = { ...user.position }
      for (let frame = 0; frame < 60; frame++) {
        user.applyForceToActions([])
        user.step(1 / 60)
      }
      expect(user.position).toEqual(before)
    })
  })

  describe('user-to-user separation within personal space', () => {
    it('pushes two coincident-ish users apart', () => {
      // Two users start very close (inside the personal space). The mutual repulsion
      // must drive them apart so their orbs do not stack.
      const personalSpaceDist = 100
      const first = new ActorUser('agent-a', { x: 0, y: 0 }, { personalSpaceDist })
      const second = new ActorUser('agent-b', { x: 10, y: 0 }, { personalSpaceDist })

      const startGap = Math.hypot(second.position.x - first.position.x, second.position.y - first.position.y)
      for (let frame = 0; frame < 200; frame++) {
        // Apply forces to both before stepping either (the scene's order).
        first.applyForceUser(second)
        second.applyForceUser(first)
        first.step(1 / 60)
        second.step(1 / 60)
      }
      const endGap = Math.hypot(second.position.x - first.position.x, second.position.y - first.position.y)

      // They separated, opening up toward the personal space.
      expect(endGap).toBeGreaterThan(startGap)
      expect(endGap).toBeGreaterThan(personalSpaceDist * 0.5)
    })

    it('separates perfectly coincident users deterministically (no random kick)', () => {
      function run(): { first: Vec2, second: Vec2 } {
        const personalSpaceDist = 80
        const first = new ActorUser('agent-a', { x: 100, y: 100 }, { personalSpaceDist })
        const second = new ActorUser('agent-b', { x: 100, y: 100 }, { personalSpaceDist })
        for (let frame = 0; frame < 50; frame++) {
          first.applyForceUser(second)
          second.applyForceUser(first)
          first.step(1 / 60)
          second.step(1 / 60)
        }
        return { first: { ...first.position }, second: { ...second.position }}
      }

      const a = run()
      const b = run()
      // No longer stacked...
      expect(Math.hypot(a.first.x - a.second.x, a.first.y - a.second.y)).toBeGreaterThan(0)
      // ...and identical run to run (deterministic, seek-safe; Gource kicks randomly).
      expect(a).toEqual(b)
    })

    it('does not separate when personal space is disabled (zero)', () => {
      const first = new ActorUser('agent-a', { x: 0, y: 0 }, { personalSpaceDist: 0 })
      const second = new ActorUser('agent-b', { x: 5, y: 0 }, { personalSpaceDist: 0 })
      for (let frame = 0; frame < 60; frame++) {
        first.applyForceUser(second)
        second.applyForceUser(first)
        first.step(1 / 60)
        second.step(1 / 60)
      }
      // Untouched: the repulsion never fired.
      expect(first.position).toEqual({ x: 0, y: 0 })
      expect(second.position).toEqual({ x: 5, y: 0 })
    })

    it('ignores a user separating from itself', () => {
      const user = new ActorUser('agent-a', { x: 0, y: 0 }, { personalSpaceDist: 100 })
      user.applyForceUser(user)
      user.step(1 / 60)
      expect(user.position).toEqual({ x: 0, y: 0 })
    })
  })

  describe('the max-speed clamp holds', () => {
    it('never moves more than max speed * dt in a single frame, however strong the pull', () => {
      // A huge pull would, unclamped, fling the user across the canvas in one frame. The
      // clamp caps the acceleration to the max speed, so one frame moves at most
      // maxSpeed * dt.
      const maxUserSpeed = 500
      const deltaSeconds = 1 / 60
      const user = new ActorUser('agent-1', { x: 0, y: 0 }, { maxUserSpeed })

      user.applyForceToActions([{ x: 1_000_000, y: 0 }])
      const before = { ...user.position }
      user.step(deltaSeconds)
      const moved = Math.hypot(user.position.x - before.x, user.position.y - before.y)

      expect(moved).toBeLessThanOrEqual(maxUserSpeed * deltaSeconds + 1e-6)
    })
  })

  describe('integration is deterministic and robust', () => {
    it('reproduces the exact same trajectory for the same inputs and fixed deltas', () => {
      function run(): Vec2 {
        const user = new ActorUser('agent-1', { x: 0, y: 0 })
        settle(user, [{ x: 700, y: 200 }], 300)
        return { ...user.position }
      }
      expect(run()).toEqual(run())
    })

    it('holds the position on a non-positive or non-finite frame delta (a paused frame)', () => {
      const user = new ActorUser('agent-1', { x: 30, y: 40 })
      user.applyForceToActions([{ x: 900, y: 0 }])
      const before = { ...user.position }
      user.step(0)
      user.step(-1)
      user.step(Number.NaN)
      expect(user.position).toEqual(before)
    })
  })

  describe('the visual', () => {
    it('reports the live position, the idle fade, the size, and the identity color', () => {
      const options: ActorUserOptions = { idleMs: 3_000, fadeMs: 1_000, size: 12 }
      const user = new ActorUser('agent-7', { x: 100, y: 0 }, options)

      const visualFresh = user.visualAt(1_000, 1_000)
      expect(visualFresh.position).toEqual({ x: 100, y: 0 })
      expect(visualFresh.alpha).toBe(1)
      expect(visualFresh.size).toBe(12)
      expect(visualFresh.color).toEqual(colorForActor('agent-7'))

      // Halfway through the fade once idle: half present.
      const visualFading = user.visualAt(1_000 + 3_000 + 500, 1_000)
      expect(visualFading.alpha).toBeCloseTo(0.5, 5)
    })
  })
})
