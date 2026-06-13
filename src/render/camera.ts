// Copyright © 2026 Jalapeno Labs

import type { Vec2 } from '../core/layout'

/**
 * Axis-aligned bounds in world space, used to frame a region of the forest.
 * `min` is the lower-left corner, `max` the upper-right (`min.x <= max.x`,
 * `min.y <= max.y`).
 */
export type WorldBounds = {
  min: Vec2
  max: Vec2
}

/**
 * The viewport the camera projects into, in CSS pixels. World space is mapped so
 * that {@link Camera.center} lands at the viewport's center.
 */
export type Viewport = {
  width: number
  height: number
}

/**
 * Limits on how far the camera may zoom, so callers (and {@link autoFrame})
 * never produce a degenerate or runaway transform. `min` is the most zoomed-out
 * scale, `max` the most zoomed-in. Both are world-units-to-pixels.
 */
export type ZoomLimits = {
  min: number
  max: number
}

/**
 * A pure, deterministic 2D pan/zoom camera. It carries no DOM, no pixi, and no
 * sources of nondeterminism (no clock, no randomness): every method is a plain
 * function of its inputs and the camera's `center`/`zoom`. That is what makes it
 * fully unit-testable and the single source of truth for the world<->screen
 * transform the backend applies.
 *
 * The transform is uniform-scale with a centered origin:
 *
 *   screen = (world - center) * zoom + viewportCenter
 *   world  = (screen - viewportCenter) / zoom + center
 *
 * `center` is the world-space point shown at the middle of the viewport; `zoom`
 * is how many screen pixels one world unit spans. The y axis is NOT flipped
 * here: callers decide their world-space y convention. Layout space and screen
 * space therefore share orientation, keeping the math obvious.
 */
export class Camera {
  /** World-space point currently centered in the viewport. */
  public center: Vec2
  /** World-units-to-pixels scale. Always kept within {@link zoomLimits}. */
  public zoom: number
  /** The viewport the camera projects into, in CSS pixels. */
  public viewport: Viewport
  /** The clamp applied to every zoom assignment. */
  public readonly zoomLimits: ZoomLimits

  constructor(options: CameraOptions = {}) {
    this.viewport = options.viewport ?? { width: 1, height: 1 }
    this.zoomLimits = options.zoomLimits ?? DEFAULT_ZOOM_LIMITS
    this.center = options.center ?? { x: 0, y: 0 }
    // Route the initial zoom through the clamp so an out-of-range option can
    // never seed an invalid camera.
    this.zoom = clamp(options.zoom ?? DEFAULT_ZOOM, this.zoomLimits.min, this.zoomLimits.max)
  }

  /** Updates the viewport size (e.g. on a window resize). */
  public setViewport(width: number, height: number): void {
    this.viewport = { width, height }
  }

  /**
   * Pans the camera by a screen-space delta in pixels: dragging the world right
   * by `dx` pixels moves `center` left by `dx / zoom` world units, so the world
   * appears to follow the cursor. Pure translation; zoom is untouched.
   */
  public panByScreen(deltaScreenX: number, deltaScreenY: number): void {
    this.center = {
      x: this.center.x - deltaScreenX / this.zoom,
      y: this.center.y - deltaScreenY / this.zoom,
    }
  }

  /**
   * Zooms by a multiplicative `factor` while keeping the world point under
   * `screenAnchor` fixed on screen (cursor-anchored zoom). A `factor > 1` zooms
   * in, `< 1` zooms out; the result is clamped to {@link zoomLimits}, and the
   * anchor invariant holds for the *clamped* zoom so the view never drifts when
   * pinned at a limit.
   */
  public zoomBy(factor: number, screenAnchor: Vec2): void {
    const anchorWorld = this.screenToWorld(screenAnchor)
    this.zoom = clamp(this.zoom * factor, this.zoomLimits.min, this.zoomLimits.max)
    // Re-center so `anchorWorld` projects back to exactly `screenAnchor` under
    // the new (clamped) zoom: center = anchorWorld - (screenAnchor - vpCenter)/zoom.
    this.center = {
      x: anchorWorld.x - (screenAnchor.x - this.viewport.width / 2) / this.zoom,
      y: anchorWorld.y - (screenAnchor.y - this.viewport.height / 2) / this.zoom,
    }
  }

  /** Projects a world-space point to screen pixels. */
  public worldToScreen(world: Vec2): Vec2 {
    return {
      x: (world.x - this.center.x) * this.zoom + this.viewport.width / 2,
      y: (world.y - this.center.y) * this.zoom + this.viewport.height / 2,
    }
  }

  /** Unprojects a screen-space pixel back to world coordinates. */
  public screenToWorld(screen: Vec2): Vec2 {
    return {
      x: (screen.x - this.viewport.width / 2) / this.zoom + this.center.x,
      y: (screen.y - this.viewport.height / 2) / this.zoom + this.center.y,
    }
  }

  /**
   * Snaps the camera so the given world bounds exactly fit the viewport with the
   * requested padding, with no easing. {@link autoFrame} uses this as its
   * destination; expose it for callers that want an instant fit.
   */
  public frameBounds(bounds: WorldBounds, padding = DEFAULT_FRAME_PADDING): void {
    const destination = computeFrameTransform(bounds, this.viewport, this.zoomLimits, padding)
    this.center = destination.center
    this.zoom = destination.zoom
  }

  /** A plain snapshot of the current transform, for handing to the backend. */
  public snapshot(): CameraSnapshot {
    return {
      center: { x: this.center.x, y: this.center.y },
      zoom: this.zoom,
      viewport: { width: this.viewport.width, height: this.viewport.height },
    }
  }
}

/** Construction options for a {@link Camera}; every field has a default. */
export type CameraOptions = {
  center?: Vec2
  zoom?: number
  viewport?: Viewport
  zoomLimits?: ZoomLimits
}

/** A plain, library-free copy of a camera's transform. */
export type CameraSnapshot = {
  center: Vec2
  zoom: number
  viewport: Viewport
}

const DEFAULT_ZOOM = 1
const DEFAULT_ZOOM_LIMITS: ZoomLimits = { min: 0.05, max: 50 }

/**
 * Fraction of the viewport left as breathing room when framing bounds: 0.1
 * keeps the framed region at 90% of the smaller axis so nothing sits flush
 * against the edge.
 */
const DEFAULT_FRAME_PADDING = 0.1

/**
 * The destination transform that fits `bounds` into `viewport` with `padding`,
 * clamped to `zoomLimits`. Pulled out so {@link Camera.frameBounds} and
 * {@link autoFrame} share one definition of "framed".
 *
 * Zoom is chosen on the *tighter* axis so the whole region is guaranteed to fit;
 * the center is simply the bounds' midpoint. A zero-area or zero-viewport input
 * degrades gracefully: it centers on the bounds and holds zoom at the max (for a
 * point) or the existing scale, never dividing by zero.
 */
export function computeFrameTransform(
  bounds: WorldBounds,
  viewport: Viewport,
  zoomLimits: ZoomLimits = DEFAULT_ZOOM_LIMITS,
  padding: number = DEFAULT_FRAME_PADDING,
): { center: Vec2, zoom: number } {
  const center = {
    x: (bounds.min.x + bounds.max.x) / 2,
    y: (bounds.min.y + bounds.max.y) / 2,
  }

  const worldWidth = bounds.max.x - bounds.min.x
  const worldHeight = bounds.max.y - bounds.min.y

  // Usable viewport after reserving padding on both sides of each axis.
  const usableWidth = viewport.width * (1 - padding * 2)
  const usableHeight = viewport.height * (1 - padding * 2)

  // A degenerate region (a single point, or an empty/zero viewport) has no
  // finite fit scale; pin to the tightest zoom so the point is shown, rather
  // than dividing by zero and producing Infinity/NaN.
  if (worldWidth <= 0 && worldHeight <= 0) {
    return { center, zoom: zoomLimits.max }
  }

  const zoomForWidth = worldWidth > 0 && usableWidth > 0
    ? usableWidth / worldWidth
    : Number.POSITIVE_INFINITY
  const zoomForHeight = worldHeight > 0 && usableHeight > 0
    ? usableHeight / worldHeight
    : Number.POSITIVE_INFINITY

  // The tighter (smaller) axis scale wins so both axes fit inside the viewport.
  const fitZoom = Math.min(zoomForWidth, zoomForHeight)
  const zoom = clamp(fitZoom, zoomLimits.min, zoomLimits.max)

  return { center, zoom }
}

/**
 * Eases an existing camera transform one step toward the transform that frames
 * `bounds`, and returns the new transform plus whether it has effectively
 * arrived. This is the pure core of "auto-frame the active region": the caller
 * holds a {@link Camera}, computes the destination once, and calls this each
 * frame with the elapsed time to glide there.
 *
 * Purity: the easing is an exponential approach driven solely by `deltaSeconds`
 * and `smoothing` (a per-second convergence rate). It reads no clock and no
 * randomness, so a given (from, bounds, deltaSeconds) always yields the same
 * result, keeping replay/seek deterministic. The zoom is interpolated in log
 * space so the perceived zoom speed is uniform across scales.
 */
export function autoFrame(options: AutoFrameOptions): AutoFrameResult {
  const { from, bounds, viewport, deltaSeconds } = options
  const zoomLimits = options.zoomLimits ?? DEFAULT_ZOOM_LIMITS
  const padding = options.padding ?? DEFAULT_FRAME_PADDING
  const smoothing = options.smoothing ?? DEFAULT_AUTO_FRAME_SMOOTHING

  const destination = computeFrameTransform(bounds, viewport, zoomLimits, padding)

  // Exponential smoothing: `t` is the fraction of the remaining gap closed this
  // step. `1 - exp(-rate * dt)` is framerate-independent (the same total easing
  // regardless of how the elapsed time is chunked) and naturally clamps to 1.
  const easeFraction = deltaSeconds <= 0
    ? 0
    : 1 - Math.exp(-smoothing * deltaSeconds)

  const center = {
    x: lerp(from.center.x, destination.center.x, easeFraction),
    y: lerp(from.center.y, destination.center.y, easeFraction),
  }

  // Interpolate zoom geometrically (lerp in log space) so doubling feels the
  // same whether near or far; both endpoints are positive so the log is safe.
  const zoom = Math.exp(lerp(Math.log(from.zoom), Math.log(destination.zoom), easeFraction))

  const centerSettled = Math.abs(center.x - destination.center.x) <= SETTLE_EPSILON
    && Math.abs(center.y - destination.center.y) <= SETTLE_EPSILON
  const zoomSettled = Math.abs(zoom - destination.zoom) <= SETTLE_EPSILON * Math.max(1, destination.zoom)

  return {
    center,
    zoom,
    destination,
    settled: centerSettled && zoomSettled,
  }
}

/** Inputs to one {@link autoFrame} step. */
export type AutoFrameOptions = {
  /** The transform to ease from (typically the live camera's center+zoom). */
  from: { center: Vec2, zoom: number }
  /** World bounds to enclose. */
  bounds: WorldBounds
  viewport: Viewport
  /** Seconds elapsed since the previous step; `<= 0` produces no movement. */
  deltaSeconds: number
  /** Per-second convergence rate; higher snaps faster. Defaults sensibly. */
  smoothing?: number
  zoomLimits?: ZoomLimits
  padding?: number
}

/** The eased transform produced by one {@link autoFrame} step. */
export type AutoFrameResult = {
  center: Vec2
  zoom: number
  /** The fully-framed transform being eased toward, for callers that want it. */
  destination: { center: Vec2, zoom: number }
  /** True once the eased transform has effectively reached its destination. */
  settled: boolean
}

/**
 * Default auto-frame convergence rate, per second. ~6 closes the great majority
 * of the gap within a few hundred milliseconds for a responsive-but-smooth feel.
 */
const DEFAULT_AUTO_FRAME_SMOOTHING = 6

/**
 * How close (in world units for center, and relative units for zoom) the eased
 * transform must be to its destination to count as settled, so a caller can stop
 * stepping instead of easing forever across an ever-shrinking gap.
 */
const SETTLE_EPSILON = 1e-3

/** Clamps `value` to `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Linear interpolation from `start` to `end` by `fraction` (`0..1`). */
function lerp(start: number, end: number, fraction: number): number {
  return start + (end - start) * fraction
}
