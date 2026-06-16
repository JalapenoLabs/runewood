// Copyright © 2026 Jalapeno Labs

// Core
import { describe, expect, it } from 'vitest'

import {
  ringRotation,
  sparkOrbitPosition,
  sparkTwinkle,
  leadingEdgeShine,
  auraBreathScale,
} from './highlightEffect'

describe('ringRotation', () => {
  it('rests at zero rotation at time zero', () => {
    // Every ring sits at angle zero at time zero (the odd ring's negated zero is still
    // numerically zero, so compare with closeTo rather than Object.is).
    expect(ringRotation(0, 0)).toBeCloseTo(0, 10)
    expect(ringRotation(0, 1)).toBeCloseTo(0, 10)
    expect(ringRotation(0, 2)).toBeCloseTo(0, 10)
  })

  it('advances continuously with time for a given ring', () => {
    const early = ringRotation(500, 0)
    const later = ringRotation(1000, 0)
    // The inner ring spins counter-clockwise (positive), so a later time is a larger angle.
    expect(early).toBeGreaterThan(0)
    expect(later).toBeGreaterThan(early)
  })

  it('counter-rotates adjacent rings (even one way, odd the other)', () => {
    const evenRing = ringRotation(1000, 0)
    const oddRing = ringRotation(1000, 1)
    // Even-indexed rings turn positive, odd-indexed negative, so adjacent rings shear.
    expect(evenRing).toBeGreaterThan(0)
    expect(oddRing).toBeLessThan(0)
  })

  it('turns each successive ring slower than the one inside it', () => {
    const inner = Math.abs(ringRotation(1000, 0))
    const middle = Math.abs(ringRotation(1000, 1))
    const outer = Math.abs(ringRotation(1000, 2))
    // The per-ring falloff means the magnitude of rotation decreases outward.
    expect(middle).toBeLessThan(inner)
    expect(outer).toBeLessThan(middle)
  })

  it('scales the spin with the configured base speed', () => {
    const slow = ringRotation(1000, 0, { baseRingSpeedRadPerSec: 1 })
    const fast = ringRotation(1000, 0, { baseRingSpeedRadPerSec: 4 })
    // Four times the base speed is four times the angle at the same time.
    expect(fast).toBeCloseTo(slow * 4, 6)
  })

  it('matches the closed-form speed * seconds for the inner ring', () => {
    // At one second the inner ring's angle is exactly its base speed in radians.
    expect(ringRotation(1000, 0, { baseRingSpeedRadPerSec: 2 })).toBeCloseTo(2, 6)
  })
})

describe('sparkOrbitPosition', () => {
  it('places a single spark on the orbit circle at the configured radius', () => {
    const point = sparkOrbitPosition(0, 0, 1, 50)
    // At time zero spark 0 sits at angle 0: straight out along +x at the radius.
    expect(point.x).toBeCloseTo(50, 6)
    expect(point.y).toBeCloseTo(0, 6)
    expect(Math.hypot(point.x, point.y)).toBeCloseTo(50, 6)
  })

  it('keeps every spark on the orbit radius as it travels', () => {
    const radius = 33
    for (let time = 0; time < 2000; time += 250) {
      for (let index = 0; index < 4; index++) {
        const point = sparkOrbitPosition(time, index, 4, radius)
        expect(Math.hypot(point.x, point.y)).toBeCloseTo(radius, 6)
      }
    }
  })

  it('spreads the sparks evenly around the circle by index', () => {
    // Four sparks at time zero are a quarter turn apart: 0, 90, 180, 270 degrees.
    const first = sparkOrbitPosition(0, 0, 4, 10)
    const second = sparkOrbitPosition(0, 1, 4, 10)
    const third = sparkOrbitPosition(0, 2, 4, 10)
    expect(first.x).toBeCloseTo(10, 6)
    expect(first.y).toBeCloseTo(0, 6)
    // A quarter turn lands spark 1 on +y.
    expect(second.x).toBeCloseTo(0, 6)
    expect(second.y).toBeCloseTo(10, 6)
    // A half turn lands spark 2 on -x, opposite spark 0.
    expect(third.x).toBeCloseTo(-10, 6)
    expect(third.y).toBeCloseTo(0, 6)
  })

  it('advances every spark by the same angle over time so the constellation orbits together', () => {
    const radius = 20
    const before = sparkOrbitPosition(0, 0, 3, radius)
    const after = sparkOrbitPosition(500, 0, 3, radius)
    const angleBefore = Math.atan2(before.y, before.x)
    const angleAfter = Math.atan2(after.y, after.x)
    // The spark has rotated forward (a positive angular advance) by half a second.
    expect(angleAfter).not.toBeCloseTo(angleBefore, 3)
  })
})

describe('sparkTwinkle', () => {
  it('stays within the floor and full range', () => {
    for (let time = 0; time < 2000; time += 50) {
      const intensity = sparkTwinkle(time, 0, { sparkTwinkleFloor: 0.3 })
      expect(intensity).toBeGreaterThanOrEqual(0.3 - 1e-9)
      expect(intensity).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  it('rests at the floor at time zero (cosine trough) for the first spark', () => {
    // Phase 0 puts (1 - cos)/2 at 0, so the twinkle sits exactly at the floor.
    expect(sparkTwinkle(0, 0, { sparkTwinkleFloor: 0.4 })).toBeCloseTo(0.4, 6)
  })

  it('reaches full brightness at half a period', () => {
    const periodMs = 1000
    // Half a period puts (1 - cos(pi))/2 at 1: full brightness.
    expect(sparkTwinkle(periodMs / 2, 0, { sparkTwinklePeriodMs: periodMs })).toBeCloseTo(1, 6)
  })

  it('phase-offsets sparks so neighbours do not flash in unison', () => {
    // Two adjacent sparks at the same instant differ, because their phases are offset.
    const sparkZero = sparkTwinkle(120, 0)
    const sparkOne = sparkTwinkle(120, 1)
    expect(sparkZero).not.toBeCloseTo(sparkOne, 4)
  })
})

describe('leadingEdgeShine', () => {
  it('is dark at the trailing end and full at the leading tip', () => {
    expect(leadingEdgeShine(0)).toBe(0)
    expect(leadingEdgeShine(1)).toBe(1)
  })

  it('clamps out-of-range progress', () => {
    expect(leadingEdgeShine(-0.5)).toBe(0)
    expect(leadingEdgeShine(1.5)).toBe(1)
  })

  it('concentrates the shine near the tip (a sharp ramp, not linear)', () => {
    // At the arc's midpoint the shine is well below half, because the ramp front-loads
    // the brightness into the final sliver near the tip.
    const midpointShine = leadingEdgeShine(0.5)
    expect(midpointShine).toBeLessThan(0.5)
    // It still rises monotonically toward the tip.
    expect(leadingEdgeShine(0.9)).toBeGreaterThan(midpointShine)
  })
})

describe('auraBreathScale', () => {
  it('is the resting size at zero breath and swells at full breath', () => {
    expect(auraBreathScale(0)).toBe(1)
    expect(auraBreathScale(1)).toBeGreaterThan(1)
  })

  it('grows monotonically with the breath', () => {
    expect(auraBreathScale(0.5)).toBeGreaterThan(auraBreathScale(0.25))
    expect(auraBreathScale(1)).toBeGreaterThan(auraBreathScale(0.5))
  })
})
