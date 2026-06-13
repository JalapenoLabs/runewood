// Copyright © 2026 Jalapeno Labs

import type { Hsl, RunewoodTheme } from '../core/theme'

/**
 * The pure visual description of one branch (the edge from a node to its parent),
 * ready for a backend to stroke as a line. Library-free: a canonical {@link Hsl}
 * `color`, a world-unit `thickness`, and a `0..1` `alpha`. This module reads only
 * the theme and the branch's depth, never pixi, the DOM, or the clock.
 */
export type EdgeVisual = {
  /** Branch color, taken from the theme. */
  color: Hsl
  /** Stroke width in world units. Thins with depth so deep trees stay legible. */
  thickness: number
  /** Stroke opacity, `0..1`. Fades with depth so the dense outer canopy reads as subtle. */
  alpha: number
}

/**
 * Tuning for {@link edgeVisualFor}. Every field has a default so the common call
 * is `edgeVisualFor(depth, theme)`.
 */
export type EdgeVisualOptions = {
  /** Stroke width of a depth-1 branch (a repo root to the forest center), in world units. */
  baseThickness?: number
  /** The thinnest a branch is ever drawn, no matter how deep, in world units. */
  minThickness?: number
  /** Opacity of a depth-1 branch, `0..1`. */
  baseAlpha?: number
  /** The faintest a branch is ever drawn, no matter how deep, `0..1`. */
  minAlpha?: number
  /**
   * Per-depth multiplicative falloff applied to both thickness and alpha, `0..1`.
   * Each ring deeper multiplies the previous by this, so branches taper and fade
   * geometrically toward the outer canopy where nodes are densest.
   */
  depthFalloff?: number
}

const DEFAULT_BASE_THICKNESS = 2.4
const DEFAULT_MIN_THICKNESS = 0.5
const DEFAULT_BASE_ALPHA = 0.5
const DEFAULT_MIN_ALPHA = 0.12
const DEFAULT_DEPTH_FALLOFF = 0.72

/**
 * Computes the visual of the branch that connects a node at the given `depth` to
 * its parent. `depth` is the child node's ring (a repo root is depth 1, its
 * children depth 2, and so on); the forest center is depth 0 and has no incoming
 * branch, so callers pass `depth >= 1`.
 *
 * Both thickness and alpha decay geometrically with depth (each ring multiplies
 * the last by `depthFalloff`) and are floored at `minThickness` / `minAlpha`, so
 * the trunk reads as a strong branch while the dense outer twigs stay faint and
 * the whole tree stays readable rather than turning into a solid web.
 *
 * Pure: a given `(depth, theme, options)` always yields the identical visual, so
 * a rewound timeline repaints every branch exactly.
 */
export function edgeVisualFor(depth: number, theme: RunewoodTheme, options: EdgeVisualOptions = {}): EdgeVisual {
  const baseThickness = options.baseThickness ?? DEFAULT_BASE_THICKNESS
  const minThickness = options.minThickness ?? DEFAULT_MIN_THICKNESS
  const baseAlpha = options.baseAlpha ?? DEFAULT_BASE_ALPHA
  const minAlpha = options.minAlpha ?? DEFAULT_MIN_ALPHA
  const depthFalloff = options.depthFalloff ?? DEFAULT_DEPTH_FALLOFF

  if (depth < 1) {
    // Depth 0 is the forest center, which has no incoming branch. A caller asking
    // for it is a bug; warn and fall back to the strongest (depth-1) branch rather
    // than producing a negative exponent.
    console.debug('runewood: edgeVisualFor called with depth < 1, clamping to 1', depth)
    depth = 1
  }

  // Rings deeper than the first taper geometrically. Depth 1 keeps the base
  // values (falloff^0 === 1); each ring out multiplies by `depthFalloff`.
  const falloff = depthFalloff ** (depth - 1)
  const thickness = Math.max(minThickness, baseThickness * falloff)
  const alpha = Math.max(minAlpha, baseAlpha * falloff)

  return { color: { ...theme.branch }, thickness, alpha }
}
