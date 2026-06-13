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
import type { Hsl, RunewoodTheme } from '../core/theme'
import type { SceneOptions } from './scene'
import type { BeamSceneOptions } from './beamScene'
import type { LabelLodOptions } from './labels'
import type { BloomQuality } from './bloom'

// Core
import { Application, Container, Graphics, Text } from 'pixi.js'

// Lib
import { AdvancedBloomFilter } from 'pixi-filters'

import { Scene } from './scene'
import { BeamScene } from './beamScene'
import { LabelScene } from './labelScene'
import { hslToRgbInt } from './color'
import { bloomParametersFor } from './bloom'

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

  /**
   * The world container for the retained beam/particle and actor layer (issue
   * #6). Added above the forest layers so the activity glow reads on top of the
   * wood. The {@link BeamScene} this backend hands out parents its graphics here.
   */
  private beamLayer: Container | null = null

  /**
   * The world container for the retained label layer (issue #7). Added above the
   * forest and beam layers so label text reads on top of everything. The
   * {@link LabelScene} this backend hands out parents its glyphs here.
   */
  private labelLayer: Container | null = null

  /**
   * The bloom post-process filter applied over the whole {@link world} (issue
   * #8). It is created lazily by {@link setBloom} the first time a non-`off`
   * quality is requested and is the single, sealed point where pixi's filter
   * pipeline meets the engine. When bloom is `off` the filter is detached from
   * the world entirely (the world's `filters` array is cleared) so there is zero
   * per-frame cost, which is exactly why bloom is the first effect the quality
   * switch turns down.
   */
  private bloomFilter: AdvancedBloomFilter | null = null

  /**
   * The bloom quality currently applied, so a repeated {@link setBloom} call with
   * the same quality is cheap and the backend can re-derive the filter on a theme
   * change. Defaults to `off`: a freshly initialized backend renders no glow
   * until the controller drives a quality in.
   */
  private bloomQuality: BloomQuality = 'off'

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

    // The beam/actor glow sits above the forest, so it is added over both the
    // branches and the node discs.
    const beamLayer = new Container()
    world.addChild(beamLayer)

    // Labels sit above everything else, so they are added last and read on top of
    // the forest and the activity glow.
    const labelLayer = new Container()
    world.addChild(labelLayer)

    this.application = application
    this.world = world
    this.edgeLayer = edgeLayer
    this.nodeLayer = nodeLayer
    this.beamLayer = beamLayer
    this.labelLayer = labelLayer
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

  /**
   * Creates a retained {@link BeamScene} parented into this backend's beam layer,
   * which sits above the forest. The controller (#9) holds the returned scene,
   * spawns beams/pulses on it as the timeline crosses events, and calls
   * `beamScene.update(...)` each frame after the forest scene so the activity
   * glow layers on top. Returns `null` if called before {@link init}, since the
   * layer does not exist yet.
   */
  public createBeamScene(options?: BeamSceneOptions): BeamScene | null {
    if (!this.beamLayer) {
      console.debug('runewood: PixiBackend.createBeamScene called before init, returning null')
      return null
    }
    return new BeamScene(this.beamLayer, options)
  }

  /**
   * Creates a retained {@link LabelScene} parented into this backend's label
   * layer, which sits above the forest and the beams. The controller (#9) holds
   * the returned scene, assembles the label candidates (files, repo roots, actors)
   * each frame, and calls `labelScene.update(...)` after the forest and beam
   * scenes so the text layers on top. Returns `null` if called before {@link init},
   * since the layer does not exist yet.
   */
  public createLabelScene(options?: LabelLodOptions): LabelScene | null {
    if (!this.labelLayer) {
      console.debug('runewood: PixiBackend.createLabelScene called before init, returning null')
      return null
    }
    return new LabelScene(this.labelLayer, options)
  }

  /**
   * Sets the bloom post-process over the rendered scene at runtime. This is the
   * single entry point the controller (#9) and the options surface (#10) drive to
   * toggle and tune the glow; callers pass the already-resolved
   * {@link import('./bloom').BloomQuality} (after any reduced-motion/low-end
   * downgrade) plus the active theme, whose `bloomIntensity` and `glowFalloff`
   * shape the concrete filter parameters via the pure
   * {@link import('./bloom').bloomParametersFor}.
   *
   * The filter is applied to {@link world}, the one container holding every
   * layer, so the glow composites over the finished forest, beams, and labels.
   * `off` detaches the filter so there is no per-frame cost (bloom is the most
   * expensive effect, so turning it down must be genuinely free, not a zeroed
   * pass that still runs). Safe to call before {@link init}: it no-ops with a
   * debug note, since the controller re-drives the quality after init anyway.
   */
  public setBloom(quality: BloomQuality, theme: RunewoodTheme): void {
    this.bloomQuality = quality

    if (!this.world) {
      // The world is built in init(); a backend can be told its bloom quality
      // before then, so just record it and apply when the layers exist.
      console.debug('runewood: PixiBackend.setBloom called before init, deferring', { quality })
      return
    }

    if (quality === 'off') {
      // Detach the filter so the pass does not run at all. Keep the instance
      // around so re-enabling does not rebuild it from scratch.
      this.world.filters = []
      return
    }

    const parameters = bloomParametersFor(quality, theme.bloomIntensity, theme.glowFalloff)

    if (!this.bloomFilter) {
      this.bloomFilter = new AdvancedBloomFilter()
    }
    this.bloomFilter.threshold = parameters.threshold
    this.bloomFilter.blur = parameters.blur
    this.bloomFilter.bloomScale = parameters.strength
    this.bloomFilter.quality = parameters.quality

    this.world.filters = [ this.bloomFilter ]
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

    // The bloom filter is parented to the world by reference, not as a child, so
    // pixi's recursive destroy does not reach it. Destroy it explicitly to free
    // its GPU resources, then drop the reference.
    this.bloomFilter?.destroy()
    this.bloomFilter = null
    this.bloomQuality = 'off'

    this.application = null
    this.world = null
    this.edgeLayer = null
    this.nodeLayer = null
    this.beamLayer = null
    this.labelLayer = null
  }
}
