// Copyright © 2026 Jalapeno Labs

import type { TreeNode, NodeStatus } from '../core/tree'

// Core
import { describe, expect, it } from 'vitest'

import { defaultTheme, colorForPath } from '../core/theme'
import { nodeVisualFor } from './nodeVisual'

/**
 * Builds a bare {@link TreeNode} for the visual model to consume. Only the fields
 * the model reads are required; the rest get sane defaults. `isFile` defaults to
 * true because most cases under test are files.
 */
function makeNode(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    name: overrides.name ?? 'main.ts',
    path: overrides.path ?? 'repo/src/main.ts',
    isFile: overrides.isFile ?? true,
    children: overrides.children ?? new Map(),
    status: overrides.status ?? 'discovered',
    touchCount: overrides.touchCount ?? 0,
    lastTouchedAt: overrides.lastTouchedAt ?? null,
  }
}

describe('nodeVisualFor', () => {
  describe('every persistent node is fully opaque (no opacity differences)', () => {
    it('renders a seeded node at full opacity, identical to a discovered one', () => {
      // The user's complaint: faint, low-opacity "connecting" nodes. A seeded node
      // must NOT be dimmed; it is full opacity just like a discovered one, so an
      // edge always terminates in a clearly visible dot. Nodes differ by color and
      // size, never by opacity.
      const seeded = makeNode({ status: 'seeded' })
      const discovered = makeNode({ status: 'discovered' })

      const seededVisual = nodeVisualFor(seeded, 1000, defaultTheme)
      const discoveredVisual = nodeVisualFor(discovered, 1000, defaultTheme)

      expect(seededVisual.alpha).toBe(1)
      expect(discoveredVisual.alpha).toBe(1)
    })

    it('renders a directory at full opacity too', () => {
      const directory = makeNode({ status: 'seeded', isFile: false, path: 'repo/src', name: 'src' })
      expect(nodeVisualFor(directory, 1000, defaultTheme).alpha).toBe(1)
    })

    it('keeps a deleted node fully opaque, leaving it by shrinking rather than fading', () => {
      // Even a deleted node never goes semi-transparent: it stays at alpha 1 and
      // leaves the scene by shrinking its radius to zero, so no faint disc lingers.
      const deletedAt = 5000
      const deleted = makeNode({ status: 'deleted', lastTouchedAt: deletedAt, touchCount: 3 })

      const atDelete = nodeVisualFor(deleted, deletedAt, defaultTheme, { deleteShrinkMs: 400 })
      const midShrink = nodeVisualFor(deleted, deletedAt + 200, defaultTheme, { deleteShrinkMs: 400 })

      expect(atDelete.alpha).toBe(1)
      expect(midShrink.alpha).toBe(1)
    })
  })

  describe('a deleted node leaves by shrinking its radius to zero', () => {
    it('shrinks the radius from its baseline to zero across the shrink window', () => {
      const deletedAt = 5000
      const deleteShrinkMs = 400
      const deleted = makeNode({ status: 'deleted', lastTouchedAt: deletedAt, touchCount: 3 })

      const atDelete = nodeVisualFor(deleted, deletedAt, defaultTheme, { deleteShrinkMs })
      const midShrink = nodeVisualFor(deleted, deletedAt + deleteShrinkMs / 2, defaultTheme, { deleteShrinkMs })
      const atEnd = nodeVisualFor(deleted, deletedAt + deleteShrinkMs, defaultTheme, { deleteShrinkMs })

      // Shrinking: largest at the delete instant, smaller halfway, zero at the end.
      expect(atDelete.radius).toBeGreaterThan(midShrink.radius)
      expect(midShrink.radius).toBeGreaterThan(atEnd.radius)
      expect(atEnd.radius).toBe(0)
    })

    it('clamps a deleted node past its shrink window to zero radius, not negative', () => {
      const deleted = makeNode({ status: 'deleted', lastTouchedAt: 1000 })
      const visual = nodeVisualFor(deleted, 1000 + 10_000, defaultTheme, { deleteShrinkMs: 400 })
      expect(visual.radius).toBe(0)
    })

    it('does not shrink a persistent (non-deleted) node', () => {
      const seeded = makeNode({ status: 'seeded', touchCount: 3, lastTouchedAt: 1000 })
      const discovered = makeNode({ status: 'discovered', touchCount: 3, lastTouchedAt: 1000 })

      // Sampled well past any pulse window so only the (absent) shrink could differ.
      const seededVisual = nodeVisualFor(seeded, 1_000_000, defaultTheme)
      const discoveredVisual = nodeVisualFor(discovered, 1_000_000, defaultTheme)

      expect(seededVisual.radius).toBeGreaterThan(0)
      expect(seededVisual.radius).toBeCloseTo(discoveredVisual.radius, 5)
    })
  })

  describe('touch flash drives brightness', () => {
    it('makes a freshly touched node brighter than an idle one', () => {
      const now = 10_000
      // Same touch count so heat baselines match; only the recency of the touch differs.
      const justTouched = makeNode({ touchCount: 2, lastTouchedAt: now })
      const idle = makeNode({ touchCount: 2, lastTouchedAt: now - 1_000_000 })

      const freshVisual = nodeVisualFor(justTouched, now, defaultTheme)
      const idleVisual = nodeVisualFor(idle, now, defaultTheme)

      expect(freshVisual.brightness).toBeGreaterThan(idleVisual.brightness)
    })

    it('decays the flash back toward baseline as time passes', () => {
      const touchedAt = 10_000
      const flashMs = 1_200
      const node = makeNode({ touchCount: 2, lastTouchedAt: touchedAt })

      const atTouch = nodeVisualFor(node, touchedAt, defaultTheme, { flashMs })
      const partway = nodeVisualFor(node, touchedAt + flashMs / 2, defaultTheme, { flashMs })
      const afterFlash = nodeVisualFor(node, touchedAt + flashMs, defaultTheme, { flashMs })

      expect(atTouch.brightness).toBeGreaterThan(partway.brightness)
      expect(partway.brightness).toBeGreaterThan(afterFlash.brightness)
    })

    it('decays the flash to EXACTLY zero by the end of the window, leaving no ring', () => {
      // The user's complaint: the middle effect "never fully dissolves / lingers
      // too long". When the heat baseline is zero, the flash is the only thing
      // lifting brightness/glow, so at exactly flashMs both must hit precisely zero,
      // proving the flash leaves nothing behind. We zero the heat by using a node
      // with no touch-count heat and a cooling window no longer than the flash, so
      // by flashMs the recency heat has also decayed to zero.
      const touchedAt = 10_000
      const flashMs = 1_200
      // touchCount 0 -> no touch heat; coolingMs 1000 (< flashMs) -> recency heat is
      // 0 by the time the flash window ends. So heat is exactly 0 at flashMs.
      const node = makeNode({ touchCount: 0, lastTouchedAt: touchedAt })

      const midFlash = nodeVisualFor(node, touchedAt + flashMs / 2, defaultTheme, { flashMs, heat: { coolingMs: 1000 }})
      const atEnd = nodeVisualFor(node, touchedAt + flashMs, defaultTheme, { flashMs, heat: { coolingMs: 1000 }})

      // The flash is clearly present partway through...
      expect(midFlash.brightness).toBeGreaterThan(0)
      expect(midFlash.glow).toBeGreaterThan(0)
      // ...and is GONE (exactly zero, not a floor) at the end of the window.
      expect(atEnd.brightness).toBe(0)
      expect(atEnd.glow).toBe(0)
    })

    it('leaves a fully idle, cold node with no glow and no brightness at all', () => {
      // The settled state the user wants: a node with no heat at all (never carrying
      // touch-count heat and well past any flash) is just its core. Both the glow
      // sprite strength and the white-lift brightness are zero, so nothing renders a
      // lingering half-faded ring.
      const node = makeNode({ touchCount: 0, lastTouchedAt: 0 })
      // now is far past the flash window, so the flash contributes nothing and the
      // zero touch-count leaves heat at zero.
      const visual = nodeVisualFor(node, 10_000_000, defaultTheme)

      expect(visual.brightness).toBe(0)
      expect(visual.glow).toBe(0)
    })

    it('never flashes a node that has never been touched', () => {
      const untouched = makeNode({ touchCount: 0, lastTouchedAt: null })
      const visual = nodeVisualFor(untouched, 10_000, defaultTheme)
      expect(visual.brightness).toBe(0)
    })

    it('clamps brightness to at most 1 even with an overdriven flash strength', () => {
      const node = makeNode({ touchCount: 10, lastTouchedAt: 10_000 })
      const visual = nodeVisualFor(node, 10_000, defaultTheme, { flashStrength: 5 })
      expect(visual.brightness).toBeLessThanOrEqual(1)
    })
  })

  describe('glow drives the soft glow sprite', () => {
    it('spikes the glow on a fresh touch above an idle node', () => {
      const now = 10_000
      const justTouched = makeNode({ touchCount: 2, lastTouchedAt: now })
      const idle = makeNode({ touchCount: 2, lastTouchedAt: now - 1_000_000 })

      const freshVisual = nodeVisualFor(justTouched, now, defaultTheme)
      const idleVisual = nodeVisualFor(idle, now, defaultTheme)

      expect(freshVisual.glow).toBeGreaterThan(idleVisual.glow)
    })

    it('keeps a faint STEADY glow on a hot idle node between touches', () => {
      // A busy file just outside its flash window still glows softly from heat, so
      // the forest reads as glowing even with the bloom post-process off. The flash
      // is gone (touch is well past flashMs) but the heat baseline carries a glow.
      const touchedAt = 10_000
      const flashMs = 1_200
      // Heavily touched, so touch-heat is high; sampled just past the flash window
      // but well within the cooling window so recency heat is still up.
      const node = makeNode({ touchCount: 12, lastTouchedAt: touchedAt })
      const visual = nodeVisualFor(node, touchedAt + flashMs + 1, defaultTheme, { flashMs })

      expect(visual.glow).toBeGreaterThan(0)
      // It is only a faint steady glow, not a full flare (the flash is what flares).
      expect(visual.glow).toBeLessThan(1)
    })

    it('decays the glow back down as the flash passes', () => {
      const touchedAt = 10_000
      const flashMs = 1_200
      const node = makeNode({ touchCount: 3, lastTouchedAt: touchedAt })

      const atTouch = nodeVisualFor(node, touchedAt, defaultTheme, { flashMs })
      const partway = nodeVisualFor(node, touchedAt + flashMs / 2, defaultTheme, { flashMs })

      expect(atTouch.glow).toBeGreaterThan(partway.glow)
    })

    it('clamps the glow to at most 1 even with an overdriven flash strength', () => {
      const node = makeNode({ touchCount: 10, lastTouchedAt: 10_000 })
      const visual = nodeVisualFor(node, 10_000, defaultTheme, { flashStrength: 5 })
      expect(visual.glow).toBeLessThanOrEqual(1)
    })
  })

  describe('radius pulses on a touch instead of growing cumulatively', () => {
    it('does NOT keep growing the resting radius with cumulative touch count', () => {
      // The user's complaint: "each modification increases the node size; it should
      // pulse instead." Sampled well past any pulse window, two heavily-edited files,
      // one edited 5x as much as the other, must rest at nearly the same size: the
      // saturating importance bump has plateaued, so the radius does not balloon.
      const restAt = 100_000
      const busy = makeNode({ touchCount: 20, lastTouchedAt: 0 })
      const frantic = makeNode({ touchCount: 100, lastTouchedAt: 0 })

      const busyVisual = nodeVisualFor(busy, restAt, defaultTheme)
      const franticVisual = nodeVisualFor(frantic, restAt, defaultTheme)

      // 5x the edits barely changes the resting size (the bump has saturated),
      // proving the radius is no longer a cumulative function of touch count.
      expect(Math.abs(franticVisual.radius - busyVisual.radius)).toBeLessThan(0.5)
    })

    it('spikes the radius right after a touch and eases it back to baseline', () => {
      const touchedAt = 10_000
      const pulseMs = 650
      const node = makeNode({ touchCount: 3, lastTouchedAt: touchedAt })

      const atTouch = nodeVisualFor(node, touchedAt, defaultTheme, { pulseMs })
      const partway = nodeVisualFor(node, touchedAt + pulseMs / 2, defaultTheme, { pulseMs })
      const atRest = nodeVisualFor(node, touchedAt + pulseMs, defaultTheme, { pulseMs })
      // The same node long after the touch, with no pulse contribution: the baseline.
      const wellAfter = nodeVisualFor(node, touchedAt + pulseMs * 10, defaultTheme, { pulseMs })

      // Biggest right at the touch, shrinking as the pulse eases off...
      expect(atTouch.radius).toBeGreaterThan(partway.radius)
      expect(partway.radius).toBeGreaterThan(atRest.radius)
      // ...and back at exactly baseline by the end of the pulse window (no lingering
      // swell), matching the long-after resting size.
      expect(atRest.radius).toBeCloseTo(wellAfter.radius, 5)
    })

    it('applies the pulse strength as a fraction of the baseline at the instant of a touch', () => {
      const touchedAt = 10_000
      const pulseMs = 650
      const node = makeNode({ touchCount: 3, lastTouchedAt: touchedAt })

      const baseline = nodeVisualFor(node, touchedAt + pulseMs * 10, defaultTheme, { pulseMs })
      const peaked = nodeVisualFor(node, touchedAt, defaultTheme, { pulseMs, pulseStrength: 0.6 })

      // At the touch the radius is (1 + pulseStrength) times the baseline.
      expect(peaked.radius).toBeCloseTo(baseline.radius * 1.6, 5)
    })

    it('does not pulse a node that has never been touched', () => {
      const node = makeNode({ touchCount: 0, lastTouchedAt: null })
      const baseline = nodeVisualFor(node, 10_000, defaultTheme)
      // An untouched node sits at its plain baseline with no pulse at all.
      const again = nodeVisualFor(node, 999_999, defaultTheme)
      expect(baseline.radius).toBeCloseTo(again.radius, 5)
    })
  })

  describe('color source differs by node kind', () => {
    it('colors a file from its extension', () => {
      const file = makeNode({ isFile: true, path: 'repo/src/main.ts' })
      const visual = nodeVisualFor(file, 1000, defaultTheme)
      expect(visual.color).toEqual(colorForPath('repo/src/main.ts'))
    })

    it('colors a directory from the neutral theme hub color, not its path', () => {
      const directory = makeNode({ isFile: false, path: 'repo/src', name: 'src' })
      const visual = nodeVisualFor(directory, 1000, defaultTheme)

      expect(visual.color).toEqual(defaultTheme.hub)
      expect(visual.color).not.toEqual(colorForPath('repo/src'))
    })

    it('makes a directory visually distinct from a same-named file', () => {
      // The whole point of the hub color: a folder and a file must never render
      // the same. A directory takes the neutral hub; a file takes its vivid
      // extension hue, so the two are clearly different colors.
      const directory = makeNode({ isFile: false, path: 'repo/src', name: 'src' })
      const file = makeNode({ isFile: true, path: 'repo/src/main.ts', name: 'main.ts' })

      const directoryVisual = nodeVisualFor(directory, 1000, defaultTheme)
      const fileVisual = nodeVisualFor(file, 1000, defaultTheme)

      expect(directoryVisual.color).not.toEqual(fileVisual.color)
      // And the directory reads as the desaturated hub, not a vivid file hue.
      expect(directoryVisual.color.s).toBeLessThan(fileVisual.color.s)
    })
  })

  describe('determinism', () => {
    it('is a pure function of its inputs', () => {
      const node = makeNode({ touchCount: 3, lastTouchedAt: 9500, status: 'discovered' })
      const first = nodeVisualFor(node, 10_000, defaultTheme)
      const second = nodeVisualFor(node, 10_000, defaultTheme)
      expect(first).toEqual(second)
    })
  })

  describe('all statuses produce a usable visual', () => {
    const statuses: NodeStatus[] = [ 'seeded', 'discovered', 'deleted' ]
    for (const status of statuses) {
      it(`returns finite, bounded params for a ${status} node`, () => {
        const touchedAt = 9000
        const node = makeNode({ status, touchCount: 2, lastTouchedAt: touchedAt })
        // Sample within the delete-shrink window so a deleted node still has a
        // positive (mid-shrink) radius; a fully-shrunk node would legitimately be 0.
        const visual = nodeVisualFor(node, touchedAt + 100, defaultTheme, { deleteShrinkMs: 400 })

        expect(Number.isFinite(visual.radius)).toBe(true)
        expect(visual.radius).toBeGreaterThan(0)
        // Every node is fully opaque now, persistent and deleted alike.
        expect(visual.alpha).toBe(1)
        expect(visual.brightness).toBeGreaterThanOrEqual(0)
        expect(visual.brightness).toBeLessThanOrEqual(1)
        expect(visual.glow).toBeGreaterThanOrEqual(0)
        expect(visual.glow).toBeLessThanOrEqual(1)
      })
    }
  })
})
