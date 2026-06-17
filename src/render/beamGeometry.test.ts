// Copyright © 2026 Jalapeno Labs

// Core
import { describe, expect, it } from 'vitest'

import { beamPlacement } from './beamGeometry'

describe('beamPlacement', () => {
  it('centers the beam on the midpoint of the source-to-target line', () => {
    const placement = beamPlacement({ x: 0, y: 0 }, { x: 100, y: 40 }, 8)
    expect(placement).not.toBeNull()
    expect(placement!.center).toEqual({ x: 50, y: 20 })
  })

  it('orients the beam along the source-to-target direction', () => {
    // A horizontal beam to the right has zero rotation.
    const right = beamPlacement({ x: 0, y: 0 }, { x: 100, y: 0 }, 8)
    expect(right!.rotation).toBeCloseTo(0, 6)

    // A beam straight down (screen y grows downward) points at +90 degrees.
    const down = beamPlacement({ x: 0, y: 0 }, { x: 0, y: 100 }, 8)
    expect(down!.rotation).toBeCloseTo(Math.PI / 2, 6)

    // A 45-degree diagonal points at +45 degrees.
    const diagonal = beamPlacement({ x: 0, y: 0 }, { x: 50, y: 50 }, 8)
    expect(diagonal!.rotation).toBeCloseTo(Math.PI / 4, 6)
  })

  it('reports the length as the source-to-target distance and width as given', () => {
    const placement = beamPlacement({ x: 10, y: 10 }, { x: 13, y: 14 }, 6)
    // A 3-4-5 triangle: the length is 5.
    expect(placement!.length).toBeCloseTo(5, 6)
    expect(placement!.width).toBe(6)
  })

  it('returns null for a degenerate zero-length beam (source == target)', () => {
    // No direction to orient a laser, so the caller skips drawing it.
    expect(beamPlacement({ x: 7, y: 7 }, { x: 7, y: 7 }, 8)).toBeNull()
  })

  it('is pure: identical inputs always yield the identical placement', () => {
    const first = beamPlacement({ x: 1, y: 2 }, { x: 9, y: 6 }, 5)
    const second = beamPlacement({ x: 1, y: 2 }, { x: 9, y: 6 }, 5)
    expect(first).toEqual(second)
  })
})
