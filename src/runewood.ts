// Copyright © 2026 Jalapeno Labs

import type { RunewoodEvent } from './types'
import type { Vec2, SpringState, LayoutOptions, SpringParams } from './core/layout'
import type { RunewoodTheme, RunewoodThemeOverrides } from './core/theme'
import type { WorldBounds } from './render/camera'
import type { FrameState, BeamSpawnRequest, PulseSpawnRequest } from './core/frameStep'
import type { ActorActivity } from './render/actors'
import type { LabelCandidate } from './render/labels'
import type { BloomQuality } from './render/bloom'
import type { SceneOptions } from './render/scene'
import type { BeamSceneOptions } from './render/beamScene'
import type { LabelLodOptions } from './render/labels'
import type { Scene } from './render/scene'
import type { BeamScene } from './render/beamScene'
import type { LabelScene } from './render/labelScene'

// Core
import { Timeline } from './core/timeline'
import { computeTargets, stepSprings } from './core/layout'
import { defaultTheme, mergeTheme, themes } from './core/theme'
import { createFrameState, stepFrame } from './core/frameStep'
import { seedTree } from './core/tree'

// Render
import { Camera, autoFrame } from './render/camera'
import { resolveBloomQuality } from './render/bloom'
import { PixiBackend } from './render/pixiBackend'

/**
 * The public, imperative controller for a Runewood visualization (issue #9). This
 * is the single entry point a host uses: it wires the timeline, the pure tree
 * fold, the layout springs, the camera, and the pixi renderer together and owns
 * the one `requestAnimationFrame` loop that drives them. It is the *only* module
 * allowed to read the wall clock and call `requestAnimationFrame`; everything
 * below it stays pure and time-injected (the playhead time flows down, never the
 * wall clock).
 *
 * Shape: an `xterm.js`/`chart.js`-style imperative controller created against a
 * DOM element, never a framework component. React/Svelte wrappers, if they ever
 * exist, are thin and live in their own entry points.
 */
export type RunewoodController = {
  /**
   * Feed one event or a batch into the timeline. Events should arrive in
   * non-decreasing time order; the timeline tolerates slight reordering. Calls
   * made before the backend has finished initializing are queued and replayed in
   * order once it is ready, so a host can ingest immediately after construction.
   */
  ingest: (events: RunewoodEvent | RunewoodEvent[]) => void
  /**
   * Pre-populate the forest with known structure (e.g. `git ls-files` output) as
   * dim, undiscovered nodes that light up as events reveal them. Like `ingest`,
   * queued until the backend is ready.
   */
  seed: (paths: string[]) => void
  /** Start playback: the loop advances the playhead by real elapsed time. */
  play: () => void
  /** Pause playback: the playhead holds, the loop keeps drawing the current state. */
  pause: () => void
  /**
   * Jump the playhead to an absolute epoch-ms time. A backward jump re-folds the
   * tree exactly and clears transient particles; a forward jump replays the
   * crossed events' effects.
   */
  seek: (time: number) => void
  /** Set the playback rate. `1` is real time, `2` double speed, `0.5` half. */
  setSpeed: (multiplier: number) => void
  /** Pin the camera to auto-frame the active region (`true`) or leave it free (`false`). */
  follow: (shouldFollow: boolean) => void
  /**
   * Re-read the container size and resize the renderer. Called automatically by an
   * internal `ResizeObserver`; exposed for hosts that resize imperatively or run
   * where `ResizeObserver` is unavailable.
   */
  resize: () => void
  /**
   * Tear everything down: stop the RAF loop, disconnect the observer and media
   * query, dispose every scene and the backend (releasing all GPU resources), and
   * remove the canvas from the container. Idempotent and leak-free.
   */
  destroy: () => void
}

/** Construction options for {@link createRunewood}; every field has a sensible default. */
export type RunewoodOptions = {
  /**
   * The visual theme: a built-in name (`dusk`, `void`, `parchment`), a full
   * {@link RunewoodTheme}, or a partial override merged onto `dusk`. Defaults to
   * `dusk`.
   */
  theme?: keyof typeof themes | RunewoodTheme | RunewoodThemeOverrides
  /**
   * The requested bloom quality. Subject to a reduced-motion / low-power
   * downgrade at runtime (see {@link resolveBloomQuality}). Defaults to `high`.
   */
  bloom?: BloomQuality
  /**
   * Whether the camera auto-frames the active region from the first frame.
   * Defaults to `true`; equivalent to calling `follow(true)` immediately.
   */
  follow?: boolean
  /** Initial playback speed multiplier. Defaults to `1`. */
  speed?: number
  /** Start playing immediately on init, rather than waiting for `play()`. Defaults to `false`. */
  autoplay?: boolean
  /**
   * A coarse "this is a weak GPU / low-power device" hint that caps bloom at
   * `low`. The reduced-motion downgrade is read from the platform media query
   * automatically; this is the one capability the host must supply. Defaults to
   * `false`.
   */
  lowPower?: boolean
  /** Tuning for the radial tidy-tree layout. */
  layout?: LayoutOptions
  /** Tuning for the layout springs (stiffness / damping). */
  springs?: SpringParams
  /** Tuning forwarded to the retained forest scene (node / edge visuals). */
  scene?: SceneOptions
  /** Tuning forwarded to the retained beam scene (particles / actor orbs). */
  beams?: BeamSceneOptions
  /** Tuning forwarded to the retained label scene (LOD policy). */
  labels?: LabelLodOptions
  /**
   * Device pixel ratio to render at. Defaults to the host's `devicePixelRatio`;
   * exposed so a harness can pin it.
   */
  resolution?: number
}

/**
 * How wide the active region's world bounds are padded, in layout units, so the
 * camera frames a little space around the live nodes rather than clipping them at
 * the edge. Mirrors the node halo scale so a glowing node near the edge is not cut.
 */
const ACTIVE_REGION_PADDING = 80

/**
 * The fallback half-extent of the framed region when there is nothing to frame
 * yet (an empty forest), so the camera shows a sensible window instead of
 * collapsing to a point at the origin.
 */
const EMPTY_REGION_HALF_EXTENT = 200

/**
 * Creates a Runewood controller mounted in `container` and returns it
 * synchronously. The pixi backend initializes asynchronously in the background
 * (pixi v8's device bring-up is async); any `ingest`/`seed` made before it is
 * ready are queued and replayed in order the instant init completes, so the host
 * never has to await anything. The RAF loop starts as soon as init finishes.
 *
 * This sync-returns-with-internal-async contract is the cleaner of the two the
 * issue floated: it matches the imperative `new Terminal(...)` / `new Chart(...)`
 * shape hosts expect, and the queue makes "ingest before ready" a non-issue
 * rather than forcing every caller to thread a promise.
 */
export function createRunewood(container: HTMLElement, options: RunewoodOptions = {}): RunewoodController {
  const theme = resolveTheme(options.theme)
  const requestedBloom: BloomQuality = options.bloom ?? 'high'
  const lowPower = options.lowPower ?? false

  // The pure / logical state, all owned here and threaded through the reducer.
  const timeline = new Timeline()
  const camera = new Camera()
  let springs: SpringState = new Map()
  let frameState: FrameState = createFrameState()

  // The forward-only visual shell, created once the backend is ready.
  const backend = new PixiBackend()
  let scene: Scene | null = null
  let beamScene: BeamScene | null = null
  let labelScene: LabelScene | null = null

  // Loop and lifecycle handles.
  let ready = false
  let destroyed = false
  let rafHandle: number | null = null
  let lastFrameTime: number | null = null
  let resizeObserver: ResizeObserver | null = null
  let reducedMotionQuery: MediaQueryList | null = null
  let appliedBloom: BloomQuality | null = null

  // Work the host requested before the backend finished initializing. Replayed in
  // order on ready so "ingest immediately after construction" just works.
  const pendingActions: Array<() => void> = []

  // Whether the host wants the camera to track the active region. Honored from the
  // first frame; toggled by `follow`.
  let following = options.follow ?? true

  /** Reads the live reduced-motion preference, guarding for non-browser hosts. */
  function prefersReducedMotion(): boolean {
    return reducedMotionQuery?.matches ?? false
  }

  /** The bloom quality to actually run, after the reduced-motion / low-power downgrade. */
  function effectiveBloom(): BloomQuality {
    return resolveBloomQuality(requestedBloom, {
      prefersReducedMotion: prefersReducedMotion(),
      lowPower,
    })
  }

  /** Pushes the current bloom quality to the backend, but only when it has changed. */
  function syncBloom(): void {
    const next = effectiveBloom()
    if (next === appliedBloom) {
      return
    }
    backend.setBloom(next, theme)
    appliedBloom = next
  }

  /**
   * One logical + visual tick. `now` is the playhead time (NOT the wall clock):
   * every downstream effect (heat, flashes, labels, actor fades) reads it so a
   * replay reproduces exactly. `deltaMs` is the real elapsed wall time, used only
   * to advance the timeline and integrate the springs / camera easing.
   */
  function tick(deltaMs: number): void {
    if (!scene || !beamScene || !labelScene) {
      return
    }

    // 1. Advance the playhead and fold the logical state (pure reducer).
    const advance = timeline.advance(deltaMs)
    const step = stepFrame(frameState, advance, advance.crossed.length > 0 ? timeline.getEvents() : EMPTY_LOG)
    frameState = step.state
    const now = frameState.playhead

    // A backward seek landed since the last tick only via `seek()`, which handles
    // its own rebuild; a forward advance never rebuilds, so `step.clearParticles`
    // is false here. The clear-on-rewind path lives in `applySeek`.

    // 2. Spawn this tick's beams / pulses into the transient particle field.
    spawnEffects(step.beams, step.pulses)

    // 3. Recompute layout targets from the (re)folded tree and step the springs in
    //    place. One long-lived SpringState across frames, never reconstructed.
    const targets = computeTargets(frameState.tree, options.layout)
    const motionScale = prefersReducedMotion() ? 0 : 1
    springs = stepSprings(springs, targets, deltaMs * motionScale, options.springs)

    // 4. Frame the active region. Under reduced motion we snap straight to the
    //    framed transform (no glide) so the camera still tracks the action but does
    //    not animate; otherwise we ease toward it framerate-independently.
    if (following) {
      const bounds = activeRegionBounds(targets)
      if (prefersReducedMotion()) {
        camera.frameBounds(bounds)
      }
      else {
        const eased = autoFrame({
          from: { center: camera.center, zoom: camera.zoom },
          bounds,
          viewport: camera.viewport,
          deltaSeconds: deltaMs / 1000,
        })
        camera.center = eased.center
        camera.zoom = eased.zoom
      }
    }

    // 5. Draw: forest, then beams, then labels, all under one camera + bloom pass.
    syncBloom()
    backend.beginFrame(theme.background)
    // The backend's CameraTransform carries the viewport as a plain {x, y} extent,
    // while the camera snapshots it as {width, height}; bridge the two here, the one
    // seam between the pure camera and the draw backend.
    const snapshot = camera.snapshot()
    backend.setCamera({
      center: snapshot.center,
      zoom: snapshot.zoom,
      viewport: { x: snapshot.viewport.width, y: snapshot.viewport.height },
    })
    scene.update(frameState.tree, springs, now, theme)

    const activities = buildActorActivities()
    beamScene.update(activities, now, theme)

    const candidates = buildLabelCandidates(now, activities)
    labelScene.update(candidates, camera.zoom, now, theme)

    backend.endFrame()
  }

  /** Spawns the reducer's beams / pulses, resolving each path to its live spring position. */
  function spawnEffects(beams: BeamSpawnRequest[], pulses: PulseSpawnRequest[]): void {
    if (!beamScene) {
      return
    }
    for (const beam of beams) {
      const target = springs.get(beam.path)
      if (!target) {
        // The node has no spring entry yet (it spawns this same frame); skip the
        // beam rather than point it at the origin. It is a single transient effect;
        // the file still lights up via its node flash.
        continue
      }
      const source = actorSourceFor(beam.actor)
      beamScene.spawn({ at: beam.at, actor: beam.actor, action: beam.action, source, target: target.position })
    }
    for (const pulse of pulses) {
      const source = actorSourceFor(pulse.actor)
      beamScene.spawnPulse({ at: pulse.at, actor: pulse.actor, action: pulse.action, source })
    }
  }

  /**
   * Where an actor's beams originate: the centroid of the files it is currently
   * touching (its orb position), so a beam visibly flies from the actor to the
   * file. Falls back to the origin for an actor with no tracked files yet.
   */
  function actorSourceFor(actor: string): Vec2 {
    const track = frameState.actors.get(actor)
    if (!track || track.touchedPaths.length === 0) {
      return { x: 0, y: 0 }
    }
    return centroidOfPaths(track.touchedPaths)
  }

  /** Mean of the live spring positions of a set of paths; the origin if none are tracked yet. */
  function centroidOfPaths(paths: string[]): Vec2 {
    let sumX = 0
    let sumY = 0
    let count = 0
    for (const path of paths) {
      const physics = springs.get(path)
      if (physics) {
        sumX += physics.position.x
        sumY += physics.position.y
        count += 1
      }
    }
    if (count === 0) {
      return { x: 0, y: 0 }
    }
    return { x: sumX / count, y: sumY / count }
  }

  /** Turns the reducer's actor tracking into drawable activity, resolving paths to spring positions. */
  function buildActorActivities(): ActorActivity[] {
    const activities: ActorActivity[] = []
    for (const track of frameState.actors.values()) {
      const touched: Vec2[] = []
      for (const path of track.touchedPaths) {
        const physics = springs.get(path)
        if (physics) {
          touched.push(physics.position)
        }
      }
      const lastCentroid = touched.length > 0 ? centroidOfPaths(track.touchedPaths) : track.lastCentroid
      // Remember where the actor last worked so it stays parked there as it fades.
      if (touched.length > 0) {
        track.lastCentroid = lastCentroid
      }
      activities.push({
        actor: track.actor,
        touched,
        lastActiveAt: track.lastActiveAt,
        lastCentroid,
      })
    }
    return activities
  }

  /**
   * Assembles the label candidates for this frame: every file and repo-root node
   * at its live spring position (files carry their `lastTouchedAt` for the touch
   * flash), plus an actor label per active actor carrying its orb alpha so the
   * label is exactly as present as the orb.
   */
  function buildLabelCandidates(now: number, activities: ActorActivity[]): LabelCandidate[] {
    const candidates: LabelCandidate[] = []

    const stack = [ frameState.tree ]
    while (stack.length > 0) {
      const node = stack.pop()!
      for (const child of node.children.values()) {
        stack.push(child)
      }
      if (!node.path) {
        continue
      }
      const physics = springs.get(node.path)
      if (!physics) {
        continue
      }
      // A repo root is a depth-1 directory (no slash in its path); everything else
      // that is a file gets a file label.
      const isRepoRoot = !node.path.includes('/') && !node.isFile
      if (isRepoRoot) {
        candidates.push({ kind: 'root', id: node.path, text: node.name, position: physics.position })
      }
      else if (node.isFile) {
        candidates.push({
          kind: 'file',
          id: node.path,
          text: node.name,
          position: physics.position,
          lastTouchedAt: node.lastTouchedAt ?? undefined,
        })
      }
    }

    for (const activity of activities) {
      // The actor label rides on the same anchor and presence as the orb: the
      // centroid of its touched files (or its parked last-centroid while quiet),
      // and exactly the orb's fade alpha so the two appear and vanish together.
      const anchor = activity.touched.length > 0
        ? meanOf(activity.touched)
        : activity.lastCentroid ?? { x: 0, y: 0 }
      candidates.push({
        kind: 'actor',
        id: activity.actor,
        text: activity.actor,
        position: anchor,
        actorAlpha: actorAlphaFor(activity, now),
      })
    }

    return candidates
  }

  /** Mean of a list of already-resolved positions; the origin when empty. */
  function meanOf(positions: Vec2[]): Vec2 {
    if (positions.length === 0) {
      return { x: 0, y: 0 }
    }
    let sumX = 0
    let sumY = 0
    for (const position of positions) {
      sumX += position.x
      sumY += position.y
    }
    return { x: sumX / positions.length, y: sumY / positions.length }
  }

  /**
   * The actor's presence alpha at `now`, mirroring the actor visual model's fade so
   * an actor label is exactly as present as its orb. Recomputed here rather than
   * threaded out of the beam scene to keep the scenes write-only from the controller.
   */
  function actorAlphaFor(activity: ActorActivity, now: number): number {
    const elapsed = now - activity.lastActiveAt
    if (elapsed <= 0) {
      return 1
    }
    return Math.max(0, Math.min(1, 1 - elapsed / ACTOR_LABEL_FADE_MS))
  }

  /**
   * The world bounds enclosing the active region, derived from the layout targets
   * (the canonical positions, so the camera frames where nodes are settling, not
   * where they currently are mid-spring). Padded so glowing nodes near the edge are
   * not clipped, and falls back to a sensible window when the forest is empty.
   */
  function activeRegionBounds(targets: Map<string, Vec2>): WorldBounds {
    if (targets.size === 0) {
      return {
        min: { x: -EMPTY_REGION_HALF_EXTENT, y: -EMPTY_REGION_HALF_EXTENT },
        max: { x: EMPTY_REGION_HALF_EXTENT, y: EMPTY_REGION_HALF_EXTENT },
      }
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const position of targets.values()) {
      minX = Math.min(minX, position.x)
      minY = Math.min(minY, position.y)
      maxX = Math.max(maxX, position.x)
      maxY = Math.max(maxY, position.y)
    }
    return {
      min: { x: minX - ACTIVE_REGION_PADDING, y: minY - ACTIVE_REGION_PADDING },
      max: { x: maxX + ACTIVE_REGION_PADDING, y: maxY + ACTIVE_REGION_PADDING },
    }
  }

  /** The RAF callback: compute the real elapsed delta, tick once, schedule the next frame. */
  function frame(timestamp: number): void {
    if (destroyed) {
      return
    }
    const deltaMs = lastFrameTime === null ? 0 : Math.max(0, timestamp - lastFrameTime)
    lastFrameTime = timestamp
    tick(deltaMs)
    rafHandle = requestAnimationFrame(frame)
  }

  /** Applies a seek and reconciles the visual shell with the (possibly rewound) logical state. */
  function applySeek(time: number): void {
    const seekResult = timeline.seek(time)
    // Adapt the bare `{ rebuild }` seek into the reducer's uniform result: the
    // sought playhead is the timeline's new time, and a seek never hands back
    // crossed events (a forward seek's effects are not replayed event-by-event;
    // the re-fold below brings the tree current either way).
    const step = stepFrame(
      frameState,
      { playhead: timeline.time, rebuild: seekResult.rebuild, crossed: []},
      timeline.getEvents(),
    )
    frameState = step.state
    if (step.clearParticles && beamScene) {
      // Backward seek: drop transient particles rather than reverse them.
      beamScene.clear()
    }
  }

  /** Brings up the backend, builds the scenes, drains the queue, and starts the loop. */
  async function initialize(): Promise<void> {
    const { width, height } = containerSize()
    await backend.init({ container, width, height, resolution: options.resolution })
    if (destroyed) {
      // Destroyed mid-init: undo the backend bring-up and bail before wiring anything.
      backend.dispose()
      return
    }

    scene = backend.createScene(options.scene)
    beamScene = backend.createBeamScene(options.beams)
    labelScene = backend.createLabelScene(options.labels)

    camera.setViewport(width, height)
    backend.setBloom(effectiveBloom(), theme)
    appliedBloom = effectiveBloom()

    // The reduced-motion query and resize observer are live shells; guard both for
    // non-browser hosts (SSR, tests) where they are absent.
    if (typeof matchMedia === 'function') {
      reducedMotionQuery = matchMedia('(prefers-reduced-motion: reduce)')
    }
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => doResize())
      resizeObserver.observe(container)
    }

    ready = true
    for (const action of pendingActions) {
      action()
    }
    pendingActions.length = 0

    // Apply the construction-time playback options now that the timeline exists and
    // the queued events (which set the log bounds the playhead clamps to) are in.
    if (options.speed !== undefined) {
      timeline.setSpeed(options.speed)
    }
    if (options.autoplay) {
      timeline.play()
    }

    rafHandle = requestAnimationFrame(frame)
  }

  /** The container's current logical size, never zero so the renderer always has a surface. */
  function containerSize(): { width: number, height: number } {
    return {
      width: Math.max(1, container.clientWidth),
      height: Math.max(1, container.clientHeight),
    }
  }

  /** Resizes the renderer and the camera viewport to the container's current size. */
  function doResize(): void {
    const { width, height } = containerSize()
    backend.resize(width, height)
    camera.setViewport(width, height)
  }

  // Kick off async init in the background; the controller is usable immediately.
  void initialize()

  return {
    ingest(events: RunewoodEvent | RunewoodEvent[]): void {
      const batch = Array.isArray(events) ? events : [ events ]
      const run = (): void => {
        for (const event of batch) {
          timeline.append(event)
        }
      }
      if (ready) {
        run()
      }
      else {
        pendingActions.push(run)
      }
    },
    seed(paths: string[]): void {
      const run = (): void => {
        // Seed dim structure onto the live tree in place: `seedTree` only adds
        // missing nodes as `seeded` and never downgrades a discovered node, which
        // is exactly the merge we want, so it shows immediately without disturbing
        // anything already lit. Record the paths on the state too, so a later
        // backward seek re-seeds them when it re-folds the tree.
        seedTree(frameState.tree, paths)
        frameState.seededPaths.push(...paths)
      }
      if (ready) {
        run()
      }
      else {
        pendingActions.push(run)
      }
    },
    play(): void {
      timeline.play()
    },
    pause(): void {
      timeline.pause()
    },
    seek(time: number): void {
      if (ready) {
        applySeek(time)
      }
      else {
        pendingActions.push(() => applySeek(time))
      }
    },
    setSpeed(multiplier: number): void {
      timeline.setSpeed(multiplier)
    },
    follow(shouldFollow: boolean): void {
      following = shouldFollow
    },
    resize(): void {
      if (ready) {
        doResize()
      }
    },
    destroy(): void {
      if (destroyed) {
        return
      }
      destroyed = true

      if (rafHandle !== null) {
        cancelAnimationFrame(rafHandle)
        rafHandle = null
      }
      resizeObserver?.disconnect()
      resizeObserver = null
      reducedMotionQuery = null

      scene?.clear()
      beamScene?.dispose()
      labelScene?.clear()
      scene = null
      beamScene = null
      labelScene = null

      // Disposing the backend destroys the pixi app, the canvas, and the bloom
      // filter; only do it once init has actually brought the backend up. If we are
      // still mid-init, the `destroyed` guard in `initialize` disposes it instead.
      if (ready) {
        backend.dispose()
      }

      springs.clear()
    },
  }
}

/** The empty log passed to the reducer on a still / no-events-crossed frame, avoiding a needless copy. */
const EMPTY_LOG: RunewoodEvent[] = []

/** How long an actor label takes to fade after its last activity, matching the actor orb's default. */
const ACTOR_LABEL_FADE_MS = 3_000

/**
 * Resolves the option's loose theme input (a built-in name, a full theme, or a
 * partial override) into a concrete {@link RunewoodTheme}. A bare name selects a
 * built-in; a full theme is used as-is; anything else is treated as an override
 * merged onto the default.
 */
function resolveTheme(input: RunewoodOptions['theme']): RunewoodTheme {
  if (input === undefined) {
    return defaultTheme
  }
  if (typeof input === 'string') {
    return themes[input] ?? defaultTheme
  }
  if (isFullTheme(input)) {
    return input
  }
  return mergeTheme(defaultTheme, input)
}

/** A full theme has every required field; an override has only some. This narrows the two apart. */
function isFullTheme(input: RunewoodTheme | RunewoodThemeOverrides): input is RunewoodTheme {
  return 'background' in input
    && 'branch' in input
    && 'label' in input
    && 'bloomIntensity' in input
    && 'glowFalloff' in input
    && typeof input.background === 'object'
    && 'h' in (input.background as object)
}
