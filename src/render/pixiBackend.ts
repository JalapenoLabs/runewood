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
import type { SceneOptions } from './scene'

// Core
import { Application, Container, Graphics, Text } from 'pixi.js'

import { Scene } from './scene'
import { hslToRgbInt } from './color'

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
   * The retained-scene layers, both children of {@link world} so the camera
   * transform applies once. Branches are added under nodes so the glowing discs
   * always sit on top of the wood that connects them. Beams and labels (drawn by
   * the immediate-mode methods below) are added straight to {@link world}, over
   * both, so an activity beam reads above the forest.
   */
  private edgeLayer: Container | null = null
  private nodeLayer: Container | null = null

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

    // Two retained layers for the forest: branches under nodes so the glowing
    // discs sit on top of the wood. The {@link Scene} this backend hands out
    // parents its per-node and per-edge graphics into these.
    const edgeLayer = new Container()
    const nodeLayer = new Container()
    world.addChild(edgeLayer)
    world.addChild(nodeLayer)

    this.application = application
    this.world = world
    this.edgeLayer = edgeLayer
    this.nodeLayer = nodeLayer
  }

  /**
   * Creates a retained {@link Scene} parented into this backend's forest layers.
   * The controller (#9) holds the returned scene and calls `scene.update(...)`
   * each frame between {@link beginFrame} and {@link endFrame} to draw the
   * glowing nodes and branches. Returns `null` if called before {@link init},
   * since the layers do not exist yet.
   */
  public createScene(options?: SceneOptions): Scene | null {
    if (!this.edgeLayer || !this.nodeLayer) {
      console.debug('runewood: PixiBackend.createScene called before init, returning null')
      return null
    }
    return new Scene(this.edgeLayer, this.nodeLayer, options)
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
    this.edgeLayer = null
    this.nodeLayer = null
  }
}
