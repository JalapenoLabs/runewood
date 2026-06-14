// Copyright © 2026 Jalapeno Labs

// Core
import { describe, expect, it } from 'vitest'

import { stepActorGlide, rampOpacity, swoopStartFor, ActorMotion } from './actorMotion'

describe('stepActorGlide', () => {
  it('glides toward the target and converges over repeated steps', () => {
    const target = { x: 100, y: 0 }
    let position = { x: 0, y: 0 }

    // Step the glide many small frames; the orb must close in on the target.
    let previousDistance = Math.hypot(position.x - target.x, position.y - target.y)
    for (let frame = 0; frame < 60; frame++) {
      position = stepActorGlide(position, target, 16, { glideRatePerSecond: 6 })
      const distance = Math.hypot(position.x - target.x, position.y - target.y)
      // Strictly monotone approach: every frame is closer than the last (ease-out).
      expect(distance).toBeLessThan(previousDistance)
      previousDistance = distance
    }
    // After a second of gliding it has essentially arrived.
    expect(previousDistance).toBeLessThan(1)
  })

  it('has an ease-out shape: it decelerates as it nears the target', () => {
    const target = { x: 100, y: 0 }
    // One big frame covers most of the gap; the next equal frame covers much less,
    // because the remaining distance (and thus the step) has shrunk.
    const afterFirst = stepActorGlide({ x: 0, y: 0 }, target, 200, { glideRatePerSecond: 6 })
    const afterSecond = stepActorGlide(afterFirst, target, 200, { glideRatePerSecond: 6 })

    const firstStep = afterFirst.x - 0
    const secondStep = afterSecond.x - afterFirst.x
    expect(firstStep).toBeGreaterThan(0)
    expect(secondStep).toBeGreaterThan(0)
    // Decelerating: the second equal-duration step moves the orb less than the first.
    expect(secondStep).toBeLessThan(firstStep)
  })

  it('is framerate-independent: one big step ~ matches several small steps', () => {
    const target = { x: 100, y: 0 }
    const options = { glideRatePerSecond: 6 }

    const oneBig = stepActorGlide({ x: 0, y: 0 }, target, 100, options)

    let small = { x: 0, y: 0 }
    for (let frame = 0; frame < 10; frame++) {
      small = stepActorGlide(small, target, 10, options)
    }

    // Exponential smoothing composes, so 10x10ms lands at the same place as 1x100ms.
    expect(small.x).toBeCloseTo(oneBig.x, 5)
    expect(small.y).toBeCloseTo(oneBig.y, 5)
  })

  it('holds the position exactly on a non-positive or non-finite frame delta', () => {
    const target = { x: 100, y: 0 }
    const current = { x: 30, y: 40 }
    expect(stepActorGlide(current, target, 0)).toEqual(current)
    expect(stepActorGlide(current, target, -16)).toEqual(current)
    expect(stepActorGlide(current, target, Number.NaN)).toEqual(current)
  })
})

describe('rampOpacity', () => {
  it('ramps linearly from 0 to 1 over the ramp window', () => {
    const rampMs = 250
    expect(rampOpacity(0, { rampMs })).toBe(0)
    expect(rampOpacity(rampMs / 2, { rampMs })).toBeCloseTo(0.5, 5)
    expect(rampOpacity(rampMs, { rampMs })).toBe(1)
  })

  it('clamps to [0, 1] outside the window', () => {
    const rampMs = 250
    expect(rampOpacity(-100, { rampMs })).toBe(0)
    expect(rampOpacity(rampMs * 10, { rampMs })).toBe(1)
  })

  it('is instant (fully opaque) for a zero-or-negative ramp window', () => {
    expect(rampOpacity(0, { rampMs: 0 })).toBe(1)
  })
})

describe('swoopStartFor', () => {
  it('starts the orb out past the target along its outward ray', () => {
    // The target sits out to the right of the origin; the swoop start must be FURTHER
    // out along that same ray, so the orb flies inward to rest.
    const target = { x: 100, y: 0 }
    const start = swoopStartFor(target, { swoopDistance: 200 })

    expect(start.x).toBeCloseTo(300, 5)
    expect(start.y).toBeCloseTo(0, 5)
    // Strictly farther from the origin than the target.
    expect(Math.hypot(start.x, start.y)).toBeGreaterThan(Math.hypot(target.x, target.y))
  })

  it('keeps the swoop start on the same outward ray as the target', () => {
    const target = { x: 60, y: 80 }
    const start = swoopStartFor(target, { swoopDistance: 100 })

    const targetAngle = Math.atan2(target.y, target.x)
    const startAngle = Math.atan2(start.y, start.x)
    expect(startAngle).toBeCloseTo(targetAngle, 5)
    // Exactly the swoop distance beyond the target along the ray.
    const beyond = Math.hypot(start.x, start.y) - Math.hypot(target.x, target.y)
    expect(beyond).toBeCloseTo(100, 5)
  })

  it('swoops in from a deterministic fallback ray when the target is the origin', () => {
    const start = swoopStartFor({ x: 0, y: 0 }, { swoopDistance: 100 })
    // No outward ray at the origin: it still starts the full swoop distance away.
    expect(Math.hypot(start.x, start.y)).toBeCloseTo(100, 5)
  })

  it('respects a custom origin the swoop comes in from', () => {
    const origin = { x: 500, y: 500 }
    const target = { x: 600, y: 500 }
    const start = swoopStartFor(target, { swoopDistance: 50, origin })
    // 100 to the right of the origin plus 50 further out = 150 right of the origin.
    expect(start.x).toBeCloseTo(650, 5)
    expect(start.y).toBeCloseTo(500, 5)
  })
})

describe('ActorMotion', () => {
  it('starts offset outward from the target on appearance, then glides in to rest', () => {
    const target = { x: 100, y: 0 }
    const motion = new ActorMotion(target, { swoopDistance: 200, glideRatePerSecond: 6 })

    // Born out past the target (swoop start), not on it.
    const start = motion.drawnPosition
    expect(start.x).toBeCloseTo(300, 5)
    expect(Math.hypot(start.x - target.x, start.y - target.y)).toBeCloseTo(200, 5)

    // After gliding for a while it has essentially arrived at the target.
    for (let frame = 0; frame < 90; frame++) {
      motion.advance(target, 16)
    }
    const arrived = motion.drawnPosition
    expect(Math.hypot(arrived.x - target.x, arrived.y - target.y)).toBeLessThan(1)
  })

  it('ramps opacity from 0 to 1 over the ramp window on appearance', () => {
    const target = { x: 100, y: 0 }
    const motion = new ActorMotion(target, { rampMs: 200 })

    // The very first frame's ramp is still near 0 (just-appeared), then it climbs and
    // saturates at 1 once the window has elapsed.
    const firstRamp = motion.advance(target, 1)
    expect(firstRamp).toBeGreaterThanOrEqual(0)
    expect(firstRamp).toBeLessThan(0.1)

    // Advance past the ramp window: fully opaque.
    motion.advance(target, 100)
    const rampedIn = motion.advance(target, 200)
    expect(rampedIn).toBe(1)
  })

  it('glides from the current drawn position to a new target (a move to a recent file)', () => {
    const firstTarget = { x: 100, y: 0 }
    const motion = new ActorMotion(firstTarget, { swoopDistance: 50, glideRatePerSecond: 8 })

    // Settle onto the first target.
    for (let frame = 0; frame < 90; frame++) {
      motion.advance(firstTarget, 16)
    }
    const settled = motion.drawnPosition
    expect(Math.hypot(settled.x - firstTarget.x, settled.y - firstTarget.y)).toBeLessThan(1)

    // Now the actor's recent work moved: glide toward the new target from where it is,
    // not by teleporting. Midway it sits between the two, then converges on the new one.
    const newTarget = { x: 100, y: 400 }
    motion.advance(newTarget, 16)
    const midGlide = motion.drawnPosition
    expect(midGlide.y).toBeGreaterThan(settled.y)
    expect(midGlide.y).toBeLessThan(newTarget.y)

    for (let frame = 0; frame < 120; frame++) {
      motion.advance(newTarget, 16)
    }
    const arrived = motion.drawnPosition
    expect(Math.hypot(arrived.x - newTarget.x, arrived.y - newTarget.y)).toBeLessThan(1)
  })

  it('restart re-swoops from outside the target and resets the opacity ramp', () => {
    const target = { x: 100, y: 0 }
    const motion = new ActorMotion(target, { swoopDistance: 200, rampMs: 200, glideRatePerSecond: 6 })

    // Glide in and fully ramp opacity.
    for (let frame = 0; frame < 90; frame++) {
      motion.advance(target, 16)
    }
    expect(Math.hypot(motion.drawnPosition.x - target.x, motion.drawnPosition.y - target.y)).toBeLessThan(1)

    // A reappearance: restart puts it back out in the open space, ramp reset.
    motion.restart(target)
    const reborn = motion.drawnPosition
    expect(Math.hypot(reborn.x - target.x, reborn.y - target.y)).toBeCloseTo(200, 5)
    const firstRamp = motion.advance(target, 1)
    expect(firstRamp).toBeLessThan(0.1)
  })

  it('holds the orb still on a non-positive frame delta (a paused frame)', () => {
    const target = { x: 100, y: 0 }
    const motion = new ActorMotion(target, { swoopDistance: 200 })
    const before = motion.drawnPosition

    motion.advance(target, 0)
    expect(motion.drawnPosition).toEqual(before)
  })
})
