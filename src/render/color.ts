// Copyright © 2026 Jalapeno Labs

import type { Hsl } from '../core/theme'

/**
 * Converts the engine's canonical {@link Hsl} (hue in degrees, S/L as `0..1`
 * fractions) to the packed `0xRRGGBB` integer a WebGL backend wants. It lives in
 * the render layer, not the theme module, because "what a color integer is" is a
 * GPU concern that must not leak above the backend. Pure and self-contained so
 * there is no dependency on pixi/colord's particular HSL parsing rules, and so it
 * is unit-testable without a GPU.
 *
 * Shared by both the {@link import('./pixiBackend').PixiBackend} and the retained
 * {@link import('./scene').Scene} so the two never drift on color handling.
 */
export function hslToRgbInt(color: Hsl): number {
  const hue = ((color.h % 360) + 360) % 360
  const saturation = clamp01(color.s)
  const lightness = clamp01(color.l)

  // Standard HSL -> RGB. `chroma` is the color's intensity, `secondary` the
  // intermediate component, and `match` the lightness offset that lifts both to
  // the requested lightness.
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const huePrime = hue / 60
  const secondary = chroma * (1 - Math.abs((huePrime % 2) - 1))
  const match = lightness - chroma / 2

  const rgb = rgbForHueSextant(huePrime, chroma, secondary)

  const red = Math.round((rgb.r + match) * 255)
  const green = Math.round((rgb.g + match) * 255)
  const blue = Math.round((rgb.b + match) * 255)

  return (red << 16) | (green << 8) | blue
}

/**
 * The un-offset RGB components for a hue, picked by which 60-degree sextant of
 * the color wheel it falls in. The caller adds the lightness `match` to all
 * three. A lookup over sextants keeps this branch-light and obvious.
 */
function rgbForHueSextant(huePrime: number, chroma: number, secondary: number): RgbTriple {
  if (huePrime < 1) {
    return { r: chroma, g: secondary, b: 0 }
  }
  if (huePrime < 2) {
    return { r: secondary, g: chroma, b: 0 }
  }
  if (huePrime < 3) {
    return { r: 0, g: chroma, b: secondary }
  }
  if (huePrime < 4) {
    return { r: 0, g: secondary, b: chroma }
  }
  if (huePrime < 5) {
    return { r: secondary, g: 0, b: chroma }
  }
  return { r: chroma, g: 0, b: secondary }
}

/** A plain RGB triple in `0..1`, internal to the HSL conversion. */
type RgbTriple = { r: number, g: number, b: number }

/** Clamps a fraction to `[0, 1]`. */
function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1)
}
