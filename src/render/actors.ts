// Copyright © 2026 Jalapeno Labs

import type { Vec2 } from '../core/layout'
import type { Hsl } from '../core/theme'

import { colorForActor } from '../core/theme'

/**
 * The pure placement model for actor sprites: the orbs that hover near the files
 * an actor is working on and fade in and out with its activity. It mirrors the
 * node/edge visual modules ({@link import('./nodeVisual')}, {@link import('./edgeVisual')}):
 * it decides *what* an actor looks like (position, opacity, color) from plain
 * inputs, and a backend draws it. Nothing here touches pixi, the DOM, the clock,
 * or randomness.
 *
 * An actor's position anchors on its *most recent* work, then is pushed radially
 * *outward* from the world origin (the tree center) so the actor floats just
 * outside the canopy near where it is contributing rather than sitting buried in
 * the middle of the forest. This is the Gource-style placement the user asked for:
 * contributors orbit the outside of the tree by their current work, not the
 * center.
 *
 * Anchoring on recent work (not the all-time centroid) is the fix for "contributors
 * float in the middle": a contributor that touches files spread across the tree has
 * a centroid that averages back to the tree center, so the old centroid anchor sat
 * it dead-center no matter how far out it was actually working. We instead blend the
 * touched-file positions with a strong bias toward the latest touch (see
 * {@link RECENCY_WEIGHT}), so the orb rides out to the leaf the actor is editing now.
 *
 * The outward push is then scaled to the *tree*, not a tiny fixed offset: the actor
 * is pushed to just past the radius of its touched cluster from the origin (plus a
 * margin), so it visibly clears the node cluster regardless of how large the tree
 * has grown. A small deterministic drift on top keeps two actors on the same file
 * from stacking exactly. Its fade rises while it is active and decays after its last
 * activity, so an actor that goes quiet dissolves rather than hanging on the canvas.
 * Every value is a pure function of the supplied activity and playhead `now`, so a
 * rewound timeline repaints every actor identically.
 */

/**
 * The live activity of one actor at a moment in time: where it is touching and
 * when it last acted. The controller assembles this from the active event window
 * (the same window that drives the beams), so the actor model never reads the
 * event log itself.
 */
export type ActorActivity = {
  /** Stable actor id; drives the color and the deterministic drift. */
  actor: string
  /**
   * Layout-space positions of the files this actor is currently touching, within
   * the controller's recency window. Empty when the actor has gone quiet but is
   * still fading out; its position then holds at its last known centroid.
   */
  touched: Vec2[]
  /**
   * Layout-space position of the actor's *most-recently-touched* file: the file it
   * is working on right now. The anchor is biased strongly toward this so the orb
   * rides out to where the work currently is, rather than the centroid of every
   * file the actor has touched (which averages to the tree center for spread-out
   * work). Omit when the actor has touched nothing this window (it just went quiet
   * and is fading); the anchor then falls back to the centroid / last-centroid.
   */
  recent?: Vec2
  /** Epoch ms of the actor's most recent activity, for the inactivity fade. */
  lastActiveAt: number
  /**
   * The centroid the actor should fall back to while `touched` is empty (it just
   * went quiet). Lets the controller keep an actor parked where it last worked as
   * it fades, instead of snapping it to the origin. Optional: omit for a brand-new
   * or never-active actor.
   */
  lastCentroid?: Vec2
}

/**
 * The pure visual description of an actor, ready for a backend to draw: a
 * world-space `position`, a `0..1` `alpha` (presence, driven by activity), a draw
 * `size` in layout units, and the actor's identity `color`. Library-free, exactly
 * like {@link import('./nodeVisual').NodeVisual}.
 */
export type ActorVisual = {
  /** Layout-space position: the touched-file centroid plus a gentle hashed drift. */
  position: Vec2
  /** Presence opacity, `0..1`. Full while active, decaying after the last activity. */
  alpha: number
  /** Draw size in layout units. */
  size: number
  color: Hsl
}

/** Tuning for {@link actorVisualFor}. Every field has a default. */
export type ActorVisualOptions = {
  /**
   * How long after an actor's last activity its sprite takes to fade from full to
   * invisible, in milliseconds. Measured from `lastActiveAt` against `now`.
   */
  fadeMs?: number
  /** Draw size of an actor orb, in layout units. */
  size?: number
  /**
   * Peak magnitude of the per-actor deterministic drift off the raw centroid, in
   * layout units. Hashed from the actor id (never randomness) so the same actor
   * always sits at the same offset and two actors on one file separate cleanly.
   */
  drift?: number
  /**
   * The margin, in layout units, the actor floats *past* the outer radius of its
   * touched cluster, measured from the world origin. The push is scaled to the
   * tree: the actor lands at `max(anchorRadius, farthestTouchedRadius) + margin`
   * from the origin along its anchor's outward ray, so it visibly clears the node
   * cluster regardless of how large the tree has grown (a tiny fixed offset was
   * the bug: it was swallowed by a big tree, leaving the actor buried). An actor
   * working dead-center (anchor at the origin and no touched files) is pushed by
   * its own drift direction instead, so it still escapes the middle. `0` lets the
   * actor sit exactly on the cluster's outer edge with no extra margin.
   */
  outwardMargin?: number
  /**
   * The world origin the outward push is measured from: the tree center the actor
   * is pushed away from. Defaults to the layout origin `{ x: 0, y: 0 }`, which is
   * where {@link import('../core/layout').computeTargets} centers the forest.
   */
  origin?: Vec2
}

const DEFAULT_FADE_MS = 3_000
const DEFAULT_SIZE = 10
const DEFAULT_DRIFT = 14

/**
 * How far, in layout units, an actor floats *past* the outer radius of its touched
 * cluster by default. This is a margin on top of the tree-scaled push (the actor is
 * floated to just beyond the farthest file it is touching, then this much further),
 * so it sits clearly outside the canopy at any tree size. Sized comfortably larger
 * than a node's hot radius so the orb reads as hovering outside the work rather than
 * on top of it. A judgment call worth tuning to taste.
 */
const DEFAULT_OUTWARD_MARGIN = 80

/**
 * How heavily the anchor favors the actor's most-recent touch over the centroid of
 * everything it is touching, `0..1`. At `1` the anchor is purely the latest file; at
 * `0` it is the plain centroid (the old, buried-in-the-middle behavior). High by
 * design: the whole point is to ride out to where the work *is now*, while the small
 * centroid share keeps the orb from snapping hard between rapid touches. A judgment
 * call worth tuning to taste.
 */
const RECENCY_WEIGHT = 0.8

/**
 * Computes the full visual of an actor at playhead time `now`. Pure and
 * deterministic: it reads only the activity, the time, and the options, never
 * `Date.now()` or randomness.
 *
 * The mapping:
 * - **position** anchors on the actor's most-recent touch (blended with the
 *   touched-files centroid, biased toward the latest file by {@link RECENCY_WEIGHT}),
 *   or `lastCentroid` while the actor is quiet, or the origin as a last resort. That
 *   anchor is then pushed radially *outward* from the world origin to just past the
 *   outer radius of its touched cluster plus `outwardMargin`, so the actor floats
 *   clearly outside the canopy near its current work at any tree size, and finally
 *   nudged by a small per-actor drift hashed from the actor id so co-located actors
 *   don't overlap.
 * - **alpha** is full at the instant of activity and decays linearly to 0 over
 *   `fadeMs` since `lastActiveAt`, so an actor that stops working fades out.
 * - **size** and **color** are constant per actor (the orb size and the actor's
 *   identity hue); the renderer can scale the glow by alpha.
 */
export function actorVisualFor(activity: ActorActivity, now: number, options: ActorVisualOptions = {}): ActorVisual {
  const fadeMs = options.fadeMs ?? DEFAULT_FADE_MS
  const size = options.size ?? DEFAULT_SIZE
  const drift = options.drift ?? DEFAULT_DRIFT
  const outwardMargin = options.outwardMargin ?? DEFAULT_OUTWARD_MARGIN
  const origin = options.origin ?? { x: 0, y: 0 }

  // Anchor on where the actor is working *now*: the most-recent file, blended only
  // lightly with the centroid of everything it is touching. This is the fix for the
  // orb sitting dead-center: a spread-out contributor's centroid averages back to the
  // tree center, but its latest touch is out at a leaf, so the recency-biased anchor
  // rides out there with the work.
  const anchor = anchorOf(activity)
  const pushed = pushPastCluster(anchor, activity.touched, origin, outwardMargin, activity.actor)
  const driftOffset = actorDrift(activity.actor, drift)
  const position = {
    x: pushed.x + driftOffset.x,
    y: pushed.y + driftOffset.y,
  }

  const alpha = activityFade(activity.lastActiveAt, now, fadeMs)

  return { position, alpha, size, color: colorForActor(activity.actor) }
}

/**
 * The actor's anchor before the outward push: a recency-weighted blend of its
 * most-recent touch and the centroid of everything it is touching. The blend leans
 * hard toward the recent touch ({@link RECENCY_WEIGHT}), so the orb tracks the file
 * being edited now rather than the average of every file the actor has touched (the
 * average is what pinned it to the tree center for cross-tree work).
 *
 * Falls back gracefully: with no recent touch it is the plain centroid; with no
 * touches at all it is the parked `lastCentroid` (a quiet, fading actor); and with
 * no history whatsoever it is the origin (logged, since that is an unexpected state
 * worth surfacing rather than silently centering).
 */
function anchorOf(activity: ActorActivity): Vec2 {
  const centroid = centroidOf(activity.touched, activity.lastCentroid)
  if (!activity.recent) {
    return centroid
  }
  return {
    x: activity.recent.x * RECENCY_WEIGHT + centroid.x * (1 - RECENCY_WEIGHT),
    y: activity.recent.y * RECENCY_WEIGHT + centroid.y * (1 - RECENCY_WEIGHT),
  }
}

/**
 * Pushes the `anchor` radially outward from `origin` so the actor floats clearly
 * past its touched cluster. The push lands the actor at
 * `max(anchorRadius, farthestTouchedRadius) + margin` from the origin along the
 * anchor's outward ray. Scaling to the cluster's own outer radius (not a tiny fixed
 * offset) is the fix for actors getting buried in a large tree: the bigger the tree,
 * the farther out the push, so the orb always reads as hovering *outside* the work.
 *
 * The result is always *strictly farther* from the origin than the anchor (margin is
 * non-negative and the cluster radius is at least the anchor's own radius), the
 * property the user wants: contributors orbit the outside near their work.
 *
 * When the anchor coincides with the origin there is no outward direction to push
 * along, so the actor's stable hashed drift direction is used instead, floating a
 * dead-center actor out into its own consistent spot rather than the crowded middle.
 */
function pushPastCluster(anchor: Vec2, touched: Vec2[], origin: Vec2, margin: number, actor: string): Vec2 {
  const directionX = anchor.x - origin.x
  const directionY = anchor.y - origin.y
  const anchorRadius = Math.hypot(directionX, directionY)

  // Push to just beyond the farthest file the actor is touching, so the orb clears
  // the whole cluster it is working in, then `margin` further still.
  const clusterRadius = Math.max(anchorRadius, farthestRadius(touched, origin))
  const targetRadius = clusterRadius + margin

  if (anchorRadius === 0) {
    // Anchor is the tree center: no radial direction. Fall back to the actor's own
    // hashed drift direction so it still escapes the middle deterministically.
    const fallback = actorDrift(actor, 1)
    const fallbackLength = Math.hypot(fallback.x, fallback.y) || 1
    return {
      x: origin.x + (fallback.x / fallbackLength) * targetRadius,
      y: origin.y + (fallback.y / fallbackLength) * targetRadius,
    }
  }

  return {
    x: origin.x + (directionX / anchorRadius) * targetRadius,
    y: origin.y + (directionY / anchorRadius) * targetRadius,
  }
}

/** The radius of the farthest touched file from `origin`; `0` when none are touched. */
function farthestRadius(touched: Vec2[], origin: Vec2): number {
  let farthest = 0
  for (const position of touched) {
    const radius = Math.hypot(position.x - origin.x, position.y - origin.y)
    if (radius > farthest) {
      farthest = radius
    }
  }
  return farthest
}

/**
 * The centroid (mean) of the touched-file positions. Falls back to `lastCentroid`
 * when the actor is touching nothing this window (it just went quiet but is still
 * fading), and to the origin only when there is no history at all. The origin
 * fallback is logged because an actor with neither current touches nor a remembered
 * centroid is an unexpected state worth surfacing rather than silently centering.
 */
function centroidOf(touched: Vec2[], lastCentroid: Vec2 | undefined): Vec2 {
  if (touched.length === 0) {
    if (lastCentroid) {
      return lastCentroid
    }
    console.debug('runewood: actor has no touched files and no last centroid, placing at origin')
    return { x: 0, y: 0 }
  }

  let sumX = 0
  let sumY = 0
  for (const position of touched) {
    sumX += position.x
    sumY += position.y
  }
  return { x: sumX / touched.length, y: sumY / touched.length }
}

/**
 * The presence opacity for an actor given how long ago it last acted. Full
 * (`1`) at the instant of activity, decaying linearly to `0` over `fadeMs`, and
 * clamped so a long-idle actor reads as gone, not negative. An actor acting in the
 * future relative to `now` (which the controller should never produce) is treated
 * as fully present rather than over-bright.
 */
function activityFade(lastActiveAt: number, now: number, fadeMs: number): number {
  const elapsed = now - lastActiveAt
  if (elapsed <= 0) {
    return 1
  }
  const remaining = 1 - elapsed / fadeMs
  return Math.max(0, Math.min(1, remaining))
}

/**
 * A stable per-actor positional nudge, hashed from the actor id so the same actor
 * always sits at the same small offset off the raw centroid. This keeps two
 * actors working the same file from drawing exactly on top of each other, and
 * gives each actor a consistent "personal space" around its files. Mirrors the
 * layout jitter: two unit values in [-1, 1] from disjoint hash bit fields.
 */
function actorDrift(actor: string, amount: number): Vec2 {
  if (amount === 0) {
    return { x: 0, y: 0 }
  }
  const hash = hashString(actor)
  const unitX = ((hash & 0xffff) / 0xffff) * 2 - 1
  const unitY = (((hash >>> 16) & 0xffff) / 0xffff) * 2 - 1
  return { x: unitX * amount, y: unitY * amount }
}

/**
 * FNV-1a 32-bit hash of a string. Stable, fast, and dependency-free; mirrors the
 * hash used by the layout jitter, the theme, and the beam field so the engine
 * keeps one hashing story and every offset is deterministic, never random.
 */
function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return hash >>> 0
}
