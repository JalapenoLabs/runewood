// Copyright © 2026 Jalapeno Labs

import type { Container, Renderer, Texture } from 'pixi.js'
import type { TreeNode } from '../core/tree'
import type { SpringState, Vec2 } from '../core/layout'
import type { VisibleNode } from '../core/collapse'
import type { RunewoodTheme, Hsl } from '../core/theme'
import type { HighlightRegistry } from '../core/highlight'
import type { NodeVisual, NodeVisualOptions } from './nodeVisual'
import type { EdgeVisualOptions } from './edgeVisual'

// Core
import { Graphics, Sprite } from 'pixi.js'

import { highlightPulse } from '../core/highlight'
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
   * Retained highlight-ring graphics, keyed by node path. A ring exists only while
   * its node is in an active highlight group (issue #180's live "watch this" / CI
   * overlay); it is created when a node first becomes highlighted and torn down the
   * moment it leaves every group. Each is re-stroked every frame it is shown so it
   * breathes via {@link highlightPulse}, independent of the playhead.
   */
  private readonly highlightRings: Map<string, Graphics>

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
    this.highlightRings = new Map()
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
   * @param highlights the live "watch this" overlay (issue #180): the set of
   *   highlight groups a host registered (e.g. a PR's files while CI runs). Each
   *   highlighted node gets an extra breathing ring in its group's color. Pass
   *   `null` when nothing is highlighted.
   * @param highlightTimeMs the wall/frame animation clock (NOT the playhead) the
   *   ring's breathing pulse reads, so highlights animate even while playback is
   *   paused or being scrubbed.
   */
  public update(
    tree: TreeNode,
    springs: SpringState,
    now: number,
    theme: RunewoodTheme,
    zoom: number,
    visibleByPath: Map<string, VisibleNode>,
    highlights: HighlightRegistry | null,
    highlightTimeMs: number,
  ): void {
    const nodesByPath = indexNodesByPath(tree)

    this.cullDeparted(springs)

    // The breathing intensity is shared by every ring this frame: it depends only on
    // the wall-clock animation time, not the node, so compute it once. Skipped (and
    // left at 0) when nothing is highlighted, so the common no-highlight path pays
    // nothing.
    const hasHighlights = highlights !== null && !highlights.isEmpty
    const pulse = hasHighlights ? highlightPulse(highlightTimeMs) : 0

    for (const [ path, physics ] of springs) {
      const node = nodesByPath.get(path)
      if (!node) {
        // In the springs but not the tree: a rewound timeline dropped it. Cull so
        // the scene never shows a node the logical tree no longer knows about.
        this.removeNode(path)
        continue
      }
      // The forest root has a spring entry (at the center) whether or not it is
      // drawn. It is only a real, visible node when a `rootLabel` is configured (the
      // collapse then yields it flagged `isForestRoot`); otherwise it is the undrawn
      // center the repo roots fan around, so skip it so the no-root behavior is
      // unchanged.
      if (path === '' && !visibleByPath.get('')?.isForestRoot) {
        this.removeNode(path)
        continue
      }
      const visual = this.drawNode(node, physics.position, now, theme)
      // Edges connect a node to its *display-parent* (nearest visible ancestor), so
      // a collapsed pass-through chain is spanned by one edge, and are styled by the
      // node's *visible* depth so a deep leaf drawn near the center is not a hairline.
      // A node missing from the map (a repo root hanging off the undrawn center) has
      // no drawable parent and carries no branch.
      this.drawEdge(path, physics.position, visibleByPath.get(path), visibleByPath, springs, theme, zoom)

      // The live highlight ring (issue #180): an extra breathing halo over a node a
      // host is watching (a PR's files during CI). It rides the node's live spring
      // position and baseline radius, so it tracks the node as it moves; it is torn
      // down promptly once the node leaves every group. The breathing is driven by
      // the wall clock, not the playhead, so it animates through pause/seek.
      const resolution = hasHighlights ? highlights.highlightFor(path) : null
      if (resolution) {
        this.drawHighlightRing(path, physics.position, visual.radius, resolution.color, pulse)
      }
      else {
        this.removeHighlightRing(path)
      }
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
  private drawNode(node: TreeNode, position: Vec2, now: number, theme: RunewoodTheme): NodeVisual {
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
      // Nothing about the core changed, but still hand back the computed visual so
      // the caller can size a highlight ring off the node's current radius.
      return visual
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

    return visual
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
    path: string,
    position: Vec2,
    visible: VisibleNode | undefined,
    visibleByPath: Map<string, VisibleNode>,
    springs: SpringState,
    theme: RunewoodTheme,
    zoom: number,
  ): void {
    if (visible?.isForestRoot) {
      // The shared center node is its own display-parent (`''`), so it would draw a
      // zero-length edge to itself. It is the trunk everything else branches off of;
      // it carries no incoming branch.
      this.removeEdge(path)
      return
    }
    // Connect to the display-parent only when that parent is itself a DRAWN node.
    // A repo root's display-parent is the empty string: when a `rootLabel` is set
    // that key is the visible forest root (so the repo branches off it), but with
    // no root label the empty string is the undrawn center and the repo carries no
    // branch. Both have a spring entry at `''`, so the drawn-ness is decided by
    // whether `visibleByPath` actually holds the parent, not by the path's truthiness.
    const displayParentPath = visible?.displayParentPath ?? ''
    const parentVisible = visibleByPath.get(displayParentPath)
    const parentPhysics = springs.get(displayParentPath)
    if (!parentVisible || !parentPhysics) {
      // No drawable parent (a repo root hanging off the undrawn forest center, or a
      // display-parent not tracked yet): nothing to connect to this frame.
      this.removeEdge(path)
      return
    }

    // Style the branch by the node's *visible* depth (repo root = 1), so a branch
    // that spans a collapsed pass-through chain is styled by its drawn ring, not by
    // how many real path segments it skipped. A node with no collapse info present
    // falls back to its raw path-segment count.
    const depth = visible?.depth ?? path.split('/').length
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

  /**
   * Updates (or creates) the live highlight ring over a node (issue #180). The ring
   * is a deliberately distinct "watch this" halo: a stroked open circle drawn OUT
   * past the soft glow, breathing between dim and bright on the wall-clock pulse, so
   * it reads as a steady, intentional marker rather than the brief touch flash or
   * the idle glow. It rides the node's live spring position and scales off its
   * baseline radius so it tracks the node as it moves and throbs.
   *
   * It is re-stroked every frame it is shown (the pulse changes the alpha and radius
   * continuously, so caching would not save a redraw), then parented at the top of
   * the node layer so it sits cleanly over both the glow and the core. A scene built
   * without a renderer still draws the ring (it is a plain `Graphics`, no texture),
   * so the highlight is visible even in the no-glow headless fallback.
   */
  private drawHighlightRing(path: string, position: Vec2, radius: number, color: Hsl, pulse: number): void {
    let ring = this.highlightRings.get(path)
    if (!ring) {
      ring = new Graphics()
      // On top of every core and glow so the "watch this" halo is never occluded by
      // the node it marks; the node layer is drawn last, so adding here puts the ring
      // above the discs.
      this.nodeLayer.addChild(ring)
      this.highlightRings.set(path, ring)
    }

    // The ring sits a fixed multiple out past the core and breathes a little wider at
    // the peak of the pulse, so it visibly pulls in and out around the node. Its
    // stroke alpha breathes on the same pulse, between a floor and full, so it always
    // stays clearly lit while CI runs but still reads as a living breath.
    const ringRadius = radius * HIGHLIGHT_RING_SCALE * (1 + pulse * HIGHLIGHT_RING_BREATH)
    const ringWidth = Math.max(HIGHLIGHT_RING_MIN_WIDTH, radius * HIGHLIGHT_RING_WIDTH_SCALE)

    ring.clear()
    ring.position.set(position.x, position.y)
    ring
      .circle(0, 0, ringRadius)
      .stroke({ color: hslToRgbInt(color), width: ringWidth, alpha: pulse })
  }

  /** Tears down a node's highlight ring if one exists (it left every highlight group, or the node departed). */
  private removeHighlightRing(path: string): void {
    const ring = this.highlightRings.get(path)
    if (ring) {
      ring.destroy()
      this.highlightRings.delete(path)
    }
  }

  /** Tears down a node's core disc, its glow sprite, its highlight ring, and its branch (they share a path). */
  private removeNode(path: string): void {
    const graphics = this.nodeGraphics.get(path)
    if (graphics) {
      graphics.destroy()
      this.nodeGraphics.delete(path)
    }
    this.removeGlow(path)
    this.removeHighlightRing(path)
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
 * resolve each spring entry to its node in O(1). The forest root is keyed by its
 * empty path so that, when it is drawn as the shared center node, the reconcile can
 * resolve its `''` spring entry to it; when the root is *not* drawn it simply has no
 * spring entry, so this extra key is harmless. Every other node is keyed by its full
 * slash-joined path, which is exactly the key the spring state uses.
 */
function indexNodesByPath(tree: TreeNode): Map<string, TreeNode> {
  const byPath = new Map<string, TreeNode>()
  const stack: TreeNode[] = [ tree ]
  while (stack.length > 0) {
    const node = stack.pop()!
    byPath.set(node.path, node)
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
 * How far out the live highlight ring sits from the core, as a multiple of the node
 * radius. Pushed well past the {@link GLOW_SCALE} reach so the "watch this" ring
 * reads as its own deliberate halo clearly outside the soft glow, not as part of
 * the node's own bloom.
 */
const HIGHLIGHT_RING_SCALE = 4.2

/**
 * How much wider the highlight ring swells at the peak of its breath, as a fraction
 * of its resting radius. The pulse drives this, so the ring gently pulls in and out
 * around the node rather than just changing opacity.
 */
const HIGHLIGHT_RING_BREATH = 0.18

/**
 * The highlight ring's stroke width as a fraction of the node radius, so a bigger
 * node carries a proportionally bolder ring. Floored by {@link HIGHLIGHT_RING_MIN_WIDTH}
 * so a tiny node's ring is still a visible stroke.
 */
const HIGHLIGHT_RING_WIDTH_SCALE = 0.35

/** The thinnest the highlight ring is ever stroked, in world units, so a small node's ring still reads. */
const HIGHLIGHT_RING_MIN_WIDTH = 1.5

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
