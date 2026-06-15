// Copyright © 2026 Jalapeno Labs

import type { Vec2, NodePhysics } from './layout'
import type { VisibleNode } from './collapse'

import { nodeHeat } from './layout'

/**
 * The continuous, Gource-style force-directed layout: a living physics simulation that
 * replaces the old deterministic radial tidy-tree. Every visible node carries a position and
 * velocity that evolve under a handful of forces each frame, so adding a node makes its local
 * neighborhood drift apart and re-settle organically instead of the canvas looking frozen
 * between events. The springiness and continuous, smooth settling are deliberate and loved.
 *
 * ### The fluid, self-settling model (this rework)
 *
 * The previous version forced every directory toward a precomputed *outward wedge target* with
 * a firm directional pull, which organized the tree but felt rigid (nodes snapped toward a
 * radial grid) and still let nodes OVERLAP because the repulsion never knew how big a node was
 * drawn. This version pivots toward a more fluid, emergent layout where the nodes settle
 * themselves:
 *
 * - **Real size-aware collision** ({@link applyCollision}) is the headline fix for overlap.
 *   Every body carries a {@link NodeMeta.collisionRadius} that matches its DRAWN size (captured
 *   in {@link sync} from the steady base radius, never the transient touch pulse, so it is
 *   stable). When two bodies sit closer than `radiusA + radiusB + margin` they are pushed apart
 *   *firmly, in proportion to how deeply they penetrate*, so they end up touching-but-not-
 *   overlapping; past that gap the force is exactly zero. This replaces the old inverse-square
 *   repulsion, which had no notion of size and so could never guarantee no-overlap.
 * - **Sibling-count rest length** ({@link restLengthFor}): a node's spring rest length to its
 *   parent grows with how many visible siblings share its ring, so a parent with many children
 *   pushes them out to a bigger ring whose circumference has room for all of them. A lone child
 *   stays close; six children sit on a noticeably wider ring. See the formula on
 *   {@link restLengthFor}.
 * - **A gentle outward bias** ({@link applyOutwardBias}), NOT a rigid wedge target. Directories
 *   feel a soft nudge directly away from the center (radially outward) so branches grow away
 *   from the trunk and do not collapse inward or fold back, but there is no per-sibling target
 *   angle anymore: the collision + sibling-count rest length + springs do the real organizing
 *   as the nodes settle themselves. A new node spawns near its parent pointing gently outward,
 *   then drifts and settles via collision.
 * - **Files cluster around their directory** (Gource `RFile`): a file is a satellite. It springs
 *   to a short rest length from its directory and collides only with its file-siblings and its
 *   own directory, so files bunch close to the directory they belong to while the directories
 *   form the spread skeleton.
 *
 * The forest root (when shown) is **pinned** at the center: fixed position, zero velocity, never
 * integrated, so the whole forest hangs and settles around it.
 *
 * This is **forward-only visual state**. It is NOT a pure function of the tree, and that is the
 * accepted tradeoff for the always-alive feel: a backward seek re-folds the (pure) tree and then
 * re-syncs the sim, which re-settles rather than reproducing pixel-exact prior positions.
 *
 * ### Collision complexity (uniform spatial grid)
 *
 * Collision acts between ALL nearby directories (and a file and its directory's satellites), not
 * just siblings, so different branches separate. A naive all-pairs pass would be `O(n^2)` per
 * frame. Instead it runs over a **uniform-bucket spatial grid** ({@link buildSpatialGrid}): every
 * body is hashed into a square cell of side {@link collisionCellSize}, and a body only tests the
 * bodies in its own cell and the eight neighbors. The cell side is sized at least one largest
 * collision diameter plus the margin, so any genuinely overlapping pair is guaranteed to share a
 * cell or sit adjacent and is never missed. Building the grid is `O(n)`.
 */
export class ForceLayout {
  /** Live per-node physics, keyed by the node's real (full) path. The public read surface. */
  private readonly bodies: Map<string, NodePhysics>

  /**
   * Per-node layout metadata captured on {@link sync} from the collapse, so {@link step} can
   * apply the spring / outward / collision forces without re-walking the tree each frame. Keyed
   * by real node path; the forest root and an un-synced node are absent.
   */
  private readonly metaByPath: Map<string, NodeMeta>

  /**
   * The path of the pinned forest root (`''`) when one is shown, else `null`. A pinned body is
   * held at the center with zero velocity and skipped by the integrator, so everything else
   * hangs and settles around it.
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
      siblingRestScale: options.siblingRestScale ?? DEFAULT_SIBLING_REST_SCALE,
      springStiffness: options.springStiffness ?? DEFAULT_SPRING_STIFFNESS,
      outwardBias: options.outwardBias ?? DEFAULT_OUTWARD_BIAS,
      fileRestLength: options.fileRestLength ?? DEFAULT_FILE_REST_LENGTH,
      collisionStiffness: options.collisionStiffness ?? DEFAULT_COLLISION_STIFFNESS,
      collisionMargin: options.collisionMargin ?? DEFAULT_COLLISION_MARGIN,
      directoryRadius: options.directoryRadius ?? DEFAULT_DIRECTORY_RADIUS,
      fileRadius: options.fileRadius ?? DEFAULT_FILE_RADIUS,
      damping: options.damping ?? DEFAULT_DAMPING,
      maxStepMs: options.maxStepMs ?? DEFAULT_MAX_STEP_MS,
      spawnOffset: options.spawnOffset ?? DEFAULT_SPAWN_OFFSET,
    }
  }

  /**
   * The live physics map. The scene, labels, beams, camera, and picking read positions straight
   * off this, exactly where they used to read the spring state, so the rest of the controller is
   * unchanged by the switch to forces. Returned by reference (not copied) because it is read
   * every frame; callers must not mutate it.
   */
  public get state(): Map<string, NodePhysics> {
    return this.bodies
  }

  /**
   * Reconciles the simulation's bodies with the current visible set (the output of
   * {@link collapseTree}). This is the structural step, run only when the tree's shape changed:
   *
   * - A **new** visible node gets a body spawned at its display-parent's *current* position,
   *   nudged a small offset along its outward direction so it visibly emerges from the parent it
   *   hangs off, already pointing away from the center. A repo root with no live parent falls
   *   back to a radial nudge from the configured center.
   * - A node no longer visible has its body **removed**, so a deleted or collapsed-away node
   *   stops being simulated and drawn.
   * - The forest root (when present, flagged `isForestRoot`) is **pinned** at the center.
   *
   * The per-node metadata index ({@link NodeMeta}) is rebuilt here too: each node's display-
   * parent, whether it is a file, its depth, its collision radius (matched to the drawn size),
   * and how many visible siblings share its ring (so the rest length can widen the ring to fit
   * them all). That lets every {@link step} apply the spring, outward, and collision forces
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

    // How many visible siblings share each display-parent's ring, so the rest length can widen
    // the ring to give all of them room (counted per kind: directories and files keep separate
    // rings, since files rest much closer in as satellites).
    const siblingCounts = countSiblings(visibleNodes)

    for (const visible of visibleNodes) {
      if (visible.isForestRoot) {
        continue
      }
      const path = visible.node.path
      const meta: NodeMeta = {
        displayParentPath: visible.displayParentPath,
        isFile: visible.node.isFile,
        depth: visible.depth,
        siblingCount: siblingCounts.get(siblingKey(visible)) ?? 1,
        collisionRadius: collisionRadiusFor(visible, this.options),
      }
      this.metaByPath.set(path, meta)

      if (!this.bodies.has(path)) {
        this.bodies.set(path, {
          position: this.spawnPositionFor(path, meta),
          velocity: { x: 0, y: 0 },
        })
      }
    }

    // Drop bodies whose node is no longer visible (deleted or collapsed away), so the sim and
    // the drawn forest stay in lockstep and the map does not grow without bound.
    for (const path of [ ...this.bodies.keys() ]) {
      if (!livePaths.has(path)) {
        this.bodies.delete(path)
      }
    }
  }

  /**
   * Clears the whole simulation: every body, index, and the pin. Used on a backward-seek
   * rebuild, where the controller re-folds the tree and then re-syncs from the rebuilt visible
   * set, letting the sim re-settle from fresh spawns rather than carrying stale positions across
   * the rewind.
   */
  public reset(): void {
    this.bodies.clear()
    this.metaByPath.clear()
    this.pinnedPath = null
  }

  /**
   * Advances the simulation by `deltaMs` of real wall time, applying the forces and integrating
   * with semi-implicit Euler (update velocity from the force, then move by the new velocity).
   * Run EVERY frame, continuously, so the forest is always gently alive: even with no structural
   * change, residual velocity keeps settling and a recent disturbance keeps propagating and
   * easing out.
   *
   * The delta is clamped to {@link ForceLayoutOptions.maxStepMs} for stability: a long stall (a
   * backgrounded tab, a GC pause) must not deliver one giant step that flings nodes across the
   * canvas. A non-positive or non-finite delta is a no-op so a paused or malformed frame never
   * corrupts the state.
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

    // Accumulate this frame's forces per body before integrating, so every force reads the same
    // start-of-frame positions (an explicit, order-independent step).
    const forces = new Map<string, Vec2>()
    for (const path of this.bodies.keys()) {
      if (path === this.pinnedPath) {
        continue
      }
      forces.set(path, { x: 0, y: 0 })
    }

    this.applyEdgeSprings(forces)
    this.applyOutwardBias(forces)
    this.applyCollision(forces)
    this.integrate(forces, deltaSeconds)
  }

  /**
   * Edge spring: pulls each node toward its display-parent so it settles at roughly the rest
   * length away, keeping the tree skeleton intact (Gource's gravity-to-parent).
   *
   * Directories rest a depth-and-sibling-scaled distance out (see {@link restLengthFor}); files
   * rest at the much shorter {@link ForceLayoutOptions.fileRestLength}, so they hug the directory
   * they belong to as a tight satellite cluster instead of spreading like a sub-tree. A node
   * whose display-parent has no body yet (a repo root hanging off the undrawn center) is pulled
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

      // Hooke's law toward the anchor: force is proportional to how far the current separation is
      // from the rest length, directed along the parent->node axis.
      const stretch = distance - restLength
      const pull = this.options.springStiffness * stretch
      force.x -= (offsetX / distance) * pull
      force.y -= (offsetY / distance) * pull
    }
  }

  /**
   * A gentle outward bias on directories (files are satellites and skip it): a soft, constant-
   * magnitude nudge pointing directly away from the center, so a branch keeps growing away from
   * the trunk and never collapses inward or folds back over the center. This is deliberately a
   * *weak* push, far softer than the old rigid wedge-target pull: it only keeps the tree growing
   * outward while the collision, the sibling-count rest length, and the springs do the real
   * organizing as the nodes settle themselves. There is no per-sibling target angle anymore, so
   * the layout is emergent rather than snapped onto a radial grid.
   *
   * The bias is scaled by the spring stiffness and rest length so it stays in proportion to the
   * spring no matter how the forest is tuned: `outwardBias` is the fraction of a unit spring's
   * pull it contributes. A directory sitting exactly on the center (no defined outward direction)
   * gets no bias that frame; the spawn nudge and the spring move it off-center first.
   */
  private applyOutwardBias(forces: Map<string, Vec2>): void {
    const center = this.options.center
    for (const [ path, force ] of forces) {
      const meta = this.metaByPath.get(path)
      if (!meta || meta.isFile) {
        continue
      }

      const body = this.bodies.get(path)!
      const offsetX = body.position.x - center.x
      const offsetY = body.position.y - center.y
      const distance = Math.hypot(offsetX, offsetY)
      if (distance < EPSILON) {
        // On the center exactly: no outward direction yet. The spring + spawn nudge move it off
        // first, then the bias kicks in next frame.
        continue
      }

      // A soft outward push proportional to the spring scale, so branches grow away from the
      // trunk without the rigid snap of a wedge target.
      const magnitude = this.options.outwardBias * this.options.springStiffness * this.options.restLength
      force.x += (offsetX / distance) * magnitude
      force.y += (offsetY / distance) * magnitude
    }
  }

  /**
   * The rest length for a node: short and flat for a file (a tight satellite radius around its
   * directory) or, for a directory, scaled by BOTH its depth and how many siblings share its
   * ring.
   *
   * - **Depth**: deeper rings sit progressively further out so the forest fans rather than
   *   crowding the trunk (the `1 + (depth - 1) * restLengthDepthScale` factor).
   * - **Sibling count**: the headline of this rework. A ring at radius `R` has circumference
   *   `2*pi*R`; to seat `n` sibling directories of diameter `d` around it without overlap that
   *   circumference must be at least `n * (d + margin)`, i.e. `R >= n * (d + margin) / (2*pi)`.
   *   So the rest length grows linearly with the sibling count: a parent with many children
   *   pushes its ring outward to where there is room for all of them, while a lone child stays at
   *   the base rest length. {@link siblingRestScale} tempers how aggressively the ring widens
   *   (1 = the full geometric requirement; lower packs the ring tighter and leans on collision).
   *
   * An un-tracked node (no metadata) falls back to the base directory rest length.
   */
  private restLengthFor(meta: NodeMeta | undefined): number {
    if (meta?.isFile) {
      return this.options.fileRestLength
    }
    const depth = meta?.depth ?? 1
    const depthFactor = 1 + Math.max(0, depth - 1) * this.options.restLengthDepthScale
    const base = this.options.restLength * depthFactor

    // The ring radius that gives the whole sibling group room: enough circumference at the ring
    // to seat every sibling's collision diameter plus its margin. `siblingRestScale` dials how
    // much of that full geometric requirement is honored by the spring vs left to collision.
    const siblingCount = meta?.siblingCount ?? 1
    const siblingDiameter = ((meta?.collisionRadius ?? this.options.directoryRadius) * 2) + this.options.collisionMargin
    const ringRadiusForSiblings = (siblingCount * siblingDiameter) / (2 * Math.PI)
    const siblingFloor = ringRadiusForSiblings * this.options.siblingRestScale

    // Take whichever is larger: the base depth ring, or the radius the sibling group needs. A
    // lone child keeps the base; a crowded ring is pushed outward to fit everyone.
    return Math.max(base, siblingFloor)
  }

  /**
   * Real size-aware collision: the no-overlap force. Over the uniform {@link buildSpatialGrid},
   * every pair of nearby bodies that may collide is visited once and, when they penetrate (sit
   * closer than the sum of their collision radii plus the margin), pushed apart in proportion to
   * how deeply they overlap, so they settle touching-but-not-overlapping. Past that gap the force
   * is exactly zero, so well-separated nodes feel nothing (no long-range shove that would fight
   * the spring).
   *
   * Two regimes, mirroring Gource:
   * - **Directory <-> directory**: every directory collides with every *nearby* directory, no
   *   matter their parentage, so branches from different parents separate and never overlap.
   * - **File**: a file collides with the *other files of the same directory* and with its own
   *   directory, so a directory's files spread into a tidy non-overlapping satellite cluster that
   *   stays hugging the directory, without a file ever shoving a stranger directory or a file
   *   from another directory.
   *
   * The pinned root is a collision *source* (nodes do not pile onto the center) but, being absent
   * from `forces`, receives none itself.
   */
  private applyCollision(forces: Map<string, Vec2>): void {
    const cellSize = this.collisionCellSize()
    const grid = buildSpatialGrid(this.bodies, cellSize)

    for (const cell of grid.cells.values()) {
      for (const neighborCell of grid.neighborhoodOf(cell.cellX, cell.cellY)) {
        const sameCell = neighborCell === cell
        for (let leftIndex = 0; leftIndex < cell.members.length; leftIndex++) {
          const startRight = sameCell ? leftIndex + 1 : 0
          for (let rightIndex = startRight; rightIndex < neighborCell.members.length; rightIndex++) {
            this.collidePair(forces, cell.members[leftIndex], neighborCell.members[rightIndex])
          }
        }
      }
    }
  }

  /**
   * Applies the symmetric collision separation between one pair of bodies, choosing the regime
   * from what the two nodes are. A file only collides with another file in the *same* directory
   * or with its own directory (the satellite cluster); a pair that mixes a file with a stranger
   * directory, or two files from different directories, never collides, so files never disturb
   * the directory skeleton. Two directories always collide.
   *
   * The push is penetration-based: with the two collision radii summed and the margin added, the
   * force is `collisionStiffness * penetration` along the separating axis, so it grows the deeper
   * the overlap and vanishes the instant they no longer overlap. That is what lets the pair
   * settle exactly touching rather than oscillating or drifting through each other.
   */
  private collidePair(forces: Map<string, Vec2>, left: GridBody, right: GridBody): void {
    const leftMeta = this.metaByPath.get(left.path)
    const rightMeta = this.metaByPath.get(right.path)
    if (!shouldCollide(left.path, leftMeta, right.path, rightMeta)) {
      return
    }

    const leftRadius = leftMeta?.collisionRadius ?? this.options.directoryRadius
    const rightRadius = rightMeta?.collisionRadius ?? this.options.directoryRadius
    const minSeparation = leftRadius + rightRadius + this.options.collisionMargin

    let offsetX = left.position.x - right.position.x
    let offsetY = left.position.y - right.position.y
    let distance = Math.hypot(offsetX, offsetY)
    if (distance >= minSeparation) {
      // No overlap: the collision force is exactly zero past the touch distance, so separated
      // nodes feel nothing and the spring alone governs them.
      return
    }

    if (distance < EPSILON) {
      // Two near-coincident nodes: nudge them onto a deterministic axis from a hash of the pair
      // so they separate the same way every run, never randomly, then treat them as fully
      // penetrating so they shove apart hard.
      const nudge = pairNudge(left.path, right.path)
      offsetX = nudge.x
      offsetY = nudge.y
      distance = EPSILON
    }

    // Penetration depth: how far inside the touch distance they sit. The push is proportional to
    // it, directed along the separating axis, so the deeper the overlap the firmer the shove and
    // a just-touching pair feels almost nothing.
    const penetration = minSeparation - distance
    const magnitude = this.options.collisionStiffness * penetration
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
   * The spatial grid's cell side for collision: at least the largest collision diameter in the
   * forest plus the margin, so any genuinely overlapping pair is guaranteed to land in the same
   * cell or an adjacent one and is never missed by the nine-cell neighborhood test. Floored to a
   * sane minimum so an empty or tiny forest still bins sensibly.
   */
  private collisionCellSize(): number {
    let largestRadius = this.options.directoryRadius
    for (const meta of this.metaByPath.values()) {
      if (meta.collisionRadius > largestRadius) {
        largestRadius = meta.collisionRadius
      }
    }
    return Math.max(MIN_COLLISION_CELL_SIZE, largestRadius * 2 + this.options.collisionMargin)
  }

  /**
   * Semi-implicit Euler integration with velocity damping: advance each non-pinned body's
   * velocity by its accumulated force, bleed off a fraction of that velocity so the system loses
   * energy and settles, then move the position by the new velocity. Done in this order (velocity
   * first, then position) because semi-implicit Euler stays stable at the variable, sometimes
   * large time steps a RAF loop produces, where plain (explicit) Euler would gain energy and
   * blow up.
   */
  private integrate(forces: Map<string, Vec2>, deltaSeconds: number): void {
    // Per-second damping converted to this step: velocity retains `(1 - damping)^dt` of itself,
    // so the decay is framerate-independent (a long frame damps proportionally more than a short
    // one) rather than tied to a fixed step count.
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
   * Where a brand-new node should be born (Gource's `setInitialPosition`): at its display-
   * parent's current position, nudged a small spawn offset *outward* (directly away from the
   * center) so it emerges from the branch already pointing away from the trunk rather than in a
   * random direction that might fold back inward. A small per-path hash jitter is mixed in so
   * siblings born together fan out instead of stacking on one ray, then drift and settle via
   * collision. Falls back to a radial nudge from the configured center when the display-parent
   * has no body yet (a repo root hanging off the undrawn forest center).
   */
  private spawnPositionFor(path: string, meta: NodeMeta): Vec2 {
    const parentBody = this.bodies.get(meta.displayParentPath)
    const anchor = parentBody ? parentBody.position : this.options.center
    const center = this.options.center

    // The outward ray: directly away from the center through the parent (or the parent itself
    // when it sits on the center). A stable per-path hash picks a ray when there is no outward
    // direction yet, so siblings still fan deterministically rather than stacking.
    let outwardX = anchor.x - center.x
    let outwardY = anchor.y - center.y
    const outwardLength = Math.hypot(outwardX, outwardY)
    if (outwardLength < EPSILON) {
      const fallbackAngle = (hashPath(path) / 0xffffffff) * Math.PI * 2
      outwardX = Math.cos(fallbackAngle)
      outwardY = Math.sin(fallbackAngle)
    }
    else {
      outwardX /= outwardLength
      outwardY /= outwardLength
    }

    // A small deterministic angular jitter off the outward ray so siblings spawned in the same
    // frame separate rather than landing on the identical point, then let collision settle them.
    const jitter = ((hashPath(path) / 0xffffffff) - 0.5) * SPAWN_JITTER_RADIANS
    const baseAngle = Math.atan2(outwardY, outwardX) + jitter

    return {
      x: anchor.x + Math.cos(baseAngle) * this.options.spawnOffset,
      y: anchor.y + Math.sin(baseAngle) * this.options.spawnOffset,
    }
  }
}

/**
 * Per-node layout metadata the sim captures once per {@link ForceLayout.sync} and reads every
 * {@link ForceLayout.step}, so no force has to re-walk the tree. Keyed in {@link ForceLayout} by
 * the node's real path.
 */
export type NodeMeta = {
  /** Path of the nearest visible ancestor; `''` for a repo root hanging off the forest center. */
  displayParentPath: string
  /** Whether the node is a file (a satellite of its directory) rather than a directory. */
  isFile: boolean
  /** The node's visible depth (1 for a repo root), used to scale the directory rest length. */
  depth: number
  /**
   * How many visible siblings of the SAME kind share this node's display-parent ring, so the
   * rest length can widen the ring to fit them all. At least 1 (the node itself).
   */
  siblingCount: number
  /**
   * The node's collision radius, matched to its DRAWN size: captured from the steady base radius
   * (never the transient touch pulse, so it stays stable), files smaller than directories.
   */
  collisionRadius: number
}

/**
 * Whether two bodies collide, given their paths and metadata. Two directories always collide (the
 * global skeleton spread). Two files collide only when they are siblings of the SAME directory
 * (one satellite cluster), so cross-directory files never interfere. A file and a directory
 * collide only when the directory is the file's OWN parent (the file's `displayParentPath` equals
 * the directory's path), so the file is held just outside its own directory disc and never
 * overlaps it, yet never collides with a stranger directory it merely happens to sit near. Pure,
 * so the regime choice is one easy-to-read place and the file-cluster invariant is enforced once.
 */
export function shouldCollide(
  leftPath: string,
  leftMeta: NodeMeta | undefined,
  rightPath: string,
  rightMeta: NodeMeta | undefined,
): boolean {
  const leftIsFile = leftMeta?.isFile ?? false
  const rightIsFile = rightMeta?.isFile ?? false

  if (!leftIsFile && !rightIsFile) {
    return true
  }
  if (leftIsFile && rightIsFile) {
    return leftMeta!.displayParentPath === rightMeta!.displayParentPath
  }
  // One file, one directory: collide only when the directory IS the file's own parent.
  if (leftIsFile) {
    return leftMeta!.displayParentPath === rightPath
  }
  return rightMeta!.displayParentPath === leftPath
}

/**
 * Counts how many visible siblings of the same kind (directory or file) share each display-
 * parent, keyed by {@link siblingKey}, so {@link ForceLayout.restLengthFor} can widen a crowded
 * ring to seat them all. Directories and files are counted separately because they live on
 * separate rings (files rest much closer in as satellites). Pure and deterministic so a re-sync
 * after a rewind reproduces the same counts. Files and directories of the forest root are
 * skipped (the root is not a body).
 */
export function countSiblings(visibleNodes: VisibleNode[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const visible of visibleNodes) {
    if (visible.isForestRoot) {
      continue
    }
    const key = siblingKey(visible)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/**
 * The grouping key for {@link countSiblings}: a node's display-parent plus its kind, so a
 * directory's directory-siblings and its file-siblings are counted as two separate rings. Pure.
 */
function siblingKey(visible: VisibleNode): string {
  const kind = visible.node.isFile ? 'file' : 'dir'
  return `${kind}:${visible.displayParentPath}`
}

/**
 * The collision radius for a visible node, matched to the size it is DRAWN at. It reads the
 * node's *steady* base radius from {@link nodeHeat} (passing `now = 0`, which is irrelevant since
 * the base radius depends only on the saturating touch importance, never recency), so the
 * collision size is stable and never breathes with the transient touch pulse that animates the
 * drawn disc. Files take {@link ForceLayoutOptions.fileRadius} of that base (smaller satellites);
 * directories take {@link ForceLayoutOptions.directoryRadius} (a touch larger, the structural
 * skeleton). Pure given the node + options, so it is directly unit-testable.
 */
export function collisionRadiusFor(visible: VisibleNode, options: Required<ForceLayoutOptions>): number {
  // The steady drawn base radius: depends only on the node's touch importance (a saturating bump),
  // not on `now`, so any time argument yields the same value. This is exactly the resting disc
  // size the renderer draws before the transient touch pulse swells it.
  const baseRadius = nodeHeat(visible.node, 0).radius
  const kindScale = visible.node.isFile ? options.fileRadius : options.directoryRadius
  return baseRadius * kindScale
}

/**
 * Tuning for {@link ForceLayout}. Every field has a sensible default, so the common construction
 * is `new ForceLayout()`. These are the knobs the user reaches for to make the forest feel
 * livelier or calmer, or to trade tightness against spread.
 */
export type ForceLayoutOptions = {
  /** Layout-space center the forest root is pinned at and stray repo roots are drawn toward. Defaults to the origin. */
  center?: Vec2
  /**
   * Rest length of a depth-1 directory edge (repo root to center) in layout units. Deeper and
   * more-crowded rings scale up from this.
   */
  restLength?: number
  /**
   * How much the directory rest length grows per visible depth past the first ring, as a fraction
   * of {@link restLength}. `0.35` makes a depth-3 directory rest ~70% further from its parent than
   * a depth-1 one, so deeper rings spread instead of crowding the trunk.
   */
  restLengthDepthScale?: number
  /**
   * How aggressively a parent's ring widens to fit its children: the fraction of the full
   * geometric "enough circumference to seat every sibling's diameter" radius that the spring
   * honors. `1` widens the ring to the exact no-overlap circumference; lower packs the ring
   * tighter and leans more on collision to finish separating siblings. This is the knob behind
   * "six children sit on a wider ring than one child".
   */
  siblingRestScale?: number
  /** Edge-spring stiffness: how hard a node is pulled to its rest length from its parent. */
  springStiffness?: number
  /**
   * Strength of the GENTLE outward bias on directories, as a fraction of a unit spring's pull.
   * Just enough that branches grow away from the trunk and never collapse inward or fold back,
   * but far softer than a rigid radial target so the layout stays fluid and emergent (the
   * collision + sibling-count rest length + springs do the real organizing). Raise it for a
   * crisper radial spread, lower for a looser, more clustered look. Set `0` for no outward bias
   * at all (pure spring + collision).
   */
  outwardBias?: number
  /**
   * Rest length of a file's edge to its directory, in layout units. Much shorter than a directory
   * edge so files hug their directory as a tight satellite cluster rather than spreading like a
   * sub-tree.
   */
  fileRestLength?: number
  /**
   * Collision stiffness: the force per unit of penetration depth when two bodies overlap. Firm
   * enough that overlapping nodes shove apart promptly to touching, soft enough that they settle
   * there without bouncing. This is the primary knob for "no overlap".
   */
  collisionStiffness?: number
  /**
   * Extra breathing room beyond the two collision radii, in layout units, before two nodes are
   * considered touching. A small positive margin keeps a visible gap between discs and feeds the
   * sibling-count ring sizing, so a crowded ring is widened to leave gaps, not just barely-
   * kissing discs.
   */
  collisionMargin?: number
  /**
   * Multiplier on a directory's steady drawn base radius to get its collision radius. `> 1` lets
   * directories claim a little more space than their drawn disc (the structural skeleton), so
   * branches keep a readable gap.
   */
  directoryRadius?: number
  /**
   * Multiplier on a file's steady drawn base radius to get its collision radius. Smaller than
   * {@link directoryRadius} so files pack into a tighter satellite cluster around their directory.
   */
  fileRadius?: number
  /**
   * Per-second velocity damping in `[0, 1)`: the fraction of a body's speed bled off each second.
   * Higher settles faster (sluggish at the extreme); lower stays livelier and rings longer. Tuned
   * so a new node's disturbance eases out over roughly one to two seconds.
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
 * Default rest length of a depth-1 directory edge, in layout units. Comparable to the old radial
 * `ringSpacing` so the forest reads at roughly the same scale.
 */
const DEFAULT_REST_LENGTH = 120

/** Default per-depth rest-length growth: a deeper directory edge rests a third further out per ring. */
const DEFAULT_REST_LENGTH_DEPTH_SCALE = 0.35

/**
 * Default sibling-count ring scaling: honor the full geometric no-overlap circumference. With
 * margin folded into the per-sibling diameter, this seats a parent's children on a ring just wide
 * enough that their collision discs fit around it with breathing room, so a six-child parent sits
 * on a visibly wider ring than a one-child parent. Lower it to pack rings tighter.
 */
const DEFAULT_SIBLING_REST_SCALE = 1

/**
 * Default edge-spring stiffness. Firm enough to hold the skeleton together against the collision
 * separation, soft enough to settle without ringing hard.
 */
const DEFAULT_SPRING_STIFFNESS = 26

/**
 * Default outward bias (the gentle anti-collapse push), as a fraction of a unit spring's pull. A
 * small value: enough that branches keep growing away from the trunk and never fold back, while
 * staying soft so the collision + sibling rest length + springs do the real organizing and the
 * motion stays fluid rather than snapping onto a radial grid. This is the primary knob for "more
 * directional" vs "looser / more emergent".
 */
const DEFAULT_OUTWARD_BIAS = 0.18

/**
 * Default file rest length, in layout units: well under a directory's {@link DEFAULT_REST_LENGTH}
 * so files orbit close to their directory as a tight satellite cluster rather than spreading like
 * a sub-tree.
 */
const DEFAULT_FILE_REST_LENGTH = 40

/**
 * Default collision stiffness: the force per unit of penetration depth. Sized well above the
 * spring stiffness so an overlap is resolved firmly (overlapping nodes shove apart to touching
 * promptly) while the penetration-proportional falloff lets them settle exactly touching without
 * bouncing through each other.
 */
const DEFAULT_COLLISION_STIFFNESS = 240

/**
 * Default collision margin, in layout units: a small gap kept between two discs beyond their radii
 * so the forest reads as separated orbs with breathing room rather than barely-kissing discs, and
 * so the sibling-count ring sizing leaves room around a crowded ring.
 */
const DEFAULT_COLLISION_MARGIN = 10

/**
 * Default directory collision-radius multiplier on the drawn base radius. A touch above 1 so a
 * directory claims slightly more than its drawn disc, keeping a readable gap between branches.
 */
const DEFAULT_DIRECTORY_RADIUS = 1.6

/**
 * Default file collision-radius multiplier on the drawn base radius. Below the directory factor so
 * files pack into a tighter satellite cluster around their directory without overlapping.
 */
const DEFAULT_FILE_RADIUS = 1.1

/**
 * Default per-second damping: a body bleeds ~90% of its speed per second (retaining ~10%), so the
 * forest settles in the one-to-two-second range the user asked for: lively, not sluggish, and
 * without a long ringing tail.
 */
const DEFAULT_DAMPING = 0.90

/** Default integration-step clamp: ~3 frames at 60fps, enough to smooth a hitch without stalling the sim. */
const DEFAULT_MAX_STEP_MS = 50

/** Default spawn offset: a small nudge off the parent so a new node visibly emerges from its branch. */
const DEFAULT_SPAWN_OFFSET = 12

/**
 * The smallest the collision spatial-grid cell may be, in layout units, so an empty or tiny forest
 * still bins into sensible cells rather than degenerate one-unit buckets.
 */
const MIN_COLLISION_CELL_SIZE = 32

/**
 * The total angular jitter (radians) a freshly spawned node's outward ray is randomized within, so
 * siblings born in the same frame separate slightly instead of landing on one point, then drift
 * apart via collision. Kept small so the spawn still clearly points outward.
 */
const SPAWN_JITTER_RADIANS = Math.PI / 6

/**
 * A deterministic unit-ish separation axis for two coincident nodes, from a hash of their combined
 * paths. So two nodes landing on the exact same point always push apart along the same direction
 * (never a random one), keeping a re-sync after a rewind reproducible. Order-independent so the
 * pair yields the same axis whichever way it is iterated.
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
 * One occupied cell of the {@link SpatialGrid}: its integer grid coordinates and the bodies that
 * hashed into it. Empty cells are never materialized, so the grid's size is bounded by the number
 * of *occupied* cells, not the (possibly vast) span of the forest.
 */
export type GridCell = {
  cellX: number
  cellY: number
  members: GridBody[]
}

/**
 * A uniform-bucket spatial index over the live bodies, the backbone of the `O(n)` collision. Every
 * body is binned into a square cell of side `cellSize` (at least the largest collision diameter
 * plus the margin), so two bodies that could collide are guaranteed to share a cell or sit in
 * adjacent cells. The collision then only has to test a body against the bodies in its own and the
 * eight neighboring cells.
 *
 * {@link neighborhoodOf} is the careful part: it yields, for a given cell, that cell itself plus
 * only the neighbor cells on the "greater" side, so iterating every cell and its neighborhood
 * visits each unordered cell-pair exactly once.
 */
export type SpatialGrid = {
  /** The occupied cells, keyed by a packed `cellX,cellY` string. */
  cells: Map<string, GridCell>
  /**
   * The cell itself plus its forward-side neighbors, chosen so iterating all cells and each one's
   * neighborhood touches every unordered cell-pair exactly once. The own cell is yielded first so
   * the caller can special-case the within-cell pairing.
   */
  neighborhoodOf: (cellX: number, cellY: number) => GridCell[]
}

/**
 * Bins `bodies` into a uniform spatial grid of cell side `cellSize` for the collision pass. Pure
 * (no time, no randomness, no mutation of the inputs) and so directly unit-testable: the same
 * bodies + cell size always yield the same buckets and neighborhoods.
 *
 * A non-finite or non-positive `cellSize` is a programming error upstream; we log and floor it to
 * `1` rather than divide by it and scatter every body into nonsense cells.
 *
 * The four forward neighbor offsets are chosen so that, combined with the own cell, iterating
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
    // The own cell is always present when called from the collision loop (we iterate the grid's
    // own cells), but guard anyway so a stray coordinate never throws.
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
 * every cell's neighborhood visit each adjacent cell-pair exactly once. Of the eight surrounding
 * cells we take only the four on the "greater" side (right, and the three on the row above): the
 * opposite four are covered when *those* cells are the iteration's current cell. This halves the
 * cross-cell work and keeps each collision force counted a single time.
 */
const FORWARD_NEIGHBOR_OFFSETS = [
  { x: 1, y: 0 },
  { x: -1, y: 1 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
] as const
