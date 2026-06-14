// Copyright © 2026 Jalapeno Labs

import type { Container, Renderer, Texture } from 'pixi.js'
import type { TreeNode } from '../core/tree'
import type { SpringState, Vec2 } from '../core/layout'
import type { RunewoodTheme } from '../core/theme'
import type { NodeVisualOptions } from './nodeVisual'
import type { EdgeVisualOptions } from './edgeVisual'

// Core
import { Graphics, Sprite } from 'pixi.js'

import { nodeVisualFor } from './nodeVisual'
import { edgeVisualFor } from './edgeVisual'
import { hslToRgbInt } from './color'
import { buildGlowTexture, GLOW_TEXTURE_RADIUS } from './glowTexture'

/**
 * The retained forest scene: one persistent pixi {@link Graphics} per node and
 * one per branch, keyed by node path so they mirror the layout's
 * {@link SpringState} map. Unlike an immediate-mode redraw, graphics are created
 * once when a node first appears and updated in place every frame; they are torn
 * down only when their node leaves the spring state (after a deleted node has
 * drifted off and been pruned by `stepSprings`).
 *
 * This is the one place besides the backend that is allowed to know about pixi:
 * the pure visual model ({@link nodeVisualFor}, {@link edgeVisualFor}) decides
 * *what* a node and branch look like; this class only translates those plain
 * draw params onto retained pixi objects and parents them into world layers the
 * backend owns. Everything above stays library-free.
 *
 * Lifecycle note (issue #4/#9): the spring state already retains a deleted node
 * until it drifts past its retention radius, so keying off that map gives the
 * fade-then-cull behavior for free. The controller (#9) owns advancing the
 * playhead and the springs; this class is a pure projection of their current
 * state onto the screen.
 */
export class Scene {
  /** The world container branches are parented into. Drawn under the nodes. */
  private readonly edgeLayer: Container
  /** The world container node discs + glow sprites are parented into. Drawn over the branches. */
  private readonly nodeLayer: Container

  /**
   * The shared, reusable soft-glow texture every node's glow sprite samples,
   * tinted to the node's hue and scaled to its glow size. Built once from the
   * renderer; `null` only when no renderer was supplied (a headless test seam),
   * in which case the glow sprite is skipped and the node is just its core.
   */
  private readonly glowTexture: Texture | null

  /** Retained node core disc graphics, keyed by node path (mirrors the spring state). */
  private readonly nodeGraphics: Map<string, Graphics>
  /** Retained per-node soft-glow sprites, keyed by node path (parented under the core). */
  private readonly glowSprites: Map<string, Sprite>
  /** Retained branch graphics, keyed by the *child* node path that owns the edge. */
  private readonly edgeGraphics: Map<string, Graphics>

  /**
   * The params each retained node was last *drawn* with, keyed by path. A node is
   * only cleared and re-stroked when its drawn appearance would actually change
   * (it moved more than {@link DRAW_EPSILON} px, or its heat/alpha/brightness
   * shifted); once the springs settle, most nodes go static and skip the redraw
   * entirely, which is where the per-frame Graphics churn goes at high event rates.
   */
  private readonly lastNodeDraw: Map<string, DrawnNode>
  /** The params each retained branch was last drawn with, keyed by child path. */
  private readonly lastEdgeDraw: Map<string, DrawnEdge>

  private readonly nodeOptions: NodeVisualOptions
  private readonly edgeOptions: EdgeVisualOptions

  /**
   * @param edgeLayer world container for branches (added under the node layer so
   *   branches sit behind the glowing discs).
   * @param nodeLayer world container for node discs + glow sprites.
   * @param renderer the pixi renderer, used once to bake the shared soft-glow
   *   texture every node's glow sprite reuses. Optional so the scene can be built
   *   headless (no glow) in a test; in production the backend always supplies it.
   */
  constructor(edgeLayer: Container, nodeLayer: Container, renderer: Renderer | null, options: SceneOptions = {}) {
    this.edgeLayer = edgeLayer
    this.nodeLayer = nodeLayer
    this.glowTexture = renderer ? buildGlowTexture(renderer) : null
    this.nodeGraphics = new Map()
    this.glowSprites = new Map()
    this.edgeGraphics = new Map()
    this.lastNodeDraw = new Map()
    this.lastEdgeDraw = new Map()
    this.nodeOptions = options.node ?? {}
    this.edgeOptions = options.edge ?? {}
  }

  /**
   * Reconciles the retained graphics with the current tree, spring positions, and
   * playhead time, then redraws each surviving node and branch from the pure
   * visual model. Call once per frame between the backend's `beginFrame` and
   * `endFrame`.
   *
   * Positions come from `springs` (the smoothly animated state), not the layout
   * targets, so motion stays fluid. A node present in the springs but missing
   * from the (re-folded) tree is treated as gone and culled, which keeps the two
   * maps from drifting apart across a backward seek.
   *
   * @param zoom the live camera zoom (world-units-to-pixels), used to floor branch
   *   thickness at a constant on-screen width so a branch never thins to nothing
   *   when the camera pulls far out and the whole forest shrinks.
   */
  public update(tree: TreeNode, springs: SpringState, now: number, theme: RunewoodTheme, zoom: number): void {
    const nodesByPath = indexNodesByPath(tree)

    this.cullDeparted(springs)

    for (const [ path, physics ] of springs) {
      const node = nodesByPath.get(path)
      if (!node) {
        // In the springs but not the tree: a rewound timeline dropped it. Cull so
        // the scene never shows a node the logical tree no longer knows about.
        this.removeNode(path)
        continue
      }
      this.drawNode(node, physics.position, now, theme)
      this.drawEdge(node, path, physics.position, springs, theme, zoom)
    }
  }

  /** Removes every retained graphic. Call when tearing the scene down. */
  public clear(): void {
    for (const path of [ ...this.nodeGraphics.keys() ]) {
      this.removeNode(path)
    }
  }

  /**
   * Drops graphics for any node that has left the spring state. Iterates the
   * retained node keys (a superset of the edge keys) since a node and its branch
   * share a path and are added and removed together.
   */
  private cullDeparted(springs: SpringState): void {
    for (const path of [ ...this.nodeGraphics.keys() ]) {
      if (!springs.has(path)) {
        this.removeNode(path)
      }
    }
  }

  /**
   * Updates (or creates) the retained visuals for one node from the visual model:
   * a soft additive glow sprite under a crisp solid core. This is the redesign the
   * user asked for: the old three-layer node (core + a hard-edged middle halo disc
   * + bloom) dropped its awkward, slow-to-dissolve middle halo, leaving just the
   * crisp core and ONE soft glow. The glow is a reusable radial-gradient sprite,
   * tinted to the node's hue and additively blended, so the big-glow look survives
   * even with the heavy bloom post-process off.
   */
  private drawNode(node: TreeNode, position: Vec2, now: number, theme: RunewoodTheme): void {
    const visual = nodeVisualFor(node, now, theme, this.nodeOptions)

    let graphics = this.nodeGraphics.get(node.path)
    const isNew = !graphics
    if (!graphics) {
      graphics = new Graphics()
      this.nodeLayer.addChild(graphics)
      this.nodeGraphics.set(node.path, graphics)
    }

    // Skip work the frame would not change. The core circle is authored in local
    // space, so only an appearance change (radius / color / alpha / brightness /
    // glow) needs the expensive clear-and-refill plus the glow-sprite update; a
    // pure move only needs the cheap `position.set`. Once the springs settle, both
    // are unchanged for most nodes and the whole node is left untouched. The
    // epsilon keeps a node creeping sub-pixel from re-stroking every frame.
    const previous = this.lastNodeDraw.get(node.path)
    const appearanceChanged = isNew
      || !previous
      || previous.radius !== visual.radius
      || previous.alpha !== visual.alpha
      || previous.brightness !== visual.brightness
      || previous.glow !== visual.glow
      || previous.color.h !== visual.color.h
      || previous.color.s !== visual.color.s
      || previous.color.l !== visual.color.l
    const moved = isNew
      || !previous
      || Math.abs(previous.x - position.x) >= DRAW_EPSILON
      || Math.abs(previous.y - position.y) >= DRAW_EPSILON

    if (!appearanceChanged && !moved) {
      return
    }

    if (appearanceChanged) {
      // The core: a crisp solid disc. Brightness lifts its hue toward white so a
      // hot/flashing node's core flares; alpha carries presence (seeded dim,
      // deleted fading). No halo disc here anymore: the soft glow is the sprite.
      const coreColor = hslToRgbInt(brightenTowardWhite(theme, visual.color, visual.brightness))
      graphics.clear()
      graphics
        .circle(0, 0, visual.radius)
        .fill({ color: coreColor, alpha: visual.alpha })

      this.updateGlow(node.path, visual.radius, visual.color, visual.alpha * visual.glow)
    }

    // Both the core and its glow sprite are positioned absolutely in world space, so
    // a pure move (no appearance change) just re-seats both at the new position.
    graphics.position.set(position.x, position.y)
    const sprite = this.glowSprites.get(node.path)
    if (sprite) {
      sprite.position.set(position.x, position.y)
    }

    this.lastNodeDraw.set(node.path, {
      x: position.x,
      y: position.y,
      radius: visual.radius,
      alpha: visual.alpha,
      brightness: visual.brightness,
      glow: visual.glow,
      color: { h: visual.color.h, s: visual.color.s, l: visual.color.l },
    })
  }

  /**
   * Updates (or creates) the soft additive glow sprite under a node's core. The
   * sprite reuses the one shared radial-gradient texture, tinted to the node's hue
   * and scaled so the glow spreads {@link GLOW_SCALE}x past the core, with its
   * opacity carrying the node's glow strength. When the glow has fully decayed to
   * zero (an idle cold node) the sprite is dropped so nothing lingers, which is the
   * behavior the user wanted: a settled node is just its core, with no half-faded
   * ring left behind. A scene built without a renderer has no glow texture, so this
   * is a no-op (the node is still drawn as its crisp core). The caller seats the
   * returned sprite's world position alongside the core.
   */
  private updateGlow(
    path: string,
    radius: number,
    color: { h: number, s: number, l: number },
    glowAlpha: number,
  ): void {
    if (!this.glowTexture) {
      return
    }

    if (glowAlpha <= 0) {
      // Fully decayed: tear the sprite down rather than leave an invisible (or
      // faintly lingering) glow parented under the node.
      this.removeGlow(path)
      return
    }

    let sprite = this.glowSprites.get(path)
    if (!sprite) {
      sprite = new Sprite(this.glowTexture)
      sprite.anchor.set(0.5)
      // Additive so overlapping glows build toward white the way real bloom stacks,
      // and so the glow reads as light rather than paint over the core.
      sprite.blendMode = 'add'
      // Under every core: inserted at index 0 of the node layer so every glow sits
      // beneath every crisp disc, which reads cleanest when nodes overlap.
      this.nodeLayer.addChildAt(sprite, 0)
      this.glowSprites.set(path, sprite)
    }

    // The texture is white, so a plain tint colors the glow to the node's hue.
    sprite.tint = hslToRgbInt(color)
    sprite.alpha = Math.min(1, glowAlpha)
    // Scale the unit texture so the glow spreads `GLOW_SCALE`x past the core.
    // `GLOW_TEXTURE_RADIUS` is the texture's own radius, so this maps its texture
    // pixels to the target world radius.
    const targetRadius = radius * GLOW_SCALE
    sprite.scale.set(targetRadius / GLOW_TEXTURE_RADIUS)
  }

  /**
   * Updates (or creates) the retained branch from one node to its parent. The
   * branch is keyed by the child path (one incoming branch per node). The forest
   * root and the repo roots have no drawable parent position, so they carry no
   * branch; their entry in {@link edgeGraphics} stays absent.
   */
  private drawEdge(
    node: TreeNode,
    path: string,
    position: Vec2,
    springs: SpringState,
    theme: RunewoodTheme,
    zoom: number,
  ): void {
    const lastSlash = path.lastIndexOf('/')
    const parentPath = lastSlash > 0 ? path.slice(0, lastSlash) : ''
    const parentPhysics = parentPath ? springs.get(parentPath) : undefined
    if (!parentPhysics) {
      // No drawable parent (a repo root hanging off the undrawn forest center, or
      // a parent not yet tracked): nothing to connect to this frame.
      this.removeEdge(path)
      return
    }

    // Depth is the number of path segments: `repo` is depth 1, `repo/src` depth 2.
    const depth = path.split('/').length
    const visual = edgeVisualFor(depth, theme, this.edgeOptions)

    // Floor the stroke at a constant on-screen width. The branch is drawn in world
    // units, which the camera scales by `zoom`, so far out a thin twig collapses to
    // a sub-pixel line and vanishes. Dividing the screen-pixel floor by the live
    // zoom yields the world width that lands on exactly that many screen pixels, so
    // a branch always reads as at least ~1.5px no matter how far the camera pulls
    // back. The `max` only ever *thickens* a too-thin branch; up close (large
    // zoom) the world thickness wins and nothing changes.
    const minWorldThickness = zoom > 0
      ? MIN_EDGE_SCREEN_PX / zoom
      : visual.thickness
    const thickness = Math.max(visual.thickness, minWorldThickness)

    let graphics = this.edgeGraphics.get(path)
    const isNew = !graphics
    if (!graphics) {
      graphics = new Graphics()
      this.edgeLayer.addChild(graphics)
      this.edgeGraphics.set(path, graphics)
    }

    const parent = parentPhysics.position

    // The branch is stroked in world coordinates (both endpoints absolute), so it
    // must be re-stroked whenever either endpoint moves *or* the zoom-floored
    // thickness changes (the camera zoomed). A static branch at a steady zoom is
    // left entirely untouched, which skips the bulk of the per-frame stroke churn.
    const previous = this.lastEdgeDraw.get(path)
    const changed = isNew
      || !previous
      || Math.abs(previous.fromX - parent.x) >= DRAW_EPSILON
      || Math.abs(previous.fromY - parent.y) >= DRAW_EPSILON
      || Math.abs(previous.toX - position.x) >= DRAW_EPSILON
      || Math.abs(previous.toY - position.y) >= DRAW_EPSILON
      || Math.abs(previous.thickness - thickness) >= DRAW_EPSILON
    if (!changed) {
      return
    }

    graphics.clear()
    graphics
      .moveTo(parent.x, parent.y)
      .lineTo(position.x, position.y)
      .stroke({ color: hslToRgbInt(visual.color), width: thickness, alpha: visual.alpha })

    this.lastEdgeDraw.set(path, {
      fromX: parent.x,
      fromY: parent.y,
      toX: position.x,
      toY: position.y,
      thickness,
    })
  }

  /** Tears down a node's core disc, its glow sprite, and its branch together (they share a path). */
  private removeNode(path: string): void {
    const graphics = this.nodeGraphics.get(path)
    if (graphics) {
      graphics.destroy()
      this.nodeGraphics.delete(path)
    }
    this.removeGlow(path)
    this.lastNodeDraw.delete(path)
    this.removeEdge(path)
  }

  /** Tears down a node's soft-glow sprite if one exists. The shared texture is left intact. */
  private removeGlow(path: string): void {
    const sprite = this.glowSprites.get(path)
    if (sprite) {
      // Destroy the sprite but NOT its texture: the glow texture is shared across
      // every node, baked once, and reused for the scene's whole life.
      sprite.destroy()
      this.glowSprites.delete(path)
    }
  }

  /** Tears down a node's branch graphic if one exists. */
  private removeEdge(path: string): void {
    const graphics = this.edgeGraphics.get(path)
    if (graphics) {
      graphics.destroy()
      this.edgeGraphics.delete(path)
    }
    this.lastEdgeDraw.delete(path)
  }
}

/** The drawn params of one node, cached so an unchanged node skips its redraw. */
type DrawnNode = {
  x: number
  y: number
  radius: number
  alpha: number
  brightness: number
  glow: number
  color: { h: number, s: number, l: number }
}

/** The drawn endpoints + thickness of one branch, cached so a static branch skips its re-stroke. */
type DrawnEdge = {
  fromX: number
  fromY: number
  toX: number
  toY: number
  thickness: number
}

/**
 * Flattens the tree into a `path -> node` lookup so the per-frame reconcile can
 * resolve each spring entry to its node in O(1). The forest root carries an empty
 * path and is not drawn, so it is skipped; every other node is keyed by its full
 * slash-joined path, which is exactly the key the spring state uses.
 */
function indexNodesByPath(tree: TreeNode): Map<string, TreeNode> {
  const byPath = new Map<string, TreeNode>()
  const stack: TreeNode[] = [ tree ]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.path) {
      byPath.set(node.path, node)
    }
    for (const child of node.children.values()) {
      stack.push(child)
    }
  }
  return byPath
}

/** Construction options for a {@link Scene}; forwards tuning to the visual models. */
export type SceneOptions = {
  node?: NodeVisualOptions
  edge?: EdgeVisualOptions
}

/**
 * The world-pixel threshold below which a node/branch is treated as not having
 * moved, so a node creeping a sub-pixel fraction as its spring settles does not
 * trigger a full clear-and-refill every frame. ~0.1px is well under one screen
 * pixel at normal zoom, so the skipped redraws are invisible while saving the bulk
 * of the per-frame Graphics churn once the springs settle.
 */
const DRAW_EPSILON = 0.1

/**
 * The minimum on-screen width, in screen pixels, a branch is ever drawn at. The
 * world thickness is floored at `MIN_EDGE_SCREEN_PX / zoom` so a branch always
 * spans at least this many pixels on screen, keeping the forest's lines visible no
 * matter how far the camera zooms out. ~1.5px keeps even the deepest twig a
 * legible hairline rather than letting it disappear.
 */
const MIN_EDGE_SCREEN_PX = 1.5

/**
 * How far past the core disc the soft glow sprite spreads, as a multiple of the
 * node radius. The sprite is a radial gradient that fades to nothing at its rim,
 * so this is the *reach* of the halo, not a hard ring: at ~3.2x the glow blooms
 * generously around the core (the "nice big glow" the user wanted) while still
 * trailing off softly. The big visible reach is what keeps the forest glowing with
 * the heavy bloom post-process off. A judgment call worth tuning to taste.
 */
const GLOW_SCALE = 3.2

/**
 * Lifts a node's base color toward white by its brightness, so a flashing or hot
 * node visibly blooms rather than just changing opacity. Mixes lightness up
 * toward 1 and bleeds a little saturation out, which is how a real additive glow
 * pushes a hue toward white. The theme's `bloomIntensity` caps how far a full
 * brightness can push, so a restrained theme (parchment) blooms gently.
 */
function brightenTowardWhite(theme: RunewoodTheme, color: { h: number, s: number, l: number }, brightness: number) {
  const lift = brightness * theme.bloomIntensity
  return {
    h: color.h,
    s: color.s * (1 - lift * 0.5),
    l: color.l + (1 - color.l) * lift,
  }
}
