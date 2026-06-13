// Copyright © 2026 Jalapeno Labs

import type { Vec2 } from './layout'

/**
 * The pure nearest-hit math behind the controller's click picking (issue #10).
 *
 * The controller owns the live {@link import('../render/camera').Camera} and the
 * live {@link import('./layout').SpringState}; on a pointer event it converts the
 * screen point to world space via the camera and asks this module which node (or
 * actor) the click landed on. Keeping the geometry here, time-free and
 * pixi-free, is what makes picking unit-testable without a canvas: the controller
 * only wires the pointer listener to {@link nearestWithinRadius}.
 *
 * "Nearest within a radius" rather than "the single closest" is deliberate: a
 * click in empty space should resolve to nothing, not snap to whatever distant
 * node happens to be least far away, so a host never deep-links to a file the
 * user did not actually click.
 */

/**
 * One candidate to hit-test against: a stable id (a node path or an actor id) and
 * its current world-space position (the live spring position for a node, the orb
 * centroid for an actor).
 */
export type PickCandidate = {
  /** Stable identifier returned when this candidate is the nearest hit. */
  id: string
  /** The candidate's world-space position, in the same space as the picked point. */
  position: Vec2
}

/**
 * Returns the id of the candidate nearest to `worldPoint`, or `null` when none
 * lie within `radius` of it. Distance is plain Euclidean distance in world
 * space, so the caller passes a radius already expressed in world units (a
 * screen-pixel hit slop divided by the camera zoom, typically).
 *
 * Ties (two candidates exactly equidistant) resolve to the first one
 * encountered; the caller decides candidate order, so a deterministic input
 * yields a deterministic hit.
 *
 * Pure: a function of its arguments alone, with no clock, randomness, or DOM, so
 * the whole picking path is exercised in node without a canvas.
 */
export function nearestWithinRadius(
  worldPoint: Vec2,
  candidates: Iterable<PickCandidate>,
  radius: number,
): string | null {
  if (!Number.isFinite(radius) || radius < 0) {
    console.debug('runewood: ignoring pick with invalid radius, returning no hit', radius)
    return null
  }

  // Compare squared distances to avoid a `Math.hypot` per candidate; the radius
  // is squared once so the comparison stays exact.
  const radiusSquared = radius * radius
  let nearestId: string | null = null
  let nearestDistanceSquared = Number.POSITIVE_INFINITY

  for (const candidate of candidates) {
    const deltaX = candidate.position.x - worldPoint.x
    const deltaY = candidate.position.y - worldPoint.y
    const distanceSquared = deltaX * deltaX + deltaY * deltaY

    if (distanceSquared <= radiusSquared && distanceSquared < nearestDistanceSquared) {
      nearestDistanceSquared = distanceSquared
      nearestId = candidate.id
    }
  }

  return nearestId
}
