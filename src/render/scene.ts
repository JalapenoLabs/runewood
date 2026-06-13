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
   */
  public update(tree: TreeNode, springs: SpringState, now: number, theme: RunewoodTheme): void {
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
      this.drawEdge(node, path, physics.position, springs, theme)
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
    if (!graphics) {
      graphics = new Graphics()
      this.nodeLayer.addChild(graphics)
      this.nodeGraphics.set(node.path, graphics)
    }

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
    graphics.position.set(position.x, position.y)
  }

  /**
   * Updates (or creates) the retained branch from one node to its parent. The
   * branch is keyed by the child path (one incoming branch per node). The forest
   * root and the repo roots have no drawable parent position, so they carry no
   * branch; their entry in {@link edgeGraphics} stays absent.
   */
  private drawEdge(node: TreeNode, path: string, position: Vec2, springs: SpringState, theme: RunewoodTheme): void {
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

    let graphics = this.edgeGraphics.get(path)
    if (!graphics) {
      graphics = new Graphics()
      this.edgeLayer.addChild(graphics)
      this.edgeGraphics.set(path, graphics)
    }

    const parent = parentPhysics.position
    graphics.clear()
    graphics
      .moveTo(parent.x, parent.y)
      .lineTo(position.x, position.y)
      .stroke({ color: hslToRgbInt(visual.color), width: visual.thickness, alpha: visual.alpha })
  }

  /** Tears down a node's disc and its branch together (they share a path). */
  private removeNode(path: string): void {
    const graphics = this.nodeGraphics.get(path)
    if (graphics) {
      graphics.destroy()
      this.nodeGraphics.delete(path)
    }
    this.removeEdge(path)
  }

  /** Tears down a node's branch graphic if one exists. */
  private removeEdge(path: string): void {
    const graphics = this.edgeGraphics.get(path)
    if (graphics) {
      graphics.destroy()
      this.edgeGraphics.delete(path)
    }
  }
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
