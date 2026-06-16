// Copyright © 2026 Jalapeno Labs

/**
 * The pure animation math behind the souped-up "watch this" highlight effect
 * (issue #180): the glowing sci-fi targeting reticle that spins, breathes, and
 * sparkles around each highlighted file while CI runs. The old flat bordered ring
 * is replaced by a layered effect (a breathing glow aura, two counter-rotating
 * gapped spinner rings each with a bright leading edge, and a few orbiting sparks),
 * and everything here is the small, clock-free geometry the scene's pixi draw reads
 * each frame.
 *
 * Nothing in this file touches pixi, the DOM, or the wall clock: every function is a
 * pure projection of the injected `animationTimeMs` (the controller's wall/frame
 * clock, NOT the playhead) plus a layer index, so the reticle spins and breathes
 * identically whether playback is playing, paused, or being scrubbed. The scene owns
 * the retained pixi objects and feeds these helpers the time, the node's live radius,
 * and the group color; this module owns *how fast each ring turns, where each spark
 * orbits right now, and how bright the leading edge shines*. Keeping it separated is
 * what lets the visually-load-bearing math be unit-tested while the draw stays a
 * thin, untested translation onto `Graphics`.
 *
 * The two motion conventions used throughout:
 * - **Counter-rotation:** even-indexed rings spin one way, odd-indexed rings the
 *   other, so adjacent rings shear past each other and read as a mechanism turning
 *   rather than a single rigid wheel. {@link ringRotation} folds the index's parity
 *   into the sign.
 * - **Per-layer speed falloff:** each successive ring (and the spark orbit) turns a
 *   little slower than the one inside it, so the layers never lock into one rigid
 *   spin. {@link ringRotation} applies the falloff off the layer index.
 */

/** Tuning for the highlight reticle's animation math. Every field has a default so the common call passes only time. */
export type HighlightEffectOptions = {
  /**
   * The base angular speed of the innermost spinner ring, in radians per second.
   * Each successive ring scales this down by {@link ringSpeedFalloff}, and the sign
   * alternates per ring so adjacent rings counter-rotate. Tuned so the inner ring
   * makes a little under one full turn every couple of seconds: clearly *moving*
   * and alive, but calm enough to read as a deliberate targeting sweep rather than a
   * frantic spin.
   */
  baseRingSpeedRadPerSec?: number
  /**
   * How much slower each successive ring turns than the one inside it, as a multiplier
   * applied per ring index (`speed * ringSpeedFalloff ^ index`). Below 1 so the outer
   * rings lag the inner ones and the whole reticle shears rather than spinning rigidly.
   */
  ringSpeedFalloff?: number
  /**
   * The angular speed the orbiting sparks travel around the reticle, in radians per
   * second. Kept a touch faster than the rings so the sparks visibly *chase* around
   * the mechanism, reading as energy flowing through it rather than fixed studs.
   */
  sparkSpeedRadPerSec?: number
  /**
   * The full twinkle period of a spark's alpha oscillation, in milliseconds: one
   * bright -> dim -> bright cycle. Short enough that the sparks shimmer noticeably
   * while they orbit, long enough not to strobe.
   */
  sparkTwinklePeriodMs?: number
  /**
   * The trough of a spark's twinkle, `0..1`: how dim a spark gets at the bottom of
   * its shimmer. Above zero so an orbiting spark never fully blinks out, just pulses
   * between this floor and full so it always reads as a bright travelling point.
   */
  sparkTwinkleFloor?: number
}

/** Base angular speed of the innermost ring, in radians per second (a little under one turn / ~2.5s). */
const DEFAULT_BASE_RING_SPEED_RAD_PER_SEC = 2.5

/** Per-ring speed multiplier: each ring out turns this fraction of the one inside it, so the reticle shears. */
const DEFAULT_RING_SPEED_FALLOFF = 0.62

/** Spark orbit angular speed, in radians per second: a touch faster than the rings so sparks chase around. */
const DEFAULT_SPARK_SPEED_RAD_PER_SEC = 1.9

/** Spark twinkle period, in milliseconds: one bright -> dim -> bright shimmer. */
const DEFAULT_SPARK_TWINKLE_PERIOD_MS = 900

/** Spark twinkle trough, `0..1`: a spark never dims below this, so it always reads as a bright point. */
const DEFAULT_SPARK_TWINKLE_FLOOR = 0.35

/**
 * The rotation angle, in radians, of spinner ring `ringIndex` at wall-clock animation
 * time `animationTimeMs`. The innermost ring (index 0) turns at the base speed; each
 * ring out turns slower by {@link HighlightEffectOptions.ringSpeedFalloff}, and the
 * direction alternates by parity (even rings one way, odd rings the other) so adjacent
 * rings counter-rotate and the reticle reads as a turning mechanism rather than a rigid
 * wheel.
 *
 * Pure and clock-free: a function of the injected time and the ring index alone, so a
 * given time always yields the same angle and the spin is reproducible. The angle grows
 * unbounded (it is fed straight to `Graphics.rotation`, which is modular), so callers
 * need not wrap it.
 */
export function ringRotation(
  animationTimeMs: number,
  ringIndex: number,
  options: HighlightEffectOptions = {},
): number {
  const baseSpeed = options.baseRingSpeedRadPerSec ?? DEFAULT_BASE_RING_SPEED_RAD_PER_SEC
  const falloff = options.ringSpeedFalloff ?? DEFAULT_RING_SPEED_FALLOFF

  // Even rings spin positive (counter-clockwise), odd rings negative, so neighbours
  // shear past one another. The `falloff ^ index` slows each successive ring so the
  // layers never lock into one rigid spin.
  const direction = ringIndex % 2 === 0 ? 1 : -1
  const speed = baseSpeed * falloff ** ringIndex
  return direction * speed * (animationTimeMs / 1000)
}

/**
 * The position of orbiting spark `sparkIndex` of `sparkCount`, at wall-clock time
 * `animationTimeMs`, as a point on a circle of the given `radius` centered on the
 * origin (the scene seats the whole reticle at the node, so these are local-space
 * offsets). The sparks are spread evenly around the circle by their index and all
 * advance together at {@link HighlightEffectOptions.sparkSpeedRadPerSec}, so they
 * travel around the reticle as a constellation rather than bunching up.
 *
 * Pure and clock-free: the same time + index + radius always yield the same point, so
 * the orbit is reproducible across a pause/seek.
 */
export function sparkOrbitPosition(
  animationTimeMs: number,
  sparkIndex: number,
  sparkCount: number,
  radius: number,
  options: HighlightEffectOptions = {},
): { x: number, y: number } {
  const speed = options.sparkSpeedRadPerSec ?? DEFAULT_SPARK_SPEED_RAD_PER_SEC

  // Spread the sparks evenly around the ring by index, then advance every spark by the
  // same time-driven angle so the whole constellation orbits together. `sparkCount`
  // guards a divide-by-zero for a caller asking for zero sparks (it returns the angle
  // offset 0 for every index, which is harmless since the caller draws none).
  const spacing = sparkCount > 0 ? (Math.PI * 2 * sparkIndex) / sparkCount : 0
  const angle = spacing + speed * (animationTimeMs / 1000)
  return {
    x: Math.cos(angle) * radius,
    y: Math.sin(angle) * radius,
  }
}

/**
 * The twinkle intensity of spark `sparkIndex` at wall-clock time `animationTimeMs`, in
 * `[floor, 1]`. Each spark shimmers on a cosine between the {@link HighlightEffectOptions.sparkTwinkleFloor}
 * and full, and the sparks are phase-offset from one another by their index so they do
 * not all flash in unison (which would read as one blinking ring rather than several
 * independent travelling sparkles).
 *
 * Pure and clock-free, mirroring the registry's `highlightPulse`: the cosine is remapped
 * from its native `[-1, 1]` to `[floor, 1]` so the twinkle rests above the floor at its
 * quietest and a spark never fully blinks out.
 */
export function sparkTwinkle(
  animationTimeMs: number,
  sparkIndex: number,
  options: HighlightEffectOptions = {},
): number {
  const periodMs = options.sparkTwinklePeriodMs ?? DEFAULT_SPARK_TWINKLE_PERIOD_MS
  const floor = options.sparkTwinkleFloor ?? DEFAULT_SPARK_TWINKLE_FLOOR

  // Offset each spark's phase by a fixed fraction of a turn per index so neighbours
  // shimmer out of step rather than all at once. A golden-ratio-ish stride keeps even a
  // handful of sparks well spread across the cycle.
  const phaseOffset = sparkIndex * Math.PI * 2 * SPARK_TWINKLE_PHASE_STRIDE
  const phase = (animationTimeMs / periodMs) * Math.PI * 2 + phaseOffset
  const unit = (1 - Math.cos(phase)) / 2
  return floor + (1 - floor) * unit
}

/**
 * How far apart, as a fraction of a full twinkle cycle, successive sparks are phase-shifted
 * so they shimmer out of unison. An irrational-ish stride (~0.618, the golden ratio's
 * fractional part) spreads even a few sparks evenly across the cycle without any two
 * landing in step.
 */
const SPARK_TWINKLE_PHASE_STRIDE = 0.618

/**
 * The shine of a rotating arc's bright leading edge for a given progress `0..1` along
 * the arc (0 at the trailing end, 1 at the leading tip). The brightness ramps sharply
 * toward the leading tip so only the last sliver of each arc flares near-white, giving
 * the "comet head" read that sells the rotation: the arc looks like it is sweeping
 * forward with a glowing edge, not a uniform stroke.
 *
 * Returns a `0..1` factor the scene mixes the arc's base color toward white by (and
 * lifts the alpha with), so 0 is the plain group color at the arc's tail and 1 is the
 * shining tip. Pure: a function of the progress alone.
 *
 * The ramp is the progress raised to {@link LEADING_EDGE_SHARPNESS}, which keeps the
 * bulk of the arc its base color and concentrates the flare in the final fraction near
 * the tip.
 */
export function leadingEdgeShine(progressAlongArc: number): number {
  if (progressAlongArc <= 0) {
    return 0
  }
  if (progressAlongArc >= 1) {
    return 1
  }
  return progressAlongArc ** LEADING_EDGE_SHARPNESS
}

/**
 * How sharply the leading-edge shine concentrates at the arc's tip. A power above 1
 * keeps most of the arc dim and flares only the final sliver near-white; higher is a
 * tighter, brighter comet head. ~3 reads as a crisp shining edge without the rest of
 * the arc going dark.
 */
const LEADING_EDGE_SHARPNESS = 3

/**
 * The breathing scale of the glow aura at breath intensity `pulse` (`0..1`, the value
 * the registry's `highlightPulse` hands the scene). The aura gently swells from its
 * resting size toward {@link AURA_BREATH_GAIN} bigger at the peak of the breath, so the
 * whole file area softly inflates and deflates as it glows rather than sitting static.
 *
 * Pure: a plain remap of the breath onto a scale multiplier, so the scene can size the
 * aura sprite off the node radius times this. Separated and tested so the breath-to-scale
 * relationship is pinned even though the sprite draw itself is not.
 */
export function auraBreathScale(pulse: number): number {
  return 1 + pulse * AURA_BREATH_GAIN
}

/**
 * How much larger the glow aura swells at the peak of its breath, as a fraction of its
 * resting size. A gentle gain so the aura visibly inflates with the breath without
 * pumping distractingly.
 */
const AURA_BREATH_GAIN = 0.22
