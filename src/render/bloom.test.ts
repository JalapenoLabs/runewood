// Copyright © 2026 Jalapeno Labs

// Core
import { describe, expect, it } from 'vitest'

import { bloomParametersFor, resolveBloomQuality } from './bloom'

describe('bloomParametersFor', () => {
  it('returns a fully zeroed pass for the off quality', () => {
    const parameters = bloomParametersFor('off', 0.65, 1.4)
    expect(parameters).toEqual({ threshold: 0, blur: 0, strength: 0, quality: 0 })
  })

  it('gives each quality level distinct, sensible parameters', () => {
    const off = bloomParametersFor('off', 0.65, 1.4)
    const low = bloomParametersFor('low', 0.65, 1.4)
    const high = bloomParametersFor('high', 0.65, 1.4)

    // off draws nothing extra.
    expect(off.strength).toBe(0)
    expect(off.blur).toBe(0)
    expect(off.quality).toBe(0)

    // low is a real pass: positive strength, blur, and at least one blur pass.
    expect(low.strength).toBeGreaterThan(0)
    expect(low.blur).toBeGreaterThan(0)
    expect(low.quality).toBeGreaterThan(0)

    // high trades cost for fidelity: stronger glow, wider halo, more blur passes.
    expect(high.strength).toBeGreaterThan(low.strength)
    expect(high.blur).toBeGreaterThan(low.blur)
    expect(high.quality).toBeGreaterThan(low.quality)
  })

  it('raises strength as the theme bloom intensity rises', () => {
    const dim = bloomParametersFor('high', 0.2, 1.4)
    const bright = bloomParametersFor('high', 0.9, 1.4)

    expect(bright.strength).toBeGreaterThan(dim.strength)
    // A brighter theme also spreads its light further.
    expect(bright.blur).toBeGreaterThan(dim.blur)
  })

  it('yields no glow at zero intensity even when the quality is on', () => {
    const parameters = bloomParametersFor('high', 0, 1.4)
    // Strength scales linearly with intensity, so a zero-intensity theme adds no
    // glow back, but the pass is still configured (a non-zero blur kernel).
    expect(parameters.strength).toBe(0)
    expect(parameters.quality).toBeGreaterThan(0)
  })

  it('clamps an out-of-range intensity instead of producing a runaway glow', () => {
    const overdriven = bloomParametersFor('high', 5, 1.4)
    const clampedToOne = bloomParametersFor('high', 1, 1.4)
    expect(overdriven).toEqual(clampedToOne)

    const negative = bloomParametersFor('high', -3, 1.4)
    const clampedToZero = bloomParametersFor('high', 0, 1.4)
    expect(negative).toEqual(clampedToZero)
  })

  it('lifts the bright-pass threshold for a tighter (higher falloff) halo', () => {
    const spreading = bloomParametersFor('high', 0.65, 1.0)
    const tight = bloomParametersFor('high', 0.65, 2.1)

    // A tighter halo keeps the glow on the hottest cores by demanding a brighter
    // pixel before it blooms.
    expect(tight.threshold).toBeGreaterThan(spreading.threshold)
  })

  it('keeps the threshold within its configured band for extreme falloff', () => {
    const veryTight = bloomParametersFor('high', 0.65, 100)
    const veryLoose = bloomParametersFor('high', 0.65, 0.01)

    // The band was lowered (was 0.3..0.8) so the bright pass actually catches the
    // glowing nodes; even the tightest halo never demands a brighter-than-0.5
    // pixel, and the loosest never drops below 0.15.
    expect(veryTight.threshold).toBeLessThanOrEqual(0.5)
    expect(veryLoose.threshold).toBeGreaterThanOrEqual(0.15)
  })

  it('keeps the bright-pass threshold low enough that the glow actually reads', () => {
    // The user could not tell bloom on from off because the old threshold (up to
    // 0.8) left almost nothing crossing the bright pass. For the built-in themes
    // (falloff ~1.0..2.1) the threshold must now stay well below that old ceiling
    // so the hot cores genuinely bloom.
    const dusk = bloomParametersFor('high', 0.65, 1.4)
    const voidTheme = bloomParametersFor('high', 0.85, 2.1)

    expect(dusk.threshold).toBeLessThan(0.5)
    expect(voidTheme.threshold).toBeLessThan(0.5)
  })

  it('makes high quality unmistakably more luminous than low, not just smoother', () => {
    const low = bloomParametersFor('high', 0.65, 1.4)
    const lowQuality = bloomParametersFor('low', 0.65, 1.4)

    // High's composite strength is well above low's (more than a hair), so
    // switching to high is a clear glow jump, exactly the user's ask.
    expect(low.strength).toBeGreaterThan(lowQuality.strength * 1.5)
  })

  it('produces a wide, smooth blur so the glow reads as a soft haze, not a hard ring', () => {
    // The user saw a crisp lighter ring with no blur radius. The fix widened the
    // blur kernel and raised the pass count hard, so a high-quality glow must now be
    // a genuinely large, multi-pass blur rather than the old narrow one.
    const high = bloomParametersFor('high', 0.65, 1.4)

    // A wide kernel: well past the node's own halo disc so the light bleeds out.
    expect(high.blur).toBeGreaterThanOrEqual(32)
    // Many passes so the blur is smooth, not banded into a visible ring.
    expect(high.quality).toBeGreaterThanOrEqual(10)
  })

  it('widens the blur further as the theme bloom intensity rises', () => {
    const dim = bloomParametersFor('high', 0.1, 1.4)
    const bright = bloomParametersFor('high', 1, 1.4)

    // The intensity spread was widened, so a full-intensity theme spreads its light
    // substantially further than a dim one, deepening the soft-haze look.
    expect(bright.blur - dim.blur).toBeGreaterThanOrEqual(10)
  })
})

describe('resolveBloomQuality', () => {
  const normalDevice = { prefersReducedMotion: false, lowPower: false }

  it('honors the requested quality on a normal, capable device', () => {
    expect(resolveBloomQuality('high', normalDevice)).toBe('high')
    expect(resolveBloomQuality('low', normalDevice)).toBe('low')
    expect(resolveBloomQuality('off', normalDevice)).toBe('off')
  })

  it('forces bloom fully off under reduced motion regardless of request', () => {
    const reducedMotion = { prefersReducedMotion: true, lowPower: false }
    expect(resolveBloomQuality('high', reducedMotion)).toBe('off')
    expect(resolveBloomQuality('low', reducedMotion)).toBe('off')
    expect(resolveBloomQuality('off', reducedMotion)).toBe('off')
  })

  it('lets reduced motion win even on an otherwise capable device', () => {
    const reducedMotionLowPower = { prefersReducedMotion: true, lowPower: true }
    expect(resolveBloomQuality('high', reducedMotionLowPower)).toBe('off')
  })

  it('caps a low-power device at low quality instead of high', () => {
    const lowPower = { prefersReducedMotion: false, lowPower: true }
    expect(resolveBloomQuality('high', lowPower)).toBe('low')
  })

  it('leaves an already-cheap request untouched on a low-power device', () => {
    const lowPower = { prefersReducedMotion: false, lowPower: true }
    expect(resolveBloomQuality('low', lowPower)).toBe('low')
    expect(resolveBloomQuality('off', lowPower)).toBe('off')
  })
})
