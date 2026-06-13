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
 * An actor's position tracks the centroid of the file positions it is currently
 * touching, eased by a small deterministic drift so two actors on the same file
 * don't stack exactly. Its fade rises while it is active and decays after its last
 * activity, so an actor that goes quiet dissolves rather than hanging on the
 * canvas. Both are pure functions of the supplied activity and playhead `now`, so
 * a rewound timeline repaints every actor identically.
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
}

const DEFAULT_FADE_MS = 3_000
const DEFAULT_SIZE = 10
const DEFAULT_DRIFT = 14

/**
 * Computes the full visual of an actor at playhead time `now`. Pure and
 * deterministic: it reads only the activity, the time, and the options, never
 * `Date.now()` or randomness.
 *
 * The mapping:
 * - **position** is the centroid of the touched-file positions (or `lastCentroid`
 *   while the actor is quiet, or the origin as a last resort), nudged by a small
 *   per-actor drift hashed from the actor id so co-located actors don't overlap.
 * - **alpha** is full at the instant of activity and decays linearly to 0 over
 *   `fadeMs` since `lastActiveAt`, so an actor that stops working fades out.
 * - **size** and **color** are constant per actor (the orb size and the actor's
 *   identity hue); the renderer can scale the glow by alpha.
 */
export function actorVisualFor(activity: ActorActivity, now: number, options: ActorVisualOptions = {}): ActorVisual {
  const fadeMs = options.fadeMs ?? DEFAULT_FADE_MS
  const size = options.size ?? DEFAULT_SIZE
  const drift = options.drift ?? DEFAULT_DRIFT

  const centroid = centroidOf(activity.touched, activity.lastCentroid)
  const driftOffset = actorDrift(activity.actor, drift)
  const position = {
    x: centroid.x + driftOffset.x,
    y: centroid.y + driftOffset.y,
  }

  const alpha = activityFade(activity.lastActiveAt, now, fadeMs)

  return { position, alpha, size, color: colorForActor(activity.actor) }
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
