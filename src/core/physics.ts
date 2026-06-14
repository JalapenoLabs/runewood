// Copyright © 2026 Jalapeno Labs

import type { Vec2, NodePhysics } from './layout'
import type { VisibleNode } from './collapse'

/**
 * The continuous, Gource-style force-directed layout: a living physics simulation
 * that replaces the old deterministic radial tidy-tree. Where {@link computeTargets}
 * sprang every node to a fixed precomputed target and then went perfectly still, this
 * sim is *always* gently reacting and settling: every visible node carries a position
 * and velocity that evolve under three forces each frame, so adding a node makes its
 * local neighborhood push apart and re-settle organically instead of the canvas
 * looking frozen between events.
 *
 * Forces (see {@link ForceLayout.step}):
 * - **Edge spring:** each node is pulled toward its display-parent to a rest length,
 *   so children hang off their parent and the tree skeleton holds together.
 * - **Repulsion:** *every* node pushes apart from every *nearby* node, regardless of
 *   parentage, so different branches separate and the tree stops crossing over itself.
 *   This is the fix for the tangled forest: when repulsion was sibling-local only,
 *   two children of different parents had nothing keeping them apart and their
 *   sub-trees overlapped. Now the repulsion is global-but-local-in-space (see the
 *   complexity note below): it is computed over a uniform spatial grid so only nodes
 *   within a cutoff radius interact, which separates crossing branches without the
 *   cost of a naive all-pairs pass.
 * - **Damping:** velocity decays each step so the system loses kinetic energy and
 *   settles, like a ball easing to rest on a table. Tuned lively, not sluggish: a new
 *   node's disturbance propagates and eases out over roughly one to two seconds.
 *
 * The forest root (when shown) is **pinned** at the center: fixed position, zero
 * velocity, never integrated, so the whole forest hangs and settles around it.
 *
 * This is **forward-only visual state**, exactly like the springs it replaces. It is
 * NOT a pure function of the tree, and that is the accepted tradeoff for the
 * always-alive feel: a backward seek re-folds the (pure) tree and then re-syncs the
 * sim, which re-settles rather than reproducing pixel-exact prior positions. The data
 * fold stays replayable and seek-exact; the layout no longer is.
 *
 * ### Repulsion complexity (uniform spatial grid)
 *
 * Repulsion now acts between ALL nodes, not just siblings, because sibling-only
 * repulsion let different branches cross and tangle. A naive all-pairs pass would be
 * `O(n^2)` per frame, which would not stay smooth on a large Seraphim forest. Instead
 * the repulsion uses a **uniform-bucket spatial grid** ({@link buildSpatialGrid}): each
 * frame every body is hashed into a square cell of side {@link cutoffRadius}, and a body
 * only computes repulsion against bodies in its own cell and the eight neighboring cells.
 * Because the force is an inverse-square that has fallen off to a negligible amount past
 * one cell, ignoring far-away cells changes the result imperceptibly while bounding the
 * work: with bodies spread roughly evenly the per-frame cost is `O(n)` (each body sees a
 * constant handful of neighbors), degrading to `O(n^2)` only in the pathological case of
 * every node piled into one cell, which the springs prevent. Building the grid is `O(n)`.
 * So the forest separates branch-from-branch yet stays cheap as it grows, which matters
 * because the user watches the FPS.
 */
export class ForceLayout {
  /** Live per-node physics, keyed by the node's real (full) path. The public read surface. */
  private readonly bodies: Map<string, NodePhysics>

  /**
   * Each node's display-parent path, captured on {@link sync} from the collapse so
   * {@link step} knows what to spring each node toward without re-walking the tree. The
   * forest root and an un-synced node are absent. Keyed by real node path; the value is
   * the nearest-visible-ancestor path (`''` for a repo root).
   */
  private readonly displayParentByPath: Map<string, string>

  /**
   * The path of the pinned forest root (`''`) when one is shown, else `null`. A pinned
   * body is held at the center with zero velocity and skipped by the integrator, so
   * everything else hangs and settles around it.
   */
  private pinnedPath: string | null

  private readonly options: Required<ForceLayoutOptions>

  constructor(options: ForceLayoutOptions = {}) {
    this.bodies = new Map()
    this.displayParentByPath = new Map()
    this.pinnedPath = null
    this.options = {
      center: options.center ?? { x: 0, y: 0 },
      restLength: options.restLength ?? DEFAULT_REST_LENGTH,
      restLengthDepthScale: options.restLengthDepthScale ?? DEFAULT_REST_LENGTH_DEPTH_SCALE,
      springStiffness: options.springStiffness ?? DEFAULT_SPRING_STIFFNESS,
      repulsionStrength: options.repulsionStrength ?? DEFAULT_REPULSION_STRENGTH,
      repulsionMinDistance: options.repulsionMinDistance ?? DEFAULT_REPULSION_MIN_DISTANCE,
      repulsionCutoff: options.repulsionCutoff ?? DEFAULT_REPULSION_CUTOFF,
      damping: options.damping ?? DEFAULT_DAMPING,
      maxStepMs: options.maxStepMs ?? DEFAULT_MAX_STEP_MS,
      spawnOffset: options.spawnOffset ?? DEFAULT_SPAWN_OFFSET,
    }
  }

  /**
   * The live physics map. The scene, labels, beams, camera, and picking read positions
   * straight off this, exactly where they used to read the spring state, so the rest of
   * the controller is unchanged by the switch to forces. Returned by reference (not
   * copied) because it is read every frame; callers must not mutate it.
   */
  public get state(): Map<string, NodePhysics> {
    return this.bodies
  }

  /**
   * Reconciles the simulation's bodies with the current visible set (the output of
   * {@link collapseTree}). This is the structural step, run only when the tree's shape
   * changed:
   *
   * - A **new** visible node gets a body spawned at its display-parent's *current*
   *   position plus a small deterministic offset, so it visibly emerges from the parent
   *   it hangs off rather than popping in at the origin. The offset is derived from a
   *   hash of the path (never randomness), so a given node always spawns the same way,
   *   and siblings created together fan out instead of stacking on one point.
   * - A node no longer visible has its body **removed**, so a deleted or collapsed-away
   *   node stops being simulated and drawn.
   * - The forest root (when present, flagged `isForestRoot`) is **pinned** at the
   *   center: its body is held fixed so the forest settles around a stable trunk.
   *
   * The display-parent index is rebuilt here too, so the next {@link step} springs
   * each node toward the current structure without re-walking the tree. Repulsion no
   * longer needs an index: it is computed over a spatial grid of the live positions
   * each frame, so it always sees the current bodies.
   */
  public sync(visibleNodes: VisibleNode[]): void {
    this.displayParentByPath.clear()
    this.pinnedPath = null

    const livePaths = new Set<string>()
    for (const visible of visibleNodes) {
      const path = visible.node.path
      livePaths.add(path)

      if (visible.isForestRoot) {
        // The shared center: pinned at the configured center, never integrated.
        this.pinnedPath = path
        const existing = this.bodies.get(path)
        if (existing) {
          existing.position.x = this.options.center.x
          existing.position.y = this.options.center.y
          existing.velocity.x = 0
          existing.velocity.y = 0
        }
        else {
          this.bodies.set(path, {
            position: { x: this.options.center.x, y: this.options.center.y },
            velocity: { x: 0, y: 0 },
          })
        }
        continue
      }

      this.displayParentByPath.set(path, visible.displayParentPath)

      if (!this.bodies.has(path)) {
        this.bodies.set(path, {
          position: this.spawnPositionFor(path, visible.displayParentPath),
          velocity: { x: 0, y: 0 },
        })
      }
    }

    // Drop bodies whose node is no longer visible (deleted or collapsed away), so the
    // sim and the drawn forest stay in lockstep and the map does not grow without bound.
    for (const path of [ ...this.bodies.keys() ]) {
      if (!livePaths.has(path)) {
        this.bodies.delete(path)
      }
    }
  }

  /**
   * Clears the whole simulation: every body, index, and the pin. Used on a backward-seek
   * rebuild, where the controller re-folds the tree and then re-syncs from the rebuilt
   * visible set, letting the sim re-settle from fresh spawns rather than carrying stale
   * positions across the rewind.
   */
  public reset(): void {
    this.bodies.clear()
    this.displayParentByPath.clear()
    this.pinnedPath = null
  }

  /**
   * Advances the simulation by `deltaMs` of real wall time, applying the three forces
   * and integrating with semi-implicit Euler (update velocity from the force, then move
   * by the new velocity). Run EVERY frame, continuously, so the forest is always gently
   * alive: even with no structural change, residual velocity keeps settling and a recent
   * disturbance keeps propagating and easing out.
   *
   * The delta is clamped to {@link ForceLayoutOptions.maxStepMs} for stability: a long
   * stall (a backgrounded tab, a GC pause) must not deliver one giant step that flings
   * nodes across the canvas. A non-positive or non-finite delta is a no-op so a paused or
   * malformed frame never corrupts the state.
   */
  public step(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
      if (deltaMs < 0 || !Number.isFinite(deltaMs)) {
        console.debug('runewood: ignoring invalid physics delta, leaving state untouched', deltaMs)
      }
      return
    }

    const clampedMs = Math.min(deltaMs, this.options.maxStepMs)
    const deltaSeconds = clampedMs / 1000

    // Accumulate this frame's forces per body before integrating, so every force reads
    // the same start-of-frame positions (an explicit, order-independent step).
    const forces = new Map<string, Vec2>()
    for (const path of this.bodies.keys()) {
      if (path === this.pinnedPath) {
        continue
      }
      forces.set(path, { x: 0, y: 0 })
    }

    this.applyEdgeSprings(forces)
    this.applyRepulsion(forces)
    this.integrate(forces, deltaSeconds)
  }

  /**
   * Edge spring: pulls each node toward its display-parent so it settles at roughly the
   * rest length away, keeping the tree skeleton intact. The rest length grows a little
   * with visible depth (via {@link ForceLayoutOptions.restLengthDepthScale}) so deeper
   * rings sit progressively further out and the forest spreads rather than crowding near
   * the trunk. A node whose display-parent has no body yet (a repo root hanging off the
   * undrawn center) is pulled gently toward the configured center instead, so the repos
   * still arrange around the middle.
   */
  private applyEdgeSprings(forces: Map<string, Vec2>): void {
    for (const [ path, force ] of forces) {
      const parentPath = this.displayParentByPath.get(path)
      const parentBody = parentPath !== undefined ? this.bodies.get(parentPath) : undefined
      const anchor = parentBody ? parentBody.position : this.options.center

      const body = this.bodies.get(path)!
      const offsetX = body.position.x - anchor.x
      const offsetY = body.position.y - anchor.y
      const distance = Math.hypot(offsetX, offsetY) || EPSILON

      // A node one ring deeper rests a touch further out, so the tree fans outward
      // instead of every ring sitting at the same radius from its parent.
      const depth = pathDepth(path)
      const restLength = this.options.restLength * (1 + (depth - 1) * this.options.restLengthDepthScale)

      // Hooke's law toward the anchor: force is proportional to how far the current
      // separation is from the rest length, directed along the parent->node axis.
      const stretch = distance - restLength
      const pull = this.options.springStiffness * stretch
      force.x -= (offsetX / distance) * pull
      force.y -= (offsetY / distance) * pull
    }
  }

  /**
   * Global-but-local repulsion: every node pushes apart from every *nearby* node
   * (within {@link ForceLayoutOptions.repulsionCutoff}), no matter their parentage, so
   * branches from different parents separate and the tree stops crossing over itself.
   * This replaces the old sibling-only pass, whose blindness across branches was the
   * cause of the tangle.
   *
   * To stay cheap it does NOT test every pair: it bins the live positions into a
   * uniform {@link buildSpatialGrid} of cell side `cutoff`, then for each body sums the
   * push only from bodies in its own cell and the eight neighbors. Past one cell the
   * inverse-square force has fallen off to a negligible amount, so skipping far cells is
   * visually free while bounding the cost to roughly `O(n)` (see the class complexity
   * note). The pinned root is included as a repulsion *source* (so nodes do not pile
   * onto the center) but, being absent from `forces`, receives none itself.
   *
   * Each pair is visited once (only neighbors with a strictly greater iteration index,
   * an order built into {@link buildSpatialGrid}'s flat cell lists) and the equal-and-
   * opposite push applied to both, so the work is halved and the forces stay symmetric.
   */
  private applyRepulsion(forces: Map<string, Vec2>): void {
    const cutoff = this.options.repulsionCutoff
    const grid = buildSpatialGrid(this.bodies, cutoff)
    const cutoffSquared = cutoff * cutoff

    for (const cell of grid.cells.values()) {
      for (const neighborCell of grid.neighborhoodOf(cell.cellX, cell.cellY)) {
        // Within a single cell, only test each unordered pair once (right index past
        // left); across two distinct cells, test every cross pair exactly once because
        // `neighborhoodOf` yields each neighbor cell only on the lower-keyed side.
        const sameCell = neighborCell === cell
        for (let leftIndex = 0; leftIndex < cell.members.length; leftIndex++) {
          const startRight = sameCell ? leftIndex + 1 : 0
          for (let rightIndex = startRight; rightIndex < neighborCell.members.length; rightIndex++) {
            const left = cell.members[leftIndex]
            const right = neighborCell.members[rightIndex]

            let offsetX = left.position.x - right.position.x
            let offsetY = left.position.y - right.position.y
            let distanceSquared = offsetX * offsetX + offsetY * offsetY
            if (distanceSquared > cutoffSquared) {
              // Beyond the cutoff the inverse-square force is negligible; skip it so a
              // body only ever feels its genuine near neighbors (the whole point of the grid).
              continue
            }

            let distance = Math.sqrt(distanceSquared)
            if (distance < this.options.repulsionMinDistance) {
              // Two near-coincident nodes: nudge them onto a deterministic axis from a
              // hash of the pair so they separate the same way every run, never randomly,
              // then clamp the distance so the inverse-square force stays finite.
              const nudge = pairNudge(left.path, right.path)
              offsetX = nudge.x
              offsetY = nudge.y
              distance = this.options.repulsionMinDistance
              distanceSquared = distance * distance
            }

            // Inverse-square magnitude so close nodes shove hard and ones near the cutoff
            // barely interact, blending smoothly into the hard cutoff with no visible seam.
            const magnitude = this.options.repulsionStrength / distanceSquared
            const pushX = (offsetX / distance) * magnitude
            const pushY = (offsetY / distance) * magnitude

            const leftForce = forces.get(left.path)
            const rightForce = forces.get(right.path)
            if (leftForce) {
              leftForce.x += pushX
              leftForce.y += pushY
            }
            if (rightForce) {
              rightForce.x -= pushX
              rightForce.y -= pushY
            }
          }
        }
      }
    }
  }

  /**
   * Semi-implicit Euler integration with velocity damping: advance each non-pinned
   * body's velocity by its accumulated force, bleed off a fraction of that velocity so
   * the system loses energy and settles, then move the position by the new velocity.
   * Done in this order (velocity first, then position) because semi-implicit Euler stays
   * stable at the variable, sometimes large time steps a RAF loop produces, where plain
   * (explicit) Euler would gain energy and blow up.
   */
  private integrate(forces: Map<string, Vec2>, deltaSeconds: number): void {
    // Per-second damping converted to this step: velocity retains `(1 - damping)^dt` of
    // itself, so the decay is framerate-independent (a long frame damps proportionally
    // more than a short one) rather than tied to a fixed step count.
    const retained = Math.pow(1 - this.options.damping, deltaSeconds)

    for (const [ path, force ] of forces) {
      const body = this.bodies.get(path)!
      body.velocity.x = (body.velocity.x + force.x * deltaSeconds) * retained
      body.velocity.y = (body.velocity.y + force.y * deltaSeconds) * retained
      body.position.x += body.velocity.x * deltaSeconds
      body.position.y += body.velocity.y * deltaSeconds
    }
  }

  /**
   * Where a brand-new node should be born: at its display-parent's current position plus
   * a small deterministic offset, so it emerges from the branch it belongs to and fans
   * away from siblings instead of all spawning on one point. The offset direction comes
   * from a hash of the node path (never randomness or time), so a given node always
   * spawns identically, which keeps a re-sync after a rewind reproducible. Falls back to
   * the configured center when the display-parent has no body yet (a repo root hanging
   * off the undrawn forest center).
   */
  private spawnPositionFor(path: string, displayParentPath: string): Vec2 {
    const parentBody = this.bodies.get(displayParentPath)
    const anchor = parentBody ? parentBody.position : this.options.center
    const angle = (hashPath(path) / 0xffffffff) * Math.PI * 2
    return {
      x: anchor.x + Math.cos(angle) * this.options.spawnOffset,
      y: anchor.y + Math.sin(angle) * this.options.spawnOffset,
    }
  }
}

/**
 * Tuning for {@link ForceLayout}. Every field has a sensible default, so the common
 * construction is `new ForceLayout()`. These are the knobs the user will reach for to
 * make the forest feel livelier or calmer: the spring/repulsion/damping strengths
 * trade tightness against spread and settle speed.
 */
export type ForceLayoutOptions = {
  /** Layout-space center the forest root is pinned at and stray repo roots are drawn toward. Defaults to the origin. */
  center?: Vec2
  /** Rest length of a depth-1 edge (repo root to center), in layout units. Deeper edges scale up from here. */
  restLength?: number
  /**
   * How much the rest length grows per visible depth past the first ring, as a fraction
   * of {@link restLength}. `0.5` makes a depth-3 node rest twice as far from its parent
   * as a depth-1 node, so deeper rings spread out instead of crowding the trunk.
   */
  restLengthDepthScale?: number
  /** Edge-spring stiffness: how hard a node is pulled to its rest length from its parent. */
  springStiffness?: number
  /**
   * Repulsion strength: the numerator of the inverse-square push between any two nearby
   * nodes (within {@link repulsionCutoff}). Larger spreads the forest wider, separating
   * branches more, before the edge springs rein them back in.
   */
  repulsionStrength?: number
  /**
   * The closest two nodes are treated as being for the repulsion force, in layout
   * units. Clamps the inverse-square magnitude so near-coincident spawns get a strong but
   * finite shove apart rather than an infinite one.
   */
  repulsionMinDistance?: number
  /**
   * The cutoff radius of the repulsion, in layout units: two nodes farther apart than
   * this exert no repulsion on each other. It is also the spatial grid's cell side, so a
   * body only ever tests the bodies in its own and the eight neighboring cells. Sized a
   * few rest-lengths wide so a node pushes apart from the neighbors that would otherwise
   * cross or overlap it, while still letting distant branches ignore each other (which is
   * both correct, the force is negligible there, and what keeps the grid cheap). Raising
   * it spreads the forest more but widens each body's neighbor scan.
   */
  repulsionCutoff?: number
  /**
   * Per-second velocity damping in `[0, 1)`: the fraction of a body's speed bled off each
   * second. Higher settles faster (sluggish at the extreme); lower stays livelier and
   * rings longer. Tuned so a new node's disturbance eases out over roughly one to two
   * seconds.
   */
  damping?: number
  /**
   * The largest single integration step, in milliseconds. A real delta longer than this
   * (a backgrounded tab, a GC hitch) is clamped to it so one giant step never flings the
   * forest apart; the sim simply advances a little slower than wall time across the stall.
   */
  maxStepMs?: number
  /**
   * How far a freshly spawned node is offset from its parent, in layout units, so it
   * emerges visibly off the branch rather than spawning exactly on the parent.
   */
  spawnOffset?: number
}

/** A small floor on a distance so a normalize divide never hits zero for two coincident bodies. */
const EPSILON = 1e-6

/**
 * Default rest length of a depth-1 edge, in layout units. Comparable to the old radial
 * `ringSpacing` so the forest reads at roughly the same scale, just no longer locked to
 * exact rings.
 */
const DEFAULT_REST_LENGTH = 120

/** Default per-depth rest-length growth: a deeper edge rests half-again further out per ring. */
const DEFAULT_REST_LENGTH_DEPTH_SCALE = 0.35

/**
 * Default edge-spring stiffness. Raised from the old sibling-only era (18) because the
 * now-global repulsion pushes every nearby node, not just siblings, so a firmer skeleton
 * is needed to hold branches together against that broader outward pressure and keep the
 * tree from blowing apart. Still soft enough to settle without ringing hard.
 */
const DEFAULT_SPRING_STIFFNESS = 26

/**
 * Default repulsion strength (the inverse-square numerator). Lowered from the old
 * sibling-only value (90_000) because repulsion now acts between ALL nearby nodes rather
 * than only siblings: a node feels many more neighbors, so a gentler per-pair push sums to
 * the right total spread. Sized so different branches separate cleanly and stop crossing
 * while the springs still rein the tree in; raise it for an airier forest, lower for denser.
 */
const DEFAULT_REPULSION_STRENGTH = 38_000

/** Default minimum repulsion distance, so two near-coincident spawns shove apart finitely. */
const DEFAULT_REPULSION_MIN_DISTANCE = 8

/**
 * Default repulsion cutoff / grid cell side, in layout units. About two-and-a-half
 * depth-1 rest-lengths wide, so a node repels the neighbors close enough to cross or
 * overlap it (the tangle) yet ignores branches that are comfortably far (where the force
 * is negligible anyway). Doubles as the spatial grid's cell size, bounding each body's
 * neighbor scan to a constant handful of cells.
 */
const DEFAULT_REPULSION_CUTOFF = 300

/**
 * Default per-second damping: a body bleeds ~90% of its speed per second (retaining
 * ~10%), a touch firmer than the old sibling-only 0.88 so the busier global-repulsion
 * field still settles in the one-to-two-second range the user asked for: lively, not
 * sluggish, and without a long ringing tail.
 */
const DEFAULT_DAMPING = 0.90

/** Default integration-step clamp: ~3 frames at 60fps, enough to smooth a hitch without stalling the sim. */
const DEFAULT_MAX_STEP_MS = 50

/** Default spawn offset: a small nudge off the parent so a new node visibly emerges from its branch. */
const DEFAULT_SPAWN_OFFSET = 12

/**
 * The node's visible depth inferred from its real path: a repo root (no slash) is depth
 * 1, one slash is depth 2, and so on. Used only to scale the edge rest length, where the
 * raw path-segment count is a fine proxy for how far out a node should rest; the true
 * collapsed visible depth lives on the {@link VisibleNode} but is not needed for this.
 */
function pathDepth(path: string): number {
  if (path.length === 0) {
    return 0
  }
  let depth = 1
  for (let index = 0; index < path.length; index++) {
    if (path.charCodeAt(index) === SLASH_CHAR_CODE) {
      depth++
    }
  }
  return depth
}

/** The `/` character code, hoisted so {@link pathDepth} does not re-parse a literal each call. */
const SLASH_CHAR_CODE = '/'.charCodeAt(0)

/**
 * A deterministic unit-ish separation axis for two coincident nodes, from a hash of
 * their combined paths. So two nodes landing on the exact same point always push apart
 * along the same direction (never a random one), keeping a re-sync after a rewind
 * reproducible. Order-independent so the pair yields the same axis whichever way it is
 * iterated.
 */
function pairNudge(leftPath: string, rightPath: string): Vec2 {
  const combined = leftPath < rightPath ? `${leftPath} ${rightPath}` : `${rightPath} ${leftPath}`
  const angle = (hashPath(combined) / 0xffffffff) * Math.PI * 2
  return { x: Math.cos(angle), y: Math.sin(angle) }
}

/** FNV-1a 32-bit hash of a string. Stable, fast, and dependency-free; matches the layout's hash. */
function hashPath(path: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < path.length; index++) {
    hash ^= path.charCodeAt(index)
    // FNV prime multiply via shifts to stay in 32-bit integer math.
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return hash >>> 0
}

/** One body in the spatial grid: its path (for the deterministic coincident-nudge) and live position. */
export type GridBody = {
  path: string
  position: Vec2
}

/**
 * One occupied cell of the {@link SpatialGrid}: its integer grid coordinates and the
 * bodies that hashed into it. Empty cells are never materialized, so the grid's size is
 * bounded by the number of *occupied* cells, not the (possibly vast) span of the forest.
 */
export type GridCell = {
  cellX: number
  cellY: number
  members: GridBody[]
}

/**
 * A uniform-bucket spatial index over the live bodies, the backbone of the `O(n)`
 * repulsion. Every body is binned into a square cell of side `cellSize` (the repulsion
 * cutoff), so two bodies that could repel each other (within the cutoff) are guaranteed
 * to share a cell or sit in adjacent cells. The repulsion then only has to test a body
 * against the bodies in its own and the eight neighboring cells.
 *
 * {@link neighborhoodOf} is the careful part: it yields, for a given cell, that cell
 * itself plus only the neighbor cells on the "greater" side, so iterating every cell and
 * its neighborhood visits each unordered cell-pair exactly once. That lets the caller
 * apply the equal-and-opposite repulsion to both bodies of a pair without ever
 * double-counting a force.
 */
export type SpatialGrid = {
  /** The occupied cells, keyed by a packed `cellX,cellY` string. */
  cells: Map<string, GridCell>
  /**
   * The cell itself plus its forward-side neighbors, chosen so iterating all cells and
   * each one's neighborhood touches every unordered cell-pair exactly once. The own cell
   * is yielded first so the caller can special-case the within-cell pairing.
   */
  neighborhoodOf: (cellX: number, cellY: number) => GridCell[]
}

/**
 * Bins `bodies` into a uniform spatial grid of cell side `cellSize` for the repulsion
 * pass. Pure (no time, no randomness, no mutation of the inputs) and so directly unit-
 * testable: the same bodies + cell size always yield the same buckets and neighborhoods.
 *
 * A non-finite or non-positive `cellSize` is a programming error upstream; we log and
 * floor it to `1` rather than divide by it and scatter every body into nonsense cells.
 *
 * The eight forward neighbor offsets are chosen so that, combined with the own cell,
 * iterating every cell's neighborhood enumerates each unordered cell-pair once (the
 * lower-keyed cell of a pair owns the edge to the higher-keyed one). See
 * {@link FORWARD_NEIGHBOR_OFFSETS}.
 */
export function buildSpatialGrid(bodies: Map<string, NodePhysics>, cellSize: number): SpatialGrid {
  let size = cellSize
  if (!Number.isFinite(size) || size <= 0) {
    console.debug('runewood: spatial grid got a non-positive cell size, flooring to 1', cellSize)
    size = 1
  }

  const cells = new Map<string, GridCell>()
  for (const [ path, body ] of bodies) {
    const cellX = Math.floor(body.position.x / size)
    const cellY = Math.floor(body.position.y / size)
    const key = `${cellX},${cellY}`
    const existing = cells.get(key)
    if (existing) {
      existing.members.push({ path, position: body.position })
    }
    else {
      cells.set(key, { cellX, cellY, members: [{ path, position: body.position }]})
    }
  }

  const neighborhoodOf = (cellX: number, cellY: number): GridCell[] => {
    const ownKey = `${cellX},${cellY}`
    const own = cells.get(ownKey)
    // The own cell is always present when called from the repulsion loop (we iterate the
    // grid's own cells), but guard anyway so a stray coordinate never throws.
    const neighborhood: GridCell[] = own ? [ own ] : []
    for (const offset of FORWARD_NEIGHBOR_OFFSETS) {
      const neighbor = cells.get(`${cellX + offset.x},${cellY + offset.y}`)
      if (neighbor) {
        neighborhood.push(neighbor)
      }
    }
    return neighborhood
  }

  return { cells, neighborhoodOf }
}

/**
 * The four forward neighbor offsets that, paired with each cell's own bucket, let a sweep
 * over every cell's neighborhood visit each adjacent cell-pair exactly once. Of the eight
 * surrounding cells we take only the four on the "greater" side (right, and the three on
 * the row above): the opposite four are covered when *those* cells are the iteration's
 * current cell. This halves the cross-cell work and keeps each repulsion force counted
 * a single time.
 */
const FORWARD_NEIGHBOR_OFFSETS = [
  { x: 1, y: 0 },
  { x: -1, y: 1 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
] as const
