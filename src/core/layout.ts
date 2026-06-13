// Copyright © 2026 Jalapeno Labs

import type { TreeNode } from './tree'

/**
 * A 2D point in layout space. Layout space is abstract and unitless: the
 * renderer maps it to screen/world coordinates. Targets and live positions are
 * both expressed in these coordinates.
 */
export type Vec2 = {
  x: number
  y: number
}

/**
 * Knobs for the radial tidy-tree. All have sensible defaults so the common call
 * is `computeTargets(tree)`. These shape geometry only; nothing here reads time
 * or randomness, so the output stays a pure function of the tree plus options.
 */
export type LayoutOptions = {
  /** Layout-space center the whole forest is arranged around. Defaults to the origin. */
  center?: Vec2
  /**
   * Radial distance between successive depth rings. Depth 1 (repo roots) sits at
   * `ringSpacing`, depth 2 at `2 * ringSpacing`, and so on.
   */
  ringSpacing?: number
  /**
   * Fraction (0..1) of a node's angular wedge its children are allowed to span.
   * Below 1 it leaves gaps between sibling sub-trees so they read as distinct
   * branches instead of a solid fan. 0.85 keeps a small breathing gap.
   */
  wedgeFill?: number
  /**
   * Peak magnitude of the deterministic per-node jitter, in layout units. The
   * jitter is derived from a hash of the node path (never randomness) so seeking
   * stays exact; it only breaks up the mechanical perfection of the rings.
   */
  jitter?: number
}

/**
 * The live, animated state of one node: where it is drawn right now and how fast
 * it is moving. Springs carry this forward frame to frame. Unlike targets, this
 * is forward-only visual state and is never re-derived from the tree.
 */
export type NodePhysics = {
  position: Vec2
  velocity: Vec2
}

/**
 * The full animated layout: one {@link NodePhysics} per node path the springs
 * are tracking. The renderer reads `position` from each entry every frame.
 *
 * Deleted nodes are *retained* here even after they leave the targets map, so
 * the renderer can keep drawing and fading them; {@link stepSprings} only prunes
 * a retained node once it has drifted far enough from the forest that it is
 * safely off screen (see `RETENTION_RADIUS`).
 */
export type SpringState = Map<string, NodePhysics>

/**
 * Spring tuning. `stiffness` pulls a node toward its target; `damping` bleeds off
 * velocity. The defaults are tuned for a critically-damped feel (a quick, settle
 * without overshoot) at the millisecond time steps a RAF loop produces.
 */
export type SpringParams = {
  stiffness?: number
  damping?: number
}

const DEFAULT_RING_SPACING = 120
const DEFAULT_WEDGE_FILL = 0.85
const DEFAULT_JITTER = 6

const DEFAULT_STIFFNESS = 120
const DEFAULT_DAMPING = 22

/**
 * How far past the outermost ring a retained (deleted) node must drift before the
 * springs drop it entirely. A deleted node loses its target, so nothing pulls it;
 * the renderer is expected to push it outward as it fades. This bound just stops
 * the state map from growing without limit. Generous so the renderer always has
 * the node available for the full duration of a fade.
 */
const RETENTION_RADIUS = 100_000

/**
 * The angular wedge a node owns: the slice of the circle, in radians, within
 * which it and all its descendants are placed. The root owns the full circle.
 */
type AngularWedge = {
  /** Wedge center angle in radians; this is where the node itself is anchored. */
  angle: number
  /** Half-width of the wedge in radians, so the node spans `[angle - span, angle + span]`. */
  span: number
}

/**
 * Computes the target position of every node in the tree as a pure radial
 * tidy-tree. The forest root sits at `center`; its children (the repo roots) are
 * spread evenly around the full circle, and each node hands its descendants a
 * slice of its own angular wedge, pushing them one ring further out per depth.
 *
 * The result is a deterministic function of `(tree, options)` alone: identical
 * input yields an identical map, with no reads of `Math.random`, the wall clock,
 * or any forward-only state. That is what lets the timeline seek and rewind
 * exactly; the springs animate toward these targets but never feed back into them.
 */
export function computeTargets(tree: TreeNode, options: LayoutOptions = {}): Map<string, Vec2> {
  const center = options.center ?? { x: 0, y: 0 }
  const ringSpacing = options.ringSpacing ?? DEFAULT_RING_SPACING
  const wedgeFill = options.wedgeFill ?? DEFAULT_WEDGE_FILL
  const jitter = options.jitter ?? DEFAULT_JITTER

  const targets = new Map<string, Vec2>()

  // The forest root has no path of its own and is not drawn; it only seeds the
  // full circle that its repo-root children divide up. Placing it at `center`
  // anyway keeps the recursion uniform.
  targets.set(tree.path, { x: center.x, y: center.y })

  placeChildren(tree, { angle: 0, span: Math.PI }, 0, {
    center,
    ringSpacing,
    wedgeFill,
    jitter,
    targets,
  })

  return targets
}

/** Everything the recursion needs that does not change between nodes. */
type PlacementContext = {
  center: Vec2
  ringSpacing: number
  wedgeFill: number
  jitter: number
  targets: Map<string, Vec2>
}

/**
 * Lays out `parent`'s children across the parent's `wedge`, one ring further out
 * than the parent, then recurses into each child with its own narrowed wedge.
 *
 * Children are visited in sorted path order so the layout is independent of Map
 * insertion order: two trees that are structurally equal but were built by
 * different event sequences must produce identical targets.
 */
function placeChildren(
  parent: TreeNode,
  wedge: AngularWedge,
  depth: number,
  context: PlacementContext,
): void {
  const children = [ ...parent.children.values() ].sort((left, right) => {
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  })
  if (children.length === 0) {
    return
  }

  const childDepth = depth + 1
  const radius = context.ringSpacing * childDepth

  // Each child gets an equal share of the (filled) parent wedge. With a single
  // child it inherits the parent's exact angle so a deep chain of lone
  // directories grows straight outward instead of drifting.
  const filledSpan = wedge.span * 2 * context.wedgeFill
  const perChildSpan = filledSpan / children.length
  const wedgeStart = wedge.angle - filledSpan / 2

  for (const [ index, child ] of children.entries()) {
    const childAngle = children.length === 1
      ? wedge.angle
      : wedgeStart + perChildSpan * (index + 0.5)

    const jitterOffset = pathJitter(child.path, context.jitter)
    const jitteredRadius = radius + jitterOffset.radial
    const jitteredAngle = childAngle + jitterOffset.angular

    context.targets.set(child.path, {
      x: context.center.x + Math.cos(jitteredAngle) * jitteredRadius,
      y: context.center.y + Math.sin(jitteredAngle) * jitteredRadius,
    })

    // Hand each child a wedge centered on its own (pre-jitter) angle so its
    // descendants stay cleanly within its slice. Half a per-child span keeps a
    // node's whole sub-tree inside the angular band the parent allotted it.
    placeChildren(child, { angle: childAngle, span: perChildSpan / 2 }, childDepth, context)
  }
}

/**
 * Deterministic pseudo-jitter for a node, derived from a hash of its path so the
 * same path always yields the same nudge. Returns a small radial and angular
 * offset (both in the range `[-amount, amount]`-ish) to break up the rings
 * without ever consulting randomness or time.
 */
function pathJitter(path: string, amount: number): { radial: number, angular: number } {
  if (amount === 0) {
    return { radial: 0, angular: 0 }
  }
  const hash = hashPath(path)
  // Pull two independent unit values in [-1, 1] from different bit fields of the
  // 32-bit hash so radial and angular jitter do not move in lockstep.
  const radialUnit = ((hash & 0xffff) / 0xffff) * 2 - 1
  const angularUnit = (((hash >>> 16) & 0xffff) / 0xffff) * 2 - 1
  return {
    radial: radialUnit * amount,
    // Angular jitter is scaled down hard: a node must stay near its true angle so
    // it never wanders out of its parent's wedge.
    angular: angularUnit * (amount / DEFAULT_RING_SPACING),
  }
}

/** FNV-1a 32-bit hash of a string. Stable, fast, and dependency-free. */
function hashPath(path: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < path.length; index++) {
    hash ^= path.charCodeAt(index)
    // FNV prime multiply via shifts to stay in 32-bit integer math.
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return hash >>> 0
}

/**
 * Advances the animated layout one frame toward `targets` and returns the same
 * (mutated) state for convenience. Each tracked node is eased toward its target
 * with a damped spring; the integration is semi-implicit Euler, which stays
 * stable at the variable time steps a RAF loop produces.
 *
 * Lifecycle handling:
 * - A target with no physics yet is a **new** node. It spawns at its parent's
 *   current position (so it appears to grow out of the parent) rather than
 *   popping in at the center, and holds there for the spawn frame before
 *   springing out to its own target on subsequent steps.
 * - A tracked node whose target has disappeared is a **deleted** node. It is
 *   retained with its last position and velocity so the renderer can fade it,
 *   and is only dropped once it has drifted beyond {@link RETENTION_RADIUS}.
 */
export function stepSprings(
  state: SpringState,
  targets: Map<string, Vec2>,
  deltaMs: number,
  params: SpringParams = {},
): SpringState {
  if (!Number.isFinite(deltaMs) || deltaMs < 0) {
    console.debug('runewood: ignoring invalid spring delta, leaving state untouched', deltaMs)
    return state
  }

  const stiffness = params.stiffness ?? DEFAULT_STIFFNESS
  const damping = params.damping ?? DEFAULT_DAMPING
  const deltaSeconds = deltaMs / 1000

  // Spawn freshly appeared targets at their parent's current position. Done in a
  // first pass against a snapshot of the live keys so a child never spawns onto
  // a sibling that was itself created this same frame. Spawned nodes skip
  // integration this frame so the renderer is guaranteed at least one frame of
  // the node sitting exactly on its parent before it springs outward.
  const previouslyTracked = new Set(state.keys())
  const spawnedThisFrame = new Set<string>()
  for (const [ path, target ] of targets) {
    if (previouslyTracked.has(path)) {
      continue
    }
    const spawn = spawnPositionFor(path, target, state)
    state.set(path, {
      position: { x: spawn.x, y: spawn.y },
      velocity: { x: 0, y: 0 },
    })
    spawnedThisFrame.add(path)
  }

  for (const [ path, physics ] of state) {
    if (spawnedThisFrame.has(path)) {
      continue
    }
    const target = targets.get(path)

    if (!target) {
      // Deleted: no target pulls it. Hold its position (the renderer drives the
      // fade and may push it outward) and prune only once it is safely far away.
      const distanceFromOrigin = Math.hypot(physics.position.x, physics.position.y)
      if (distanceFromOrigin > RETENTION_RADIUS) {
        state.delete(path)
      }
      continue
    }

    integrateAxis(physics, 'x', target.x, stiffness, damping, deltaSeconds)
    integrateAxis(physics, 'y', target.y, stiffness, damping, deltaSeconds)
  }

  return state
}

/**
 * One axis of the damped-spring step, semi-implicit Euler: update velocity from
 * the spring + damping force, then move the position with the new velocity. Done
 * per axis because x and y are fully independent in this layout.
 */
function integrateAxis(
  physics: NodePhysics,
  axis: 'x' | 'y',
  target: number,
  stiffness: number,
  damping: number,
  deltaSeconds: number,
): void {
  const displacement = target - physics.position[axis]
  const acceleration = stiffness * displacement - damping * physics.velocity[axis]
  physics.velocity[axis] += acceleration * deltaSeconds
  physics.position[axis] += physics.velocity[axis] * deltaSeconds
}

/**
 * Where a brand-new node should appear: at its parent's current drawn position,
 * so it reads as growing out of the branch it belongs to. Falls back to the
 * node's own target when the parent is not (yet) tracked, e.g. a repo root whose
 * forest-root parent was never given physics.
 */
function spawnPositionFor(path: string, target: Vec2, state: SpringState): Vec2 {
  const lastSlash = path.lastIndexOf('/')
  if (lastSlash > 0) {
    const parentPath = path.slice(0, lastSlash)
    const parentPhysics = state.get(parentPath)
    if (parentPhysics) {
      return parentPhysics.position
    }
  }
  return target
}

/**
 * Visual "heat" of a node, derived purely from its activity so the renderer can
 * size and brighten it. Heat is a 0..1 scalar combining how often the node has
 * been touched with how recently, and `radius` is a convenience size in layout
 * units scaled from that heat. Recency needs a reference "now" because nodes
 * carry an absolute `lastTouchedAt`; the caller passes the current playhead time.
 */
export function nodeHeat(node: TreeNode, now: number, options: HeatOptions = {}): { heat: number, radius: number } {
  const baseRadius = options.baseRadius ?? DEFAULT_BASE_RADIUS
  const maxRadius = options.maxRadius ?? DEFAULT_MAX_RADIUS
  const touchSaturation = options.touchSaturation ?? DEFAULT_TOUCH_SATURATION
  const coolingMs = options.coolingMs ?? DEFAULT_COOLING_MS

  // Touch heat saturates: the first few touches matter most, then it plateaus so
  // a runaway-edited file does not dwarf the whole forest.
  const touchHeat = node.touchCount <= 0
    ? 0
    : 1 - Math.exp(-node.touchCount / touchSaturation)

  // Recency heat decays linearly over the cooling window since the last touch.
  let recencyHeat = 0
  if (node.lastTouchedAt !== null) {
    const elapsed = now - node.lastTouchedAt
    recencyHeat = Math.max(0, Math.min(1, 1 - elapsed / coolingMs))
  }

  // Weight touch count as the dominant factor with recency as a warm boost,
  // clamped to a clean 0..1 so the renderer can map it however it likes.
  const heat = Math.max(0, Math.min(1, touchHeat * 0.7 + recencyHeat * 0.3))
  const radius = baseRadius + (maxRadius - baseRadius) * heat

  return { heat, radius }
}

/** Tuning for {@link nodeHeat}. Defaults give a usable size range out of the box. */
export type HeatOptions = {
  /** Size of a cold (never-touched) node, in layout units. */
  baseRadius?: number
  /** Size of a maximally hot node, in layout units. */
  maxRadius?: number
  /** Touch count at which touch-heat reaches ~63% of its max (the exponential's knee). */
  touchSaturation?: number
  /** How long since the last touch before recency heat fully decays, in milliseconds. */
  coolingMs?: number
}

const DEFAULT_BASE_RADIUS = 3
const DEFAULT_MAX_RADIUS = 18
const DEFAULT_TOUCH_SATURATION = 4
const DEFAULT_COOLING_MS = 10_000
