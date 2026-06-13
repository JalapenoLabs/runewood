// Copyright © 2026 Jalapeno Labs

import type { Hsl } from './theme'

// Core
import { describe, expect, it } from 'vitest'

// Subject under test
import {
  colorForActor,
  colorForPath,
  defaultTheme,
  mergeTheme,
  themes,
} from './theme'

/** The fixed saturation/lightness every generated node/actor hue is rendered at. */
const EXPECTED_NODE_SATURATION = 0.62
const EXPECTED_NODE_LIGHTNESS = 0.55

function expectValidHue(color: Hsl): void {
  expect(color.h).toBeGreaterThanOrEqual(0)
  expect(color.h).toBeLessThan(360)
  expect(Number.isFinite(color.h)).toBe(true)
}

describe('colorForPath', () => {
  it('maps a curated extension to its intentional hue', () => {
    // TypeScript is pinned to blue (211) in the curated table, regardless of
    // how deep the path is.
    expect(colorForPath('seraphim/api/src/main.ts').h).toBe(211)
    expect(colorForPath('index.ts').h).toBe(211)
  })

  it('maps every distinct curated extension to a distinct, fixed-vividness color', () => {
    const rustColor = colorForPath('api/src/lib.rs')
    const goColor = colorForPath('cmd/main.go')
    const pythonColor = colorForPath('scripts/build.py')

    // Different languages must read as different colors.
    expect(rustColor.h).not.toBe(goColor.h)
    expect(goColor.h).not.toBe(pythonColor.h)
    expect(rustColor.h).not.toBe(pythonColor.h)

    // Only the hue varies; saturation and lightness are pinned so the palette
    // stays at one consistent vividness.
    for (const color of [ rustColor, goColor, pythonColor ]) {
      expect(color.s).toBe(EXPECTED_NODE_SATURATION)
      expect(color.l).toBe(EXPECTED_NODE_LIGHTNESS)
    }
  })

  it('is case-insensitive on the extension', () => {
    expect(colorForPath('src/App.TS')).toEqual(colorForPath('src/app.ts'))
    expect(colorForPath('README.MD')).toEqual(colorForPath('readme.md'))
  })

  it('gives unknown extensions a stable color across repeated calls', () => {
    const first = colorForPath('weird/file.zonk')
    const second = colorForPath('weird/file.zonk')
    expect(first).toEqual(second)
    expectValidHue(first)
  })

  it('keys the unknown-extension color off the extension, not the full path', () => {
    // Two different files sharing an unknown extension must share a color, just
    // like the curated languages do.
    const oneZonk = colorForPath('a/one.zonk')
    const otherZonk = colorForPath('b/c/other.zonk')
    expect(oneZonk).toEqual(otherZonk)
  })

  it('gives extension-less files a stable color hashed from the whole path', () => {
    const makefile = colorForPath('build/Makefile')
    expect(makefile).toEqual(colorForPath('build/Makefile'))
    expectValidHue(makefile)

    // Different extension-less files hash their distinct paths, so they differ.
    expect(colorForPath('build/Makefile').h).not.toBe(colorForPath('LICENSE').h)
  })

  it('treats a leading-dot dotfile as its own extension', () => {
    // `.env` is curated (hue 60); the dotfile name itself is the extension.
    expect(colorForPath('.env').h).toBe(60)
    expect(colorForPath('config/.env')).toEqual(colorForPath('.env'))
  })

  it('always returns a hue within [0, 360)', () => {
    const samplePaths = [
      'src/index.ts',
      'a/b/c/deeply/nested/file.unknownext',
      'no-extension-file',
      '.gitignore',
      'x.go',
    ]
    for (const samplePath of samplePaths) {
      expectValidHue(colorForPath(samplePath))
    }
  })
})

describe('colorForActor', () => {
  it('gives the same actor the same color every time', () => {
    expect(colorForActor('claude-agent')).toEqual(colorForActor('claude-agent'))
  })

  it('gives different actors different, well-distributed hues', () => {
    const actorNames = [ 'alice', 'bob', 'carol', 'dave', 'erin', 'frank' ]
    const hues = actorNames.map((actorName) => colorForActor(actorName).h)

    // No two of this sample collide: the hash spreads them around the wheel.
    const uniqueHues = new Set(hues)
    expect(uniqueHues.size).toBe(actorNames.length)
  })

  it('renders actors at the same fixed vividness as file nodes', () => {
    const actorColor = colorForActor('some-actor')
    expect(actorColor.s).toBe(EXPECTED_NODE_SATURATION)
    expect(actorColor.l).toBe(EXPECTED_NODE_LIGHTNESS)
    expectValidHue(actorColor)
  })
})

describe('built-in themes', () => {
  it('exposes the three documented themes by name', () => {
    expect(Object.keys(themes).sort()).toEqual([ 'dusk', 'parchment', 'void' ])
    expect(themes.dusk.name).toBe('dusk')
    expect(themes.void.name).toBe('void')
    expect(themes.parchment.name).toBe('parchment')
  })

  it('defaults to dusk', () => {
    expect(defaultTheme).toBe(themes.dusk)
  })
})

describe('mergeTheme', () => {
  it('returns the base unchanged when no overrides are given', () => {
    const merged = mergeTheme(themes.dusk)
    expect(merged).toEqual(themes.dusk)
  })

  it('overrides only the supplied scalar fields and keeps the rest', () => {
    const merged = mergeTheme(themes.dusk, { bloomIntensity: 0.1 })
    expect(merged.bloomIntensity).toBe(0.1)
    // Untouched fields are inherited verbatim.
    expect(merged.glowFalloff).toBe(themes.dusk.glowFalloff)
    expect(merged.background).toEqual(themes.dusk.background)
    expect(merged.name).toBe(themes.dusk.name)
  })

  it('merges a partial Hsl override per channel, keeping untouched channels', () => {
    const merged = mergeTheme(themes.dusk, { background: { h: 10 }})
    expect(merged.background.h).toBe(10)
    // Saturation and lightness fall through from the base background.
    expect(merged.background.s).toBe(themes.dusk.background.s)
    expect(merged.background.l).toBe(themes.dusk.background.l)
  })

  it('does not mutate the base theme', () => {
    const baseSnapshot = structuredClone(themes.dusk)
    mergeTheme(themes.dusk, { background: { h: 123 }, bloomIntensity: 0.01 })
    expect(themes.dusk).toEqual(baseSnapshot)
  })

  it('lets a caller fully re-theme by stacking overrides', () => {
    const merged = mergeTheme(themes.void, {
      name: 'custom',
      label: { h: 200, s: 0.5, l: 0.5 },
      glowFalloff: 3.3,
    })
    expect(merged.name).toBe('custom')
    expect(merged.label).toEqual({ h: 200, s: 0.5, l: 0.5 })
    expect(merged.glowFalloff).toBe(3.3)
    // The fields not overridden still come from the void base.
    expect(merged.background).toEqual(themes.void.background)
    expect(merged.bloomIntensity).toBe(themes.void.bloomIntensity)
  })
})
