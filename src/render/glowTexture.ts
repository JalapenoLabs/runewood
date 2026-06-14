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
