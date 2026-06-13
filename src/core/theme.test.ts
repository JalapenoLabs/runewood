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
const EXPECTED_NODE_SATURATION = 0.85
const EXPECTED_NODE_LIGHTNESS = 0.58

function expectValidHue(color: Hsl): void {
  expect(color.h).toBeGreaterThanOrEqual(0)
  expect(color.h).toBeLessThan(360)
  expect(Number.isFinite(color.h)).toBe(true)
}

describe('colorForPath', () => {
  it('maps a curated extension to its intentional hue', () => {
    // TypeScript is pinned to blue (210) in the curated table, regardless of
    // how deep the path is.
    expect(colorForPath('seraphim/api/src/main.ts').h).toBe(210)
    expect(colorForPath('index.ts').h).toBe(210)
  })

  it('keeps the common languages on vivid, well-separated hues', () => {
    // The curated palette must keep the languages a viewer sees most far enough
    // apart that neighbors never collapse into one indistinguishable color. We
    // assert a real minimum spacing between every pair of the headline extensions
    // rather than just "they differ", so a future retune cannot quietly crowd two
    // of them back together.
    const headlineExtensions = [ 'ts', 'js', 'py', 'rs', 'go', 'rb', 'json', 'css', 'md', 'sh' ]
    const headlinePaths = headlineExtensions.map((extension) => `sample.${extension}`)
    const hues = headlinePaths.map((samplePath) => colorForPath(samplePath).h)

    const minSeparationDegrees = 12
    for (let outer = 0; outer < hues.length; outer++) {
      for (let inner = outer + 1; inner < hues.length; inner++) {
        // Compare around the wheel, so 350 and 5 read as 15 degrees apart, not 345.
        const rawDelta = Math.abs(hues[outer] - hues[inner])
        const wheelDelta = Math.min(rawDelta, 360 - rawDelta)
        expect(wheelDelta).toBeGreaterThanOrEqual(minSeparationDegrees)
      }
    }
  })

  it('renders curated file colors at the high, vivid saturation', () => {
    // The bump to a vivid palette must actually reach the file colors, not just
    // the constant: a curated language should come back fully saturated.
    const typescript = colorForPath('src/main.ts')
    expect(typescript.s).toBe(EXPECTED_NODE_SATURATION)
    expect(typescript.l).toBe(EXPECTED_NODE_LIGHTNESS)
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
    // `.env` is curated (hue 58); the dotfile name itself is the extension.
    expect(colorForPath('.env').h).toBe(58)
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

  it('gives every theme a neutral hub clearly less saturated than its files', () => {
    // The hub (directory) color is the folder-vs-file cue: it must stay
    // desaturated so a directory never competes with the vivid file nodes. We
    // assert it against the file saturation rather than a hard-coded number so the
    // contract survives a future palette retune.
    for (const theme of Object.values(themes)) {
      expect(theme.hub.s).toBeLessThan(EXPECTED_NODE_SATURATION)
    }
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

  it('merges a partial hub override per channel like the other colors', () => {
    const merged = mergeTheme(themes.dusk, { hub: { h: 120 }})
    expect(merged.hub.h).toBe(120)
    // The untouched hub channels fall through from the base.
    expect(merged.hub.s).toBe(themes.dusk.hub.s)
    expect(merged.hub.l).toBe(themes.dusk.hub.l)
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
