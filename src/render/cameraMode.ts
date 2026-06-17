// Copyright © 2026 Jalapeno Labs

import type { Vec2 } from '../core/layout'
import type { WorldBounds } from './camera'

/**
 * How the camera chooses what to frame each tick. Exposed both as a construction
 * option ({@link import('../runewood').RunewoodOptions.cameraMode}) and at runtime
 * via `setCameraMode`, and reflected on `getState().cameraMode` so a host overlay
 * can show which mode is live.
 *
 * - `overview`: ease to frame the bounds of the WHOLE active tree (fit
 *   everything). Good for a wall display that wants the entire forest in view.
 * - `follow`: the Gource-style camera. Ease to frame only the *recently active*
 *   region at a closer zoom, and travel as activity moves across the forest. The
 *   target region is derived by {@link recentActivityBounds}.
 * - `manual`: user-controlled. The drag-to-pan / wheel-to-zoom handlers switch the
 *   mode to this automatically so the chosen view sticks; selecting `overview` or
 *   `follow` re-engages auto control.
 */
export type CameraMode = 'overview' | 'follow' | 'manual'

/** The two modes under which the camera auto-frames; `manual` opts out of framing. */
export const AUTO_CAMERA_MODES = [ 'overview', 'follow' ] as const

/** Whether a mode drives automatic framing (vs. leaving the camera under user control). */
export function isAutoCameraMode(mode: CameraMode): boolean {
  return mode === 'overview' || mode === 'follow'
}

/**
 * One node's contribution to the follow-mode framing: its drawn world position and
 * when it was last touched by an event. The controller resolves these from the
 * live spring positions and the folded tree's `lastTouchedAt`; keeping the input a
 * plain list of samples (rather than the tree + springs themselves) is what makes
 * {@link recentActivityBounds} a pure, trivially-testable function.
 */
export type RecentNodeSample = {
  /** The node's drawn world position. */
  position: Vec2
  /** Epoch ms of the node's most recent event, or `null` if it has never been touched. */
  lastTouchedAt: number | null
}

/**
 * One actor's contribution to the follow-mode framing: where it is currently
 * working and when it was last active. Active actors are always included (their
 * orb is on screen), so the camera keeps the worker in frame even if the single
 * file it just touched has already aged out of the node window.
 */
export type RecentActorSample = {
  /** The actor's current world position (the centroid of the files it is touching). */
  position: Vec2
  /** Epoch ms of the actor's most recent event. */
  lastActiveAt: number
}

/** Inputs to {@link recentActivityBounds}. */
export type RecentActivityBoundsOptions = {
  /** The current playhead time in epoch ms; recency is measured back from here. */
  playhead: number
  /**
   * How far back from `playhead` (in ms) a node / actor counts as "recently
   * active". Anything older is excluded from the framed region so the camera
   * tracks where work is happening *now*, not the whole history.
   */
  windowMs: number
  /** World-space padding added on every side of the recent region, so glowing nodes near the edge are not clipped. */
  padding: number
  /**
   * The bounds to return when nothing is recently active. The controller passes
   * the last framing here so the camera gently holds its current view instead of
   * snapping back to the origin during a quiet stretch.
   */
  fallback: WorldBounds
}

/**
 * Computes the world bounds the follow camera should frame: the axis-aligned box
 * enclosing every node touched within the recency window plus every actor active
 * within it, padded. This is the Gource-style "frame where commits are happening
 * now" region, and it is a pure function of its inputs so it can be unit-tested in
 * isolation and the live easing stays a thin wrapper around it.
 *
 * Recency is `playhead - lastTouchedAt <= windowMs` (and likewise for actors), so
 * an event exactly at the window edge is still in, and a future-dated sample (a
 * node touched at the playhead) is always in. When nothing qualifies the `fallback`
 * is returned unchanged, which lets the caller hold its last framing rather than
 * collapse to a point.
 */
export function recentActivityBounds(
  nodes: RecentNodeSample[],
  actors: RecentActorSample[],
  options: RecentActivityBoundsOptions,
): WorldBounds {
  const { playhead, windowMs, padding, fallback } = options

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let included = 0

  for (const node of nodes) {
    if (node.lastTouchedAt === null || playhead - node.lastTouchedAt > windowMs) {
      continue
    }
    minX = Math.min(minX, node.position.x)
    minY = Math.min(minY, node.position.y)
    maxX = Math.max(maxX, node.position.x)
    maxY = Math.max(maxY, node.position.y)
    included += 1
  }

  for (const actor of actors) {
    if (playhead - actor.lastActiveAt > windowMs) {
      continue
    }
    minX = Math.min(minX, actor.position.x)
    minY = Math.min(minY, actor.position.y)
    maxX = Math.max(maxX, actor.position.x)
    maxY = Math.max(maxY, actor.position.y)
    included += 1
  }

  // Nothing recent: hold the caller's last framing rather than snap to the origin.
  if (included === 0) {
    return fallback
  }

  return {
    min: { x: minX - padding, y: minY - padding },
    max: { x: maxX + padding, y: maxY + padding },
  }
}

/** Inputs to {@link followActorBounds}. */
export type FollowActorBoundsOptions = {
  /**
   * The followed actor's live world position (its orb), or `null` when the actor
   * no longer exists (faded out / gone). A `null` position is the auto-release
   * signal: the function returns `null` so the caller drops the follow and falls
   * back to its current camera mode.
   */
  actorPosition: Vec2 | null
  /**
   * The live world positions of the files the actor is currently touching, framed
   * alongside the actor so its work stays on screen rather than only its orb. May
   * be empty (the actor is between files), in which case only the actor + the
   * minimum half-extent define the box.
   */
  touchedPositions: Vec2[]
  /**
   * The minimum half-width / half-height (world units) the framed box is grown to
   * around the actor, so a lone actor (or an actor and a single nearby file) is
   * framed at a steady, readable follow zoom instead of collapsing to a point and
   * slamming to the max zoom. The Gource "lock onto a user" close-up distance.
   */
  minHalfExtent: number
  /** World-space padding added on every side of the framed region. */
  padding: number
}

/**
 * Computes the world bounds the camera should frame while LOCKED onto a single
 * followed actor (the Gource click-to-follow), or `null` when the actor is gone.
 *
 * The box encloses the actor's orb plus every file it is currently touching, then
 * is grown to at least `minHalfExtent` on each side around the actor so a lone
 * actor is framed at a stable close-up follow zoom rather than collapsing to a
 * point. It is padded like the other framing functions. A `null` `actorPosition`
 * means the actor no longer exists, and the function returns `null` so the caller
 * auto-releases the follow and reverts to its current camera mode.
 *
 * Pure and I/O-free (no clock, no DOM): given the same positions it always yields
 * the same box, so it is unit-tested in isolation and the live camera easing stays
 * a thin wrapper that feeds it this frame's positions and eases toward the result.
 */
export function followActorBounds(options: FollowActorBoundsOptions): WorldBounds | null {
  const { actorPosition, touchedPositions, minHalfExtent, padding } = options

  // The actor is gone (faded out): signal the caller to release the follow.
  if (actorPosition === null) {
    return null
  }

  // Start the box at the actor's orb, then stretch it to include every file the
  // actor is touching this frame so its live work is framed alongside it.
  let minX = actorPosition.x
  let minY = actorPosition.y
  let maxX = actorPosition.x
  let maxY = actorPosition.y
  for (const position of touchedPositions) {
    minX = Math.min(minX, position.x)
    minY = Math.min(minY, position.y)
    maxX = Math.max(maxX, position.x)
    maxY = Math.max(maxY, position.y)
  }

  // Grow the box to at least the minimum half-extent AROUND THE ACTOR on each
  // side, so the followed actor stays centered at a steady close-up zoom even when
  // it is touching nothing (or only a file right beside it). Without this floor a
  // lone actor would frame a zero-area box and snap to the tightest zoom.
  minX = Math.min(minX, actorPosition.x - minHalfExtent)
  minY = Math.min(minY, actorPosition.y - minHalfExtent)
  maxX = Math.max(maxX, actorPosition.x + minHalfExtent)
  maxY = Math.max(maxY, actorPosition.y + minHalfExtent)

  return {
    min: { x: minX - padding, y: minY - padding },
    max: { x: maxX + padding, y: maxY + padding },
  }
}
