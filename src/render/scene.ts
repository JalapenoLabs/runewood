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
import {
  ringRotation,
  sparkOrbitPosition,
  sparkTwinkle,
  leadingEdgeShine,
  auraBreathScale,
} from './highlightEffect'

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
 * shrink-then-cull behavior for free (a deleted node's visual radius collapses to
 * zero, then the spring drops it). The controller (#9) owns advancing the playhead
 * and the springs; this class is a pure projection of their current state onto the
 * screen.
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
   * Retained highlight-reticle graphics, keyed by node path. The reticle is the
   * souped-up "watch this" / CI overlay (issue #180): a single {@link Graphics} onto
   * which every animated layer EXCEPT the aura is drawn each frame (the counter-
   * rotating gapped spinner rings with their shining leading edges, and the orbiting
   * twinkling sparks). It exists only while its node is in an active highlight group,
   * created when the node first becomes highlighted and torn down the moment it leaves
   * every group. Re-drawn every frame it is shown since it spins, breathes, and
   * sparkles on the wall clock, independent of the playhead.
   */
  private readonly highlightRings: Map<string, Graphics>
  /**
   * Retained highlight-aura sprites, keyed by node path: the soft additive glow halo
   * behind each highlighted node, reusing the shared {@link glowTexture} tinted to the
   * group color and breathing on {@link highlightPulse}. Kept as a Sprite (not part of
   * the reticle Graphics) so the aura is one cheap additive blit under the spinner.
   * Created and torn down in lockstep with the reticle. Absent on a headless scene with
   * no glow texture (the reticle still draws; only the aura is skipped).
   */
  private readonly highlightAuras: Map<string, Sprite>

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
   * Above this many drawn nodes the per-node soft-glow sprite is auto-disabled (issue: at scale the
   * additive glow is the most expensive per-node effect and the main bloom-bleed clutter, so a big
   * forest stays crisp small dots and fast). The crisp cores + edges are always kept. A host can
   * raise it for a glowier large forest or lower it to degrade sooner; see {@link SceneOptions}.
   */
  private readonly maxGlowNodes: number

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
    this.highlightAuras = new Map()
    this.lastNodeDraw = new Map()
    this.lastEdgeDraw = new Map()
    this.nodeOptions = options.node ?? {}
    this.edgeOptions = options.edge ?? {}
    this.maxGlowNodes = options.maxGlowNodes ?? DEFAULT_MAX_GLOW_NODES
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

    // Effect degrade at scale: above the glow-node cap, drop the per-node soft-glow sprite (the
    // priciest per-node effect and the worst bloom-bleed clutter), so a large forest reads as crisp
    // dots + edges and stays fast. Decided once per frame off the live drawn-node count.
    const glowEnabled = springs.size <= this.maxGlowNodes

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
      const visual = this.drawNode(node, physics.position, now, theme, glowEnabled)
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
        this.drawHighlight(path, physics.position, visual.radius, resolution.color, pulse, highlightTimeMs, zoom)
      }
      else {
        this.removeHighlight(path)
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
  private drawNode(
    node: TreeNode,
    position: Vec2,
    now: number,
    theme: RunewoodTheme,
    glowEnabled: boolean,
  ): NodeVisual {
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
      || previous.glowEnabled !== glowEnabled
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
      // hot/flashing node's core flares; every persistent node is fully opaque
      // (nodes differ by color and size, never opacity), and a deleted node leaves
      // by its radius shrinking to zero rather than by fading. No halo disc here
      // anymore: the soft glow is the sprite.
      const coreColor = hslToRgbInt(brightenTowardWhite(visual.color, visual.brightness))
      graphics.clear()
      graphics
        .circle(0, 0, visual.radius)
        .fill({ color: coreColor, alpha: visual.alpha })

      // Degrade at scale: when the glow is disabled (too many nodes) force the glow strength to zero
      // so `updateGlow` tears any existing sprite down, leaving just the crisp core.
      const glowStrength = glowEnabled ? visual.alpha * visual.glow : 0
      this.updateGlow(node.path, visual.radius, visual.color, glowStrength)
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
      glowEnabled,
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
   * Updates (or creates) the live highlight reticle over a node (issue #180): the
   * souped-up "watch this" / CI effect, a glowing sci-fi targeting reticle that spins,
   * breathes, and sparkles around the file. It replaces the old flat bordered ring with
   * a layered, animated effect, all driven by the WALL-CLOCK `animationTimeMs` (so it
   * spins and breathes through pause/seek) and tinted by the group `color` (amber =
   * running, green = passed, red = failed all read correctly):
   *
   * 1. **Breathing glow aura** ({@link drawHighlightAura}): a soft additive halo behind
   *    the node, swelling and brightening on the {@link highlightPulse} breath, so the
   *    whole file area softly glows in the group color.
   * 2. **Counter-rotating spinner rings** ({@link drawSpinnerRing}): {@link HIGHLIGHT_RING_COUNT}
   *    gapped arc rings at stepped radii, each turning at a different speed and adjacent
   *    ones in OPPOSITE directions, each arc flaring near-white at its leading tip so it
   *    reads as motion and shine.
   * 3. **Orbiting sparks** ({@link drawHighlightSparks}): {@link HIGHLIGHT_SPARK_COUNT}
   *    bright additive dots travelling around the reticle, twinkling as they go.
   *
   * Every layer pulses subtly on the breath. The reticle is re-drawn every frame it is
   * shown (it animates continuously, so caching would save nothing), parented at the top
   * of the node layer so it sits cleanly over the core and glow. The on-screen size is
   * floored via the live `zoom` so the reticle stays readable when the camera is pulled
   * far out. A scene built without a renderer still draws the rings + sparks (plain
   * `Graphics`); only the textured aura is skipped.
   */
  private drawHighlight(
    path: string,
    position: Vec2,
    radius: number,
    color: Hsl,
    pulse: number,
    animationTimeMs: number,
    zoom: number,
  ): void {
    // Floor the reticle's working radius at a constant on-screen size: world units are
    // scaled by `zoom`, so far out the node's own radius collapses to a few pixels and
    // the reticle would vanish. Taking the max with `MIN_SCREEN_PX / zoom` keeps the
    // reticle at least that many screen pixels across however far the camera pulls back,
    // while up close the node's real radius wins and nothing changes.
    const minWorldRadius = zoom > 0 ? HIGHLIGHT_MIN_SCREEN_PX / zoom : radius
    const baseRadius = Math.max(radius, minWorldRadius)

    this.drawHighlightAura(path, position, baseRadius, color, pulse)

    let reticle = this.highlightRings.get(path)
    if (!reticle) {
      reticle = new Graphics()
      // On top of every core and glow so the reticle is never occluded by the node it
      // marks; the node layer is drawn last, so adding here puts it above the discs.
      this.nodeLayer.addChild(reticle)
      this.highlightRings.set(path, reticle)
    }

    reticle.clear()
    reticle.position.set(position.x, position.y)
    const colorInt = hslToRgbInt(color)

    // The spinner rings, innermost out: each steps a little further from the core and
    // turns at its own speed, with adjacent rings counter-rotating, so the set reads as
    // a mechanism turning rather than one rigid wheel.
    for (let ringIndex = 0; ringIndex < HIGHLIGHT_RING_COUNT; ringIndex += 1) {
      this.drawSpinnerRing(reticle, ringIndex, baseRadius, colorInt, pulse, animationTimeMs)
    }

    this.drawHighlightSparks(reticle, baseRadius, colorInt, pulse, animationTimeMs)
  }

  /**
   * Updates (or creates) the breathing glow aura behind a highlighted node: a soft
   * additive halo reusing the shared glow texture, tinted to the group color, swelling
   * and brightening on the breath {@link highlightPulse} so the file area glows. Sized
   * off the (zoom-floored) reticle radius so it tracks the node and stays visible far
   * out. A headless scene with no glow texture skips the aura (the spinner + sparks
   * still draw), exactly as the node glow does.
   */
  private drawHighlightAura(path: string, position: Vec2, radius: number, color: Hsl, pulse: number): void {
    if (!this.glowTexture) {
      return
    }

    let aura = this.highlightAuras.get(path)
    if (!aura) {
      aura = new Sprite(this.glowTexture)
      aura.anchor.set(0.5)
      // Additive so the aura reads as light layering over the forest rather than paint,
      // matching the node glow. Parented at index 0 of the node layer so it sits beneath
      // every crisp disc and under the reticle's rings and sparks.
      aura.blendMode = 'add'
      this.nodeLayer.addChildAt(aura, 0)
      this.highlightAuras.set(path, aura)
    }

    aura.tint = hslToRgbInt(color)
    // Breathe the aura's reach and brightness together on the pulse: it swells a little
    // wider and brightens toward full at the peak, so the glow visibly inhales/exhales.
    aura.alpha = HIGHLIGHT_AURA_ALPHA * pulse
    const auraRadius = radius * HIGHLIGHT_AURA_SCALE * auraBreathScale(pulse)
    aura.scale.set(auraRadius / GLOW_TEXTURE_RADIUS)
    aura.position.set(position.x, position.y)
  }

  /**
   * Strokes one gapped spinner ring of the reticle onto the shared `reticle` graphics
   * (already seated at the node). The ring is {@link HIGHLIGHT_RING_ARC_SEGMENTS} short
   * arc segments with gaps between them (a loading-spinner look), rotated as a whole by
   * the wall-clock {@link ringRotation} for this ring index, so it sweeps around. Each
   * arc's leading tip flares near-white via {@link leadingEdgeShine}, sub-stroked as a
   * few bright sub-arcs at the head, so the motion shines like a comet. The ring's radius
   * steps out per index and breathes on the pulse; its alpha breathes too so it stays lit
   * while CI runs but still pulses.
   */
  private drawSpinnerRing(
    reticle: Graphics,
    ringIndex: number,
    radius: number,
    colorInt: number,
    pulse: number,
    animationTimeMs: number,
  ): void {
    // Each ring sits a step further out and breathes a little wider at the peak so it
    // pulls in and out around the node.
    const ringRadius = radius * (HIGHLIGHT_RING_BASE_SCALE + ringIndex * HIGHLIGHT_RING_STEP)
      * (1 + pulse * HIGHLIGHT_RING_BREATH)
    const ringWidth = Math.max(HIGHLIGHT_RING_MIN_WIDTH, radius * HIGHLIGHT_RING_WIDTH_SCALE)
    const rotation = ringRotation(animationTimeMs, ringIndex)

    // Lay the gapped arcs around the circle: each segment spans `arcSpan` of its slot and
    // leaves the rest as a gap, so the ring reads as a loading spinner. The base of each
    // arc is the group color at a breathing alpha; the leading tip is sub-stroked
    // near-white so the sweep shines.
    const slot = (Math.PI * 2) / HIGHLIGHT_RING_ARC_SEGMENTS
    const arcSpan = slot * HIGHLIGHT_RING_ARC_FRACTION
    const baseAlpha = HIGHLIGHT_RING_ALPHA_FLOOR + (1 - HIGHLIGHT_RING_ALPHA_FLOOR) * pulse

    for (let segment = 0; segment < HIGHLIGHT_RING_ARC_SEGMENTS; segment += 1) {
      const arcStart = rotation + segment * slot
      const arcEnd = arcStart + arcSpan

      // The dim body of the arc in the plain group color.
      reticle
        .arc(0, 0, ringRadius, arcStart, arcEnd)
        .stroke({ color: colorInt, width: ringWidth, alpha: baseAlpha })

      // The shining leading edge: a handful of short sub-arcs at the head of the arc,
      // each mixed further toward white and brighter the closer it is to the tip, so the
      // last sliver flares like a comet head leading the sweep.
      for (let step = 0; step < HIGHLIGHT_EDGE_STEPS; step += 1) {
        const nearTip = (step + 1) / HIGHLIGHT_EDGE_STEPS
        const shine = leadingEdgeShine(nearTip)
        const subStart = arcStart + arcSpan * (1 - HIGHLIGHT_EDGE_FRACTION) + arcSpan * HIGHLIGHT_EDGE_FRACTION
          * (step / HIGHLIGHT_EDGE_STEPS)
        const subEnd = arcStart + arcSpan * (1 - HIGHLIGHT_EDGE_FRACTION) + arcSpan * HIGHLIGHT_EDGE_FRACTION
          * ((step + 1) / HIGHLIGHT_EDGE_STEPS)
        reticle
          .arc(0, 0, ringRadius, subStart, subEnd)
          .stroke({ color: mixTowardWhite(colorInt, shine), width: ringWidth, alpha: baseAlpha })
      }
    }
  }

  /**
   * Draws the orbiting sparks of the reticle onto the shared `reticle` graphics: a few
   * bright dots travelling around the rings, their angle advancing with the wall clock
   * ({@link sparkOrbitPosition}) and their brightness twinkling ({@link sparkTwinkle}),
   * each with a near-white core and a small additive-feeling halo so they sparkle. The
   * orbit radius sits between the inner and outer rings and breathes on the pulse so the
   * sparks ride the breathing mechanism.
   */
  private drawHighlightSparks(
    reticle: Graphics,
    radius: number,
    colorInt: number,
    pulse: number,
    animationTimeMs: number,
  ): void {
    // Orbit between the inner and outer rings so the sparks read as energy threading
    // through the mechanism, breathing wider with the rings on the pulse.
    const orbitRadius = radius * HIGHLIGHT_SPARK_ORBIT_SCALE * (1 + pulse * HIGHLIGHT_RING_BREATH)
    const sparkRadius = Math.max(HIGHLIGHT_SPARK_MIN_RADIUS, radius * HIGHLIGHT_SPARK_RADIUS_SCALE)

    for (let sparkIndex = 0; sparkIndex < HIGHLIGHT_SPARK_COUNT; sparkIndex += 1) {
      const point = sparkOrbitPosition(animationTimeMs, sparkIndex, HIGHLIGHT_SPARK_COUNT, orbitRadius)
      const twinkle = sparkTwinkle(animationTimeMs, sparkIndex)

      // A soft tinted halo around the spark so it has a little glow, then a bright
      // near-white core on top so it shines. Both ride the twinkle, lifted by the breath
      // so the sparks brighten as the whole reticle inhales.
      const sparkAlpha = Math.min(1, twinkle * (HIGHLIGHT_SPARK_ALPHA_BASE + pulse * HIGHLIGHT_SPARK_ALPHA_PULSE))
      reticle
        .circle(point.x, point.y, sparkRadius * HIGHLIGHT_SPARK_HALO_SCALE)
        .fill({ color: colorInt, alpha: sparkAlpha * HIGHLIGHT_SPARK_HALO_ALPHA })
      reticle
        .circle(point.x, point.y, sparkRadius)
        .fill({ color: mixTowardWhite(colorInt, HIGHLIGHT_SPARK_CORE_SHINE), alpha: sparkAlpha })
    }
  }

  /**
   * Tears down a node's highlight reticle + aura if they exist (it left every highlight
   * group, or the node departed).
   */
  private removeHighlight(path: string): void {
    const reticle = this.highlightRings.get(path)
    if (reticle) {
      reticle.destroy()
      this.highlightRings.delete(path)
    }
    const aura = this.highlightAuras.get(path)
    if (aura) {
      // Destroy the sprite but NOT its texture: the glow texture is shared and reused for
      // the scene's whole life.
      aura.destroy()
      this.highlightAuras.delete(path)
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
    this.removeHighlight(path)
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
  /** Whether the per-node glow sprite was enabled when last drawn, so a scale toggle forces a redraw. */
  glowEnabled: boolean
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
  /**
   * Above this many drawn nodes the per-node soft-glow sprite is auto-disabled, so a large forest
   * stays crisp dots + edges and fast (the additive glow is the most expensive per-node effect and
   * the main bloom-bleed clutter at scale). The crisp cores + edges always draw. Defaults to
   * {@link DEFAULT_MAX_GLOW_NODES}. Raise it for a glowier big forest; lower it to degrade sooner.
   */
  maxGlowNodes?: number
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
 * so this is the *reach* of the halo, not a hard ring. This is RESTRAINED on purpose
 * (it used to be 3.2x): with the base node radius aligned to the layout's file spacing,
 * a 3.2x glow on every file bled the soft halos into each other and buried the tree (the
 * user's "cluttered / buried" complaint, of which the big soft glows were the main
 * culprit). At ~1.8x a file reads as a small crisp dot with a subtle glow, and a dense
 * cluster stays legible instead of melting into one bright blob, while a hot/flashing node
 * still blooms clearly. A judgment call worth tuning to taste.
 */
const GLOW_SCALE = 1.8

/**
 * The default cap on drawn nodes before the per-node soft-glow sprite is auto-disabled (the
 * {@link SceneOptions.maxGlowNodes} default). Below this a forest keeps its glowing-wood look; above
 * it (a large multi-repo load of thousands of nodes) the glow is dropped so the forest stays crisp
 * dots + edges and fast, since the additive glow is the priciest per-node effect and the worst
 * bloom-bleed clutter at scale. Sized so a typical small/medium tree glows fully and only a genuinely
 * large forest degrades. A judgment call worth tuning to the target hardware.
 */
const DEFAULT_MAX_GLOW_NODES = 1200

/**
 * The minimum on-screen size, in screen pixels, the highlight reticle's working radius
 * is floored at. The reticle is sized in world units (scaled by the camera zoom), so
 * far out a small node would shrink it to nothing; flooring the radius at
 * `HIGHLIGHT_MIN_SCREEN_PX / zoom` keeps the whole reticle readable however far the
 * camera pulls back, while up close the node's real radius wins.
 */
const HIGHLIGHT_MIN_SCREEN_PX = 18

/** How many counter-rotating gapped spinner rings the reticle draws. Three reads as a rich mechanism, no clutter. */
const HIGHLIGHT_RING_COUNT = 3

/**
 * The radius of the innermost spinner ring as a multiple of the (zoom-floored) node
 * radius. Pushed out past the {@link GLOW_SCALE} node glow so the reticle reads as its
 * own deliberate marker clearly outside the node's own bloom.
 */
const HIGHLIGHT_RING_BASE_SCALE = 3.2

/** How much further out each successive spinner ring sits, as a multiple of the node radius, so the rings nest. */
const HIGHLIGHT_RING_STEP = 1.0

/**
 * How much wider the rings (and the spark orbit) swell at the peak of the breath, as a
 * fraction of their resting radius. The pulse drives this, so the reticle gently pulls
 * in and out around the node rather than only changing opacity.
 */
const HIGHLIGHT_RING_BREATH = 0.12

/**
 * A spinner ring's stroke width as a fraction of the node radius, so a bigger node
 * carries a proportionally bolder ring. Floored by {@link HIGHLIGHT_RING_MIN_WIDTH} so a
 * tiny node's ring still reads.
 */
const HIGHLIGHT_RING_WIDTH_SCALE = 0.22

/** The thinnest a spinner ring is ever stroked, in world units, so a small node's ring still reads. */
const HIGHLIGHT_RING_MIN_WIDTH = 1.5

/** How many gapped arc segments make up one spinner ring (the loading-spinner look). */
const HIGHLIGHT_RING_ARC_SEGMENTS = 3

/** What fraction of each arc slot is drawn as arc; the rest is the gap. ~0.55 leaves a clear spinner gap. */
const HIGHLIGHT_RING_ARC_FRACTION = 0.55

/** The dimmest a spinner ring's arc is ever drawn, `0..1`, lifted toward full by the breath pulse. */
const HIGHLIGHT_RING_ALPHA_FLOOR = 0.45

/** What fraction of each arc's length, at its leading end, is sub-stroked as the shining comet head. */
const HIGHLIGHT_EDGE_FRACTION = 0.4

/** How many bright sub-arcs make up the shining leading edge: more is a smoother flare at a small draw cost. */
const HIGHLIGHT_EDGE_STEPS = 4

/** How many sparks orbit the reticle. A handful sparkles richly without reading as clutter. */
const HIGHLIGHT_SPARK_COUNT = 5

/** The spark orbit radius as a multiple of the node radius: between the inner and outer spinner rings. */
const HIGHLIGHT_SPARK_ORBIT_SCALE = 4.0

/** A spark's core radius as a fraction of the node radius, floored by {@link HIGHLIGHT_SPARK_MIN_RADIUS}. */
const HIGHLIGHT_SPARK_RADIUS_SCALE = 0.16

/** The smallest a spark's core is ever drawn, in world units, so a spark on a tiny node still reads. */
const HIGHLIGHT_SPARK_MIN_RADIUS = 1.2

/** A spark's soft tinted halo radius as a multiple of its core radius, giving it a little glow. */
const HIGHLIGHT_SPARK_HALO_SCALE = 2.4

/** The alpha of a spark's soft halo relative to its core alpha, so the halo reads as a faint glow, not a disc. */
const HIGHLIGHT_SPARK_HALO_ALPHA = 0.35

/** How far a spark's core color is mixed toward white, `0..1`, so the spark shines near-white at its center. */
const HIGHLIGHT_SPARK_CORE_SHINE = 0.7

/** A spark's base alpha (before the breath lift), multiplied by its twinkle, so it always reads as a bright point. */
const HIGHLIGHT_SPARK_ALPHA_BASE = 0.7

/** How much the breath pulse lifts a spark's alpha at its peak, so the sparks brighten as the reticle inhales. */
const HIGHLIGHT_SPARK_ALPHA_PULSE = 0.3

/** The reach of the highlight aura halo as a multiple of the node radius, before the breath swell is applied. */
const HIGHLIGHT_AURA_SCALE = 5.0

/** The aura halo's peak alpha (at full breath); the breath pulse scales it down toward the trough between breaths. */
const HIGHLIGHT_AURA_ALPHA = 0.5

/**
 * How far a full-brightness flash lightens a node's core, hard-capped so the core
 * never washes out to a colorless white. This used to be `brightness *
 * theme.bloomIntensity`, which on a frequently-touched file (heat pegged near 1)
 * under a strong-bloom theme pushed the core to a desaturated near-white, so the
 * file looked blank. Now the lift is small and capped, the hue and most of the
 * saturation are kept, and the additive glow sprite (plus the optional bloom
 * post-process) carry the bright white flare instead.
 */
const CORE_BRIGHTEN_STRENGTH = 0.35

/** Lightness ceiling a brightened core may reach; below pure white so the hue always reads. */
const CORE_BRIGHTEN_CEIL = 0.82

/**
 * Brightens a node's core a little on heat/flash WITHOUT washing out its color, so
 * a hot or flashing node reads as a vivid, brighter version of its own hue rather
 * than a blank white dot. The hue is always preserved, only a sliver of saturation
 * is bled, and the lightness rises by a small capped amount toward (not to) white.
 * The big white bloom is the glow sprite's job, not the core's.
 */
function brightenTowardWhite(color: { h: number, s: number, l: number }, brightness: number) {
  const lift = Math.min(1, Math.max(0, brightness)) * CORE_BRIGHTEN_STRENGTH
  return {
    h: color.h,
    s: color.s * (1 - lift * 0.25),
    l: Math.min(CORE_BRIGHTEN_CEIL, color.l + (1 - color.l) * lift),
  }
}

/**
 * Mixes a packed `0xRRGGBB` color toward white by `amount` (`0..1`): each channel is
 * lerped toward 255, so 0 is the original color and 1 is pure white. Used by the
 * highlight reticle to make a rotating arc's leading edge and a spark's core flare
 * near-white, which is what sells the shine under additive-feeling blending. Pure and
 * self-contained so it stays cheap to call per sub-arc and per spark each frame.
 */
function mixTowardWhite(color: number, amount: number): number {
  const clamped = Math.min(Math.max(amount, 0), 1)
  const red = (color >> 16) & 0xff
  const green = (color >> 8) & 0xff
  const blue = color & 0xff
  const mixedRed = Math.round(red + (255 - red) * clamped)
  const mixedGreen = Math.round(green + (255 - green) * clamped)
  const mixedBlue = Math.round(blue + (255 - blue) * clamped)
  return (mixedRed << 16) | (mixedGreen << 8) | mixedBlue
}
