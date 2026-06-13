// Copyright © 2026 Jalapeno Labs

// Core
import { describe, expect, it } from 'vitest'

import { defaultTheme } from '../core/theme'
import { edgeVisualFor } from './edgeVisual'

describe('edgeVisualFor', () => {
  it('takes its color from the theme branch color', () => {
    const visual = edgeVisualFor(1, defaultTheme)
    expect(visual.color).toEqual(defaultTheme.branch)
  })

  it('thins and fades branches as depth increases, so deep trees stay readable', () => {
    const trunk = edgeVisualFor(1, defaultTheme)
    const mid = edgeVisualFor(3, defaultTheme)
    const deep = edgeVisualFor(6, defaultTheme)

    expect(mid.thickness).toBeLessThan(trunk.thickness)
    expect(deep.thickness).toBeLessThan(mid.thickness)

    expect(mid.alpha).toBeLessThan(trunk.alpha)
    expect(deep.alpha).toBeLessThan(mid.alpha)
  })

  it('floors thickness and alpha so a very deep branch never vanishes entirely', () => {
    const veryDeep = edgeVisualFor(40, defaultTheme, {
      minThickness: 0.5,
      minAlpha: 0.12,
    })
    expect(veryDeep.thickness).toBe(0.5)
    expect(veryDeep.alpha).toBe(0.12)
  })

  it('keeps the depth-1 branch at the base thickness and alpha', () => {
    const visual = edgeVisualFor(1, defaultTheme, {
      baseThickness: 2.4,
      baseAlpha: 0.5,
    })
    expect(visual.thickness).toBeCloseTo(2.4, 5)
    expect(visual.alpha).toBeCloseTo(0.5, 5)
  })

  it('clamps an invalid depth below 1 up to the strongest branch', () => {
    const clamped = edgeVisualFor(0, defaultTheme)
    const trunk = edgeVisualFor(1, defaultTheme)
    expect(clamped).toEqual(trunk)
  })

  it('is a pure function of its inputs', () => {
    const first = edgeVisualFor(4, defaultTheme)
    const second = edgeVisualFor(4, defaultTheme)
    expect(first).toEqual(second)
  })
})
