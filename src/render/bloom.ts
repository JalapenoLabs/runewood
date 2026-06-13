// Copyright © 2026 Jalapeno Labs

/**
 * The bloom (post-process glow) quality tier. This is the single knob the host,
 * the controller (#9), and the options surface (#10) turn to trade fidelity for
 * frame time:
 *
 * - `off`: no bloom pass at all. The cheapest path; the filter is removed from
 *   the scene entirely so there is zero per-frame cost.
 * - `low`: a soft, cheap glow. Fewer blur passes and a smaller kernel, sized so
 *   a weak GPU can still hold frame budget.
 * - `high`: the full luminous look, more blur quality and a wider halo.
 *
 * Bloom is the most expensive effect in the renderer, so it is deliberately the
 * first thing the quality switch turns down (see {@link resolveBloomQuality}).
 */
export type BloomQuality = 'off' | 'low' | 'high'

/**
 * The concrete, library-agnostic bloom parameters a backend feeds into its glow
 * pass. These are plain numbers with no pixi/WebGL types so this module stays
 * unit-testable in node; the {@link import('./pixiBackend').PixiBackend} maps
 * them onto `pixi-filters`' `AdvancedBloomFilter` one-to-one.
 *
 * The names match the standard bright-pass-blur-composite bloom every renderer
 * implements, so the mapping is obvious regardless of the draw library:
 */
export type BloomParameters = {
  /**
   * How bright a pixel must be (`0..1`) before it contributes to the glow. A
   * higher threshold means only the hottest nodes bloom; a lower one lets more
   * of the forest glow. Theme `glowFalloff` drives this: a tighter, more
   * contained halo (high falloff) lifts the threshold so the glow stays on the
   * brightest cores.
   */
  threshold: number
  /**
   * The blur radius of the glow, in the filter's pixel units. Larger spreads the
   * light further. Scales up with quality (a wider halo at `high`) and with the
   * theme's `bloomIntensity`.
   */
  blur: number
  /**
   * The strength of the composite, i.e. how much of the bloomed, blurred image
   * is added back over the scene. This is the primary "how much glow" dial:
   * higher `bloomIntensity` raises it, and `high` quality pushes it above `low`.
   */
  strength: number
  /**
   * The number of blur passes. The chief fidelity-vs-cost trade: `low` uses few
   * passes for a cheap, slightly banded glow; `high` uses more for a smooth one.
   * `off` reports `0`, but a backend should skip the pass entirely rather than
   * run a zero-quality blur.
   */
  quality: number
}

/**
 * Device/environment capabilities that can force the requested bloom quality
 * down. This module never reads the DOM or probes the GPU itself: the controller
 * (#9) reads `prefers-reduced-motion` and any low-end signal and hands the two
 * booleans in, so the downgrade decision stays a pure, testable function.
 */
export type BloomCapabilities = {
  /**
   * The user has asked the platform to minimize non-essential motion and
   * animation (`prefers-reduced-motion: reduce`). Bloom is a non-essential,
   * animated glow, so this forces it fully `off`.
   */
  prefersReducedMotion: boolean
  /**
   * A coarse "this is a weak GPU / low-power device" signal (an integrated GPU,
   * a battery-saver hint, a small device-memory budget). It caps bloom at `low`
   * so a struggling device keeps its frame budget instead of running the full
   * `high` pass.
   */
  lowPower: boolean
}

/**
 * Per-quality blur passes (the `AdvancedBloomFilter.quality`). `low` keeps the
 * pass count down for cheap, slightly banded glow; `high` smooths it out. `off`
 * is `0` and signals "no pass" to a backend that should skip it entirely.
 */
const BLUR_PASSES_BY_QUALITY = {
  off: 0,
  low: 2,
  high: 6,
} as const satisfies Record<BloomQuality, number>

/**
 * The base blur radius per quality, before the theme's `bloomIntensity` widens
 * it. A wider halo at `high` is the visible difference from `low`.
 */
const BASE_BLUR_BY_QUALITY = {
  off: 0,
  low: 4,
  high: 12,
} as const satisfies Record<BloomQuality, number>

/**
 * The base composite strength per quality, before `bloomIntensity` scales it.
 * `high` is strictly stronger than `low` so a quality bump is always a visible
 * intensity bump, not just a smoothness one.
 */
const BASE_STRENGTH_BY_QUALITY = {
  off: 0,
  low: 0.7,
  // Pushed well above `low` so "high" is unmistakably more luminous, not a subtle
  // smoothness bump. Paired with the lowered threshold band below, "high" reads as
  // a clear glow the moment it is selected, while "off" stays a true no-op.
  high: 2.4,
} as const satisfies Record<BloomQuality, number>

/**
 * How much the theme's `bloomIntensity` (`0..1`) is allowed to widen the blur on
 * top of the per-quality base, in the filter's pixel units. At full intensity a
 * `high` halo reaches `BASE_BLUR_BY_QUALITY.high + this`.
 */
const BLUR_INTENSITY_SPREAD = 6

/**
 * The lowest and highest bright-pass threshold the theme's `glowFalloff` maps
 * to. A tighter halo (large falloff) raises the threshold so only the hottest
 * cores glow; a spreading halo (small falloff) lowers it so more of the forest
 * lights up. `glowFalloff` is `> 0` and typically lands around `1..2`.
 */
// Lowered from 0.3..0.8 so the bright pass actually catches the glowing nodes: at
// the old band almost nothing crossed the threshold, so "high" looked the same as
// "off". A lower band lets the hot cores (and their halos) bloom visibly while
// still keeping the dim background below the pass, so the scene glows without
// washing out.
const MIN_THRESHOLD = 0.15
const MAX_THRESHOLD = 0.5

/**
 * The `glowFalloff` value mapped to {@link MAX_THRESHOLD}; falloff at or above
 * this is treated as "fully tight". Chosen to cover the built-in themes, whose
 * falloff ranges roughly `1.0..2.1`.
 */
const FALLOFF_FOR_MAX_THRESHOLD = 2.5

/**
 * Maps a quality tier plus the active theme's glow knobs to concrete bloom
 * parameters. Pure and deterministic: identical inputs always yield identical
 * parameters, so a backend can recompute them on every theme change without
 * surprise.
 *
 * The mapping:
 * - **`off`** yields all-zero parameters (no threshold work, no blur, no
 *   strength), the unambiguous "draw nothing extra" signal for a backend.
 * - **`strength`** is the per-quality base scaled by `bloomIntensity`, so a
 *   brighter theme glows harder and `high` always out-glows `low`.
 * - **`blur`** is the per-quality base widened by `bloomIntensity`, so a more
 *   intense theme also spreads its light further.
 * - **`threshold`** comes from `glowFalloff`: a tighter halo lifts it so only
 *   the brightest nodes bloom; a spreading halo lowers it.
 * - **`quality`** (blur passes) is fixed per tier, the core fidelity-vs-cost
 *   trade.
 */
export function bloomParametersFor(
  quality: BloomQuality,
  bloomIntensity: number,
  glowFalloff: number,
): BloomParameters {
  if (quality === 'off') {
    return { threshold: 0, blur: 0, strength: 0, quality: 0 }
  }

  // Clamp the theme intensity defensively: it crosses in from caller-supplied
  // theme overrides, a runtime boundary, so an out-of-range value should not
  // produce a negative blur or a runaway glow.
  const intensity = Math.min(Math.max(bloomIntensity, 0), 1)

  const strength = BASE_STRENGTH_BY_QUALITY[quality] * intensity
  const blur = BASE_BLUR_BY_QUALITY[quality] + BLUR_INTENSITY_SPREAD * intensity

  // A tighter halo (larger falloff) keeps the glow on the hottest cores by
  // raising the bright-pass threshold; a spreading halo lowers it so more of the
  // forest lights up. `glowFalloff` is `> 0`; clamp the mapped fraction to the
  // configured threshold band.
  const falloffFraction = Math.min(Math.max(glowFalloff / FALLOFF_FOR_MAX_THRESHOLD, 0), 1)
  const threshold = MIN_THRESHOLD + (MAX_THRESHOLD - MIN_THRESHOLD) * falloffFraction

  return {
    threshold,
    blur,
    strength,
    quality: BLUR_PASSES_BY_QUALITY[quality],
  }
}

/**
 * Resolves the bloom quality a device should actually run, downgrading the
 * caller's request when the environment cannot afford it. Pure: it reads only
 * the two booleans handed in, never the DOM.
 *
 * The precedence, strongest first:
 * 1. **Reduced motion wins outright.** If the user asked for reduced motion,
 *    bloom is forced fully `off` no matter what was requested. It is an
 *    animated, non-essential glow, exactly what that preference opts out of.
 * 2. **Low power caps at `low`.** A weak GPU keeps a cheap glow rather than the
 *    full `high` pass, but is not forced off, so the forest still reads as
 *    luminous. A request of `off` or `low` is left untouched.
 * 3. Otherwise the requested quality is honored verbatim.
 */
export function resolveBloomQuality(
  requested: BloomQuality,
  capabilities: BloomCapabilities,
): BloomQuality {
  if (capabilities.prefersReducedMotion) {
    return 'off'
  }

  if (capabilities.lowPower && requested === 'high') {
    return 'low'
  }

  return requested
}
