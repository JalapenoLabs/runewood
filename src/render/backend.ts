// Copyright © 2026 Jalapeno Labs

import type { Vec2 } from '../core/layout'
import type { Hsl } from '../core/theme'

/**
 * A draw-library-agnostic rendering backend. Everything above this interface
 * (the scene, the layout, the controller) speaks only in world coordinates and
 * plain primitives; only the concrete implementation behind it knows about
 * pixi/WebGL.
 *
 * Deliberately abstract: there are NO pixi or WebGL types anywhere on this
 * surface. Colors come in as the engine's canonical {@link Hsl}; positions and
 * sizes are plain numbers in world space. This is what lets the pixi backend be
 * swapped for raw WebGL/regl later without touching a single caller.
 *
 * The contract is intentionally an `interface` (not the repo's usual `type`)
 * because it reads as a behavioral contract that multiple backends implement,
 * which is exactly what an `interface` communicates.
 */
export interface RenderBackend {
  /**
   * Attaches the backend to a host element and brings up the underlying
   * renderer. Async because real backends (pixi v8) initialize their GPU device
   * asynchronously. Safe to call once per backend instance.
   */
  init(options: RenderBackendInitOptions): Promise<void>

  /**
   * Resizes the drawing surface, in CSS pixels. The backend is responsible for
   * applying the device pixel ratio internally; callers pass logical sizes.
   */
  resize(width: number, height: number): void

  /**
   * Opens a frame, clearing the surface to `backgroundColor`. Every draw call
   * for the frame happens between this and {@link endFrame}.
   */
  beginFrame(backgroundColor: Hsl): void

  /** Presents the frame built since the last {@link beginFrame}. */
  endFrame(): void

  /**
   * Draws a filled circle: a forest node. `worldPosition` is in world space and
   * is run through the active camera by the backend; `radius` is in world units.
   */
  drawNode(node: NodeDrawCommand): void

  /**
   * Draws a line segment: a branch/edge between two nodes. Endpoints are world
   * space; `thickness` is in world units.
   */
  drawEdge(edge: EdgeDrawCommand): void

  /**
   * Draws a directional "beam" of activity (an actor reaching a node). Kept
   * distinct from {@link drawEdge} so a backend can render it with additive glow
   * rather than as a plain branch.
   */
  drawBeam(beam: BeamDrawCommand): void

  /** Draws a text label anchored at a world-space position. */
  drawLabel(label: LabelDrawCommand): void

  /**
   * Updates the camera transform the backend applies to world coordinates. The
   * backend owns no camera logic of its own; the controller drives this from the
   * pure {@link import('./camera').Camera}.
   */
  setCamera(transform: CameraTransform): void

  /** Tears down the renderer and releases GPU resources. Idempotent. */
  dispose(): void
}

/** The host surface and sizing a backend needs to initialize. */
export type RenderBackendInitOptions = {
  /**
   * The DOM element the backend renders into. The backend creates and appends
   * its own canvas; callers do not pass a canvas directly, so a backend that
   * needs more than one surface (e.g. an overlay) is free to add it.
   */
  container: HTMLElement
  /** Initial logical size in CSS pixels. */
  width: number
  height: number
  /**
   * Device pixel ratio to render at. Defaults to the host's `devicePixelRatio`
   * inside the backend when omitted; exposed so a harness can pin it.
   */
  resolution?: number
}

/**
 * The camera transform a backend applies, expressed as a plain pan/zoom so no
 * matrix or library type crosses the interface. `worldScreen = (world - pan) *
 * zoom + viewportCenter`, matching the pure camera in `./camera`.
 */
export type CameraTransform = {
  /** World-space point currently centered in the viewport. */
  center: Vec2
  /** Uniform world-to-screen scale; `2` means a world unit spans two pixels. */
  zoom: number
  /** Viewport size in CSS pixels, so the backend can center the transform. */
  viewport: Vec2
}

/** A filled-circle node draw. */
export type NodeDrawCommand = {
  worldPosition: Vec2
  /** Radius in world units. */
  radius: number
  color: Hsl
  /** 0..1 opacity, for fading seeded/deleted nodes. Defaults to fully opaque. */
  alpha?: number
}

/** A line-segment edge draw between two world-space endpoints. */
export type EdgeDrawCommand = {
  from: Vec2
  to: Vec2
  /** Stroke width in world units. */
  thickness: number
  color: Hsl
  alpha?: number
}

/** A directional activity beam from a source to a target, both world space. */
export type BeamDrawCommand = {
  from: Vec2
  to: Vec2
  /** Stroke width in world units. */
  thickness: number
  color: Hsl
  /** 0..1 progress of the beam along its path, for an animated reach. */
  progress?: number
  alpha?: number
}

/** A text label anchored at a world-space position. */
export type LabelDrawCommand = {
  text: string
  worldPosition: Vec2
  color: Hsl
  /** Font size in world units. */
  size: number
  alpha?: number
}
