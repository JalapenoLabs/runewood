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
import type { PickCandidate } from './core/picking'

// Core
import { Timeline } from './core/timeline'
import { computeTargets, stepSprings } from './core/layout'
import { defaultTheme, mergeTheme, themes } from './core/theme'
import { createFrameState, stepFrame } from './core/frameStep'
import { seedTree } from './core/tree'
import { Emitter } from './core/emitter'
import { nearestWithinRadius } from './core/picking'

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
   * Subscribe `handler` to a controller `event` and get back an unsubscribe
   * function. The payload type is inferred from the event name (see
   * {@link RunewoodEventMap}), so handling the wrong shape is a compile error.
   * Use this to react to playback (`play`/`pause`/`seek`/`reachedLiveEdge`) or to
   * deep-link off a click (`nodeClick`/`actorClick`).
   */
  on: <Name extends keyof RunewoodEventMap>(
    event: Name,
    handler: (payload: RunewoodEventMap[Name]) => void,
  ) => () => void
  /** Remove a handler previously registered with {@link on}. */
  off: <Name extends keyof RunewoodEventMap>(
    event: Name,
    handler: (payload: RunewoodEventMap[Name]) => void,
  ) => void
  /**
   * A snapshot of the current playback state, read from the timeline. Lets an
   * overlay (the #11 transport) or a host render controls without reaching into
   * the controller's internals.
   */
  getState: () => RunewoodPlaybackState
  /**
   * Tear everything down: stop the RAF loop, disconnect the observer and media
   * query, drop every event subscriber, dispose every scene and the backend
   * (releasing all GPU resources), and remove the canvas from the container.
   * Idempotent and leak-free.
   */
  destroy: () => void
}

/** Payload for the `seek` event: where the playhead landed, as time and fraction. */
export type RunewoodSeekPayload = {
  /** The new playhead time in epoch milliseconds. */
  time: number
  /** Fraction of the timeline elapsed at that time, `0..1`. */
  progress: number
}

/** Payload for the `nodeClick` event: the path of the node the click resolved to. */
export type RunewoodNodeClickPayload = {
  /** The clicked node's full slash-joined path, e.g. `seraphim/api/src/main.rs`. */
  path: string
}

/** Payload for the `actorClick` event: the id of the actor the click resolved to. */
export type RunewoodActorClickPayload = {
  /** The clicked actor's stable id. */
  actor: string
}

/**
 * The controller's typed event surface (issue #10): each key is an event name and
 * its value is that event's payload type. Drives {@link RunewoodController.on} /
 * {@link RunewoodController.off} so subscribing is fully type-checked.
 *
 * - `play` / `pause`: emitted from the matching methods (and from autoplay).
 * - `seek`: emitted on every seek with the resulting time + progress.
 * - `reachedLiveEdge`: emitted when the playhead catches up to the newest event
 *   while following live, so a host can light up a "live" indicator.
 * - `nodeClick` / `actorClick`: emitted when a click resolves to a node / actor.
 */
export type RunewoodEventMap = {
  play: void
  pause: void
  seek: RunewoodSeekPayload
  reachedLiveEdge: void
  nodeClick: RunewoodNodeClickPayload
  actorClick: RunewoodActorClickPayload
}

/** The snapshot {@link RunewoodController.getState} returns. */
export type RunewoodPlaybackState = {
  /** Whether the clock is currently advancing. */
  playing: boolean
  /** The current playhead time in epoch milliseconds. */
  time: number
  /** Total span of the loaded log in milliseconds (`last - first`), `0` when empty. */
  duration: number
  /** Fraction of the timeline elapsed, `0..1`. */
  progress: number
  /** The current playback rate (`1` real time, `2` double, `0.5` half). */
  speed: number
  /** Whether the playhead is pinned to the newest event (following live). */
  following: boolean
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
  /**
   * Whether the playhead starts pinned to the newest event, so live-appended
   * events drag the view to the latest activity and the `reachedLiveEdge` event
   * fires as it catches up. Defaults to `true` for a live feed; a host replaying a
   * fixed log from the start will usually pass `false`. A manual `seek` detaches
   * live-follow until the host opts back in.
   */
  followLive?: boolean
  /** Initial playback speed multiplier. Defaults to `1`. */
  speed?: number
  /** Start playing immediately on init, rather than waiting for `play()`. Defaults to `false`. */
  autoplay?: boolean
  /**
   * Force the reduced-motion behavior on (`true`) or off (`false`), overriding the
   * platform `prefers-reduced-motion` media query. Left unset, the controller
   * honors the media query (the default). A host that has its own motion toggle
   * passes the resolved value here so the library never fights it.
   */
  reducedMotion?: boolean
  /**
   * Whether node / actor labels are drawn at all. `false` suppresses the label
   * scene entirely (the LOD policy in {@link labels} only governs *which* labels
   * show when they are enabled). Defaults to `true`.
   */
  showLabels?: boolean
  /**
   * Cap on how many events the timeline retains. Older events past this many are
   * dropped on ingest so a long-running live feed does not grow without bound;
   * the retained window still folds exactly. Omit (the default) to retain every
   * event, which is what a bounded replay log wants.
   */
  maxEvents?: number
  /**
   * Click hit slop in screen pixels: how far from a node / actor a click may land
   * and still resolve to it. Converted to world units via the camera zoom at click
   * time, so the slop stays constant on screen regardless of zoom. Defaults to
   * {@link DEFAULT_HIT_RADIUS_PX}.
   */
  hitRadius?: number
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
  // The playhead position the tree was last folded to. Each frame we fold the
  // events in (lastFoldedPlayhead, timeline.time], so the tree tracks the playhead
  // however it moved: forward `play` (advance) OR a live `append` that pinned the
  // playhead to the newest event. Without this, live-follow appends move the clock
  // but never fold, leaving the canvas frozen while playback state still updates.
  let lastFoldedPlayhead = 0
  let resizeObserver: ResizeObserver | null = null
  let reducedMotionQuery: MediaQueryList | null = null
  let appliedBloom: BloomQuality | null = null

  // Work the host requested before the backend finished initializing. Replayed in
  // order on ready so "ingest immediately after construction" just works.
  const pendingActions: Array<() => void> = []

  // Whether the host wants the camera to track the active region. Honored from the
  // first frame; toggled by `follow`.
  let following = options.follow ?? true

  // The typed event surface (issue #10). Dependency-free; cleared on destroy.
  const emitter = new Emitter<RunewoodEventMap>()

  // Whether labels are drawn at all (the LOD policy still governs which show). A
  // host can suppress the whole label scene without touching the LOD knobs.
  const showLabels = options.showLabels ?? true

  // Click hit slop in screen pixels, converted to world units per click via zoom.
  const hitRadiusPx = options.hitRadius ?? DEFAULT_HIT_RADIUS_PX

  // The pointer listener, kept so destroy can detach it. Created on init once the
  // canvas exists; null before init and after teardown.
  let pointerListener: ((pointerEvent: PointerEvent) => void) | null = null

  // Whether the playhead was sitting exactly on the newest event on the previous
  // tick, so `reachedLiveEdge` fires once on the transition rather than every frame.
  let wasAtLiveEdge = false

  /**
   * Reads the effective reduced-motion preference: the explicit option override
   * when the host supplied one, otherwise the live platform media query (guarded
   * for non-browser hosts, where it is absent).
   */
  function prefersReducedMotion(): boolean {
    if (options.reducedMotion !== undefined) {
      return options.reducedMotion
    }
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

    // 1. Advance the clock when playing (forward play crosses events here), then
    //    fold the tree up to wherever the playhead now sits regardless of how it
    //    got there. Forward play moves it via `advance`; live-follow moves it via
    //    `append` (the playhead jumps to each newest event). Folding by the
    //    (lastFolded, now] interval handles both, so live events actually appear.
    timeline.advance(deltaMs)
    const now = timeline.time
    let step
    if (now < lastFoldedPlayhead) {
      // The playhead moved backward (e.g. a retention trim dropped the event it
      // sat on); re-fold from scratch to stay exact.
      step = stepFrame(frameState, { playhead: now, rebuild: true, crossed: []}, timeline.getEvents())
    }
    else {
      const crossed = timeline.crossedBetween(lastFoldedPlayhead, now)
      step = stepFrame(
        frameState,
        { playhead: now, rebuild: false, crossed },
        crossed.length > 0 ? timeline.getEvents() : EMPTY_LOG,
      )
    }
    lastFoldedPlayhead = now
    frameState = step.state

    // Fire `reachedLiveEdge` on the transition into "caught up to the newest event
    // while following live", not every frame we sit there. A host lights its live
    // indicator off this.
    emitLiveEdgeTransition()

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

    // Labels can be suppressed wholesale; when off, the scene gets an empty
    // candidate set so it tears its retained text down rather than holding stale.
    const candidates = showLabels ? buildLabelCandidates(now, activities) : EMPTY_LABELS
    labelScene.update(candidates, camera.zoom, now, theme)

    backend.endFrame()
  }

  /**
   * Emits `reachedLiveEdge` exactly when the playhead first catches up to the
   * newest event while following live. Tracking the previous-frame state means it
   * fires on the transition, not continuously while parked at the edge.
   */
  function emitLiveEdgeTransition(): void {
    const lastEventTime = timeline.lastEventTime
    const atLiveEdge = timeline.live && lastEventTime !== null && timeline.time >= lastEventTime
    if (atLiveEdge && !wasAtLiveEdge) {
      emitter.emit('reachedLiveEdge', undefined)
    }
    wasAtLiveEdge = atLiveEdge
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
    // The seek already folded the tree to the sought time, so keep the loop's
    // fold cursor in sync: without this the next tick would re-cross everything
    // between a stale cursor and the new playhead (a forward seek) or fight the
    // rebuild (a backward seek).
    lastFoldedPlayhead = timeline.time
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

    // Wire pointer hit-testing on the live canvas. The listener stays a thin shell:
    // it converts the screen point to world space via the camera and hands the pure
    // picking math the live node / actor positions; see `handlePointer`.
    const canvas = backend.canvas
    if (canvas) {
      pointerListener = (pointerEvent: PointerEvent): void => handlePointer(pointerEvent, canvas)
      canvas.addEventListener('pointerdown', pointerListener)
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
    // Live-follow defaults on: pin the playhead to the newest event so the view
    // tracks live activity. Enabling jumps to the latest event immediately.
    timeline.followLive(options.followLive ?? true)
    if (options.autoplay) {
      timeline.play()
    }

    rafHandle = requestAnimationFrame(frame)
  }

  /**
   * Resolves one pointer event to the nearest node and actor and emits
   * `nodeClick` / `actorClick`. The screen point is taken relative to the canvas
   * (so an offset / scrolled host still hits correctly), unprojected to world
   * space by the camera, and matched against the live spring positions (nodes) and
   * the actor orb centroids (actors) by the pure {@link nearestWithinRadius}. The
   * screen-pixel hit slop is divided by the live zoom so the radius is constant on
   * screen at any zoom.
   */
  function handlePointer(pointerEvent: PointerEvent, canvas: HTMLCanvasElement): void {
    const rect = canvas.getBoundingClientRect()
    const screenPoint = { x: pointerEvent.clientX - rect.left, y: pointerEvent.clientY - rect.top }
    const worldPoint = camera.screenToWorld(screenPoint)
    const worldRadius = hitRadiusPx / camera.zoom

    const nodePath = nearestWithinRadius(worldPoint, nodeCandidates(), worldRadius)
    if (nodePath !== null) {
      emitter.emit('nodeClick', { path: nodePath })
    }

    const actorId = nearestWithinRadius(worldPoint, actorCandidates(), worldRadius)
    if (actorId !== null) {
      emitter.emit('actorClick', { actor: actorId })
    }
  }

  /** The live node pick candidates: every spring-tracked node at its drawn position. */
  function nodeCandidates(): PickCandidate[] {
    const candidates: PickCandidate[] = []
    for (const [ path, physics ] of springs) {
      candidates.push({ id: path, position: physics.position })
    }
    return candidates
  }

  /** The live actor pick candidates: each tracked actor at the centroid of its touched files. */
  function actorCandidates(): PickCandidate[] {
    const candidates: PickCandidate[] = []
    for (const track of frameState.actors.values()) {
      const position = track.touchedPaths.length > 0
        ? centroidOfPaths(track.touchedPaths)
        : track.lastCentroid
      if (position) {
        candidates.push({ id: track.actor, position })
      }
    }
    return candidates
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
        // Bound a long-running live feed: drop history beyond the retention cap
        // after appending so the log never grows without limit. A no-op when the
        // host left `maxEvents` unset.
        if (options.maxEvents !== undefined) {
          timeline.trimToCount(options.maxEvents)
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
      emitter.emit('play', undefined)
    },
    pause(): void {
      timeline.pause()
      emitter.emit('pause', undefined)
    },
    seek(time: number): void {
      if (ready) {
        applySeek(time)
      }
      else {
        pendingActions.push(() => applySeek(time))
      }
      // Emit the resulting playhead + progress regardless of ready state: before
      // init the timeline still clamps and reports the sought time, so a host's
      // scrubber stays in sync from the very first interaction.
      emitter.emit('seek', { time: timeline.time, progress: timeline.progress() })
    },
    setSpeed(multiplier: number): void {
      timeline.setSpeed(multiplier)
    },
    follow(shouldFollow: boolean): void {
      following = shouldFollow
    },
    on(event, handler) {
      return emitter.on(event, handler)
    },
    off(event, handler) {
      emitter.off(event, handler)
    },
    getState(): RunewoodPlaybackState {
      return {
        playing: timeline.playing,
        time: timeline.time,
        duration: timeline.duration(),
        progress: timeline.progress(),
        speed: timeline.speed,
        following: timeline.live,
      }
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

      // Detach the pointer listener before the backend (and its canvas) go away,
      // and drop every event subscriber so the controller leaves nothing behind.
      const canvas = backend.canvas
      if (pointerListener && canvas) {
        canvas.removeEventListener('pointerdown', pointerListener)
      }
      pointerListener = null
      emitter.clear()

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

/** The empty candidate set handed to the label scene when labels are suppressed. */
const EMPTY_LABELS: LabelCandidate[] = []

/** How long an actor label takes to fade after its last activity, matching the actor orb's default. */
const ACTOR_LABEL_FADE_MS = 3_000

/**
 * Default click hit slop in screen pixels: how far from a node / actor a click may
 * land and still resolve to it. A few pixels of forgiveness so tapping near a
 * small node still selects it, without grabbing unrelated neighbors.
 */
const DEFAULT_HIT_RADIUS_PX = 16

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
