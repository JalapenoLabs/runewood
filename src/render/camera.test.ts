// Copyright © 2026 Jalapeno Labs

import type { WorldBounds, Viewport, ZoomLimits } from './camera'

// Core
import { describe, expect, it } from 'vitest'

// Subject under test
import { Camera, computeFrameTransform, autoFrame } from './camera'

/** A standard test viewport: a plain 800x600 surface. */
const VIEWPORT: Viewport = { width: 800, height: 600 }

/** Asserts two points are equal within floating-point tolerance. */
function expectPointClose(actual: { x: number, y: number }, expected: { x: number, y: number }): void {
  expect(actual.x).toBeCloseTo(expected.x, 6)
  expect(actual.y).toBeCloseTo(expected.y, 6)
}

describe('Camera', () => {
  describe('worldToScreen / screenToWorld round-trip', () => {
    // Sweep a spread of pan and zoom values; for each, every probe point must
    // survive a world -> screen -> world round-trip unchanged. This is the core
    // invariant the whole renderer relies on for hit-testing and panning.
    const panZoomCases = [
      { center: { x: 0, y: 0 }, zoom: 1 },
      { center: { x: 100, y: -50 }, zoom: 1 },
      { center: { x: -250, y: 375 }, zoom: 2.5 },
      { center: { x: 12.5, y: 9001 }, zoom: 0.25 },
      { center: { x: -1000, y: -1000 }, zoom: 7.3 },
    ]

    const probePoints = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: -640, y: 480 },
      { x: 333.33, y: -127.7 },
    ]

    for (const { center, zoom } of panZoomCases) {
      it(`round-trips world points at center=(${center.x},${center.y}) zoom=${zoom}`, () => {
        const camera = new Camera({ center, zoom, viewport: VIEWPORT })

        for (const worldPoint of probePoints) {
          const screen = camera.worldToScreen(worldPoint)
          const backToWorld = camera.screenToWorld(screen)
          expectPointClose(backToWorld, worldPoint)
        }
      })

      it(`round-trips screen points at center=(${center.x},${center.y}) zoom=${zoom}`, () => {
        const camera = new Camera({ center, zoom, viewport: VIEWPORT })

        // The reverse direction must hold too: an arbitrary pixel unprojected
        // then re-projected lands back on itself.
        const screenProbes = [
          { x: 0, y: 0 },
          { x: 400, y: 300 },
          { x: 799, y: 1 },
          { x: 123.4, y: 567.8 },
        ]
        for (const screenPoint of screenProbes) {
          const world = camera.screenToWorld(screenPoint)
          const backToScreen = camera.worldToScreen(world)
          expectPointClose(backToScreen, screenPoint)
        }
      })
    }

    it('places the camera center at the exact viewport center on screen', () => {
      const camera = new Camera({ center: { x: 42, y: -17 }, zoom: 3, viewport: VIEWPORT })
      const screen = camera.worldToScreen({ x: 42, y: -17 })
      expectPointClose(screen, { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 })
    })
  })

  describe('panByScreen', () => {
    it('moves the world to follow the cursor and scales the shift by zoom', () => {
      const camera = new Camera({ center: { x: 0, y: 0 }, zoom: 2, viewport: VIEWPORT })

      // Dragging 100px right + 40px down moves center by the negated, zoom-scaled
      // delta so the grabbed world point appears to follow the pointer.
      camera.panByScreen(100, 40)
      expectPointClose(camera.center, { x: -50, y: -20 })
    })

    it('keeps a world point pinned under the cursor across a pan', () => {
      const camera = new Camera({ center: { x: 10, y: 10 }, zoom: 1.5, viewport: VIEWPORT })
      const anchorScreen = { x: 200, y: 200 }
      const worldUnderCursorBefore = camera.screenToWorld(anchorScreen)

      // A drag should slide that same world point by exactly the screen delta.
      camera.panByScreen(30, -25)
      const screenAfter = camera.worldToScreen(worldUnderCursorBefore)
      expectPointClose(screenAfter, { x: anchorScreen.x + 30, y: anchorScreen.y - 25 })
    })
  })

  describe('zoomBy', () => {
    it('keeps the anchored world point fixed on screen while zooming in', () => {
      const camera = new Camera({ center: { x: 0, y: 0 }, zoom: 1, viewport: VIEWPORT })
      const anchor = { x: 600, y: 150 }
      const worldUnderAnchorBefore = camera.screenToWorld(anchor)

      camera.zoomBy(2, anchor)

      expect(camera.zoom).toBeCloseTo(2, 6)
      // The world point that was under the cursor must still project to the cursor.
      const projected = camera.worldToScreen(worldUnderAnchorBefore)
      expectPointClose(projected, anchor)
    })

    it('clamps zoom to the configured limits and still holds the anchor', () => {
      const zoomLimits: ZoomLimits = { min: 0.5, max: 4 }
      const camera = new Camera({ center: { x: 0, y: 0 }, zoom: 1, viewport: VIEWPORT, zoomLimits })
      const anchor = { x: 100, y: 500 }
      const worldUnderAnchorBefore = camera.screenToWorld(anchor)

      // Ask for 100x; it must clamp to the max of 4 and keep the anchor pinned
      // under the clamped zoom (no drift at the limit).
      camera.zoomBy(100, anchor)

      expect(camera.zoom).toBe(4)
      const projected = camera.worldToScreen(worldUnderAnchorBefore)
      expectPointClose(projected, anchor)
    })

    it('clamps the initial zoom passed to the constructor', () => {
      const camera = new Camera({ zoom: 999, zoomLimits: { min: 0.1, max: 10 }})
      expect(camera.zoom).toBe(10)
    })
  })

  describe('frameBounds', () => {
    it('frames bounds so their projected screen extent fits inside the viewport', () => {
      const camera = new Camera({ viewport: VIEWPORT })
      const bounds: WorldBounds = { min: { x: -100, y: -50 }, max: { x: 100, y: 50 }}

      camera.frameBounds(bounds)

      // Every corner of the world bounds must land within the viewport.
      const corners = boundsCorners(bounds)
      for (const corner of corners) {
        const screen = camera.worldToScreen(corner)
        expect(screen.x).toBeGreaterThanOrEqual(0)
        expect(screen.x).toBeLessThanOrEqual(VIEWPORT.width)
        expect(screen.y).toBeGreaterThanOrEqual(0)
        expect(screen.y).toBeLessThanOrEqual(VIEWPORT.height)
      }
    })

    it('centers the view on the midpoint of the framed bounds', () => {
      const camera = new Camera({ viewport: VIEWPORT })
      const bounds: WorldBounds = { min: { x: 20, y: 40 }, max: { x: 120, y: 240 }}

      camera.frameBounds(bounds)
      expectPointClose(camera.center, { x: 70, y: 140 })
    })
  })
})

describe('computeFrameTransform', () => {
  it('picks the tighter axis so both axes fit (wide bounds are width-limited)', () => {
    // A region far wider than tall must be limited by width: the resulting zoom
    // is the usable width over the world width.
    const bounds: WorldBounds = { min: { x: 0, y: 0 }, max: { x: 1000, y: 10 }}
    const padding = 0.1
    const { zoom } = computeFrameTransform(bounds, VIEWPORT, { min: 0.001, max: 1000 }, padding)

    const usableWidth = VIEWPORT.width * (1 - padding * 2)
    expect(zoom).toBeCloseTo(usableWidth / 1000, 6)
  })

  it('clamps the fit zoom to the zoom limits for a tiny region', () => {
    // A pinhead region would demand an enormous zoom; it must clamp to max.
    const bounds: WorldBounds = { min: { x: 0, y: 0 }, max: { x: 0.001, y: 0.001 }}
    const zoomLimits: ZoomLimits = { min: 0.5, max: 8 }
    const { zoom } = computeFrameTransform(bounds, VIEWPORT, zoomLimits)
    expect(zoom).toBe(zoomLimits.max)
  })

  it('degrades gracefully on a zero-area region (pins to max zoom, centers on the point)', () => {
    const point = { x: 5, y: -3 }
    const bounds: WorldBounds = { min: point, max: point }
    const zoomLimits: ZoomLimits = { min: 0.25, max: 16 }
    const { center, zoom } = computeFrameTransform(bounds, VIEWPORT, zoomLimits)

    expect(Number.isFinite(zoom)).toBe(true)
    expect(zoom).toBe(zoomLimits.max)
    expectPointClose(center, point)
  })

  it('never returns a non-finite zoom for a zero-size viewport', () => {
    const bounds: WorldBounds = { min: { x: 0, y: 0 }, max: { x: 100, y: 100 }}
    const zoomLimits: ZoomLimits = { min: 0.1, max: 10 }
    const { zoom } = computeFrameTransform(bounds, { width: 0, height: 0 }, zoomLimits)
    // With no usable viewport there is no real fit, so the unbounded fit scale is
    // Infinity; the clamp must turn that into a finite limit (the max) rather
    // than letting Infinity or NaN escape.
    expect(Number.isFinite(zoom)).toBe(true)
    expect(zoom).toBe(zoomLimits.max)
  })
})

describe('autoFrame', () => {
  it('eases toward the framing destination without overshooting in one step', () => {
    const bounds: WorldBounds = { min: { x: -200, y: -100 }, max: { x: 200, y: 100 }}
    const from = { center: { x: 1000, y: 1000 }, zoom: 0.2 }

    const destination = computeFrameTransform(bounds, VIEWPORT)
    const step = autoFrame({ from, bounds, viewport: VIEWPORT, deltaSeconds: 1 / 60 })

    // One short step closes part of the gap: the eased center sits strictly
    // between the start and the destination on each axis.
    expect(step.center.x).toBeLessThan(from.center.x)
    expect(step.center.x).toBeGreaterThan(destination.center.x)
    expect(step.settled).toBe(false)
    // It reports the destination it is easing toward.
    expectPointClose(step.destination.center, destination.center)
    expect(step.destination.zoom).toBeCloseTo(destination.zoom, 6)
  })

  it('does not move when no time has elapsed', () => {
    const bounds: WorldBounds = { min: { x: 0, y: 0 }, max: { x: 10, y: 10 }}
    const from = { center: { x: 100, y: 100 }, zoom: 0.5 }

    const step = autoFrame({ from, bounds, viewport: VIEWPORT, deltaSeconds: 0 })
    expectPointClose(step.center, from.center)
    expect(step.zoom).toBeCloseTo(from.zoom, 6)
  })

  it('converges so the final framed view encloses the world bounds', () => {
    const bounds: WorldBounds = { min: { x: -300, y: -120 }, max: { x: 220, y: 260 }}
    let current = { center: { x: 4000, y: -4000 }, zoom: 0.02 }

    // Integrate many steps to settle, the way a RAF loop would. The easing is
    // pure and framerate-independent, so this is fully deterministic.
    let settled = false
    for (let frame = 0; frame < 600 && !settled; frame++) {
      const step = autoFrame({ from: current, bounds, viewport: VIEWPORT, deltaSeconds: 1 / 60 })
      current = { center: step.center, zoom: step.zoom }
      settled = step.settled
    }

    expect(settled).toBe(true)

    // With the settled transform, every corner of the world bounds must project
    // inside the viewport: the auto-frame genuinely encloses the region.
    const settledCamera = new Camera({ center: current.center, zoom: current.zoom, viewport: VIEWPORT })
    for (const corner of boundsCorners(bounds)) {
      const screen = settledCamera.worldToScreen(corner)
      expect(screen.x).toBeGreaterThanOrEqual(-1e-3)
      expect(screen.x).toBeLessThanOrEqual(VIEWPORT.width + 1e-3)
      expect(screen.y).toBeGreaterThanOrEqual(-1e-3)
      expect(screen.y).toBeLessThanOrEqual(VIEWPORT.height + 1e-3)
    }
  })

  it('eases zoom monotonically from a too-far-out start toward the fit', () => {
    const bounds: WorldBounds = { min: { x: -50, y: -50 }, max: { x: 50, y: 50 }}
    const destination = computeFrameTransform(bounds, VIEWPORT)

    // Starting more zoomed out than the fit, each step's zoom should increase
    // toward the destination and never exceed it.
    let current = { center: { x: 0, y: 0 }, zoom: destination.zoom / 10 }
    let previousZoom = current.zoom
    for (let frame = 0; frame < 200; frame++) {
      const step = autoFrame({ from: current, bounds, viewport: VIEWPORT, deltaSeconds: 1 / 60 })
      expect(step.zoom).toBeGreaterThanOrEqual(previousZoom - 1e-9)
      expect(step.zoom).toBeLessThanOrEqual(destination.zoom + 1e-9)
      previousZoom = step.zoom
      current = { center: step.center, zoom: step.zoom }
    }
  })
})

/** The four corners of an axis-aligned world bounds, for enclosure checks. */
function boundsCorners(bounds: WorldBounds): Array<{ x: number, y: number }> {
  return [
    { x: bounds.min.x, y: bounds.min.y },
    { x: bounds.max.x, y: bounds.min.y },
    { x: bounds.min.x, y: bounds.max.y },
    { x: bounds.max.x, y: bounds.max.y },
  ]
}
