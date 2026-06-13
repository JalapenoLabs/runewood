// Copyright © 2026 Jalapeno Labs

import type {
  RenderBackend,
  RenderBackendInitOptions,
  CameraTransform,
  NodeDrawCommand,
  EdgeDrawCommand,
  BeamDrawCommand,
  LabelDrawCommand,
} from './backend'
import type { Hsl } from '../core/theme'

// Core
import { Application, Container, Graphics, Text } from 'pixi.js'

/**
 * The concrete {@link RenderBackend} for v1, built on pixi.js v8. This is the
 * ONLY file in the engine that imports or names a pixi type: everything pixi or
 * WebGL stays sealed in here, so the abstract interface above can later be
 * re-implemented on raw WebGL/regl without touching a single caller.
 *
 * It is intentionally minimal at this stage (issue #4): it brings up a pixi
 * renderer, clears to the theme background each frame, and can draw the handful
 * of world-space primitives the scene layers need. There is no batching strategy
 * or pooling yet; the node/edge/beam renderer issues (#5/#6/#7) will flesh out
 * the draw methods. A placeholder primitive proves the pipeline end to end.
 *
 * Why this cannot be unit-tested: pixi v8 needs a real WebGL/WebGPU device, and
 * node (Vitest) has no GPU context. Per the issue, it is validated by typecheck
 * and build, and proven visually in the playground (#15). We deliberately do NOT
 * add jsdom/WebGL mocks: a mocked GPU would only prove the mock, not the render.
 */
export class PixiBackend implements RenderBackend {
  /** The pixi application; created lazily in {@link init}. */
  private application: Application | null = null

  /**
   * The world-space scene container. The camera transform is applied to this
   * single container (position + uniform scale), so every child is authored in
   * plain world coordinates and projected for free.
   */
  private world: Container | null = null

  /**
   * A reusable placeholder primitive, drawn once to prove the pipeline. Later
   * issues replace this with real node/edge/beam graphics.
   */
  private placeholder: Graphics | null = null

  public async init(options: RenderBackendInitOptions): Promise<void> {
    if (this.application) {
      console.debug('runewood: PixiBackend.init called twice, ignoring the second call')
      return
    }

    const application = new Application()
    await application.init({
      // Force the WebGL2 renderer for v1 so behavior is uniform across hosts;
      // WebGPU can be opted into later once the higher layers are stable.
      preference: 'webgl',
      width: options.width,
      height: options.height,
      resolution: options.resolution ?? globalThis.devicePixelRatio ?? 1,
      autoDensity: true,
      antialias: true,
      // We drive presentation manually via beginFrame/endFrame, so the built-in
      // render-on-tick loop would only double-present. Stop the shared ticker.
      sharedTicker: false,
    })

    application.ticker.stop()
    options.container.appendChild(application.canvas)

    const world = new Container()
    application.stage.addChild(world)

    // A simple placeholder so the very first frame visibly proves the pipeline:
    // a unit-ish marker at the world origin. Replaced by real geometry in #5+.
    const placeholder = new Graphics()
    placeholder
      .circle(0, 0, 24)
      .fill({ color: 0xffffff, alpha: 0.9 })
    world.addChild(placeholder)

    this.application = application
    this.world = world
    this.placeholder = placeholder
  }

  public resize(width: number, height: number): void {
    if (!this.application) {
      console.debug('runewood: PixiBackend.resize called before init, ignoring', { width, height })
      return
    }
    this.application.renderer.resize(width, height)
  }

  public beginFrame(backgroundColor: Hsl): void {
    if (!this.application) {
      console.debug('runewood: PixiBackend.beginFrame called before init, ignoring')
      return
    }
    // Set the clear color for this frame. The actual clear happens as part of
    // the render in endFrame.
    this.application.renderer.background.color = hslToRgbInt(backgroundColor)
  }

  public endFrame(): void {
    if (!this.application) {
      console.debug('runewood: PixiBackend.endFrame called before init, ignoring')
      return
    }
    this.application.render()
  }

  public drawNode(node: NodeDrawCommand): void {
    if (!this.world) {
      console.debug('runewood: PixiBackend.drawNode called before init, ignoring')
      return
    }
    const graphics = new Graphics()
    graphics
      .circle(node.worldPosition.x, node.worldPosition.y, node.radius)
      .fill({ color: hslToRgbInt(node.color), alpha: node.alpha ?? 1 })
    this.world.addChild(graphics)
  }

  public drawEdge(edge: EdgeDrawCommand): void {
    if (!this.world) {
      console.debug('runewood: PixiBackend.drawEdge called before init, ignoring')
      return
    }
    const graphics = new Graphics()
    graphics
      .moveTo(edge.from.x, edge.from.y)
      .lineTo(edge.to.x, edge.to.y)
      .stroke({ color: hslToRgbInt(edge.color), width: edge.thickness, alpha: edge.alpha ?? 1 })
    this.world.addChild(graphics)
  }

  public drawBeam(beam: BeamDrawCommand): void {
    if (!this.world) {
      console.debug('runewood: PixiBackend.drawBeam called before init, ignoring')
      return
    }
    // Render the beam only up to its progress along the path, so an animated
    // reach grows from source toward target. Defaults to the full segment.
    const progress = beam.progress ?? 1
    const tip = {
      x: beam.from.x + (beam.to.x - beam.from.x) * progress,
      y: beam.from.y + (beam.to.y - beam.from.y) * progress,
    }
    const graphics = new Graphics()
    graphics
      .moveTo(beam.from.x, beam.from.y)
      .lineTo(tip.x, tip.y)
      .stroke({ color: hslToRgbInt(beam.color), width: beam.thickness, alpha: beam.alpha ?? 1 })
    this.world.addChild(graphics)
  }

  public drawLabel(label: LabelDrawCommand): void {
    if (!this.world) {
      console.debug('runewood: PixiBackend.drawLabel called before init, ignoring')
      return
    }
    const text = new Text({
      text: label.text,
      style: {
        fill: hslToRgbInt(label.color),
        fontSize: label.size,
      },
    })
    text.position.set(label.worldPosition.x, label.worldPosition.y)
    text.alpha = label.alpha ?? 1
    this.world.addChild(text)
  }

  public setCamera(transform: CameraTransform): void {
    if (!this.world) {
      console.debug('runewood: PixiBackend.setCamera called before init, ignoring')
      return
    }
    // Apply the pure camera's transform to the world container so children stay
    // authored in plain world coordinates:
    //   screen = (world - center) * zoom + viewportCenter
    // becomes a container scale of `zoom` and a position that puts `center` at
    // the viewport middle.
    this.world.scale.set(transform.zoom)
    this.world.position.set(
      transform.viewport.x / 2 - transform.center.x * transform.zoom,
      transform.viewport.y / 2 - transform.center.y * transform.zoom,
    )
  }

  public dispose(): void {
    if (!this.application) {
      return
    }
    // Tear down the renderer and remove the canvas; pixi recursively destroys
    // the stage and its children.
    this.application.destroy(true, { children: true })
    this.application = null
    this.world = null
    this.placeholder = null
  }
}

/**
 * Converts the engine's canonical {@link Hsl} (hue in degrees, S/L as `0..1`
 * fractions) to the packed `0xRRGGBB` integer pixi wants. Kept here, not in the
 * theme module, because "what a color integer is" is a pixi/WebGL concern and
 * must not leak above this backend. Pure and self-contained so there is no
 * dependency on pixi/colord's particular HSL parsing rules.
 */
function hslToRgbInt(color: Hsl): number {
  const hue = ((color.h % 360) + 360) % 360
  const saturation = clamp01(color.s)
  const lightness = clamp01(color.l)

  // Standard HSL -> RGB. `chroma` is the color's intensity, `secondary` the
  // intermediate component, and `match` the lightness offset that lifts both to
  // the requested lightness.
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const huePrime = hue / 60
  const secondary = chroma * (1 - Math.abs((huePrime % 2) - 1))
  const match = lightness - chroma / 2

  const rgb = rgbForHueSextant(huePrime, chroma, secondary)

  const red = Math.round((rgb.r + match) * 255)
  const green = Math.round((rgb.g + match) * 255)
  const blue = Math.round((rgb.b + match) * 255)

  return (red << 16) | (green << 8) | blue
}

/**
 * The un-offset RGB components for a hue, picked by which 60-degree sextant of
 * the color wheel it falls in. The caller adds the lightness `match` to all
 * three. A lookup over sextants keeps this branch-light and obvious.
 */
function rgbForHueSextant(huePrime: number, chroma: number, secondary: number): Vec2RGB {
  if (huePrime < 1) {
    return { r: chroma, g: secondary, b: 0 }
  }
  if (huePrime < 2) {
    return { r: secondary, g: chroma, b: 0 }
  }
  if (huePrime < 3) {
    return { r: 0, g: chroma, b: secondary }
  }
  if (huePrime < 4) {
    return { r: 0, g: secondary, b: chroma }
  }
  if (huePrime < 5) {
    return { r: secondary, g: 0, b: chroma }
  }
  return { r: chroma, g: 0, b: secondary }
}

/** A plain RGB triple in `0..1`, internal to the HSL conversion. */
type Vec2RGB = { r: number, g: number, b: number }

/** Clamps a fraction to `[0, 1]`. */
function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1)
}
