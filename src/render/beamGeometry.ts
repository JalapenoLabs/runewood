// Copyright © 2026 Jalapeno Labs

import type { Vec2 } from '../core/layout'

/**
 * The placement of a single beam sprite along the line from a source (the user) to a
 * target (the file): where to center it, how far to rotate it, and how long and wide
 * to stretch the baked beam-gradient texture across it. This is the pure geometry the
 * render layer turns into a tinted, additively-blended `Sprite` for Gource's glowing
 * laser; keeping it pure makes it unit-testable without pixi or a GPU.
 */
export type BeamPlacement = {
  /** The sprite center: the midpoint of the beam, so it stretches symmetrically along the line. */
  center: Vec2
  /** The beam's rotation, in radians, the angle of the line from source to target. */
  rotation: number
  /** The beam's length in layout units: the distance from source to target. */
  length: number
  /** The beam's perpendicular width in layout units, at its current lifetime width. */
  width: number
}

/**
 * Computes the {@link BeamPlacement} for a beam running from `source` to `target` at a
 * given perpendicular `width`. A `Sprite` of the beam texture is then centered, rotated,
 * and scaled by these so the gradient stretches along the line, brightest at the core
 * and soft at the ends, exactly like Gource's textured beam quad.
 *
 * Returns `null` for a degenerate zero-length beam (source == target): it has no
 * direction to orient the sprite, so the caller skips drawing it rather than placing a
 * point with an undefined angle.
 *
 * Pure: identical inputs always yield the identical placement, with no time, randomness,
 * or pixi state.
 */
export function beamPlacement(source: Vec2, target: Vec2, width: number): BeamPlacement | null {
  const directionX = target.x - source.x
  const directionY = target.y - source.y
  const length = Math.hypot(directionX, directionY)
  if (length === 0) {
    return null
  }

  return {
    center: {
      x: (source.x + target.x) / 2,
      y: (source.y + target.y) / 2,
    },
    rotation: Math.atan2(directionY, directionX),
    length,
    width,
  }
}
