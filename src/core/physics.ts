// Copyright © 2026 Jalapeno Labs

import type { Vec2, NodePhysics } from './layout'
import type { VisibleNode } from './collapse'

/**
 * A faithful port of Gource's layout model (epic #20). The previous version simulated EVERY node,
 * files included, as a free physics body under a stack of competing custom forces (size-aware
 * collision, directional outward bias, untangle/fan, sibling-rest springs). At scale those forces
 * fought one another and the forest flailed. Gource solved this years ago with a far simpler,
 * proven model, and this module ports it directly from `gource-reference/src/dirnode.cpp` and
 * `file.cpp`.
 *
 * ### The Gource model (what this implements)
 *
 * Only **directories** are force-directed bodies. Each frame, for every visible directory
 * (Gource's `RDirNode::applyForces` + `move`):
 *
 * 1. **Directory <-> directory repulsion**, computed over a Barnes-Hut {@link QuadTree} so it is
 *    `O(n log n)` rather than all-pairs. The repulsion fires ONLY when two directory discs overlap
 *    (`distance = gap between the two radii < 0`), pushing them apart by exactly the penetration
 *    depth (`accel += distance * normalise(dir)`, Gource `applyForceDir`). A directory never repels
 *    its own parent, a direct child, or any ancestor/descendant (Gource's `DirForceFunctor`
 *    exclusions via `isParent`); it always repels its parent separately so a child never piles onto
 *    the parent it springs from.
 * 2. **A spring toward the parent** at a rest distance derived from the parent's CONTENT radius:
 *    the node is pulled so it sits just outside the sum of its own radius and the parent's
 *    `parent_radius` (Gource `distanceToParent` + the `gGourceForceGravity * parent_dist` gravity).
 *    A directory's radius grows with how much it contains (`sqrt(content area)`), so a fat parent
 *    pushes its children out to a wider ring with room for them all, exactly like Gource.
 * 3. **A parent-edge-normal nudge** along the grandparent -> parent direction (Gource's
 *    `parent_edge_normal` term), so a branch keeps growing outward off the trunk instead of folding
 *    back over it.
 * 4. **A sibling spread** among the visible children of the same parent (Gource's last term in
 *    `applyForces`): each sibling is pushed directly away from its siblings, scaled by the parent's
 *    circumference divided by the sibling count, so a crowded ring fans itself out evenly.
 *
 * A new directory **spawns** at its parent's current position, nudged a unit step along the
 * grandparent -> parent direction plus a deterministic per-path hash jitter (Gource
 * `setInitialPosition`), so siblings born together emerge off the branch pointing outward rather
 * than stacking on one point.
 *
 * **Files are deterministic satellites, NOT bodies.** A file's slot is packed into concentric
 * rings around its parent directory (Gource `calcFileDest` / `updateFilePositions`): ring `k` holds
 * up to `max(1, k * PI)` files at radius `k * fileDiameter`, each at an evenly spaced angle. Every
 * frame the file simply eases from its current spot toward `directory.position + slot` (Gource
 * `RFile::logic`: `accel = dest - pos; pos += clamp(accel * speed * dt, accel)`, no momentum). Files
 * never repel each other globally and never feed back into the directory sim, which is the key
 * stability and performance win: hundreds of files cost a deterministic placement, not n-body work.
 *
 * The forest root (when shown) is **pinned** at the center, never integrated, so the whole forest
 * hangs and settles around it.
 *
 * ### Constants
 *
 * The defaults are Gource's own values (see {@link ForceLayoutOptions}): gravity `10`, directory
 * padding `1.5`, file diameter `8`, file ease speed `5`. The one addition is a light per-second
 * velocity {@link ForceLayoutOptions.damping} on directories. Gource runs with `elasticity = 0`
 * (pure `pos += accel * dt`, no stored velocity), but runewood's {@link applyImpulse} camera wobble
 * needs a velocity channel to spend, so directories carry a velocity that the damping bleeds off,
 * letting a wobble settle while leaving the steady-state layout Gource-identical.
 *
 * This is **forward-only visual state**, not a pure function of the tree: a backward seek re-folds
 * the (pure) tree and re-syncs the sim, which re-settles rather than reproducing pixel-exact prior
 * positions. That is the accepted tradeoff for the always-alive feel.
 */
export class ForceLayout {
  /** Live per-node physics, keyed by the node's real (full) path. The public read surface. */
  private readonly bodies: Map<string, NodePhysics>

  /**
   * Per-directory sleep state, keyed by real node path (files are never bodies, so they are never
   * here). A directory whose velocity AND net force stay below {@link SLEEP_*} thresholds for
   * {@link SLEEP_DWELL_MS} of accumulated quiet time goes {@link SleepState.asleep}, after which the
   * integrator skips it entirely until something wakes it (a force above the wake threshold, a
   * camera impulse, or a structural change near it). This is the convergence + scale-perf win: a
   * settled forest does almost no integration work, and its nodes stop micro-moving so the scene's
   * skip-redraw actually triggers. Absent for the pinned root (never integrated anyway).
   */
  private readonly sleepByPath: Map<string, SleepState>

  /**
   * Per-node layout metadata captured on {@link sync} from the collapse, so {@link step} can apply
   * the forces without re-walking the tree each frame. Keyed by real node path; the forest root and
   * an un-synced node are absent.
   */
  private readonly metaByPath: Map<string, NodeMeta>

  /**
   * The path of the pinned forest root (`''`) when one is shown, else `null`. A pinned body is held
   * at the center with zero velocity and skipped by the integrator, so everything else hangs and
   * settles around it.
   */
  private pinnedPath: string | null

  private readonly options: Required<ForceLayoutOptions>

  /**
   * The global cooling temperature (d3-force-style `alpha`), in `[0, 1]`. Every directory's force
   * step is scaled by it, and it decays toward 0 each step ({@link ALPHA_DECAY_PER_SECOND}). This is
   * the convergence schedule on top of the per-body sleeping: it shrinks the residual jitter of a
   * deep, competing force network frame by frame until each body's realized step drops below the
   * sleep threshold and the whole forest goes static, instead of limit-cycling forever. It is
   * REHEATED to 1 by any disturbance (a structural change on {@link sync} or a camera
   * {@link applyImpulse}) so the layout re-anneals when it actually needs to move.
   */
  private alpha: number

  constructor(options: ForceLayoutOptions = {}) {
    this.bodies = new Map()
    this.sleepByPath = new Map()
    this.metaByPath = new Map()
    this.pinnedPath = null
    this.alpha = 1
    this.options = {
      center: options.center ?? { x: 0, y: 0 },
      gravity: options.gravity ?? DEFAULT_GRAVITY,
      directoryPadding: options.directoryPadding ?? DEFAULT_DIRECTORY_PADDING,
      fileDiameter: options.fileDiameter ?? DEFAULT_FILE_DIAMETER,
      fileEaseSpeed: options.fileEaseSpeed ?? DEFAULT_FILE_EASE_SPEED,
      damping: options.damping ?? DEFAULT_DAMPING,
      maxStepMs: options.maxStepMs ?? DEFAULT_MAX_STEP_MS,
      quadTreeTheta: options.quadTreeTheta ?? DEFAULT_QUAD_TREE_THETA,
      wobbleMaxSpeed: options.wobbleMaxSpeed ?? DEFAULT_WOBBLE_MAX_SPEED,
    }
  }

  /**
   * The live physics map. The scene, labels, beams, camera, and picking read positions straight off
   * this, exactly where they used to, so the rest of the controller is unchanged by the new model.
   * Returned by reference (not copied) because it is read every frame; callers must not mutate it.
   */
  public get state(): Map<string, NodePhysics> {
    return this.bodies
  }

  /**
   * Reconciles the simulation's bodies with the current visible set (the output of
   * {@link collapseTree}). The structural step, run only when the tree's shape changed:
   *
   * - A **new** directory spawns at its display-parent's current position, nudged along the
   *   grandparent -> parent direction plus a per-path hash jitter (Gource `setInitialPosition`), so
   *   it emerges off the branch pointing outward. A **new** file spawns directly on its directory
   *   and eases out to its ring slot over the next frames.
   * - A node no longer visible has its body **removed**.
   * - The forest root (when present, `isForestRoot`) is **pinned** at the center.
   *
   * The per-node metadata index ({@link NodeMeta}) is rebuilt here: each node's display-parent,
   * whether it is a file, its depth, its content radius, and (for files) its packed ring slot. That
   * lets every {@link step} apply the forces without re-walking the tree.
   */
  public sync(visibleNodes: VisibleNode[]): void {
    this.metaByPath.clear()
    this.pinnedPath = null

    const livePaths = new Set<string>()
    for (const visible of visibleNodes) {
      livePaths.add(visible.node.path)
      if (visible.isForestRoot) {
        this.pinForestRoot(visible.node.path)
      }
    }

    // Pre-compute each directory's content radius, its direct visible file count (for the
    // parent-radius rest gap), and each file's packed ring slot, so the spring rest distances and
    // the file destinations are ready before any body is spawned. The radial tidy-tree placement
    // gives every NEW directory a sensible, already-organized initial spot (see below).
    const contentRadii = computeContentRadii(visibleNodes, this.options)
    const fileSlots = computeFileSlots(visibleNodes, this.options)
    const directFileCounts = countDirectFiles(visibleNodes)
    const initialPlacement = computeInitialPlacement(visibleNodes, this.options)

    for (const visible of visibleNodes) {
      if (visible.isForestRoot) {
        continue
      }
      const path = visible.node.path
      const meta: NodeMeta = {
        displayParentPath: visible.displayParentPath,
        isFile: visible.node.isFile,
        depth: visible.depth,
        contentRadius: contentRadii.get(path) ?? this.options.directoryPadding,
        fileCount: directFileCounts.get(path) ?? 0,
        fileSlot: fileSlots.get(path) ?? null,
      }
      this.metaByPath.set(path, meta)

      if (!this.bodies.has(path)) {
        // A NEW node: place a directory at its deterministic radial tidy-tree spot so a bulk seed
        // of thousands lands already spread out (the force sim then only gently refines + de-laps,
        // instead of relaxing from one giant pile and exploding). A file still spawns on its
        // directory and eases out to its ring slot. The radial spot is the big first-load fix.
        this.bodies.set(path, {
          position: this.spawnPositionFor(path, meta, initialPlacement),
          velocity: { x: 0, y: 0 },
        })
      }
      else {
        // An existing directory gains/keeps a body. A structural change (a sibling appeared, a
        // child was added under it) disturbs its force balance, so wake it to re-settle; a file is
        // not an integrated body and needs no waking.
        if (!meta.isFile) {
          this.wake(path)
        }
      }
      // Every tracked directory must have a sleep record; create one (awake) for a fresh body.
      if (!meta.isFile && !this.sleepByPath.has(path)) {
        this.sleepByPath.set(path, { asleep: false, restMs: 0, lastStepDistance: 0 })
      }
    }

    // Drop bodies (and their sleep state) whose node is no longer visible, so the sim and the drawn
    // forest stay in lockstep, and wake any directory that lost a neighbor so the gap re-settles.
    for (const path of [ ...this.bodies.keys() ]) {
      if (!livePaths.has(path)) {
        this.bodies.delete(path)
        this.sleepByPath.delete(path)
      }
    }

    // A structural change (the only time the controller calls `sync`) disturbs the force balance, so
    // reheat the cooling schedule to full: the layout re-anneals from whatever it was, then cools
    // back to rest. Without this, a node added after the forest cooled would never get the energy to
    // find its place.
    this.alpha = 1
  }

  /**
   * Wakes a sleeping directory so the integrator resumes moving it: clears its asleep flag and its
   * accumulated quiet time. Called when something disturbs the layout near it (a structural change
   * on {@link sync}, a strong force, or a camera {@link applyImpulse}). A no-op for a path with no
   * sleep record (a file, the pinned root, or an untracked node).
   */
  private wake(path: string): void {
    const sleep = this.sleepByPath.get(path)
    if (sleep) {
      sleep.asleep = false
      sleep.restMs = 0
    }
  }

  /**
   * Wakes a directory ONLY if it is currently asleep, leaving an already-awake body's settle dwell
   * untouched. Used for the overlap-wake during repulsion: a node drifting into a settled cluster
   * revives the sleepers it touches, but a settled pair that rests microscopically overlapping must
   * NOT keep resetting each other's dwell (or neither would ever sleep). An awake body decides to
   * sleep purely from its own force + velocity in {@link integrateDirectories}.
   */
  private wakeIfAsleep(path: string): void {
    const sleep = this.sleepByPath.get(path)
    if (sleep?.asleep) {
      sleep.asleep = false
      sleep.restMs = 0
    }
  }

  /** Pins (or repins) the forest root body at the configured center with zero velocity. */
  private pinForestRoot(path: string): void {
    this.pinnedPath = path
    const existing = this.bodies.get(path)
    if (existing) {
      existing.position.x = this.options.center.x
      existing.position.y = this.options.center.y
      existing.velocity.x = 0
      existing.velocity.y = 0
      return
    }
    this.bodies.set(path, {
      position: { x: this.options.center.x, y: this.options.center.y },
      velocity: { x: 0, y: 0 },
    })
  }

  /**
   * Clears the whole simulation: every body, index, and the pin. Used on a backward-seek rebuild,
   * where the controller re-folds the tree and re-syncs from the rebuilt visible set, letting the
   * sim re-settle from fresh spawns rather than carrying stale positions across the rewind.
   */
  public reset(): void {
    this.bodies.clear()
    this.sleepByPath.clear()
    this.metaByPath.clear()
    this.pinnedPath = null
    this.alpha = 1
  }

  /**
   * Advances the simulation by `deltaMs` of real wall time. Directories are force-directed (spring
   * to parent, parent-edge nudge, sibling spread, quadtree repulsion) and integrated with velocity
   * damping; files ease deterministically toward their packed ring slot around their directory.
   *
   * The delta is clamped to {@link ForceLayoutOptions.maxStepMs} for stability: a long stall (a
   * backgrounded tab, a GC pause) must not deliver one giant step that flings nodes across the
   * canvas. A non-positive or non-finite delta is a no-op.
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

    // Accumulate this frame's directory forces before integrating, so every force reads the same
    // start-of-frame positions (an explicit, order-independent step). Files are not force bodies;
    // they ease toward their slot in a separate pass after the directories have moved. Only AWAKE
    // directories get an acceleration slot: a sleeping one is skipped for the (expensive) force
    // passes entirely. A sleeping directory still sits in the repulsion quadtree as a SOURCE, and
    // an awake body overlapping it wakes it (so a neighbor moving into a settled node revives it).
    const accelerations = new Map<string, Vec2>()
    for (const [ path, meta ] of this.metaByPath) {
      if (meta.isFile || path === this.pinnedPath) {
        continue
      }
      if (this.sleepByPath.get(path)?.asleep) {
        continue
      }
      accelerations.set(path, { x: 0, y: 0 })
    }

    this.applyDirectoryRepulsion(accelerations)
    this.applyParentSpring(accelerations)
    this.applyParentEdgeNudge(accelerations)
    this.applySiblingSpread(accelerations)
    this.integrateDirectories(accelerations, clampedMs, deltaSeconds)
    this.easeFiles(deltaSeconds)

    // Cool the global temperature toward rest, framerate-independently. As alpha shrinks, each
    // body's force step shrinks with it, so a deep, competing force network anneals to stillness
    // (its residual jitter falls under the sleep threshold) instead of limit-cycling forever. Files
    // are not cooled (they ease deterministically and always reach their slot).
    this.alpha *= Math.pow(ALPHA_DECAY_PER_SECOND, deltaSeconds)
    if (this.alpha < ALPHA_FLOOR) {
      this.alpha = 0
    }
  }

  /**
   * Kicks the whole forest with a one-shot velocity impulse so it visibly wobbles and then springs
   * back to rest, the way a hanging mobile jiggles when you nudge the frame it dangles from. The
   * controller calls this from the camera's pan and zoom handlers.
   *
   * `worldVelocity` is added to every non-pinned DIRECTORY body's velocity in WORLD units per
   * second; the spring + damping then settle the kick into a wobble. Files carry no velocity (they
   * are momentumless satellites), so they simply follow their directory as it wobbles, which keeps
   * a file glued to its cluster instead of drifting off on a kick. The pinned forest root is left
   * untouched so the forest hangs and wobbles around its fixed center.
   *
   * The kick is capped at {@link ForceLayoutOptions.wobbleMaxSpeed} ({@link clampSpeed}) so a fast
   * camera flick cannot inject a runaway velocity. A zero / non-finite impulse is a no-op.
   */
  public applyImpulse(worldVelocity: Vec2): void {
    const kick = clampSpeed(worldVelocity, this.options.wobbleMaxSpeed)
    if (kick.x === 0 && kick.y === 0) {
      return
    }

    for (const [ path, body ] of this.bodies) {
      if (path === this.pinnedPath) {
        continue
      }
      const meta = this.metaByPath.get(path)
      if (meta?.isFile) {
        // Files have no momentum channel in Gource; they follow their directory rather than taking
        // a kick of their own, so a wobble never scatters a directory's satellite cluster.
        continue
      }
      body.velocity.x += kick.x
      body.velocity.y += kick.y
      // A kicked body has velocity to spend, so wake it (and let the wobble settle it back to sleep).
      this.wake(path)
    }

    // Reheat the cooling schedule so the kicked forest has the force-energy to re-settle into a tidy
    // arrangement after the wobble, rather than the kick just sliding cooled-flat bodies around.
    this.alpha = 1
  }

  /**
   * Directory <-> directory repulsion over a Barnes-Hut {@link QuadTree} (Gource `applyForceDir`
   * driven by `DirForceFunctor`). Each directory is inserted into the tree weighted by its content
   * radius; for each directory we then walk the tree, and for every other directory whose disc
   * overlaps ours we add a push apart equal to the penetration depth. The tree lets a far-away
   * cluster be summarized by its center of mass once instead of visited node by node, so the pass
   * is `O(n log n)`.
   *
   * Exclusions mirror Gource exactly: a directory never repels itself, its parent, a direct child,
   * or any ancestor / descendant (so a branch is held together by its springs, not torn apart by
   * its own repulsion). The parent is instead always repelled separately, regardless of distance,
   * by {@link applyParentSpring}'s companion push, so a child never sits on top of its parent.
   */
  private applyDirectoryRepulsion(accelerations: Map<string, Vec2>): void {
    const tree = this.buildDirectoryQuadTree()
    if (!tree) {
      return
    }

    for (const [ path, acceleration ] of accelerations) {
      const body = this.bodies.get(path)!
      const radius = this.radiusOf(path)
      // Only a body that actually MOVED last step can wake a sleeping neighbor it overlaps: that is
      // a genuine intruder drifting in. A settled cluster rests with standing overlap (gravity packs
      // the discs slightly inside one another), so waking on static overlap would never let it
      // sleep; requiring real motion means only a true disturbance revives a sleeper.
      const isMover = (this.sleepByPath.get(path)?.lastStepDistance ?? 0) > WAKE_MOVE_EPSILON
      const push = tree.repulsionOn(
        path,
        body.position,
        radius,
        (candidatePath) => this.repelsAgainst(path, candidatePath),
        isMover ? (overlappedPath) => this.wakeIfAsleep(overlappedPath) : undefined,
      )
      acceleration.x += push.x
      acceleration.y += push.y
    }
  }

  /** Builds the Barnes-Hut tree over the current directory bodies (files are excluded). */
  private buildDirectoryQuadTree(): QuadTree | null {
    const points: QuadPoint[] = []
    for (const [ path, meta ] of this.metaByPath) {
      if (meta.isFile) {
        continue
      }
      const body = this.bodies.get(path)
      if (!body) {
        continue
      }
      points.push({ path, position: body.position, radius: this.radiusOf(path) })
    }
    // The pinned forest root is a repulsion source too (nothing should pile onto the center), so it
    // is included even though it never receives a force itself.
    if (this.pinnedPath !== null) {
      const rootBody = this.bodies.get(this.pinnedPath)
      if (rootBody) {
        points.push({ path: this.pinnedPath, position: rootBody.position, radius: this.options.directoryPadding })
      }
    }
    if (points.length === 0) {
      return null
    }
    return buildQuadTree(points, this.options.quadTreeTheta)
  }

  /**
   * Whether directory `path` repels directory `candidatePath`: never itself, its parent, a direct
   * child, or any ancestor / descendant (Gource's `DirForceFunctor` exclusions). Mirrors
   * `RDirNode::isParent`, walking the display-parent chain both ways.
   */
  private repelsAgainst(path: string, candidatePath: string): boolean {
    if (path === candidatePath) {
      return false
    }
    return !this.isAncestorOrDescendant(path, candidatePath)
  }

  /** Whether one of the two paths is an ancestor of the other along the display-parent chain. */
  private isAncestorOrDescendant(pathA: string, pathB: string): boolean {
    if (this.isDisplayAncestor(pathA, pathB)) {
      return true
    }
    return this.isDisplayAncestor(pathB, pathA)
  }

  /** Whether `ancestorPath` sits above `descendantPath` on the display-parent chain. */
  private isDisplayAncestor(ancestorPath: string, descendantPath: string): boolean {
    let current = this.metaByPath.get(descendantPath)?.displayParentPath
    while (current !== undefined) {
      if (current === ancestorPath) {
        return true
      }
      if (current === this.pinnedPath || current === '') {
        // Reached the forest center: a repo root's display-parent. Nothing above it to climb.
        return current === ancestorPath
      }
      current = this.metaByPath.get(current)?.displayParentPath
    }
    return false
  }

  /**
   * The spring that pulls a directory toward its parent so it settles just outside the parent's
   * content (Gource `distanceToParent` + the gravity term). The rest distance is the sum of this
   * node's radius and the parent's `parent_radius`, so a node sits tangent to the parent's content
   * disc; the spring force is `gravity * (currentGap - restGap)` directed along the parent -> node
   * axis. A directory whose display-parent has no body yet (a repo root hanging off the undrawn
   * center) springs toward the configured center.
   *
   * It also adds Gource's "always repel the parent" push (`applyForceDir(parent)`): when the node
   * has drifted inside the parent's disc it is shoved straight out, so a child never overlaps the
   * parent it springs from even though the repulsion pass deliberately skips the parent.
   */
  private applyParentSpring(accelerations: Map<string, Vec2>): void {
    for (const [ path, acceleration ] of accelerations) {
      const meta = this.metaByPath.get(path)!
      const parentPath = meta.displayParentPath
      const parentBody = this.bodies.get(parentPath)
      const anchor = parentBody ? parentBody.position : this.options.center

      const body = this.bodies.get(path)!
      const offsetX = body.position.x - anchor.x
      const offsetY = body.position.y - anchor.y
      const distance = Math.hypot(offsetX, offsetY) || EPSILON

      const nodeRadius = this.radiusOf(path)
      const parentRadius = this.parentRadiusOf(parentPath)
      const restGap = nodeRadius + parentRadius

      // Gource gravity: pull along the parent -> node axis toward the rest gap. Positive when the
      // node sits too far out (pull in), negative when too close (push out).
      const parentDistance = distance - restGap
      const gravity = this.options.gravity * parentDistance
      acceleration.x -= (offsetX / distance) * gravity
      acceleration.y -= (offsetY / distance) * gravity

      // Always repel the parent when overlapping its disc (Gource `applyForceDir(parent)`), so a
      // child is never allowed to sit on top of the parent it hangs from.
      const overlap = (nodeRadius + parentRadius) - distance
      if (overlap > 0) {
        acceleration.x += (offsetX / distance) * overlap
        acceleration.y += (offsetY / distance) * overlap
      }
    }
  }

  /**
   * Gource's parent-edge-normal term: each directory is nudged toward the point just outside its
   * parent along the grandparent -> parent direction, so a branch keeps growing outward off the
   * trunk instead of folding back across its neighbors (`dest = parent.pos + (parent.radius +
   * radius) * parent_edge_normal - pos`). With no grandparent (a repo root) there is no edge to
   * follow, so the term sits out and the spring + sibling spread place the node.
   */
  private applyParentEdgeNudge(accelerations: Map<string, Vec2>): void {
    for (const [ path, acceleration ] of accelerations) {
      const meta = this.metaByPath.get(path)!
      const parentPath = meta.displayParentPath
      const parentBody = this.bodies.get(parentPath)
      if (!parentBody) {
        // A repo root hanging off the undrawn center has no drawn parent edge to follow.
        continue
      }

      const edge = this.outwardEdgeOf(parentPath, parentBody.position)
      if (!edge) {
        continue
      }

      const parentRadius = this.radiusOf(parentPath)
      const nodeRadius = this.radiusOf(path)
      const reach = parentRadius + nodeRadius

      const body = this.bodies.get(path)!
      const destX = parentBody.position.x + edge.x * reach
      const destY = parentBody.position.y + edge.y * reach
      acceleration.x += destX - body.position.x
      acceleration.y += destY - body.position.y
    }
  }

  /**
   * The unit grandparent -> parent direction (Gource `parent_edge_normal`): the way the parent's
   * branch is growing, which its children are nudged to grow further along. For a repo root, whose
   * display-parent is the undrawn center, it points from the configured center toward the parent.
   * Returns `null` when the parent sits exactly on its own parent (no defined direction yet).
   */
  private outwardEdgeOf(parentPath: string, parentPosition: Vec2): Vec2 | null {
    const parentMeta = this.metaByPath.get(parentPath)
    const grandparentPath = parentMeta?.displayParentPath
    const grandparentBody = grandparentPath !== undefined ? this.bodies.get(grandparentPath) : undefined
    const origin = grandparentBody ? grandparentBody.position : this.options.center

    const directionX = parentPosition.x - origin.x
    const directionY = parentPosition.y - origin.y
    const length = Math.hypot(directionX, directionY)
    if (length < EPSILON) {
      return null
    }
    return { x: directionX / length, y: directionY / length }
  }

  /**
   * Gource's sibling-spread term: within each set of visible directory siblings, every sibling is
   * pushed directly away from the others (`sib_accel -= normalise(other - pos)`), then scaled by the
   * parent circumference divided by the sibling count (`slice_size = parent.radius * PI / (visible +
   * 1)`). The effect is an even fan: a crowded ring spreads itself out, an already-even one barely
   * moves. Only sets of two or more matter (a lone child has nothing to spread against).
   */
  private applySiblingSpread(accelerations: Map<string, Vec2>): void {
    for (const group of this.directorySiblingGroups()) {
      const parentRadius = this.radiusOf(group.parentPath)
      const sliceSize = (parentRadius * Math.PI) / (group.childPaths.length + 1)

      for (const path of group.childPaths) {
        const acceleration = accelerations.get(path)
        if (!acceleration) {
          continue
        }
        const body = this.bodies.get(path)!

        let spreadX = 0
        let spreadY = 0
        for (const siblingPath of group.childPaths) {
          if (siblingPath === path) {
            continue
          }
          const siblingBody = this.bodies.get(siblingPath)!
          const offsetX = siblingBody.position.x - body.position.x
          const offsetY = siblingBody.position.y - body.position.y
          const distance = Math.hypot(offsetX, offsetY)
          if (distance < EPSILON) {
            continue
          }
          // Push away from each sibling: subtract the unit vector toward it (Gource `sib_accel`).
          spreadX -= offsetX / distance
          spreadY -= offsetY / distance
        }

        acceleration.x += spreadX * sliceSize
        acceleration.y += spreadY * sliceSize
      }
    }
  }

  /**
   * Groups the tracked directory bodies into sibling sets of two or more by their display-parent,
   * for {@link applySiblingSpread}. Files are excluded (they are satellites, not part of the
   * directory fan). Reads the live metadata index, so it needs no tree walk.
   */
  private directorySiblingGroups(): SiblingGroup[] {
    const byParent = new Map<string, string[]>()
    for (const [ path, meta ] of this.metaByPath) {
      if (meta.isFile) {
        continue
      }
      const existing = byParent.get(meta.displayParentPath)
      if (existing) {
        existing.push(path)
      }
      else {
        byParent.set(meta.displayParentPath, [ path ])
      }
    }

    const groups: SiblingGroup[] = []
    for (const [ parentPath, childPaths ] of byParent) {
      if (childPaths.length >= 2) {
        groups.push({ parentPath, childPaths })
      }
    }
    return groups
  }

  /**
   * Integrates the directory bodies, faithful to Gource plus a decaying wobble channel.
   *
   * Gource's `RDirNode::move` is `pos += accel * dt`, with the acceleration recomputed from scratch
   * every frame and never stored. That is deliberately momentumless: it behaves like one step of
   * gradient descent toward the force balance, so it cannot accumulate the energy that a stiff
   * spring under semi-implicit Euler would, and it stays stable at hundreds of directories without
   * any damping at all. We keep that exactly for the force response (`pos += accel * dt`).
   *
   * The body's `velocity` is reserved purely for runewood's camera-wobble {@link applyImpulse}: a
   * kick lives there and decays by the per-second {@link ForceLayoutOptions.damping}, sliding the
   * body each frame, so a wobble glides and settles. With no kick the velocity is zero and the
   * motion is pure Gource. The force is integrated directly into position (not into velocity), so a
   * strong spring can never build up runaway momentum: that is the anti-flail fix.
   */
  private integrateDirectories(accelerations: Map<string, Vec2>, deltaMs: number, deltaSeconds: number): void {
    // Per-second damping converted to this step: the wobble velocity retains `(1 - damping)^dt`, so
    // the decay is framerate-independent rather than tied to a fixed step count.
    const retained = Math.pow(1 - this.options.damping, deltaSeconds)

    for (const [ path, acceleration ] of accelerations) {
      const body = this.bodies.get(path)!
      const startX = body.position.x
      const startY = body.position.y

      // Gource's momentumless force response: step straight toward the force balance, scaled by the
      // global cooling temperature `alpha` so a deep, competing force network anneals to rest rather
      // than limit-cycling forever (the convergence schedule). The step is also CLAMPED to a
      // fraction of the node's own radius per frame ({@link maxStepFractionOfRadius}), so a strong,
      // stiff force (deep in a big forest the gravity + edge terms can be large) can never carry the
      // node past its equilibrium and set up a perpetual overshoot. Capping plus cooling keeps every
      // frame a sub-equilibrium relaxation, so the forest converges to rest, while a settled node
      // (tiny force) is unaffected.
      const stepX = acceleration.x * deltaSeconds * this.alpha
      const stepY = acceleration.y * deltaSeconds * this.alpha
      const stepLength = Math.hypot(stepX, stepY)
      const maxStep = Math.max(this.radiusOf(path), MIN_DIR_STEP) * MAX_STEP_FRACTION_OF_RADIUS
      if (stepLength > maxStep) {
        const scale = maxStep / stepLength
        body.position.x += stepX * scale
        body.position.y += stepY * scale
      }
      else {
        body.position.x += stepX
        body.position.y += stepY
      }

      // The decaying wobble channel: spend and bleed off any camera-kick velocity.
      body.position.x += body.velocity.x * deltaSeconds
      body.position.y += body.velocity.y * deltaSeconds
      body.velocity.x *= retained
      body.velocity.y *= retained

      // Record how far the body actually moved this step, so the overlap-wake can tell a real
      // intruder (a moving body) from a settled neighbor resting with standing overlap.
      const sleepState = this.sleepByPath.get(path)
      if (sleepState) {
        sleepState.lastStepDistance = Math.hypot(body.position.x - startX, body.position.y - startY)
      }

      // Sleep bookkeeping (convergence + the scale perf win): a directory whose actual per-step
      // MOVEMENT and residual wobble velocity both sit below the sleep thresholds is quiet.
      // Accumulate that quiet time; once it clears the dwell, the body sleeps and the integrator
      // skips it next frame (so it stops micro-moving and the scene's skip-redraw triggers). Any
      // disturbance above the thresholds resets the dwell, keeping the body awake while it still has
      // settling to do. Keying on the realized step (not the raw force) means a body resting in a
      // standing-overlap equilibrium, where opposing forces nearly cancel into a tiny net step, is
      // correctly recognized as quiet and allowed to sleep.
      if (!sleepState) {
        continue
      }
      const speed = Math.hypot(body.velocity.x, body.velocity.y)
      if (sleepState.lastStepDistance < SLEEP_STEP_THRESHOLD && speed < SLEEP_SPEED_THRESHOLD) {
        sleepState.restMs += deltaMs
        if (sleepState.restMs >= SLEEP_DWELL_MS) {
          sleepState.asleep = true
          // Zero the residual wobble so a sleeping body is truly static (no leftover sub-threshold
          // drift), which is what lets the scene treat it as unmoved and skip its redraw.
          body.velocity.x = 0
          body.velocity.y = 0
        }
      }
      else {
        sleepState.restMs = 0
      }
    }
  }

  /**
   * Eases every file toward its packed ring slot around its directory (Gource `RFile::logic`). The
   * destination is the directory's CURRENT position plus the file's ring offset, so files follow
   * their directory wherever it drifts. The move is `accel = dest - pos`, advanced by `accel *
   * speed * dt` but never overshooting the destination (Gource clamps the step to the full offset),
   * and the file keeps no momentum. A file whose directory has no body yet is left where it is.
   */
  private easeFiles(deltaSeconds: number): void {
    for (const [ path, meta ] of this.metaByPath) {
      if (!meta.isFile || !meta.fileSlot) {
        continue
      }
      const directoryBody = this.bodies.get(meta.displayParentPath)
      if (!directoryBody) {
        continue
      }
      const body = this.bodies.get(path)!

      const destX = directoryBody.position.x + meta.fileSlot.x
      const destY = directoryBody.position.y + meta.fileSlot.y
      const offsetX = destX - body.position.x
      const offsetY = destY - body.position.y

      // Step a fraction of the way toward the slot, never past it (Gource clamps `accel2` to
      // `accel`). Files keep no velocity: they are momentumless satellites.
      const stepScale = Math.min(1, this.options.fileEaseSpeed * deltaSeconds)
      body.position.x += offsetX * stepScale
      body.position.y += offsetY * stepScale
      body.velocity.x = 0
      body.velocity.y = 0
    }
  }

  /** A directory's content radius (Gource `dir_radius`), or the padding floor for an untracked node. */
  private radiusOf(path: string): number {
    if (path === this.pinnedPath) {
      return this.options.directoryPadding
    }
    return this.metaByPath.get(path)?.contentRadius ?? this.options.directoryPadding
  }

  /**
   * A directory's `parent_radius` (Gource): the radius a child should rest just outside, derived
   * from the parent's OWN files only (`sqrt(file area) * padding`), not its whole subtree. Keeping
   * the rest gap tied to the parent's direct file disc (rather than its full content radius) is
   * what stops a deep directory from flinging its children absurdly far out.
   */
  private parentRadiusOf(parentPath: string): number {
    const meta = this.metaByPath.get(parentPath)
    if (!meta) {
      // The undrawn forest center or an untracked parent: a small floor so repo roots ring the
      // center at a sane distance rather than collapsing onto it.
      return this.options.directoryPadding
    }
    return parentFileRadius(meta, this.options)
  }

  /**
   * Where a brand-new node is born. A **directory** lands at its deterministic radial tidy-tree spot
   * ({@link computeInitialPlacement}), so a bulk seed of thousands arrives already spread across the
   * forest rather than piled at its parent (the explosion the force sim used to relax from). A
   * **file** spawns directly on its directory and eases out to its ring slot. The radial placement
   * is centered on the sim's center, so it is in the same world space the sim then refines in.
   *
   * The placement map is computed once per {@link sync} over the whole visible set; if a directory
   * is somehow absent from it (it should not be), we fall back to the old Gource off-the-branch
   * nudge so a node never spawns at an undefined position.
   */
  private spawnPositionFor(path: string, meta: NodeMeta, placement: Map<string, Vec2>): Vec2 {
    if (meta.isFile) {
      // Files start on their directory and ease out to the ring; no jitter needed.
      const directoryBody = this.bodies.get(meta.displayParentPath)
      const anchor = directoryBody ? directoryBody.position : this.options.center
      return { x: anchor.x, y: anchor.y }
    }

    const radial = placement.get(path)
    if (radial) {
      return { x: radial.x, y: radial.y }
    }

    // Fallback (a directory missing from the placement, which the pure helper should never omit):
    // the old Gource off-the-branch spawn, so a node always gets a defined, sane initial position.
    const parentBody = this.bodies.get(meta.displayParentPath)
    const anchor = parentBody ? parentBody.position : this.options.center
    const edge = parentBody ? this.outwardEdgeOf(meta.displayParentPath, anchor) : null
    const jitter = hashUnitVector(path)
    const directionX = edge ? edge.x * 2 + jitter.x : jitter.x
    const directionY = edge ? edge.y * 2 + jitter.y : jitter.y
    const length = Math.hypot(directionX, directionY) || EPSILON
    const reach = this.radiusOf(meta.displayParentPath) + meta.contentRadius
    return {
      x: anchor.x + (directionX / length) * reach,
      y: anchor.y + (directionY / length) * reach,
    }
  }
}

/**
 * The internal sleep state of one directory body, keyed by path in {@link ForceLayout.sleepByPath}.
 * A body accumulates {@link restMs} of below-threshold quiet time and, once it clears
 * {@link SLEEP_DWELL_MS}, flips {@link asleep} so the integrator skips it until something wakes it.
 */
type SleepState = {
  /** Whether the integrator currently skips this body (it has settled). */
  asleep: boolean
  /** Accumulated quiet (below-threshold) time since the body was last disturbed, in milliseconds. */
  restMs: number
  /**
   * How far this body moved on its last integrated step, in layout units. Drives the overlap-wake:
   * only a body that genuinely moved (a real intruder, not a settled body resting with standing
   * overlap) wakes the sleeping neighbors it overlaps. Zero for a sleeping or never-stepped body.
   */
  lastStepDistance: number
}

/**
 * Per-node layout metadata the sim captures once per {@link ForceLayout.sync} and reads every
 * {@link ForceLayout.step}, so no force has to re-walk the tree. Keyed in {@link ForceLayout} by the
 * node's real path.
 */
export type NodeMeta = {
  /** Path of the nearest visible ancestor; `''` for a repo root hanging off the forest center. */
  displayParentPath: string
  /** Whether the node is a file (a deterministic satellite) rather than a force-directed directory. */
  isFile: boolean
  /** The node's visible depth (1 for a repo root). */
  depth: number
  /**
   * The directory's content radius (Gource `dir_radius`): `sqrt(content area) * padding`, growing
   * with how many files and sub-directories it holds. For a file this is the radius of its own
   * (childless) disc and is not used by the directory sim.
   */
  contentRadius: number
  /**
   * How many visible files this directory holds directly (Gource `visible_count`), used to size the
   * `parent_radius` a child rests just outside. `0` for a file or a directory with no direct files.
   */
  fileCount: number
  /**
   * For a file, its packed ring slot relative to its directory (Gource `calcFileDest` * distance):
   * the offset vector from the directory center to the file's resting spot. `null` for a directory.
   */
  fileSlot: Vec2 | null
}

/** One directory sibling set for the spread pass: the shared parent path and its child paths. */
export type SiblingGroup = {
  parentPath: string
  childPaths: string[]
}

/** A small floor on a distance so a normalize divide never hits zero for two coincident bodies. */
const EPSILON = 1e-6

/**
 * The minimum disc penetration (layout units) at which an awake body's overlap WAKES a sleeping
 * neighbor. Two settled bodies rest tangent and micro-overlap by floating-point noise alone; waking
 * on that would keep a converged cluster from ever fully sleeping. A node genuinely drifting into a
 * settled cluster penetrates well past this, so it still revives the nodes it actually disturbs.
 */
const WAKE_PENETRATION = 0.5

/**
 * The minimum per-step movement (layout units) that makes an awake body a "mover" able to wake the
 * sleeping neighbors it overlaps. Above the sleep step threshold so a body settling toward rest does
 * not count as an intruder, but low enough that a body genuinely travelling (a fresh node drifting
 * into a cluster, a kicked body) does. This is the dynamic half of the wake test: a settled cluster
 * with standing overlap has no movers, so it stays asleep; a real arrival has a clear mover.
 */
const WAKE_MOVE_EPSILON = 0.1

/**
 * Default parent gravity (Gource `gGourceForceGravity`): how hard a directory is pulled to rest just
 * outside its parent's content disc. Gource's own value.
 */
const DEFAULT_GRAVITY = 10

/**
 * Default directory radius padding (Gource `gGourceDirPadding`): the multiplier on `sqrt(content
 * area)` that gives a directory's drawn / collision radius a little breathing room. Gource's value.
 */
const DEFAULT_DIRECTORY_PADDING = 1.5

/**
 * File diameter: sets both the area each file contributes to its directory's radius and the spacing
 * between the concentric file rings. Gource ships `8`; runewood spreads the layout a little wider
 * (`12`) so the file-ring spacing is comfortably larger than a rendered file dot (base radius ~4)
 * plus its restrained glow. Combined with the smaller dots + glow, this is what reconciles the
 * render sizes with the layout so a small tree reads airy and a big tree stays legible (the user's
 * "cluttered / buried" complaint) instead of cramming overlapping glowing orbs together. The dot
 * size is a fixed layout-unit value (it does not track this), so widening the spacing here directly
 * opens the gaps between files.
 */
const DEFAULT_FILE_DIAMETER = 12

/**
 * Default file ease speed (Gource `RFile::speed`): the per-second fraction of the remaining distance
 * a file closes toward its ring slot each frame, clamped so it never overshoots. Gource's value.
 */
const DEFAULT_FILE_EASE_SPEED = 5

/**
 * Default per-second velocity damping in `[0, 1)` on directory bodies. Gource runs with no damping
 * (elasticity 0, pure `pos += accel * dt`), but runewood's camera wobble injects a velocity that
 * needs to bleed off; this decays it over roughly a second so a kick settles into a wobble while the
 * steady-state layout stays Gource-faithful (at rest the velocity decays to zero regardless).
 */
const DEFAULT_DAMPING = 0.85

/** Default integration-step clamp: ~3 frames at 60fps, enough to smooth a hitch without stalling. */
const DEFAULT_MAX_STEP_MS = 50

/**
 * The largest single-frame displacement a directory may take, as a fraction of its own radius. The
 * momentumless `pos += accel * dt` scheme is stable only while a step stays under the distance to
 * equilibrium; a stiff force deep in a large forest can otherwise overshoot and oscillate forever.
 * Capping each step to a slice of the node's radius keeps every frame a sub-equilibrium relaxation,
 * so the forest converges to rest instead of jittering, while leaving an already-settled node (with
 * a tiny force, far under the cap) completely untouched. A generous fraction so settling stays
 * brisk.
 */
const MAX_STEP_FRACTION_OF_RADIUS = 4

/** A floor on the per-frame step cap so a tiny-radius directory can still move a sane minimum. */
const MIN_DIR_STEP = 8

/**
 * The per-SECOND multiplier the global cooling temperature `alpha` decays by (framerate-independent:
 * `alpha *= ALPHA_DECAY_PER_SECOND ^ deltaSeconds` each step). At `0.08` the temperature roughly
 * halves every ~0.27s, so a freshly-(re)heated forest anneals from full energy to effectively cold
 * in a few seconds, after which the residual force steps are tiny and every body sleeps. This is the
 * convergence schedule that breaks the deep-tree limit cycle the raw force model otherwise sits in.
 * Lower cools faster (snappier settle, less organic glide); higher cools slower (more lingering
 * motion). Reheated to 1 by any structural change ({@link ForceLayout.sync}) or camera impulse.
 */
const ALPHA_DECAY_PER_SECOND = 0.08

/**
 * The temperature below which `alpha` snaps to exactly 0, so a cooled forest does no residual force
 * stepping at all (the force step becomes literally zero) and every body reliably sleeps rather than
 * creeping by ever-smaller-but-nonzero amounts forever. Small enough that the layout is visually at
 * rest well before it trips.
 */
const ALPHA_FLOOR = 0.002

/**
 * The realized per-step movement (layout units) below which a directory counts as quiet for
 * sleeping. Keying on the actual step (rather than the raw force) is what lets a body resting in a
 * standing-overlap equilibrium sleep: there the spring and repulsion nearly cancel into a tiny net
 * step even though each individual force is sizeable. Set well under the scene's redraw epsilon
 * ({@link import('../render/scene').DRAW_EPSILON}, ~0.1px) so a node sleeps right around the point
 * its motion would already be invisible, while a real disturbance (a step many times larger) keeps
 * it awake. A tuning knob: lower for stricter stillness before sleeping, higher to quiesce sooner.
 */
const SLEEP_STEP_THRESHOLD = 0.05

/**
 * The wobble-velocity magnitude (layout units per second) below which a directory counts as quiet
 * for sleeping. Only the camera-impulse channel carries velocity (the force response is
 * momentumless), so this is essentially "the camera kick has bled off"; paired with
 * {@link SLEEP_FORCE_THRESHOLD} so a body sleeps only when both its force and its residual motion
 * are small.
 */
const SLEEP_SPEED_THRESHOLD = 4

/**
 * How long (in accumulated below-threshold milliseconds) a directory must stay quiet before it
 * sleeps. A short dwell so a settled forest goes static within a fraction of a second, but long
 * enough that a node merely passing through its equilibrium on the way to overshoot does not sleep
 * prematurely. ~250ms is a handful of frames at 60fps.
 */
const SLEEP_DWELL_MS = 250

/**
 * Default Barnes-Hut opening angle (theta). A quadtree cell is treated as a single center-of-mass
 * point when its width over the distance to it is below this; `0.5` is the standard Barnes-Hut
 * accuracy / speed tradeoff. `0` forces exact all-pairs (every leaf visited).
 */
const DEFAULT_QUAD_TREE_THETA = 0.5

/**
 * Default cap on a single {@link ForceLayout.applyImpulse} kick, in layout units per second, so a
 * hard camera flick produces a lively-but-contained wobble rather than launching the forest
 * off-screen.
 */
const DEFAULT_WOBBLE_MAX_SPEED = 220

/**
 * Tuning for {@link ForceLayout}. Every field defaults to Gource's own constant (or, for the two
 * runewood-only knobs, a sensible value), so the common construction is `new ForceLayout()`.
 */
export type ForceLayoutOptions = {
  /** Layout-space center the forest root is pinned at and stray repo roots ring. Defaults to the origin. */
  center?: Vec2
  /**
   * Parent gravity (Gource `gGourceForceGravity`, default `10`): how hard a directory springs to
   * rest just outside its parent's content disc. Higher snaps the skeleton tighter.
   */
  gravity?: number
  /**
   * Directory radius padding (Gource `gGourceDirPadding`, default `1.5`): the multiplier on
   * `sqrt(content area)` for a directory's radius, so discs keep a readable gap.
   */
  directoryPadding?: number
  /**
   * File diameter in layout units (Gource `gGourceFileDiameter`, default `8`): the area each file
   * adds to its directory and the spacing between the concentric file rings.
   */
  fileDiameter?: number
  /**
   * File ease speed (Gource `RFile::speed`, default `5`): the per-second fraction of the remaining
   * distance a file closes toward its ring slot, clamped so it never overshoots.
   */
  fileEaseSpeed?: number
  /**
   * Per-second velocity damping in `[0, 1)` on directory bodies (runewood-only, default `0.85`).
   * Gource has none; runewood needs it so a camera-wobble impulse settles. At rest it is moot (the
   * velocity is already zero), so it does not change the Gource steady-state layout.
   */
  damping?: number
  /**
   * The largest single integration step, in milliseconds (default `50`). A real delta longer than
   * this (a backgrounded tab, a GC hitch) is clamped so one giant step never flings the forest
   * apart.
   */
  maxStepMs?: number
  /**
   * Barnes-Hut opening angle for the directory repulsion quadtree (default `0.5`). Lower is more
   * accurate and slower; `0` is exact all-pairs.
   */
  quadTreeTheta?: number
  /**
   * The hard cap, in layout units per second, on the velocity {@link ForceLayout.applyImpulse}
   * imparts in one kick (default `220`), so a fast camera gesture cannot fling the forest apart.
   */
  wobbleMaxSpeed?: number
}

/**
 * Computes every directory's content radius (Gource `RDirNode::calcRadius`): `dir_radius =
 * sqrt(dir_area) * padding`, where `dir_area` is the total area of the directory's own visible files
 * plus the areas of all its sub-directories, summed bottom-up. A file's own radius is just its
 * single-disc area. Pure given the visible set + options, so it is directly unit-testable.
 *
 * Walks the display-parent forest so a collapsed pass-through directory never inflates a radius (the
 * sim only knows visible nodes). Each file contributes `(fileDiameter / 2)^2 * PI` of area to its
 * directory; the directory radius is `max(1, sqrt(area)) * padding`.
 */
export function computeContentRadii(
  visibleNodes: VisibleNode[],
  options: Required<ForceLayoutOptions>,
): Map<string, number> {
  const fileRadius = options.fileDiameter * 0.5
  const fileArea = fileRadius * fileRadius * Math.PI

  // Children grouped by display-parent so we can fold areas bottom-up (deepest depth first).
  const childrenByParent = new Map<string, VisibleNode[]>()
  const byPath = new Map<string, VisibleNode>()
  let maxDepth = 0
  for (const visible of visibleNodes) {
    if (visible.isForestRoot) {
      continue
    }
    byPath.set(visible.node.path, visible)
    maxDepth = Math.max(maxDepth, visible.depth)
    const siblings = childrenByParent.get(visible.displayParentPath)
    if (siblings) {
      siblings.push(visible)
    }
    else {
      childrenByParent.set(visible.displayParentPath, [ visible ])
    }
  }

  // Accumulated area per directory path, folded from the leaves up so a parent sees its children's
  // finished areas. Files contribute their own disc area; directories accumulate their children.
  const areaByPath = new Map<string, number>()
  for (let depth = maxDepth; depth >= 1; depth--) {
    for (const visible of visibleNodes) {
      if (visible.isForestRoot || visible.depth !== depth) {
        continue
      }
      const path = visible.node.path
      if (visible.node.isFile) {
        areaByPath.set(path, fileArea)
        continue
      }

      let area = areaByPath.get(path) ?? 0
      for (const child of childrenByParent.get(path) ?? []) {
        area += areaByPath.get(child.node.path) ?? 0
      }
      areaByPath.set(path, area)
    }
  }

  const radii = new Map<string, number>()
  for (const [ path, visible ] of byPath) {
    const area = areaByPath.get(path) ?? 0
    if (visible.node.isFile) {
      // A file's "radius" is just its own disc; the directory sim does not use it, but keep it
      // consistent so callers can read a sensible value.
      radii.set(path, fileRadius)
      continue
    }
    radii.set(path, Math.max(1, Math.sqrt(area)) * options.directoryPadding)
  }
  return radii
}

/**
 * Computes a deterministic radial tidy-tree position for every visible **directory**, used to give a
 * freshly-spawned node a sensible, already-organized initial spot instead of piling it on its parent
 * (issue: a bulk seed of thousands all spawning at/near their parents starts the force sim from a
 * massively-overlapping degenerate state, producing an explosion of repulsion and minutes of churn).
 * Seeding the radial layout up front means the force sim only has to gently refine and de-overlap,
 * so a 3000-node first load lands organized in a second or two.
 *
 * The placement is the same radial fan {@link import('./layout').computeTargets} produces, computed
 * directly off the {@link VisibleNode} display-parent grouping the sim already holds (rather than the
 * raw tree): repo roots ring the center, and each directory hands its visible directory-children an
 * even slice of its own angular wedge one ring further out. Files are intentionally absent (they are
 * deterministic ring satellites of their directory, placed by {@link computeFileSlots}, and spawn on
 * the directory then ease out). The forest root, when present, sits at the center.
 *
 * Pure given `(visibleNodes, options)`: identical input yields identical positions, with no time or
 * randomness, so a bulk add is reproducible and unit-testable. Directories are visited in sorted
 * path order so the fan is independent of input ordering.
 */
export function computeInitialPlacement(
  visibleNodes: VisibleNode[],
  options: Required<ForceLayoutOptions>,
): Map<string, Vec2> {
  // Group the visible DIRECTORIES by their display-parent, so the radial recursion walks only the
  // directory skeleton (files are satellites, not part of the fan). Children are kept sorted by path
  // for an order-independent layout.
  const directoryChildrenByParent = new Map<string, VisibleNode[]>()
  for (const visible of visibleNodes) {
    if (visible.isForestRoot || visible.node.isFile) {
      continue
    }
    const siblings = directoryChildrenByParent.get(visible.displayParentPath)
    if (siblings) {
      siblings.push(visible)
    }
    else {
      directoryChildrenByParent.set(visible.displayParentPath, [ visible ])
    }
  }
  for (const siblings of directoryChildrenByParent.values()) {
    siblings.sort((left, right) => {
      return left.node.path < right.node.path ? -1 : left.node.path > right.node.path ? 1 : 0
    })
  }

  const positions = new Map<string, Vec2>()
  // The repo roots (display-parent `''`) fan around the full circle; each directory then hands its
  // own children a slice of its wedge, one ring further out, exactly like the radial tidy-tree.
  placeRadialChildren('', { angle: 0, span: Math.PI }, 0, {
    center: options.center,
    ringSpacing: options.directoryPadding * RADIAL_RING_SPACING_PADDINGS,
    directoryChildrenByParent,
    positions,
  })
  return positions
}

/**
 * Lays out the visible directory children of `parentPath` across the parent's angular `wedge`, one
 * ring further out than the parent's depth, then recurses into each child with its own narrowed
 * wedge. Mirrors the radial tidy-tree in {@link import('./layout').computeTargets}, but over the
 * directory-only {@link VisibleNode} grouping the sim holds. A deterministic per-path jitter breaks
 * up the mechanical ring perfection so the force sim starts from a slightly organic spread.
 */
function placeRadialChildren(
  parentPath: string,
  wedge: { angle: number, span: number },
  depth: number,
  context: RadialPlacementContext,
): void {
  const children = context.directoryChildrenByParent.get(parentPath)
  if (!children || children.length === 0) {
    return
  }

  const childDepth = depth + 1
  const radius = context.ringSpacing * childDepth

  // Each child gets an equal share of the parent's wedge; a lone child inherits the parent's exact
  // angle so a deep chain grows straight outward instead of drifting.
  const filledSpan = wedge.span * 2 * RADIAL_WEDGE_FILL
  const perChildSpan = filledSpan / children.length
  const wedgeStart = wedge.angle - filledSpan / 2

  for (const [ index, child ] of children.entries()) {
    const childAngle = children.length === 1
      ? wedge.angle
      : wedgeStart + perChildSpan * (index + 0.5)

    // A small deterministic radial jitter from the path hash so siblings born together do not land
    // on a mathematically perfect arc the sim then has to perturb; the angle is left clean so a node
    // stays well within its parent's wedge.
    const jitterUnit = (hashPath(child.node.path) & 0xffff) / 0xffff - 0.5
    const jitteredRadius = radius + jitterUnit * context.ringSpacing * RADIAL_JITTER_FRACTION

    context.positions.set(child.node.path, {
      x: context.center.x + Math.cos(childAngle) * jitteredRadius,
      y: context.center.y + Math.sin(childAngle) * jitteredRadius,
    })

    placeRadialChildren(child.node.path, { angle: childAngle, span: perChildSpan / 2 }, childDepth, context)
  }
}

/** Everything {@link placeRadialChildren} needs that does not change between nodes. */
type RadialPlacementContext = {
  center: Vec2
  ringSpacing: number
  directoryChildrenByParent: Map<string, VisibleNode[]>
  positions: Map<string, Vec2>
}

/**
 * The radial ring spacing for {@link computeInitialPlacement}, expressed as a multiple of the
 * directory padding so the initial fan's ring gap scales with the same unit the content radii use.
 * Wide enough that sibling sub-trees start clearly separated, so the force sim opens from an
 * already-spread state rather than a pile.
 */
const RADIAL_RING_SPACING_PADDINGS = 80

/**
 * Fraction (0..1) of a node's angular wedge its children are allowed to span, leaving a gap between
 * sibling sub-trees so they read as distinct branches. Mirrors the radial tidy-tree's default.
 */
const RADIAL_WEDGE_FILL = 0.85

/**
 * Peak radial jitter on the initial placement, as a fraction of the ring spacing, derived from each
 * path's hash (never randomness, so the placement stays deterministic). Just enough to break the
 * mechanical ring perfection so the force sim does not start every sibling on one exact arc.
 */
const RADIAL_JITTER_FRACTION = 0.15

/**
 * A directory's `parent_radius` (Gource `calcRadius`): the radius a child rests just outside,
 * derived from the directory's OWN visible files only (`sqrt(file area) * padding`), NOT its whole
 * subtree. Counting only the direct files keeps a deep directory from flinging its children far out.
 * Pure given the node's meta + options.
 */
export function parentFileRadius(meta: NodeMeta, options: Required<ForceLayoutOptions>): number {
  if (meta.fileCount <= 0) {
    return options.directoryPadding
  }
  const fileRadius = options.fileDiameter * 0.5
  const fileArea = fileRadius * fileRadius * Math.PI
  const total = fileArea * meta.fileCount
  return Math.max(1, Math.sqrt(total)) * options.directoryPadding
}

/**
 * Counts how many visible files each directory holds directly (Gource `visible_count`), keyed by
 * the directory's path. Drives the `parent_radius` rest gap a child of that directory rests just
 * outside. Pure and deterministic. Directories with no direct files are simply absent (read as 0).
 */
export function countDirectFiles(visibleNodes: VisibleNode[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const visible of visibleNodes) {
    if (visible.isForestRoot || !visible.node.isFile) {
      continue
    }
    const directoryPath = visible.displayParentPath
    counts.set(directoryPath, (counts.get(directoryPath) ?? 0) + 1)
  }
  return counts
}

/**
 * Packs each directory's visible files into concentric rings around it and returns each file's
 * resting offset from the directory center (Gource `calcFileDest` scaled by `distance` from
 * `updateFilePositions`). Ring `k` (1-based) sits at radius `k * fileDiameter` and holds up to
 * `max(1, round(k * PI))` files, each at an evenly spaced angle `(slot + 0.5) / ringCapacity` of a
 * full turn. Pure and deterministic: the same visible set yields the same slots, so a re-sync after
 * a rewind reproduces the packing exactly.
 *
 * Files are ordered within a directory by path so the packing is independent of map insertion order.
 * The returned map is keyed by file path; directories are absent.
 */
export function computeFileSlots(
  visibleNodes: VisibleNode[],
  options: Required<ForceLayoutOptions>,
): Map<string, Vec2> {
  // Group visible files by their directory (display-parent), then pack each group into rings.
  const filesByDirectory = new Map<string, string[]>()
  for (const visible of visibleNodes) {
    if (visible.isForestRoot || !visible.node.isFile) {
      continue
    }
    const directoryPath = visible.displayParentPath
    const existing = filesByDirectory.get(directoryPath)
    if (existing) {
      existing.push(visible.node.path)
    }
    else {
      filesByDirectory.set(directoryPath, [ visible.node.path ])
    }
  }

  const slots = new Map<string, Vec2>()
  for (const [ , filePaths ] of filesByDirectory) {
    const ordered = [ ...filePaths ].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    packFilesIntoRings(ordered, options, slots)
  }
  return slots
}

/**
 * Packs one directory's ordered file paths into concentric rings, writing each file's offset into
 * `slots` (Gource `updateFilePositions`). Ring 1 holds a single centered file, then each successive
 * ring sits one `fileDiameter` further out and holds `max(1, round(diameter * PI))` files spread
 * evenly around it. Pure aside from the `slots` it fills.
 */
function packFilesIntoRings(
  filePaths: string[],
  options: Required<ForceLayoutOptions>,
  slots: Map<string, Vec2>,
): void {
  let ring = 1
  let radius = 0
  let capacity = 1
  let slotInRing = 0
  let filesLeft = filePaths.length

  for (const filePath of filePaths) {
    // Even angle within the current ring (Gource `calcFileDest`): half a slice in, then one slice
    // per file, around the full circle. `sin`/`cos` swapped to match Gource's `(sin, cos)` so the
    // first file sits at the top, but any consistent convention works.
    const fraction = (slotInRing + 0.5) / capacity
    const angle = fraction * Math.PI * 2
    slots.set(filePath, {
      x: Math.sin(angle) * radius,
      y: Math.cos(angle) * radius,
    })

    filesLeft--
    slotInRing++

    if (slotInRing >= capacity) {
      // Advance to the next ring: one file-diameter further out, capacity = circumference / file.
      ring++
      radius += options.fileDiameter
      capacity = Math.max(1, Math.round(ring * Math.PI))
      if (filesLeft < capacity) {
        capacity = Math.max(1, filesLeft)
      }
      slotInRing = 0
    }
  }
}

/**
 * Caps a velocity vector to a maximum magnitude, preserving its direction. Used by
 * {@link ForceLayout.applyImpulse} so a fast camera gesture cannot inject a runaway kick: at or
 * under `maxSpeed` the vector passes through unchanged; above it the magnitude is clamped while the
 * direction is kept. A non-finite component or a non-positive `maxSpeed` collapses to a zero kick.
 * Pure, so it is directly unit-testable.
 */
export function clampSpeed(velocity: Vec2, maxSpeed: number): Vec2 {
  if (!Number.isFinite(velocity.x) || !Number.isFinite(velocity.y) || !(maxSpeed > 0)) {
    return { x: 0, y: 0 }
  }

  const speed = Math.hypot(velocity.x, velocity.y)
  if (speed <= maxSpeed) {
    return { x: velocity.x, y: velocity.y }
  }

  const scale = maxSpeed / speed
  return { x: velocity.x * scale, y: velocity.y * scale }
}

/**
 * The radial wobble impulse for a zoom gesture: a velocity that points from the zoom anchor toward
 * (or, zooming out, away from) the forest's current center, so a wheel-zoom nudges the nodes out/in
 * along the zoom axis and they spring back into a wobble. `centerOffset` is the vector from the
 * anchor to the sim's center in WORLD units; `factor` is the zoom multiplier (`> 1` zoomed in, `< 1`
 * zoomed out); `strength` scales the kick. Zooming in pushes the forest outward (away from the
 * anchor) and zooming out pulls it inward, proportional to the zoom step (`|ln factor|`).
 *
 * An anchor on the center (no defined radial direction) or a non-positive / unit `factor` yields a
 * zero impulse. Pure, so the zoom kick is directly unit-testable.
 */
export function zoomImpulse(centerOffset: Vec2, factor: number, strength: number): Vec2 {
  if (!(factor > 0) || factor === 1) {
    return { x: 0, y: 0 }
  }

  const distance = Math.hypot(centerOffset.x, centerOffset.y)
  if (distance < EPSILON) {
    return { x: 0, y: 0 }
  }

  const magnitude = -Math.log(factor) * strength
  return {
    x: (centerOffset.x / distance) * magnitude,
    y: (centerOffset.y / distance) * magnitude,
  }
}

/** FNV-1a 32-bit hash of a string. Stable, fast, and dependency-free; matches the layout's hash. */
export function hashPath(path: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < path.length; index++) {
    hash ^= path.charCodeAt(index)
    // FNV prime multiply via shifts to stay in 32-bit integer math.
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return hash >>> 0
}

/**
 * A deterministic unit-ish vector in `[-1, 1]^2` from a path hash (Gource's `vec2Hash`): used to
 * scatter freshly spawned siblings off one ray so they fan out instead of stacking. Two independent
 * bit-fields of the 32-bit hash feed x and y so they do not move in lockstep.
 */
export function hashUnitVector(path: string): Vec2 {
  const hash = hashPath(path)
  const x = ((hash & 0xffff) / 0xffff) * 2 - 1
  const y = (((hash >>> 16) & 0xffff) / 0xffff) * 2 - 1
  return { x, y }
}

/**
 * One point inserted into the Barnes-Hut {@link QuadTree}: a directory's path, live position, and
 * content radius (used as its "mass" so a big directory pushes harder, mirroring Gource where the
 * penetration push scales with both discs' radii).
 */
export type QuadPoint = {
  path: string
  position: Vec2
  radius: number
}

/**
 * A Barnes-Hut quadtree over the directory bodies, the backbone of the `O(n log n)` directory
 * repulsion (Gource uses a quadtree for exactly this in `RDirNode::applyForces`). It summarizes a
 * cluster of far-away directories by their combined center of mass and radius, so a query walks only
 * `O(log n)` nodes instead of every directory.
 *
 * {@link repulsionOn} computes the total push on one directory: it descends the tree, and for any
 * cell far enough away (its width over the distance below `theta`) treats the whole cell as one
 * lumped repulsor; otherwise it recurses. A leaf is tested directly and skipped by the caller's
 * `excludes` predicate (self, parent, child, ancestors), exactly Gource's `DirForceFunctor`.
 */
export type QuadTree = {
  repulsionOn: (
    path: string,
    position: Vec2,
    radius: number,
    repels: (candidatePath: string) => boolean,
    onOverlap?: (overlappedPath: string) => void,
  ) => Vec2
}

/** One node of the Barnes-Hut tree: either a leaf holding one point, or an internal cell of four quadrants. */
type QuadCell = {
  /** Cell bounds (a square), used for the `width / distance < theta` opening test. */
  minX: number
  minY: number
  size: number
  /** Combined mass center of every point under this cell, for the lumped far-field approximation. */
  comX: number
  comY: number
  totalRadius: number
  /** The single point when this is a leaf, else `null`. */
  point: QuadPoint | null
  /** The four child quadrants when this is internal, else `null`. */
  children: QuadCell[] | null
}

/**
 * Builds a Barnes-Hut quadtree from `points` for the directory repulsion. Pure (no time, no
 * randomness): the same points + theta always yield the same tree. An empty input returns a tree
 * whose {@link QuadTree.repulsionOn} is always zero.
 *
 * The bounds are the square bounding box of every point (with a small pad so two coincident points
 * still nest), and each point is inserted by recursively subdividing the cell it lands in.
 */
export function buildQuadTree(points: QuadPoint[], theta: number): QuadTree {
  if (points.length === 0) {
    return { repulsionOn: () => ({ x: 0, y: 0 }) }
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of points) {
    minX = Math.min(minX, point.position.x)
    minY = Math.min(minY, point.position.y)
    maxX = Math.max(maxX, point.position.x)
    maxY = Math.max(maxY, point.position.y)
  }

  // A square root cell covering every point, padded so coincident points still have room to nest.
  const span = Math.max(maxX - minX, maxY - minY, EPSILON) + 1
  const root = makeCell(minX, minY, span)
  for (const point of points) {
    insertPoint(root, point)
  }

  const repulsionOn = (
    path: string,
    position: Vec2,
    radius: number,
    repels: (candidatePath: string) => boolean,
    onOverlap?: (overlappedPath: string) => void,
  ): Vec2 => {
    const push = { x: 0, y: 0 }
    accumulateRepulsion(root, path, position, radius, theta, repels, push, onOverlap)
    return push
  }

  return { repulsionOn }
}

/** Allocates an empty leaf-capable cell with the given bounds. */
function makeCell(minX: number, minY: number, size: number): QuadCell {
  return {
    minX,
    minY,
    size,
    comX: 0,
    comY: 0,
    totalRadius: 0,
    point: null,
    children: null,
  }
}

/**
 * Inserts one point into the tree, subdividing as needed (standard Barnes-Hut insertion). The
 * running center of mass (radius-weighted) is updated on every cell the point passes through, so the
 * far-field approximation has each cell's lumped position and total radius ready.
 */
function insertPoint(cell: QuadCell, point: QuadPoint): void {
  // Fold the point into this cell's radius-weighted center of mass.
  const newTotal = cell.totalRadius + point.radius
  cell.comX = (cell.comX * cell.totalRadius + point.position.x * point.radius) / newTotal
  cell.comY = (cell.comY * cell.totalRadius + point.position.y * point.radius) / newTotal
  cell.totalRadius = newTotal

  if (!cell.children && cell.point === null) {
    // Empty leaf: park the point here.
    cell.point = point
    return
  }

  if (!cell.children && cell.point !== null) {
    // Occupied leaf: subdivide and push the existing point down before inserting the new one.
    const existing = cell.point
    cell.point = null
    cell.children = subdivide(cell)
    insertPoint(childFor(cell, existing.position), existing)
  }

  insertPoint(childFor(cell, point.position), point)
}

/** The four child quadrants of a cell, each half the side, in [SW, SE, NW, NE] order. */
function subdivide(cell: QuadCell): QuadCell[] {
  const half = cell.size / 2
  return [
    makeCell(cell.minX, cell.minY, half),
    makeCell(cell.minX + half, cell.minY, half),
    makeCell(cell.minX, cell.minY + half, half),
    makeCell(cell.minX + half, cell.minY + half, half),
  ]
}

/** Selects which of a subdivided cell's four children a position falls into. */
function childFor(cell: QuadCell, position: Vec2): QuadCell {
  const half = cell.size / 2
  const east = position.x >= cell.minX + half ? 1 : 0
  const north = position.y >= cell.minY + half ? 1 : 0
  return cell.children![north * 2 + east]
}

/**
 * Accumulates the Barnes-Hut repulsion on one directory from a cell (the recursive heart of
 * {@link buildQuadTree}). For a far-enough internal cell (`size / distance < theta`) the whole cell
 * is treated as one lumped repulsor at its center of mass; otherwise it recurses into its children.
 * A leaf applies Gource's `applyForceDir`: a push apart equal to the disc penetration, but ONLY when
 * the two discs overlap and only if the caller's `repels` predicate allows it (skipping self,
 * parent, child, ancestors).
 */
function accumulateRepulsion(
  cell: QuadCell,
  path: string,
  position: Vec2,
  radius: number,
  theta: number,
  repels: (candidatePath: string) => boolean,
  push: Vec2,
  onOverlap?: (overlappedPath: string) => void,
): void {
  if (cell.totalRadius <= 0) {
    return
  }

  if (cell.point !== null) {
    // A leaf: apply Gource's pairwise overlap push directly, honoring the exclusion predicate.
    const other = cell.point
    if (other.path === path || !repels(other.path)) {
      return
    }
    const beforeX = push.x
    const beforeY = push.y
    addOverlapPush(position, radius, other.position, other.radius, push)
    // The push delta equals the disc penetration depth; report the overlap so the caller can wake a
    // sleeping neighbor the querying body has drifted INTO, but only when the penetration is
    // MEANINGFUL ({@link WAKE_PENETRATION}). Two bodies resting tangent micro-overlap by floating
    // point alone; waking on that would keep a settled cluster from ever fully sleeping. A real
    // intruder penetrates well past the epsilon.
    if (onOverlap) {
      const penetration = Math.hypot(push.x - beforeX, push.y - beforeY)
      if (penetration > WAKE_PENETRATION) {
        onOverlap(other.path)
      }
    }
    return
  }

  if (!cell.children) {
    return
  }

  const offsetX = cell.comX - position.x
  const offsetY = cell.comY - position.y
  const distance = Math.hypot(offsetX, offsetY)

  // Far-field test: if the cell subtends a small enough angle, lump it. A lumped cell can only ever
  // contribute a push if the query disc reaches its combined radius, mirroring the overlap-only
  // pairwise rule, so a far cluster (the common case) contributes nothing and is never opened. A
  // lumped cell has no single path, so it never fires the overlap-wake callback (a far cluster is
  // not a direct neighbor); only leaf overlaps wake a sleeper, which is exactly the intent.
  if (distance > EPSILON && cell.size / distance < theta) {
    addOverlapPush(position, radius, { x: cell.comX, y: cell.comY }, cell.totalRadius, push)
    return
  }

  for (const child of cell.children) {
    accumulateRepulsion(child, path, position, radius, theta, repels, push, onOverlap)
  }
}

/**
 * Gource's `applyForceDir` overlap push between one body and another (or a lumped cell): when the
 * two discs overlap (`distance < radiusA + radiusB`), add a shove apart equal to the penetration
 * depth along the separating axis. Past the touch distance the push is exactly zero, so well-spread
 * directories feel nothing. Two coincident bodies get a deterministic unit nudge so they never
 * divide by zero or stay stuck.
 */
function addOverlapPush(
  position: Vec2,
  radius: number,
  otherPosition: Vec2,
  otherRadius: number,
  push: Vec2,
): void {
  const offsetX = position.x - otherPosition.x
  const offsetY = position.y - otherPosition.y
  const distance = Math.hypot(offsetX, offsetY)
  const sumRadius = radius + otherRadius

  if (distance >= sumRadius) {
    // No overlap: zero force past the touch distance (Gource's early `distance2 > 0` return).
    return
  }

  if (distance < EPSILON) {
    // Coincident: nudge apart on a fixed axis so they separate deterministically rather than NaN.
    push.x += sumRadius
    return
  }

  // Penetration depth (Gource: `distance = posd - myradius - yourradius`, negative; the push is
  // `distance * normalise(dir)` away from the other body), i.e. shove apart by how deep they sit.
  const penetration = sumRadius - distance
  push.x += (offsetX / distance) * penetration
  push.y += (offsetY / distance) * penetration
}
