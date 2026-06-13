// Copyright © 2026 Jalapeno Labs

import type { Container } from 'pixi.js'
import type { TreeNode } from '../core/tree'
import type { SpringState, Vec2 } from '../core/layout'
import type { RunewoodTheme } from '../core/theme'
import type { NodeVisualOptions } from './nodeVisual'
import type { EdgeVisualOptions } from './edgeVisual'

// Core
import { Graphics } from 'pixi.js'

import { nodeVisualFor } from './nodeVisual'
import { edgeVisualFor } from './edgeVisual'
import { hslToRgbInt } from './color'

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
  /** The world container node discs are parented into. Drawn over the branches. */
  private readonly nodeLayer: Container

  /** Retained node disc graphics, keyed by node path (mirrors the spring state). */
  private readonly nodeGraphics: Map<string, Graphics>
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
   * @param nodeLayer world container for node discs.
   */
  constructor(edgeLayer: Container, nodeLayer: Container, options: SceneOptions = {}) {
    this.edgeLayer = edgeLayer
    this.nodeLayer = nodeLayer
    this.nodeGraphics = new Map()
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

  /** Updates (or creates) the retained disc for one node from the visual model. */
  private drawNode(node: TreeNode, position: Vec2, now: number, theme: RunewoodTheme): void {
    const visual = nodeVisualFor(node, now, theme, this.nodeOptions)

    let graphics = this.nodeGraphics.get(node.path)
    const isNew = !graphics
    if (!graphics) {
      graphics = new Graphics()
      this.nodeLayer.addChild(graphics)
      this.nodeGraphics.set(node.path, graphics)
    }

    // Skip work the frame would not change. The geometry (the halo + core circles)
    // is authored in local space, so only an appearance change (radius / color /
    // alpha / brightness) needs the expensive clear-and-refill; a pure move only
    // needs the cheap `position.set`. Once the springs settle, both are unchanged
    // for most nodes and the whole node is left untouched. The epsilon keeps a node
    // creeping sub-pixel from re-stroking every frame.
    const previous = this.lastNodeDraw.get(node.path)
    const appearanceChanged = isNew
      || !previous
      || previous.radius !== visual.radius
      || previous.alpha !== visual.alpha
      || previous.brightness !== visual.brightness
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
      // Redraw in place: clear last frame's geometry, then lay down a soft additive
      // glow halo under a solid core so a hot/flashing node blooms. Brightness lifts
      // the core toward white and scales the halo; alpha carries presence (seeded
      // dim, deleted fading).
      const coreColor = hslToRgbInt(brightenTowardWhite(theme, visual.color, visual.brightness))
      const haloColor = hslToRgbInt(visual.color)
      graphics.clear()
      graphics
        .circle(0, 0, visual.radius * GLOW_HALO_SCALE)
        .fill({ color: haloColor, alpha: visual.alpha * visual.brightness * GLOW_HALO_ALPHA })
      graphics
        .circle(0, 0, visual.radius)
        .fill({ color: coreColor, alpha: visual.alpha })
    }
    graphics.position.set(position.x, position.y)

    this.lastNodeDraw.set(node.path, {
      x: position.x,
      y: position.y,
      radius: visual.radius,
      alpha: visual.alpha,
      brightness: visual.brightness,
      color: { h: visual.color.h, s: visual.color.s, l: visual.color.l },
    })
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

  /** Tears down a node's disc and its branch together (they share a path). */
  private removeNode(path: string): void {
    const graphics = this.nodeGraphics.get(path)
    if (graphics) {
      graphics.destroy()
      this.nodeGraphics.delete(path)
    }
    this.lastNodeDraw.delete(path)
    this.removeEdge(path)
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
 * How much larger than the core disc the soft glow halo is drawn. The halo is a
 * faint, wide ring that reads as bloom; the core is the crisp node on top.
 */
const GLOW_HALO_SCALE = 2.6

/** Peak opacity of the glow halo, before it is scaled by the node's alpha and brightness. */
const GLOW_HALO_ALPHA = 0.45

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
