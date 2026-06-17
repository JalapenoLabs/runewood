// Copyright © 2026 Jalapeno Labs

import type { Renderer, Texture } from 'pixi.js'

// Core
import { Graphics } from 'pixi.js'

/**
 * Builds a reusable soft radial-gradient glow texture: a white disc that is fully
 * opaque at the center and fades smoothly to transparent at the edge. Drawn once,
 * tinted per node, and blended additively under each node's crisp core, it is the
 * cheap stand-in for a real bloom pass: it gives every node the "nice big glow"
 * look the user liked without running the expensive `AdvancedBloomFilter`, so the
 * forest still glows with bloom defaulted off.
 *
 * Why a generated texture and not a `Graphics` gradient per node: a single texture
 * is uploaded to the GPU once and reused by every node's `Sprite` (tinted and
 * scaled per node), so the whole forest's glow costs one texture and N cheap
 * sprite draws rather than N gradient fills. The texture is white so a sprite's
 * `tint` colors it to the node's hue for free.
 *
 * The gradient is approximated by stacking concentric translucent rings rather
 * than a canvas `createRadialGradient`, so it works in any pixi backend
 * (WebGL/WebGPU) without reaching for a 2D canvas context the renderer may not
 * expose. {@link GLOW_RING_COUNT} rings is plenty for a glow that reads as smooth
 * once it is blurred by its own softness and scaled up.
 */
export function buildGlowTexture(renderer: Renderer, radius: number = GLOW_TEXTURE_RADIUS): Texture {
  const graphics = new Graphics()

  // Stack filled circles from the outer edge inward, each a little more opaque, so
  // the accumulated alpha rises smoothly from 0 at the rim to 1 at the center. A
  // squared falloff concentrates the brightness in the core and lets the outer
  // halo trail off gently, which reads as a soft glow rather than a hard disc.
  for (let ring = GLOW_RING_COUNT; ring >= 1; ring--) {
    const fraction = ring / GLOW_RING_COUNT
    const ringRadius = radius * fraction
    // Per-ring alpha so the *stacked* result approximates a smooth falloff. Each
    // ring adds a thin, low-opacity layer; the squared term front-loads the
    // opacity toward the center.
    const ringAlpha = (1 - fraction) ** 2 * GLOW_RING_ALPHA
    graphics.circle(0, 0, ringRadius).fill({ color: 0xffffff, alpha: ringAlpha })
  }

  return renderer.generateTexture(graphics)
}

/**
 * Builds a reusable soft beam-gradient texture: Gource's `beam.png` rebuilt in code.
 * It is a white horizontal strip that is transparent at both ends and rises to a hot
 * opaque core in the middle, so when it is stretched along a beam and tinted, the
 * beam reads as a glowing colored laser that is brightest at its center and softens
 * to nothing at the user and file ends, rather than a flat-edged bar.
 *
 * Why one baked strip and not a per-beam gradient: the texture is uploaded to the GPU
 * once and every live beam draws it as a cheap tinted, rotated, scaled `Sprite`
 * (additively blended), so the whole field's glow costs one texture and N sprite
 * draws. White texels mean a sprite's `tint` recolors it to the action/actor hue for
 * free, exactly like the node glow texture above.
 *
 * The gradient runs along the strip's WIDTH ({@link BEAM_TEXTURE_LENGTH} texels) and
 * is a single texel tall: a beam has no meaningful cross-axis detail of its own (its
 * perpendicular softness comes from the additive blend + the layer blur), so a 1-px
 * tall strip is all the GPU needs and keeps the upload tiny, matching Gource's
 * 128x1 `beam.png`. The falloff is a smooth bell (a raised cosine) so the core blooms
 * and the ends fade with no hard seam.
 */
export function buildBeamTexture(renderer: Renderer): Texture {
  const graphics = new Graphics()

  // Paint the strip one vertical column at a time, each column's alpha following a
  // raised-cosine bell: 0 at both ends, 1 at the center. Stacking thin opaque columns
  // approximates the smooth 1D gradient of Gource's beam.png without a 2D canvas
  // context the WebGL/WebGPU backend may not expose.
  for (let column = 0; column < BEAM_TEXTURE_LENGTH; column++) {
    const position = column / (BEAM_TEXTURE_LENGTH - 1)
    // Raised cosine: peaks at the midpoint, falls smoothly to 0 at both ends.
    const alpha = 0.5 - 0.5 * Math.cos(position * Math.PI * 2)
    graphics
      .rect(column, 0, 1, BEAM_TEXTURE_THICKNESS)
      .fill({ color: 0xffffff, alpha })
  }

  return renderer.generateTexture(graphics)
}

/**
 * The length, in texels, of the baked beam-gradient strip (its long, gradient axis).
 * Mirrors Gource's 128-wide `beam.png`: enough samples that stretching it along a
 * beam stays a smooth bell, while the strip stays a one-time, near-free GPU upload.
 */
export const BEAM_TEXTURE_LENGTH = 128

/**
 * The thickness, in texels, of the baked beam strip (its short axis). Gource's beam is
 * a single row; a few texels here just give `generateTexture` a non-degenerate height
 * to rasterize, and the sprite scales this to the drawn beam width regardless.
 */
const BEAM_TEXTURE_THICKNESS = 4

/**
 * The radius, in texture pixels, the glow texture is generated at. Large enough
 * that scaling it up per node stays smooth, small enough to keep the one-time
 * GPU upload cheap. Node sprites scale this to the node's glow size, so the
 * absolute value only sets the texture's internal resolution. Exported so a
 * sprite consumer can map texture pixels to world units without guessing.
 */
export const GLOW_TEXTURE_RADIUS = 128

/**
 * How many concentric rings approximate the radial gradient. More rings is a
 * smoother falloff at a higher one-time draw cost; the texture is built once, so
 * this is generous enough to read as a continuous gradient after blur + scale.
 */
const GLOW_RING_COUNT = 48

/**
 * Peak per-ring opacity. The rings stack, so this is kept low and the squared
 * falloff plus the ring count accumulate it toward ~1 at the center, giving a
 * bright core that trails off softly without a single ring reading as a hard edge.
 */
const GLOW_RING_ALPHA = 0.10
