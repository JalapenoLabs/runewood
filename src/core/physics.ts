// Copyright © 2026 Jalapeno Labs

import type { Vec2, NodePhysics } from './layout'
import type { VisibleNode } from './collapse'

/**
 * The continuous, Gource-style force-directed layout: a living physics simulation
 * that replaces the old deterministic radial tidy-tree. Where {@link computeTargets}
 * sprang every node to a fixed precomputed target and then went perfectly still, this
 * sim is *always* gently reacting and settling: every visible node carries a position
 * and velocity that evolve under a handful of forces each frame, so adding a node makes
 * its local neighborhood push apart and re-settle organically instead of the canvas
 * looking frozen between events.
 *
 * ### Modeled on Gource's actual layout (`src/dirnode.cpp`)
 *
 * The earlier version of this sim was springy and smooth (which the user loves) but the
 * tree "crossed up": branches grew in random hash-seeded directions and folded back over
 * each other. This version adopts Gource's organizing trick so the forest grows OUTWARD
 * from the center in tidy angular wedges instead. The pieces, mapped to Gource:
 *
 * - **Outward directional growth** (Gource `setInitialPosition` + the "parent_parent to
 *   parent normal" term in `applyForces`): every directory has a preferred *outward
 *   direction*, the unit vector pointing from its grandparent toward its parent (radially
 *   away from the pinned center for a repo root). A directory is pulled toward a target
 *   that sits one rest-length out from its parent *along that outward direction*, so a
 *   branch grows away from the center and does not fold back across its siblings. This is
 *   the anti-crossing force; see {@link applyDirectionalGrowth} and {@link outwardTargetFor}.
 * - **Sibling arc distribution** (Gource's "dirs should repulse from other dirs of this
 *   parent", scaling sibling repulsion by the parent's circumference / sibling count):
 *   instead of all of a parent's child directories chasing the exact same outward point
 *   (which would stack them on one ray), each sibling is handed its own slice of the
 *   parent's outward-facing arc. The outward target above is rotated by the node's wedge
 *   offset, so N child directories fan across an arc centered on the outward direction,
 *   each subtree getting its own wedge. See {@link siblingWedgeOffset}.
 * - **Files cluster around their directory** (Gource `RFile`, whose position is relative
 *   to its dir and packed into tight concentric rings, never part of the global spread):
 *   a file is a *satellite*. It springs to a short rest length from its directory and
 *   only repels its file-siblings (not the whole forest), so files bunch close to the
 *   directory they belong to while the directories form the spread skeleton. See the file
 *   branches in {@link applyEdgeSprings} / {@link applyRepulsion}.
 * - **Directory-to-directory repulsion** (Gource's quadtree `applyForceDir`): directories
 *   push apart from every *nearby* directory, regardless of parentage, so different
 *   branches separate. Kept over the same uniform spatial grid as before for `O(n)` cost.
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
 * Directory repulsion acts between ALL directories, not just siblings, because
 * sibling-only repulsion let different branches cross and tangle. A naive all-pairs pass
 * would be `O(n^2)` per frame, which would not stay smooth on a large Seraphim forest.
 * Instead the repulsion uses a **uniform-bucket spatial grid** ({@link buildSpatialGrid}):
 * each frame every body is hashed into a square cell of side {@link repulsionCutoff}, and a
 * body only computes repulsion against bodies in its own cell and the eight neighboring
 * cells. Because the force is an inverse-square that has fallen off to a negligible amount
 * past one cell, ignoring far-away cells changes the result imperceptibly while bounding
 * the work to roughly `O(n)`. Building the grid is `O(n)`.
 */
export class ForceLayout {
  /** Live per-node physics, keyed by the node's real (full) path. The public read surface. */
  private readonly bodies: Map<string, NodePhysics>

  /**
   * Per-node layout metadata captured on {@link sync} from the collapse, so {@link step}
   * can apply the directional / spring / clustering forces without re-walking the tree
   * each frame. Keyed by real node path; the forest root and an un-synced node are absent.
   */
  private readonly metaByPath: Map<string, NodeMeta>

  /**
   * The path of the pinned forest root (`''`) when one is shown, else `null`. A pinned
   * body is held at the center with zero velocity and skipped by the integrator, so
   * everything else hangs and settles around it.
   */
  private pinnedPath: string | null

  private readonly options: Required<ForceLayoutOptions>

  constructor(options: ForceLayoutOptions = {}) {
    this.bodies = new Map()
    this.metaByPath = new Map()
    this.pinnedPath = null
    this.options = {
      center: options.center ?? { x: 0, y: 0 },
      restLength: options.restLength ?? DEFAULT_REST_LENGTH,
      restLengthDepthScale: options.restLengthDepthScale ?? DEFAULT_REST_LENGTH_DEPTH_SCALE,
      springStiffness: options.springStiffness ?? DEFAULT_SPRING_STIFFNESS,
      directionalStrength: options.directionalStrength ?? DEFAULT_DIRECTIONAL_STRENGTH,
      siblingArc: options.siblingArc ?? DEFAULT_SIBLING_ARC,
      fileRestLength: options.fileRestLength ?? DEFAULT_FILE_REST_LENGTH,
      fileRepulsionStrength: options.fileRepulsionStrength ?? DEFAULT_FILE_REPULSION_STRENGTH,
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
   *   position, nudged a small offset along its outward direction so it visibly emerges
   *   from the parent it hangs off, already pointing away from the center (Gource's
   *   `setInitialPosition`). A repo root with no live parent falls back to a radial nudge
   *   from the configured center.
   * - A node no longer visible has its body **removed**, so a deleted or collapsed-away
   *   node stops being simulated and drawn.
   * - The forest root (when present, flagged `isForestRoot`) is **pinned** at the center.
   *
   * The per-node metadata index ({@link NodeMeta}) is rebuilt here too: each node's
   * display-parent and grandparent (for the outward direction), whether it is a file, its
   * depth, and its directory-sibling wedge offset (its slice of the parent's outward arc).
   * That lets every {@link step} apply the directional, spring, and clustering forces
   * without re-walking the tree.
   */
  public sync(visibleNodes: VisibleNode[]): void {
    this.metaByPath.clear()
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
    }

    // The wedge slots are assigned per display-parent, so the directory children of one
    // parent each get a distinct slice of that parent's outward arc. Built from the live
    // visible set (deterministic path order) so a re-sync after a rewind is reproducible.
    const wedgeByPath = assignSiblingWedges(visibleNodes)

    for (const visible of visibleNodes) {
      if (visible.isForestRoot) {
        continue
      }
      const path = visible.node.path
      const meta: NodeMeta = {
        displayParentPath: visible.displayParentPath,
        isFile: visible.node.isFile,
        depth: visible.depth,
        wedge: wedgeByPath.get(path) ?? { index: 0, count: 1 },
      }
      this.metaByPath.set(path, meta)

      if (!this.bodies.has(path)) {
        this.bodies.set(path, {
          position: this.spawnPositionFor(path, meta),
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
    this.metaByPath.clear()
    this.pinnedPath = null
  }

  /**
   * Advances the simulation by `deltaMs` of real wall time, applying the forces and
   * integrating with semi-implicit Euler (update velocity from the force, then move by the
   * new velocity). Run EVERY frame, continuously, so the forest is always gently alive:
   * even with no structural change, residual velocity keeps settling and a recent
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
    this.applyDirectionalGrowth(forces)
    this.applyRepulsion(forces)
    this.integrate(forces, deltaSeconds)
  }

  /**
   * Edge spring: pulls each node toward its display-parent so it settles at roughly the
   * rest length away, keeping the tree skeleton intact (Gource's gravity-to-parent).
   *
   * Directories rest a depth-scaled distance out (deeper rings sit progressively further,
   * so the forest spreads rather than crowding the trunk); files rest at the much shorter
   * {@link ForceLayoutOptions.fileRestLength}, so they hug the directory they belong to as
   * a tight satellite cluster instead of spreading like a sub-tree. A node whose
   * display-parent has no body yet (a repo root hanging off the undrawn center) is pulled
   * gently toward the configured center instead, so the repos still arrange around the middle.
   */
  private applyEdgeSprings(forces: Map<string, Vec2>): void {
    for (const [ path, force ] of forces) {
      const meta = this.metaByPath.get(path)
      const parentPath = meta?.displayParentPath
      const parentBody = parentPath !== undefined ? this.bodies.get(parentPath) : undefined
      const anchor = parentBody ? parentBody.position : this.options.center

      const body = this.bodies.get(path)!
      const offsetX = body.position.x - anchor.x
      const offsetY = body.position.y - anchor.y
      const distance = Math.hypot(offsetX, offsetY) || EPSILON

      const restLength = this.restLengthFor(meta)

      // Hooke's law toward the anchor: force is proportional to how far the current
      // separation is from the rest length, directed along the parent->node axis.
      const stretch = distance - restLength
      const pull = this.options.springStiffness * stretch
      force.x -= (offsetX / distance) * pull
      force.y -= (offsetY / distance) * pull
    }
  }

  /**
   * Outward directional growth: the anti-crossing force, modeled on Gource's
   * "parent_parent to parent normal" push plus its sibling-arc spread. For each directory
   * (files are skipped, they are satellites) this pulls the node toward a target one rest
   * length out from its parent *along the parent's outward direction* (grandparent ->
   * parent, or radially from center for a repo root), rotated into the node's own slice of
   * the parent's outward-facing arc. The result is that a parent's child directories fan
   * across a wedge that faces away from the center, each subtree owning its own angular
   * band, so branches grow outward and stop folding back over one another.
   *
   * This is a *soft* pull (its own gentle stiffness, separate from the edge spring) layered
   * on top of the spring + repulsion, so the springy, always-settling feel is preserved: it
   * biases where a branch wants to sit without rigidly snapping it to a radial grid.
   */
  private applyDirectionalGrowth(forces: Map<string, Vec2>): void {
    for (const [ path, force ] of forces) {
      const meta = this.metaByPath.get(path)
      if (!meta || meta.isFile) {
        // Files are satellites of their directory; they get no outward spread, only the
        // short edge spring and file-sibling repulsion. Directories form the skeleton.
        continue
      }

      const target = this.outwardTargetFor(path, meta)
      if (!target) {
        continue
      }

      const body = this.bodies.get(path)!
      force.x += (target.x - body.position.x) * this.options.directionalStrength
      force.y += (target.y - body.position.y) * this.options.directionalStrength
    }
  }

  /**
   * The point a directory "wants" to sit at: one rest length out from its parent, along the
   * parent's outward direction, rotated into this node's slice of the parent's outward arc.
   * Returns `null` when the parent has no live body yet (e.g. a repo root whose forest-root
   * parent is undrawn), in which case the directional force is simply skipped this frame and
   * the radial spawn + edge spring still arrange it around the center.
   */
  private outwardTargetFor(path: string, meta: NodeMeta): Vec2 | null {
    const parentBody = this.bodies.get(meta.displayParentPath)
    if (!parentBody) {
      return null
    }

    const outward = this.outwardDirectionFor(meta, parentBody.position)
    const wedgeOffset = siblingWedgeOffset(meta.wedge, this.options.siblingArc)
    const angle = Math.atan2(outward.y, outward.x) + wedgeOffset
    const restLength = this.restLengthFor(meta)

    return {
      x: parentBody.position.x + Math.cos(angle) * restLength,
      y: parentBody.position.y + Math.sin(angle) * restLength,
    }
  }

  /**
   * A directory's outward unit direction: grandparent -> parent (Gource's
   * `parent_edge_normal`), so a branch keeps growing the way it already pointed and away
   * from the center. A repo root has no live grandparent (its parent is the undrawn forest
   * center), so its outward direction is radial: center -> parent. When the parent sits
   * exactly on its own anchor (a fresh spawn, no separation yet) we fall back to a stable
   * per-path hash direction so the target is always well-defined.
   */
  private outwardDirectionFor(meta: NodeMeta, parentPosition: Vec2): Vec2 {
    const grandparentPath = this.metaByPath.get(meta.displayParentPath)?.displayParentPath
    const grandparentBody = grandparentPath !== undefined ? this.bodies.get(grandparentPath) : undefined
    const grandparentPosition = grandparentBody ? grandparentBody.position : this.options.center

    // When parent and grandparent coincide (a fresh spawn, no separation yet) fall back to a
    // stable outward ray hashed from the parent path, so siblings still fan deterministically
    // rather than stacking on one point.
    const fallbackAngle = (hashPath(meta.displayParentPath) / 0xffffffff) * Math.PI * 2
    const fallback = { x: Math.cos(fallbackAngle), y: Math.sin(fallbackAngle) }
    return outwardDirection(parentPosition, grandparentPosition, fallback)
  }

  /**
   * The rest length for a node: short and flat for a file (a tight satellite radius around
   * its directory) or depth-scaled for a directory (deeper rings sit further out so the
   * forest fans rather than crowding the trunk). An un-tracked node (no metadata) falls
   * back to the base directory rest length.
   */
  private restLengthFor(meta: NodeMeta | undefined): number {
    if (meta?.isFile) {
      return this.options.fileRestLength
    }
    const depth = meta?.depth ?? 1
    return this.options.restLength * (1 + Math.max(0, depth - 1) * this.options.restLengthDepthScale)
  }

  /**
   * Repulsion. Two distinct regimes, mirroring Gource:
   *
   * - **Directory <-> directory**: every directory pushes apart from every *nearby*
   *   directory (within {@link ForceLayoutOptions.repulsionCutoff}), no matter their
   *   parentage, so branches from different parents separate and stop crossing. Computed
   *   over the uniform {@link buildSpatialGrid} for `O(n)` cost.
   * - **File <-> file-sibling**: a file only repels the *other files of the same
   *   directory*, at a gentler strength, so a directory's files spread into a tidy
   *   satellite cluster without shoving the whole forest around. A file never repels a
   *   directory or a file from another directory.
   *
   * Each unordered pair is visited once (within a cell, only a right index past the left;
   * across cells, each cross pair once via {@link buildSpatialGrid}'s forward neighbors)
   * and the equal-and-opposite push applied to both, so the work is halved and forces stay
   * symmetric. The pinned root is a repulsion *source* (nodes do not pile onto the center)
   * but, being absent from `forces`, receives none itself.
   */
  private applyRepulsion(forces: Map<string, Vec2>): void {
    const cutoff = this.options.repulsionCutoff
    const grid = buildSpatialGrid(this.bodies, cutoff)
    const cutoffSquared = cutoff * cutoff

    for (const cell of grid.cells.values()) {
      for (const neighborCell of grid.neighborhoodOf(cell.cellX, cell.cellY)) {
        const sameCell = neighborCell === cell
        for (let leftIndex = 0; leftIndex < cell.members.length; leftIndex++) {
          const startRight = sameCell ? leftIndex + 1 : 0
          for (let rightIndex = startRight; rightIndex < neighborCell.members.length; rightIndex++) {
            const left = cell.members[leftIndex]
            const right = neighborCell.members[rightIndex]
            this.repelPair(forces, left, right, cutoffSquared)
          }
        }
      }
    }
  }

  /**
   * Applies the symmetric repulsion between one pair of bodies, choosing the regime from
   * what the two nodes are. A file only interacts with another file in the *same*
   * directory (the satellite cluster); a pair that mixes a file with a directory, or two
   * files from different directories, exerts no repulsion, so files never disturb the
   * directory skeleton. Two directories use the global inverse-square push.
   */
  private repelPair(
    forces: Map<string, Vec2>,
    left: GridBody,
    right: GridBody,
    cutoffSquared: number,
  ): void {
    const leftMeta = this.metaByPath.get(left.path)
    const rightMeta = this.metaByPath.get(right.path)
    const leftIsFile = leftMeta?.isFile ?? false
    const rightIsFile = rightMeta?.isFile ?? false

    let strength: number
    if (leftIsFile || rightIsFile) {
      // Files only cluster-repel their own directory's other files; otherwise nothing, so
      // a file never pushes a directory (or a stranger file) and stays a tight satellite.
      const sameDirectory
        = leftIsFile && rightIsFile && leftMeta!.displayParentPath === rightMeta!.displayParentPath
      if (!sameDirectory) {
        return
      }
      strength = this.options.fileRepulsionStrength
    }
    else {
      strength = this.options.repulsionStrength
    }
    if (strength <= 0) {
      return
    }

    let offsetX = left.position.x - right.position.x
    let offsetY = left.position.y - right.position.y
    let distanceSquared = offsetX * offsetX + offsetY * offsetY
    if (distanceSquared > cutoffSquared) {
      // Beyond the cutoff the inverse-square force is negligible; skip it so a body only
      // ever feels its genuine near neighbors (the whole point of the grid).
      return
    }

    let distance = Math.sqrt(distanceSquared)
    if (distance < this.options.repulsionMinDistance) {
      // Two near-coincident nodes: nudge them onto a deterministic axis from a hash of the
      // pair so they separate the same way every run, never randomly, then clamp the
      // distance so the inverse-square force stays finite.
      const nudge = pairNudge(left.path, right.path)
      offsetX = nudge.x
      offsetY = nudge.y
      distance = this.options.repulsionMinDistance
      distanceSquared = distance * distance
    }

    // Inverse-square magnitude so close nodes shove hard and ones near the cutoff barely
    // interact, blending smoothly into the hard cutoff with no visible seam.
    const magnitude = strength / distanceSquared
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

  /**
   * Semi-implicit Euler integration with velocity damping: advance each non-pinned body's
   * velocity by its accumulated force, bleed off a fraction of that velocity so the system
   * loses energy and settles, then move the position by the new velocity. Done in this
   * order (velocity first, then position) because semi-implicit Euler stays stable at the
   * variable, sometimes large time steps a RAF loop produces, where plain (explicit) Euler
   * would gain energy and blow up.
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
   * Where a brand-new node should be born (Gource's `setInitialPosition`): at its
   * display-parent's current position, nudged a small spawn offset *along its outward
   * direction* so it emerges from the branch already pointing away from the center rather
   * than in a random hash direction that might fold back inward. A small per-path hash jitter
   * is mixed in so siblings born together fan out instead of stacking on one ray. Falls back
   * to a radial nudge from the configured center when the display-parent has no body yet (a
   * repo root hanging off the undrawn forest center).
   */
  private spawnPositionFor(path: string, meta: NodeMeta): Vec2 {
    const parentBody = this.bodies.get(meta.displayParentPath)
    const anchor = parentBody ? parentBody.position : this.options.center

    let directionX: number
    let directionY: number
    if (parentBody) {
      const outward = this.outwardDirectionFor(meta, parentBody.position)
      // A small deterministic angular jitter off the outward ray so siblings spawned in the
      // same frame separate rather than landing on the identical point.
      const jitter = ((hashPath(path) / 0xffffffff) - 0.5) * SPAWN_JITTER_RADIANS
      const angle = Math.atan2(outward.y, outward.x) + jitter
      directionX = Math.cos(angle)
      directionY = Math.sin(angle)
    }
    else {
      // No live parent (repo root): a stable radial ray from the center, hashed per path.
      const angle = (hashPath(path) / 0xffffffff) * Math.PI * 2
      directionX = Math.cos(angle)
      directionY = Math.sin(angle)
    }

    return {
      x: anchor.x + directionX * this.options.spawnOffset,
      y: anchor.y + directionY * this.options.spawnOffset,
    }
  }
}

/**
 * Per-node layout metadata the sim captures once per {@link ForceLayout.sync} and reads
 * every {@link ForceLayout.step}, so no force has to re-walk the tree. Keyed in
 * {@link ForceLayout} by the node's real path.
 */
type NodeMeta = {
  /** Path of the nearest visible ancestor; `''` for a repo root hanging off the forest center. */
  displayParentPath: string
  /** Whether the node is a file (a satellite of its directory) rather than a directory. */
  isFile: boolean
  /** The node's visible depth (1 for a repo root), used to scale the directory rest length. */
  depth: number
  /** This node's slot among its directory-siblings, for fanning across the parent's outward arc. */
  wedge: SiblingWedge
}

/**
 * A directory's slice of its parent's outward-facing arc: which of `count` sibling
 * directories this is (`index`), so {@link siblingWedgeOffset} can fan them evenly across
 * the arc. A lone child (`count: 1`) gets the exact outward direction (zero offset) so a
 * deep single-child chain grows straight out instead of drifting.
 */
export type SiblingWedge = {
  index: number
  count: number
}

/**
 * Assigns each *directory* a {@link SiblingWedge} slot among the directory-children of its
 * display-parent, so the directional force can fan siblings across the parent's outward arc
 * with each subtree owning its own wedge. Files are excluded (they are satellites, not part
 * of the spread) and so are never given a slot.
 *
 * Pure and deterministic: siblings are ordered by path (independent of Map/event order) so a
 * re-sync after a rewind reproduces the same wedge assignment. Mirrors Gource distributing a
 * parent's circumference among its visible child directories.
 */
export function assignSiblingWedges(visibleNodes: VisibleNode[]): Map<string, SiblingWedge> {
  const directoryChildrenByParent = new Map<string, string[]>()
  for (const visible of visibleNodes) {
    if (visible.isForestRoot || visible.node.isFile) {
      continue
    }
    const siblings = directoryChildrenByParent.get(visible.displayParentPath)
    if (siblings) {
      siblings.push(visible.node.path)
    }
    else {
      directoryChildrenByParent.set(visible.displayParentPath, [ visible.node.path ])
    }
  }

  const wedgeByPath = new Map<string, SiblingWedge>()
  for (const siblings of directoryChildrenByParent.values()) {
    const ordered = [ ...siblings ].sort((left, right) => {
      return left < right ? -1 : left > right ? 1 : 0
    })
    for (const [ index, path ] of ordered.entries()) {
      wedgeByPath.set(path, { index, count: ordered.length })
    }
  }
  return wedgeByPath
}

/**
 * The angular offset (in radians) from the parent's outward direction that this sibling
 * should be biased toward, spreading `count` siblings evenly across an arc of total width
 * `arcWidth` centered on the outward direction. A lone child (`count <= 1`) gets `0` so it
 * grows straight outward; otherwise sibling `index` of `count` sits at its slice center,
 * from `-arcWidth/2` to `+arcWidth/2`. Pure, so it is directly unit-testable.
 */
export function siblingWedgeOffset(wedge: SiblingWedge, arcWidth: number): number {
  if (wedge.count <= 1) {
    return 0
  }
  const sliceWidth = arcWidth / wedge.count
  const arcStart = -arcWidth / 2
  // The slice center: half a slice in, then one slice per index, so the fan is symmetric
  // about the outward direction (e.g. two siblings land at -arcWidth/4 and +arcWidth/4).
  return arcStart + sliceWidth * (wedge.index + 0.5)
}

/**
 * The preferred outward unit direction for a node given its parent's and grandparent's
 * positions: grandparent -> parent, normalized (Gource's `parent_edge_normal`), so a branch
 * grows the way it already pointed and away from the center. Pass the configured `center` as
 * `grandparentPosition` for a repo root (its grandparent is the undrawn forest center), which
 * makes its outward direction radial: center -> parent. When parent and grandparent coincide
 * the direction is undefined; the caller supplies a `fallback` unit ray (a stable per-path
 * hash) so the result is always well-defined. Pure, so it is directly unit-testable.
 */
export function outwardDirection(
  parentPosition: Vec2,
  grandparentPosition: Vec2,
  fallback: Vec2,
): Vec2 {
  const directionX = parentPosition.x - grandparentPosition.x
  const directionY = parentPosition.y - grandparentPosition.y
  const length = Math.hypot(directionX, directionY)
  if (length < EPSILON) {
    return fallback
  }
  return { x: directionX / length, y: directionY / length }
}

/**
 * Tuning for {@link ForceLayout}. Every field has a sensible default, so the common
 * construction is `new ForceLayout()`. These are the knobs the user will reach for to make
 * the forest feel livelier or calmer, or to trade tightness against spread.
 */
export type ForceLayoutOptions = {
  /** Layout-space center the forest root is pinned at and stray repo roots are drawn toward. Defaults to the origin. */
  center?: Vec2
  /** Rest length of a depth-1 directory edge (repo root to center) in layout units. Deeper edges scale up from this. */
  restLength?: number
  /**
   * How much the directory rest length grows per visible depth past the first ring, as a
   * fraction of {@link restLength}. `0.5` makes a depth-3 directory rest twice as far from
   * its parent as a depth-1 one, so deeper rings spread instead of crowding the trunk.
   */
  restLengthDepthScale?: number
  /** Edge-spring stiffness: how hard a node is pulled to its rest length from its parent. */
  springStiffness?: number
  /**
   * Strength of the outward directional pull on directories (Gource's outward-arc force):
   * how firmly a directory is biased toward the point one rest length out from its parent
   * along its wedge of the parent's outward direction. Higher gives a crisper radial,
   * less-crossing tree; lower lets repulsion and the spring dominate for a looser look.
   */
  directionalStrength?: number
  /**
   * Total angular width (radians) of the arc a parent's child directories fan across,
   * centered on the parent's outward direction. Wider lets many siblings spread without
   * overlapping; narrower keeps a subtree tightly columnar. Kept below `PI` so children
   * stay on the outward-facing half and never fold back toward the center.
   */
  siblingArc?: number
  /**
   * Rest length of a file's edge to its directory, in layout units. Much shorter than a
   * directory edge so files hug their directory as a tight satellite cluster rather than
   * spreading like a sub-tree.
   */
  fileRestLength?: number
  /**
   * Repulsion strength among the files of one directory (the satellite-cluster spread).
   * Gentler than the directory repulsion so a directory's files fan into a readable ring
   * without shoving the directory skeleton around. Files only ever repel their own
   * directory's other files.
   */
  fileRepulsionStrength?: number
  /**
   * Directory-to-directory repulsion strength: the numerator of the inverse-square push
   * between any two nearby directories (within {@link repulsionCutoff}). Larger spreads the
   * forest wider, separating branches more, before the springs rein them back in.
   */
  repulsionStrength?: number
  /**
   * The closest two nodes are treated as being for the repulsion force, in layout units.
   * Clamps the inverse-square magnitude so near-coincident spawns get a strong but finite
   * shove apart rather than an infinite one.
   */
  repulsionMinDistance?: number
  /**
   * The cutoff radius of the repulsion, in layout units: two nodes farther apart than this
   * exert no repulsion on each other. It is also the spatial grid's cell side, so a body
   * only ever tests the bodies in its own and the eight neighboring cells. Sized a few
   * rest-lengths wide so a node pushes apart from the neighbors that would otherwise cross
   * or overlap it, while letting distant branches ignore each other (which is both correct,
   * the force is negligible there, and what keeps the grid cheap).
   */
  repulsionCutoff?: number
  /**
   * Per-second velocity damping in `[0, 1)`: the fraction of a body's speed bled off each
   * second. Higher settles faster (sluggish at the extreme); lower stays livelier and rings
   * longer. Tuned so a new node's disturbance eases out over roughly one to two seconds.
   */
  damping?: number
  /**
   * The largest single integration step, in milliseconds. A real delta longer than this (a
   * backgrounded tab, a GC hitch) is clamped to it so one giant step never flings the forest
   * apart; the sim simply advances a little slower than wall time across the stall.
   */
  maxStepMs?: number
  /**
   * How far a freshly spawned node is offset from its parent, in layout units, so it emerges
   * visibly off the branch (already pointing outward) rather than spawning exactly on the parent.
   */
  spawnOffset?: number
}

/** A small floor on a distance so a normalize divide never hits zero for two coincident bodies. */
const EPSILON = 1e-6

/**
 * Default rest length of a depth-1 directory edge, in layout units. Comparable to the old
 * radial `ringSpacing` so the forest reads at roughly the same scale.
 */
const DEFAULT_REST_LENGTH = 120

/** Default per-depth rest-length growth: a deeper directory edge rests half-again further out per ring. */
const DEFAULT_REST_LENGTH_DEPTH_SCALE = 0.35

/**
 * Default edge-spring stiffness. Firm enough to hold the skeleton together against the
 * global directory repulsion, soft enough to settle without ringing hard. The directional
 * pull below shares the spreading job, so this can stay moderate.
 */
const DEFAULT_SPRING_STIFFNESS = 26

/**
 * Default outward-directional strength (the anti-crossing pull). Sized so a directory
 * reliably settles into its outward wedge and branches stop folding back, while staying soft
 * enough that the spring + repulsion keep the motion springy rather than snapping nodes onto
 * a rigid radial grid. This is the primary knob for "more organized" vs "looser".
 */
const DEFAULT_DIRECTIONAL_STRENGTH = 12

/**
 * Default sibling arc width, in radians (~150 degrees). A parent's child directories fan
 * across this much of the circle centered on the outward direction. Below `PI` so children
 * stay on the outward-facing half and never fold back toward the center, but wide enough that
 * a parent with many child directories spreads them without piling up.
 */
const DEFAULT_SIBLING_ARC = (5 / 6) * Math.PI

/**
 * Default file rest length, in layout units: well under a directory's {@link DEFAULT_REST_LENGTH}
 * so files orbit close to their directory as a tight satellite cluster rather than spreading
 * like a sub-tree.
 */
const DEFAULT_FILE_REST_LENGTH = 40

/**
 * Default file-sibling repulsion strength. Much gentler than the directory repulsion so a
 * directory's files fan into a readable little ring around it without disturbing the spread.
 */
const DEFAULT_FILE_REPULSION_STRENGTH = 6_000

/**
 * Default directory-to-directory repulsion strength (the inverse-square numerator). Sized so
 * different branches separate cleanly and stop crossing while the springs and the directional
 * pull still rein the tree in; raise it for an airier forest, lower for denser.
 */
const DEFAULT_REPULSION_STRENGTH = 38_000

/** Default minimum repulsion distance, so two near-coincident spawns shove apart finitely. */
const DEFAULT_REPULSION_MIN_DISTANCE = 8

/**
 * Default repulsion cutoff / grid cell side, in layout units. About two-and-a-half depth-1
 * rest-lengths wide, so a node repels the neighbors close enough to cross or overlap it yet
 * ignores branches that are comfortably far. Doubles as the spatial grid's cell size.
 */
const DEFAULT_REPULSION_CUTOFF = 300

/**
 * Default per-second damping: a body bleeds ~90% of its speed per second (retaining ~10%),
 * so the forest settles in the one-to-two-second range the user asked for: lively, not
 * sluggish, and without a long ringing tail.
 */
const DEFAULT_DAMPING = 0.90

/** Default integration-step clamp: ~3 frames at 60fps, enough to smooth a hitch without stalling the sim. */
const DEFAULT_MAX_STEP_MS = 50

/** Default spawn offset: a small nudge off the parent so a new node visibly emerges from its branch. */
const DEFAULT_SPAWN_OFFSET = 12

/**
 * The total angular jitter (radians) a freshly spawned node's outward ray is randomized
 * within, so siblings born in the same frame separate slightly instead of landing on one
 * point. Kept small so the spawn still clearly points outward.
 */
const SPAWN_JITTER_RADIANS = Math.PI / 6

/**
 * A deterministic unit-ish separation axis for two coincident nodes, from a hash of their
 * combined paths. So two nodes landing on the exact same point always push apart along the
 * same direction (never a random one), keeping a re-sync after a rewind reproducible.
 * Order-independent so the pair yields the same axis whichever way it is iterated.
 */
function pairNudge(leftPath: string, rightPath: string): Vec2 {
  const combined = leftPath < rightPath ? `${leftPath} ${rightPath}` : `${rightPath} ${leftPath}`
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
 * One occupied cell of the {@link SpatialGrid}: its integer grid coordinates and the bodies
 * that hashed into it. Empty cells are never materialized, so the grid's size is bounded by
 * the number of *occupied* cells, not the (possibly vast) span of the forest.
 */
export type GridCell = {
  cellX: number
  cellY: number
  members: GridBody[]
}

/**
 * A uniform-bucket spatial index over the live bodies, the backbone of the `O(n)` repulsion.
 * Every body is binned into a square cell of side `cellSize` (the repulsion cutoff), so two
 * bodies that could repel each other (within the cutoff) are guaranteed to share a cell or
 * sit in adjacent cells. The repulsion then only has to test a body against the bodies in its
 * own and the eight neighboring cells.
 *
 * {@link neighborhoodOf} is the careful part: it yields, for a given cell, that cell itself
 * plus only the neighbor cells on the "greater" side, so iterating every cell and its
 * neighborhood visits each unordered cell-pair exactly once.
 */
export type SpatialGrid = {
  /** The occupied cells, keyed by a packed `cellX,cellY` string. */
  cells: Map<string, GridCell>
  /**
   * The cell itself plus its forward-side neighbors, chosen so iterating all cells and each
   * one's neighborhood touches every unordered cell-pair exactly once. The own cell is
   * yielded first so the caller can special-case the within-cell pairing.
   */
  neighborhoodOf: (cellX: number, cellY: number) => GridCell[]
}

/**
 * Bins `bodies` into a uniform spatial grid of cell side `cellSize` for the repulsion pass.
 * Pure (no time, no randomness, no mutation of the inputs) and so directly unit-testable: the
 * same bodies + cell size always yield the same buckets and neighborhoods.
 *
 * A non-finite or non-positive `cellSize` is a programming error upstream; we log and floor
 * it to `1` rather than divide by it and scatter every body into nonsense cells.
 *
 * The eight forward neighbor offsets are chosen so that, combined with the own cell, iterating
 * every cell's neighborhood enumerates each unordered cell-pair once (the lower-keyed cell of a
 * pair owns the edge to the higher-keyed one). See {@link FORWARD_NEIGHBOR_OFFSETS}.
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
 * The four forward neighbor offsets that, paired with each cell's own bucket, let a sweep over
 * every cell's neighborhood visit each adjacent cell-pair exactly once. Of the eight
 * surrounding cells we take only the four on the "greater" side (right, and the three on the
 * row above): the opposite four are covered when *those* cells are the iteration's current
 * cell. This halves the cross-cell work and keeps each repulsion force counted a single time.
 */
const FORWARD_NEIGHBOR_OFFSETS = [
  { x: 1, y: 0 },
  { x: -1, y: 1 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
] as const
