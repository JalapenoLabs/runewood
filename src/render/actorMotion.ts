// Copyright © 2026 Jalapeno Labs

import type { Vec2 } from '../core/layout'

/**
 * The pure, forward-only *motion* model for an actor orb: the swoop-in, glide, and
 * ease-to-rest the user asked for (a contributor's orb "swoops in like Gource",
 * glides to its target, and rolls gently to a stop like a ball on a pool table).
 *
 * It is the orb's animation counterpart to the placement model in
 * {@link import('./actors').actorVisualFor}: that one decides *where the orb wants
 * to be right now* (the outward recency anchor) and *how present it is* (the
 * lingering fade + idle breath); this one decides *how the orb travels there* over
 * wall time so it glides instead of teleporting. Where the placement model is a pure
 * function of the playhead (so a rewind repaints identically), this motion is
 * deliberately forward-only visual state driven by the real frame delta, exactly
 * like the force-directed node sim it rides above: a recomputed target each frame,
 * and the drawn position eases toward it.
 *
 * Nothing here touches pixi, the DOM, the clock, or randomness; the controller/scene
 * owns the retained {@link ActorMotion} state and feeds it each frame's target,
 * opacity, and `deltaMs`.
 *
 * The model has two pieces, both pure and unit-tested:
 * - **{@link stepActorGlide}**: an ease-out glide of the drawn position toward the
 *   target. It is framerate-independent exponential smoothing (the same shape the
 *   node sim's damping uses): each frame the orb closes a fixed *fraction* of the
 *   remaining distance per unit time, so it moves fast when far and decelerates as it
 *   nears the target, coming smoothly to rest rather than snapping. Forward-only: it
 *   reads only the current position, the target, and `deltaMs`.
 * - **{@link rampOpacity}**: a quick linear ramp from 0 to 1 over the ramp window,
 *   so a freshly-appeared orb fades in fast as it swoops rather than popping on.
 *
 * The retained {@link ActorMotion} stitches them together: on first appearance it
 * starts the orb OUT in the open space (further along the outward ray, past the
 * target, via {@link swoopStartFor}) with opacity at 0, then each
 * {@link ActorMotion.advance} glides it inward and ramps the fade in, so it flies in,
 * eases to rest, and stays put until its target moves again.
 */

/** Tuning for the actor glide + opacity ramp. Every field has a default. */
export type ActorMotionOptions = {
  /**
   * The ease-out rate constant of the glide, in "per second": the orb's distance to
   * the target decays like `e^(-rate * dt)` each frame, so a higher rate arrives
   * faster and a lower one drifts in more lazily. Framerate-independent (the exponential
   * composes exactly across frames) and never snaps, so the glide looks the same at 30
   * or 144 fps. Tuned so a typical swoop settles over roughly half a second, reading as
   * a fast-but-smooth arrival.
   */
  glideRatePerSecond?: number
  /**
   * How long the opacity ramp from 0 to full takes on (re)appearance, in
   * milliseconds. Kept short (a fast ramp-in) so the orb is visible almost
   * immediately as it swoops rather than lingering ghostly; the glide carries the
   * sense of arrival, not a slow fade.
   */
  rampMs?: number
  /**
   * How far *past* the target, along the target's outward ray from the world origin,
   * a freshly-appeared orb starts, in layout units, so it visibly flies inward from
   * the open space rather than materializing on the spot. A larger value gives a
   * longer, more dramatic swoop. The direction is the target's own outward ray; for a
   * target sitting exactly on the origin a deterministic fallback ray is used so the
   * orb still swoops in from somewhere consistent rather than not at all.
   */
  swoopDistance?: number
  /**
   * The world origin the swoop ray is measured from: a fresh orb starts this far
   * *beyond* its target as seen from here. Defaults to the layout origin
   * `{ x: 0, y: 0 }`, matching the forest center the placement model pushes actors
   * away from, so the swoop comes in from outside the canopy.
   */
  origin?: Vec2
}

/**
 * The ease-out rate constant of the glide, in "per second": the distance to the target
 * decays like `e^(-rate * dt)`. At ~6/s the orb covers most of the gap in the first
 * ~0.4s (retaining ~e^-0.1 ≈ 0.9 of the distance per 16ms frame) and then eases the
 * last sliver to rest, a fast swoop that rolls gently to a stop rather than snapping or
 * overshooting.
 */
const DEFAULT_GLIDE_RATE_PER_SECOND = 6

/**
 * Default opacity-ramp duration, in milliseconds: a quick ~0.25s fade-in so the orb
 * appears almost at once as it begins its swoop, the fast ramp the user asked for.
 */
const DEFAULT_RAMP_MS = 250

/**
 * Default swoop distance, in layout units: how far beyond its target an orb starts so
 * it flies inward from the open space. Comfortably larger than a node's spacing so
 * the inward glide reads clearly, a judgment call worth tuning to taste.
 */
const DEFAULT_SWOOP_DISTANCE = 220

/**
 * Eases the drawn position one frame toward `target` with an ease-out, returning the
 * next position. Framerate-independent exponential smoothing: the orb retains
 * `(1 - rate)^deltaSeconds` of its distance to the target each frame, so it closes a
 * fixed fraction of the gap per unit time. That gives the pool-ball feel: quick while
 * far from rest, decelerating smoothly as it arrives, never overshooting and never
 * snapping.
 *
 * Pure and forward-only: it reads only the current position, the target, and the
 * frame delta. A non-positive or non-finite `deltaMs` (a paused or malformed frame)
 * holds the position exactly where it is rather than corrupting it.
 */
export function stepActorGlide(
  current: Vec2,
  target: Vec2,
  deltaMs: number,
  options: ActorMotionOptions = {},
): Vec2 {
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return { x: current.x, y: current.y }
  }

  const glideRate = options.glideRatePerSecond ?? DEFAULT_GLIDE_RATE_PER_SECOND
  const deltaSeconds = deltaMs / 1000
  // Fraction of the remaining distance still left after this frame, from an
  // exponential decay with `glideRate` as the per-second rate constant. `e^(-rate*dt)`
  // is always in (0, 1) for a positive rate, and composes exactly across frames, so the
  // decay is framerate-independent (a long frame eases proportionally more than a short
  // one) AND never snaps, the way a naive `(1 - rate)^dt` would for a rate above 1.
  const remaining = Math.exp(-glideRate * deltaSeconds)
  return {
    x: target.x + (current.x - target.x) * remaining,
    y: target.y + (current.y - target.y) * remaining,
  }
}

/**
 * The opacity ramp for an orb that appeared `elapsedMs` ago: a linear rise from 0 to
 * 1 over the ramp window, clamped to `[0, 1]`. So a freshly-swooped-in orb fades in
 * quickly rather than popping on, and once the window has passed it stays fully
 * opaque. A zero or negative ramp window means "instant" (fully opaque at once).
 *
 * Pure: a function of the elapsed time alone, so a given age always yields the same
 * opacity.
 */
export function rampOpacity(elapsedMs: number, options: ActorMotionOptions = {}): number {
  const rampMs = options.rampMs ?? DEFAULT_RAMP_MS
  if (rampMs <= 0) {
    return 1
  }
  const fraction = elapsedMs / rampMs
  if (fraction <= 0) {
    return 0
  }
  if (fraction >= 1) {
    return 1
  }
  return fraction
}

/**
 * Where a freshly-appeared orb should start its swoop: out past `target` along the
 * target's outward ray from the origin, by `swoopDistance`, so it flies inward from
 * the open space to its resting place. When the target sits exactly on the origin
 * (no outward ray to extend) a fixed fallback ray is used so the orb still swoops in
 * from a consistent direction rather than starting on top of its target.
 *
 * Pure and deterministic: the same target + options always yield the same start, so
 * the swoop is reproducible.
 */
export function swoopStartFor(target: Vec2, options: ActorMotionOptions = {}): Vec2 {
  const swoopDistance = options.swoopDistance ?? DEFAULT_SWOOP_DISTANCE
  const origin = options.origin ?? { x: 0, y: 0 }

  const directionX = target.x - origin.x
  const directionY = target.y - origin.y
  const radius = Math.hypot(directionX, directionY)
  if (radius === 0) {
    // Target is the origin: no outward ray. Swoop in from a fixed diagonal so the orb
    // still flies inward from somewhere rather than appearing in place.
    const fallback = Math.SQRT1_2
    return {
      x: origin.x + fallback * swoopDistance,
      y: origin.y + fallback * swoopDistance,
    }
  }
  return {
    x: target.x + (directionX / radius) * swoopDistance,
    y: target.y + (directionY / radius) * swoopDistance,
  }
}

/**
 * The retained motion state of one actor orb: its current drawn position and the
 * time it (re)appeared, stitching {@link stepActorGlide} and {@link rampOpacity}
 * together into the swoop-in / glide / ease-to-rest behavior. The scene owns one of
 * these per live actor and {@link advance}s it each frame with the actor's freshly
 * recomputed target and the real frame delta.
 *
 * This is forward-only visual state (it carries a position across frames), so it
 * lives here in the render layer, never in the replayable fold.
 */
export class ActorMotion {
  /** The orb's current drawn position, eased toward the target each frame. */
  private position: Vec2
  /**
   * Wall-clock-ish age of this appearance, accumulated from the frame deltas, driving
   * the opacity ramp. Reset to 0 on a fresh appearance so the orb ramps in again.
   */
  private elapsedMs: number
  private readonly options: ActorMotionOptions

  /**
   * @param target the orb's first target (its outward resting place). The orb starts
   *   OUT past it (see {@link swoopStartFor}) with opacity 0 so its first
   *   {@link advance} glides it inward and ramps it in.
   */
  constructor(target: Vec2, options: ActorMotionOptions = {}) {
    this.options = options
    this.position = swoopStartFor(target, options)
    this.elapsedMs = 0
  }

  /** The orb's current drawn position. Read by the scene to place the graphic. */
  public get drawnPosition(): Vec2 {
    return this.position
  }

  /**
   * Advances the motion one frame: ages the appearance clock, glides the drawn
   * position toward `target` with the ease-out, and returns the current opacity-ramp
   * factor `0..1`. The caller multiplies that ramp into the orb's modeled presence
   * alpha so the orb fades in as it swoops and is at full ramp once arrived.
   *
   * `deltaMs` is the real elapsed wall time for the frame; a non-positive frame ages
   * nothing and holds the position, so a paused frame never disturbs the orb.
   */
  public advance(target: Vec2, deltaMs: number): number {
    if (Number.isFinite(deltaMs) && deltaMs > 0) {
      this.elapsedMs += deltaMs
    }
    this.position = stepActorGlide(this.position, target, deltaMs, this.options)
    return rampOpacity(this.elapsedMs, this.options)
  }

  /**
   * Restarts the swoop: places the orb back OUT past `target` and resets the opacity
   * ramp, so it flies in and fades in fresh. The scene calls this when an actor
   * reappears after fully fading out, so a returning contributor swoops in again
   * rather than blinking back at its old spot.
   */
  public restart(target: Vec2): void {
    this.position = swoopStartFor(target, this.options)
    this.elapsedMs = 0
  }
}
