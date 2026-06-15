// Copyright © 2026 Jalapeno Labs

import type { RunewoodEvent } from './types'
import type { Vec2, NodePhysics, LayoutOptions, SpringParams } from './core/layout'
import type { ForceLayoutOptions } from './core/physics'
import type { RunewoodTheme, RunewoodThemeOverrides } from './core/theme'
import type { WorldBounds } from './render/camera'
import type { FrameState, BeamSpawnRequest, PulseSpawnRequest } from './core/frameStep'
import type { ActorActivity, ActorVisualOptions } from './render/actors'
import type { LabelCandidate } from './render/labels'
import type { BloomQuality } from './render/bloom'
import type { SceneOptions } from './render/scene'
import type { BeamSceneOptions } from './render/beamScene'
import type { LabelLodOptions } from './render/labels'
import type { Scene } from './render/scene'
import type { BeamScene } from './render/beamScene'
import type { LabelScene } from './render/labelScene'
import type { PickCandidate } from './core/picking'
import type { PathFilter } from './core/filter'
import type { VisibleNode } from './core/collapse'
import type { CameraMode, RecentNodeSample, RecentActorSample } from './render/cameraMode'
import type { Hsl } from './core/theme'

// Core
import { Timeline } from './core/timeline'
import { HighlightRegistry } from './core/highlight'
import { ForceLayout } from './core/physics'
import { collapseTree } from './core/collapse'
import { defaultTheme, mergeTheme, themes } from './core/theme'
import { createFrameState, stepFrame } from './core/frameStep'
import { seedTree } from './core/tree'
import { Emitter } from './core/emitter'
import { nearestWithinRadius } from './core/picking'
import { compilePathFilter } from './core/filter'

// Render
import { Camera, autoFrame } from './render/camera'
import { recentActivityBounds, isAutoCameraMode } from './render/cameraMode'
import { resolveBloomQuality } from './render/bloom'
import { PixiBackend } from './render/pixiBackend'
import { actorVisualFor } from './render/actors'

/**
 * The public, imperative controller for a Runewood visualization (issue #9). This
 * is the single entry point a host uses: it wires the timeline, the pure tree
 * fold, the force-directed layout sim, the camera, and the pixi renderer together
 * and owns the one `requestAnimationFrame` loop that drives them. It is the *only*
 * module allowed to read the wall clock and call `requestAnimationFrame`; everything
 * below it stays pure and time-injected (the playhead time flows down, never the
 * wall clock) EXCEPT the layout sim, which is deliberately forward-only visual state
 * (it re-settles on a rewind rather than reproducing exact prior positions).
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
   * tree exactly (the data fold stays seek-exact) and clears transient particles; a
   * forward jump replays the crossed events' effects. Note the LAYOUT is no longer
   * frame-exact across a backward jump: the force-directed sim is reset and re-settles
   * from fresh spawns on the rebuilt tree, so node positions after a rewind are
   * organically re-derived rather than pixel-identical to before. This is the accepted
   * tradeoff for the continuously-alive, Gource-style physics.
   */
  seek: (time: number) => void
  /** Set the playback rate. `1` is real time, `2` double speed, `0.5` half. */
  setSpeed: (multiplier: number) => void
  /**
   * Choose how the camera frames the forest: `overview` (ease to fit the whole
   * active tree), `follow` (the Gource-style camera: ease to the recently-active
   * region at a closer zoom and travel with the action), or `manual` (leave the
   * view under the user's drag / wheel control). Selecting `overview` or `follow`
   * re-engages auto control; a manual pan / zoom flips the mode to `manual` on its
   * own so the chosen view sticks. The current mode is exposed on
   * {@link RunewoodController.getState}.
   */
  setCameraMode: (mode: CameraMode) => void
  /**
   * Backwards-compatible shim for the old boolean follow toggle: `follow(true)`
   * re-engages the `follow` camera, `follow(false)` switches to `manual` (free
   * view). New code should prefer {@link RunewoodController.setCameraMode}.
   */
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
   * Light up a SET of nodes with a breathing "watch this" glow that persists until
   * the host clears it (issue #180). Unlike the event-driven touch flash, a
   * highlight is a LIVE overlay: its pulse runs on wall/frame time (not the
   * playhead), so it keeps breathing while playback is paused or being scrubbed,
   * and it survives a seek untouched. The canonical use is Seraphim's watch page
   * lighting every file a pull request touched while its CI runs, then clearing
   * them when CI finishes.
   *
   * Returns a {@link RunewoodHighlight} handle so the host can grow / shrink the set
   * as work progresses (`update`) or drop it (`clear`). Pass an `id` to address a
   * specific group later (re-using an id replaces that group); omit it for a fresh
   * generated id. The default color is a sensible attention amber.
   *
   * Overlaps resolve most-recently-added-wins: a node lit by two groups shows the
   * newer group's color. Call {@link clearHighlights} to drop every group at once.
   */
  highlight: (paths: string[], options?: HighlightOptions) => RunewoodHighlight
  /** Drop every active highlight group at once (e.g. all CI runs finished). */
  clearHighlights: () => void
  /**
   * Tear everything down: stop the RAF loop, disconnect the observer and media
   * query, drop every event subscriber, dispose every scene and the backend
   * (releasing all GPU resources), and remove the canvas from the container.
   * Idempotent and leak-free.
   */
  destroy: () => void
}

/**
 * Options for {@link RunewoodController.highlight}. Both fields are optional: the
 * color defaults to a sensible attention amber, and an omitted id gets a fresh
 * generated one. Passing an existing id replaces that group in place.
 */
export type HighlightOptions = {
  /** The ring color for this group's nodes. Defaults to {@link DEFAULT_HIGHLIGHT_COLOR} (amber). */
  color?: Hsl
  /**
   * A stable id for the group, so the host can update or clear exactly this set
   * later (e.g. one id per pull request). Re-using an id replaces that group's
   * paths + color. Omit it to get a fresh generated id back on the handle.
   */
  id?: string
}

/**
 * The handle {@link RunewoodController.highlight} returns: a small remote for one
 * live highlight group. The host keeps it to drive the group as work progresses
 * (`update` the set of lit paths, e.g. adding a newly-touched file as CI advances)
 * and to remove it when done (`clear`, e.g. CI finished). `id` is the group's
 * resolved id (the one passed in, or the generated one).
 */
export type RunewoodHighlight = {
  /** The group's resolved id, stable for its lifetime. */
  id: string
  /** Replace the set of lit paths for this group, keeping its color. The per-file progressive update. */
  update: (paths: string[]) => void
  /** Remove this group's highlight. Idempotent; a second call is a harmless no-op. */
  clear: () => void
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
 * Payload for the `nodeHover` event: the node the cursor is currently over, with
 * the live screen-pixel position to anchor a host tooltip, or `null` once the
 * cursor leaves every node. Emitted only on a change (enter, move to a different
 * node, or leave), never every frame, so a host can drive a tooltip cheaply.
 */
export type RunewoodNodeHoverPayload = {
  /** The hovered node's full slash-joined path, e.g. `seraphim/api/src/main.rs`. */
  path: string
  /** The cursor position in canvas-relative screen pixels, for positioning a tooltip. */
  screen: { x: number, y: number }
} | null

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
 * - `nodeHover`: emitted when the hovered node changes (enter / move-to-different /
 *   leave); the payload carries the node path + cursor screen point, or `null` on
 *   leave. A host drives a tooltip off this; the library stays framework-agnostic.
 */
export type RunewoodEventMap = {
  play: void
  pause: void
  seek: RunewoodSeekPayload
  reachedLiveEdge: void
  nodeClick: RunewoodNodeClickPayload
  actorClick: RunewoodActorClickPayload
  nodeHover: RunewoodNodeHoverPayload
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
  /** The active camera mode, so a host overlay can reflect overview / follow / manual. */
  cameraMode: CameraMode
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
   * downgrade at runtime (see {@link resolveBloomQuality}). Defaults to `off`: the
   * cheap per-node soft-glow sprite carries the glow, and skipping the heavy
   * `AdvancedBloomFilter` is much faster. Set `low` / `high` to opt back into the
   * cinematic screen-space bloom pass on top of the per-node glow.
   */
  bloom?: BloomQuality
  /**
   * How the camera frames the forest from the first frame (issue #180): `overview`
   * eases to fit the whole active tree, `follow` is the Gource-style camera that
   * tracks the recently-active region at a closer zoom, and `manual` leaves the
   * view under user control. Defaults to `follow`. A manual pan / wheel-zoom flips
   * the live mode to `manual`; `setCameraMode` re-engages an auto mode.
   */
  cameraMode?: CameraMode
  /**
   * @deprecated Use {@link cameraMode}. Backwards-compatible boolean follow toggle:
   * `true` selects the `follow` camera, `false` selects `manual`. Ignored when
   * {@link cameraMode} is also supplied. Left unset, the default is the `follow`
   * camera.
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
  /**
   * When set, the forest root (`path: ''`) becomes a VISIBLE node at the center
   * labeled with this string, and every top-level repo branches off it (an edge
   * root -> repo), so the whole forest reads as one connected tree growing outward
   * from a single trunk rather than a ring of separate radial fans. When unset (the
   * default) there is no root node and the repo roots fan around the undrawn center,
   * exactly the original behavior. Seraphim integration (#180) passes the workspace
   * name here (e.g. the org or "workspace").
   */
  rootLabel?: string
  /**
   * How long an actor lingers parked at its last node before it fades, in
   * milliseconds (Part C, the lingering knob). An LLM agent edits a file then often
   * pauses before the next edit; with a long linger the actor STAYS at its last node
   * (gently idle-pulsing) across that gap instead of dissolving after a few seconds.
   * Defaults to a very long window (effectively "stays for the whole session"); set
   * it shorter to make a quiet contributor dissolve sooner. Seraphim integration
   * (#180) should leave it long for a live agent feed. Forwarded to the actor visual
   * model as its `lingerMs`; finer actor tuning (idle-pulse depth, fade) is available
   * via {@link beams}`.actors`.
   */
  actorLingerMs?: number
  /**
   * Tuning for the continuous force-directed layout: spring rest length + stiffness, the
   * sibling-count ring widening, the gentle outward bias, the gentle untangle force (the fan
   * spreading + anti-foldback that coaxes branches into tidy fans), size-aware collision
   * (stiffness, margin, the per-kind collision radii), damping, and the integration-step clamp.
   * These are the knobs that make the forest feel livelier or calmer and control overlap. See
   * {@link ForceLayoutOptions}.
   */
  physics?: ForceLayoutOptions
  /**
   * @deprecated The radial tidy-tree was replaced by the force-directed sim
   * ({@link physics}). Only its `center` is still honored, as the sim's center / root
   * pin. Every other field is ignored.
   */
  layout?: LayoutOptions
  /**
   * @deprecated The damped springs were replaced by the force-directed sim
   * ({@link physics}). This field is ignored; use {@link physics} instead.
   */
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
  /**
   * Whitelist globs for forest paths. When non-empty, only events / seed paths
   * matching at least one pattern are kept; an exclude still subtracts from the
   * survivors. Empty / omitted (the default) means "every path is a candidate".
   * Supports `**`, `*`, `?`, and `{a,b}` alternation; see {@link compilePathFilter}.
   *
   * Filtering is **construction-time** for v1: the predicate is compiled once
   * here and applied at ingest and seed. To change it, rebuild the controller.
   */
  include?: string[]
  /**
   * Blacklist globs for forest paths, the common case: omit noise like
   * `**\/node_modules/**`, `**\/__pycache__/**`, `**\/.git/**`, `**\/dist/**`.
   * A path matching any exclude is dropped even if it also matched an include
   * (exclude wins). Pathless `pulse` events are actor-level and always kept.
   * Construction-time, same as {@link include}.
   */
  exclude?: string[]
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
 * How far back in playhead time (ms) a node / actor counts as "recently active"
 * for the `follow` camera. A few seconds keeps the framed region centered on
 * where work is happening *now* and lets the camera travel as activity moves,
 * rather than fitting the whole history. Comfortably wider than the actor recency
 * window so an actor's just-touched files are still in frame when it is.
 */
const FOLLOW_ACTIVITY_WINDOW_MS = 5_000

/**
 * World-space padding around the `follow` camera's recent region. Larger than the
 * overview padding so a single hot file is framed at a moderate, readable zoom
 * (Gource-style) instead of filling the screen.
 */
const FOLLOW_REGION_PADDING = 240

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
  // Bloom defaults OFF: the cheap per-node soft-glow sprite (see the forest scene)
  // now carries the glowing-forest look, and running without the heavy
  // `AdvancedBloomFilter` is markedly faster. `high`/`low` remain an opt-in
  // cinematic post-process (screen-space, so it no longer clips to a growing box).
  const requestedBloom: BloomQuality = options.bloom ?? 'off'
  const lowPower = options.lowPower ?? false

  // The pure / logical state, all owned here and threaded through the reducer.
  const timeline = new Timeline()
  const camera = new Camera()
  let frameState: FrameState = createFrameState()

  // The continuous, Gource-style force-directed layout (replacing the old radial
  // targets + springs). It OWNS a live `{ position, velocity }` per visible node and
  // evolves them under edge springs, sibling repulsion, and damping EVERY frame, so
  // the forest is always gently reacting and settling instead of springing to fixed
  // targets and then freezing. Unlike the old targets, these positions are NOT a pure
  // function of the tree: that is the accepted tradeoff for the always-alive feel, so
  // a backward seek re-folds the (pure) tree and lets the sim re-settle rather than
  // reproducing pixel-exact prior positions. The scene/labels/beams/camera read
  // positions straight off `physics.state`, exactly where they read the old springs.
  const physics = new ForceLayout(resolvePhysicsOptions(options))

  // The sim's live body map, held as a stable binding the helper functions read from
  // (the scene/labels/beams/camera/picking) so they need no awareness of the sim
  // object. `physics.state` returns the same Map by reference for the controller's
  // whole life, so this is captured once and never re-pointed.
  const bodies: Map<string, NodePhysics> = physics.state

  // Whether the tree structure changed since the sim was last synced. The sim only
  // needs re-syncing (bodies added/removed) when a node was added or removed; the
  // `step` runs every frame regardless. Starts true so the first frame syncs the
  // (possibly seeded) forest. Set by a step that added a node, a seed, or a rebuild.
  let structureStale = true

  // The display-collapse of the tree, keyed by real node path, memoized on the same
  // structure-changed signal as the physics sync. It records which nodes are visible
  // (collapsed pass-through directories are skipped), each visible node's nearest
  // visible ancestor (so an edge spans a collapsed chain in one hop), and its visible
  // depth. The scene, the label builder, and the physics sync all read it so they
  // agree on exactly what is drawn. Recomputed only when the structure changes, since
  // it is a pure function of the tree's shape.
  let visibleByPath = new Map<string, VisibleNode>()

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

  // How the camera frames the forest (issue #180): `overview` fits the whole tree,
  // `follow` tracks the recently-active region (Gource-style), `manual` leaves the
  // view to the user. Honored from the first frame; switched by `setCameraMode`,
  // by the deprecated `follow` shim, and flipped to `manual` by a manual pan / zoom.
  // The default is `follow`; the legacy `follow` boolean option still maps (true ->
  // follow, false -> manual) when `cameraMode` is not given.
  let cameraMode: CameraMode = resolveInitialCameraMode(options)

  // The last bounds the `follow` camera framed, held so a quiet stretch (nothing
  // recently active) gently keeps the current view instead of snapping to origin.
  let lastFollowBounds: WorldBounds | null = null

  // The typed event surface (issue #10). Dependency-free; cleared on destroy.
  const emitter = new Emitter<RunewoodEventMap>()

  // The live "watch this" highlight overlay (issue #180): the set of highlight
  // groups a host registered (e.g. a PR's files while CI runs). It is a "now"
  // concern, deliberately OUTSIDE the replayable fold, so it persists across
  // pause/seek and animates on the wall clock below, never the playhead. Cleared on
  // destroy.
  const highlights = new HighlightRegistry()

  // The wall/frame animation clock for the highlights, accumulated from each frame's
  // real `deltaMs`. It is kept entirely separate from the playhead (`timeline.time`)
  // so a highlighted node keeps breathing even while playback is paused or being
  // scrubbed: a seek moves the playhead, this clock only ever moves forward by real
  // elapsed time. A monotonically rising counter is all the pure pulse needs.
  let highlightClockMs = 0

  // Counter for generated highlight-group ids, so a host that omits an id still gets
  // a stable, unique one back on the handle.
  let nextHighlightId = 0

  // Whether labels are drawn at all (the LOD policy still governs which show). A
  // host can suppress the whole label scene without touching the LOD knobs.
  const showLabels = options.showLabels ?? true

  // Whether the forest root is a drawn center node (Part A): set when the host
  // configured a `rootLabel`, so every repo branches off one shared trunk. A blank
  // / unset label leaves it off (the original ring-of-fans). Computed once: the
  // label text never changes over the controller's life.
  const rootLabel = options.rootLabel?.trim()
  const rootVisible = !!rootLabel

  // The resolved actor visual options (the lingering knob folded in), held so the
  // controller can compute an actor label's presence from the very same model the
  // orb uses, keeping the label exactly as present as its orb through the linger and
  // idle pulse. The beam scene is constructed from the same resolved options.
  const actorVisualOptions: ActorVisualOptions = resolveBeamSceneOptions(options).actors ?? {}

  // Click hit slop in screen pixels, converted to world units per click via zoom.
  const hitRadiusPx = options.hitRadius ?? DEFAULT_HIT_RADIUS_PX

  // Construction-time path filter (issue #180): compiled once from the include /
  // exclude globs and applied at ingest and seed. Pathless `pulse` events bypass
  // it (no path to filter); see `ingest`. A trivially-keep-all predicate when the
  // host configured neither list.
  const pathFilter: PathFilter = compilePathFilter({ include: options.include, exclude: options.exclude })

  // The canvas pointer + wheel listeners, kept so destroy can detach every one.
  // Created on init once the canvas exists; null before init and after teardown.
  let pointerDownListener: ((pointerEvent: PointerEvent) => void) | null = null
  let pointerMoveListener: ((pointerEvent: PointerEvent) => void) | null = null
  let pointerUpListener: ((pointerEvent: PointerEvent) => void) | null = null
  let pointerLeaveListener: ((pointerEvent: PointerEvent) => void) | null = null
  let wheelListener: ((wheelEvent: WheelEvent) => void) | null = null

  // Drag tracking: a press starts a potential drag; we pan on each move and only
  // treat the gesture as a click on release if the pointer barely moved (so a drag
  // to pan never deep-links). `dragOrigin` is the press point (canvas-relative),
  // `dragLast` the previous move point we panned from, `dragExceededThreshold`
  // latches once the movement crosses `CLICK_DRAG_THRESHOLD_PX`.
  let dragOrigin: { x: number, y: number } | null = null
  let dragLast: { x: number, y: number } | null = null
  let dragExceededThreshold = false

  // The path of the node the cursor currently hovers, so `nodeHover` fires only on
  // a change (enter / move-to-different / leave) rather than every pointer move.
  let hoveredPath: string | null = null

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

    // Advance the highlights' wall/frame animation clock by the real elapsed time,
    // unconditionally. It is independent of the playhead, so the highlight rings
    // breathe at a steady real-time cadence whether playback is playing, paused, or
    // being scrubbed; only this clock (never `timeline.time`) drives their pulse.
    highlightClockMs += deltaMs

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
    // A step that added a node (or re-folded the tree) changes which nodes are
    // visible, so the sim must be re-synced (bodies added/removed) and the
    // display-collapse rebuilt; otherwise the structure is unchanged and both stand.
    if (step.structureChanged) {
      structureStale = true
    }

    // Fire `reachedLiveEdge` on the transition into "caught up to the newest event
    // while following live", not every frame we sit there. A host lights its live
    // indicator off this.
    emitLiveEdgeTransition()

    // A backward seek landed since the last tick only via `seek()`, which handles
    // its own rebuild; a forward advance never rebuilds, so `step.clearParticles`
    // is false here. The clear-on-rewind path lives in `applySeek`.

    // 2. Spawn this tick's beams / pulses into the transient particle field.
    spawnEffects(step.beams, step.pulses)

    // 3. Sync the force sim's bodies to the current visible set, but only when the
    //    structure changed this step (a node was added/removed, a rebuild, or a
    //    seed): the display-collapse is a pure function of the tree's shape, so
    //    re-walking it every frame is pure waste once the structure is stable. The
    //    sim's `step` below runs every frame regardless, which is what keeps the
    //    forest continuously alive even when nothing structural happened.
    if (structureStale) {
      // A configured `rootLabel` makes the forest root a drawn center node every
      // repo branches off of (one connected tree), so both the sim and the display-
      // collapse must agree the root is visible (and pinned at the center). Without
      // it, the root stays undrawn and the repos fan around the center, as before.
      const visibleNodes = collapseTree(frameState.tree, { rootVisible })
      // Rebuild the display-collapse, keyed by real path, so the scene, the label
      // builder, and the sim all resolve each drawn node's visible ancestor and
      // depth from one shared, in-lockstep view of the structure.
      visibleByPath = new Map(visibleNodes.map((visible) => [ visible.node.path, visible ]))
      // Add bodies for newly-visible nodes (spawned off their parent) and drop bodies
      // for nodes no longer visible. The forest root, when shown, is pinned here.
      physics.sync(visibleNodes)
      structureStale = false
    }
    // Advance the simulation EVERY frame so it is always settling: residual velocity
    // keeps easing and a recent node's disturbance keeps propagating out. Under
    // reduced motion the sim still runs (so positions stay correct) but is stepped at
    // a faster effective rate so it settles almost immediately with little visible
    // glide; otherwise it steps by the real elapsed time.
    const physicsDeltaMs = prefersReducedMotion() ? deltaMs * REDUCED_MOTION_STEP_SCALE : deltaMs
    physics.step(physicsDeltaMs)

    // 4. Frame the forest per the camera mode. `overview` fits the whole active
    //    tree; `follow` (Gource-style) frames only the recently-active region at a
    //    closer zoom and travels with the action; `manual` leaves the camera under
    //    user control and frames nothing. Under reduced motion we snap straight to
    //    the framed transform (no glide) so the camera still tracks the action but
    //    does not animate; otherwise we ease toward it framerate-independently.
    if (isAutoCameraMode(cameraMode)) {
      const bounds = cameraMode === 'follow' ? followRegionBounds(now) : activeRegionBounds(bodies)
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
    // Thread the live camera zoom into the scenes so they can floor on-screen sizes
    // (branch thickness, actor orbs, actor labels) and keep them visible no matter
    // how far the camera has pulled out. `snapshot.zoom` is the same value the
    // backend was just handed, so the floors track exactly what is on screen.
    const zoom = snapshot.zoom
    // Thread the live highlight overlay + its own wall-clock animation time into the
    // scene so highlighted nodes draw a breathing ring that animates independently of
    // the playhead. `highlights` is passed even when empty (the scene cheaply skips
    // the ring work then); `highlightClockMs` is the wall clock accumulated above.
    scene.update(frameState.tree, bodies, now, theme, zoom, visibleByPath, highlights, highlightClockMs)

    const activities = buildActorActivities()
    // The beams resolve their endpoints live every frame: the source from the firing
    // actor's orb (held inside the beam scene) and the target from the node's live
    // physics position, looked up by path here so a beam follows the node as the sim
    // migrates it. A path with no body (rewound / collapsed away, or not yet spawned)
    // returns null, ending that beam gracefully. The orb glide + opacity ramp is driven
    // by the real frame `deltaMs`, like the node sim's step.
    const nodePosition = (path: string): Vec2 | null => bodies.get(path)?.position ?? null
    beamScene.update(activities, now, deltaMs, nodePosition, theme, zoom)

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

  /**
   * Spawns the reducer's beams / pulses as LIVE references, not frozen coordinates:
   * a beam carries its target node's path (the beam scene resolves both endpoints
   * live every frame, the source from the firing actor's orb and the target from the
   * node's live position), and a pulse carries just its actor. The old centroid source
   * and spawn-time target position are gone (they were the "beam points at the middle /
   * misses the node" bug): the centroid averaged to the screen center, and the frozen
   * target pointed at where a freshly-spawned node briefly was before it migrated out.
   *
   * A beam is spawned even if its target node has no physics body yet (it was added
   * this same frame): the live resolver simply draws nothing until the body appears,
   * rather than the beam pointing at the origin, and the file still lights up via its
   * node flash in the meantime.
   */
  function spawnEffects(beams: BeamSpawnRequest[], pulses: PulseSpawnRequest[]): void {
    if (!beamScene) {
      return
    }
    for (const beam of beams) {
      beamScene.spawn({ at: beam.at, actor: beam.actor, action: beam.action, targetPath: beam.path })
    }
    for (const pulse of pulses) {
      beamScene.spawnPulse({ at: pulse.at, actor: pulse.actor, action: pulse.action })
    }
  }

  /** Mean of the live physics positions of a set of paths; the origin if none are tracked yet. */
  function centroidOfPaths(paths: string[]): Vec2 {
    let sumX = 0
    let sumY = 0
    let count = 0
    for (const path of paths) {
      const body = bodies.get(path)
      if (body) {
        sumX += body.position.x
        sumY += body.position.y
        count += 1
      }
    }
    if (count === 0) {
      return { x: 0, y: 0 }
    }
    return { x: sumX / count, y: sumY / count }
  }

  /** Turns the reducer's actor tracking into drawable activity, resolving paths to physics positions. */
  function buildActorActivities(): ActorActivity[] {
    const activities: ActorActivity[] = []
    for (const track of frameState.actors.values()) {
      const touched: Vec2[] = []
      for (const path of track.touchedPaths) {
        const body = bodies.get(path)
        if (body) {
          touched.push(body.position)
        }
      }
      const lastCentroid = touched.length > 0 ? centroidOfPaths(track.touchedPaths) : track.lastCentroid
      // Remember where the actor last worked so it stays parked there as it fades.
      if (touched.length > 0) {
        track.lastCentroid = lastCentroid
      }
      // Resolve the actor's most-recently-touched file to its live physics position
      // so the orb can anchor on where the work is *now* (out at the leaves), not
      // the centroid of everything it has touched. Undefined until the path has a
      // body, or once the actor has gone quiet (the window cleared it).
      const recent = track.recentPath ? bodies.get(track.recentPath)?.position : undefined
      activities.push({
        actor: track.actor,
        touched,
        recent,
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

    // The shared center node (Part A): when a `rootLabel` is configured, the forest
    // root is drawn at the center and gets an always-visible, constant-screen-size
    // label, like a repo root. Its physics body is keyed by the empty path.
    if (rootVisible && rootLabel) {
      const rootBody = bodies.get('')
      if (rootBody) {
        candidates.push({ kind: 'root', id: '', text: rootLabel, position: rootBody.position })
      }
    }

    const stack = [ frameState.tree ]
    while (stack.length > 0) {
      const node = stack.pop()!
      for (const child of node.children.values()) {
        stack.push(child)
      }
      if (!node.path) {
        continue
      }
      const body = bodies.get(node.path)
      if (!body) {
        continue
      }
      // Only nodes that survived the display-collapse get a label: a collapsed
      // pass-through directory has no node, position, or label. It also has no
      // physics body (it is never synced), so this is belt-and-suspenders, but it
      // keeps the label set exactly aligned with what the scene draws.
      if (!visibleByPath.has(node.path)) {
        continue
      }
      // A repo root is a depth-1 directory (no slash in its path); everything else
      // that is a file gets a file label.
      const isRepoRoot = !node.path.includes('/') && !node.isFile
      if (isRepoRoot) {
        candidates.push({ kind: 'root', id: node.path, text: node.name, position: body.position })
      }
      else if (node.isFile) {
        candidates.push({
          kind: 'file',
          id: node.path,
          text: node.name,
          position: body.position,
          lastTouchedAt: node.lastTouchedAt ?? undefined,
        })
      }
    }

    for (const activity of activities) {
      // The actor label rides EXACTLY on its orb: anchor it on the orb's live eased
      // drawn position (read straight off the beam scene's retained motion, the same
      // position the orb is drawn at this frame), so the label sits on the orb instead
      // of drifting off to the touched-files centroid the orb has glided away from.
      // Before the orb has a live motion (its very first frame, or while fully faded)
      // fall back to the placement model's target so the label still has a sensible
      // anchor for that one frame.
      const orbPosition = beamScene?.actorOrbPosition(activity.actor)
        ?? actorVisualFor(activity, now, actorVisualOptions).position
      candidates.push({
        kind: 'actor',
        id: activity.actor,
        text: activity.actor,
        position: orbPosition,
        // Drive the label's presence from the very same actor visual model the orb
        // uses (lingering fade + idle breath), so the label lingers and breathes in
        // exact lockstep with its orb rather than fading on its own short timer.
        actorAlpha: actorVisualFor(activity, now, actorVisualOptions).alpha,
      })
    }

    return candidates
  }

  /**
   * The world bounds enclosing the active region, derived from the live physics
   * positions. With the force sim there are no separate canonical targets to frame,
   * so the camera frames where the nodes actually are; since the sim is always gently
   * settling the framing is stable rather than jittery. Padded so glowing nodes near
   * the edge are not clipped, and falls back to a sensible window when empty.
   */
  function activeRegionBounds(bodies: Map<string, NodePhysics>): WorldBounds {
    if (bodies.size === 0) {
      return {
        min: { x: -EMPTY_REGION_HALF_EXTENT, y: -EMPTY_REGION_HALF_EXTENT },
        max: { x: EMPTY_REGION_HALF_EXTENT, y: EMPTY_REGION_HALF_EXTENT },
      }
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const { position } of bodies.values()) {
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

  /**
   * The world bounds the `follow` camera should frame at playhead time `now`: the
   * Gource-style recently-active region. It collects the live spring position of
   * every node touched within the recency window (paired with the tree's
   * `lastTouchedAt`) plus every actor active within it, then defers to the pure
   * {@link recentActivityBounds} to pad and box them. When nothing is recently
   * active it returns the last framing (held on `lastFollowBounds`, or a sensible
   * window before the first frame) so the camera gently holds rather than snapping
   * to the origin. The chosen region is remembered for that hold.
   */
  function followRegionBounds(now: number): WorldBounds {
    const nodes = recentNodeSamples()
    const actors = recentActorSamples()
    const fallback = lastFollowBounds ?? activeRegionBounds(physics.state)
    const bounds = recentActivityBounds(nodes, actors, {
      playhead: now,
      windowMs: FOLLOW_ACTIVITY_WINDOW_MS,
      padding: FOLLOW_REGION_PADDING,
      fallback,
    })
    lastFollowBounds = bounds
    return bounds
  }

  /**
   * The follow camera's node samples, gathered in a single walk of the folded tree:
   * each node's live spring position paired with its `lastTouchedAt`, so the pure
   * bounds function can window by recency. Walking the tree (rather than iterating
   * the bodies and looking each path up) reads the touch time straight off the
   * node we already hold. A node with no physics body yet is skipped (it has no
   * drawn position); one never touched carries a `null` time and the window drops it.
   */
  function recentNodeSamples(): RecentNodeSample[] {
    const samples: RecentNodeSample[] = []
    const stack = [ frameState.tree ]
    while (stack.length > 0) {
      const node = stack.pop()!
      for (const child of node.children.values()) {
        stack.push(child)
      }
      if (!node.path) {
        continue
      }
      const body = bodies.get(node.path)
      if (!body) {
        continue
      }
      samples.push({ position: body.position, lastTouchedAt: node.lastTouchedAt })
    }
    return samples
  }

  /**
   * The follow camera's actor samples: each tracked actor at the centroid of the
   * files it is touching (or its parked last-centroid while fading), paired with
   * its `lastActiveAt`. Active actors keep the camera on the worker even if the one
   * file it just touched has already aged out of the node window.
   */
  function recentActorSamples(): RecentActorSample[] {
    const samples: RecentActorSample[] = []
    for (const track of frameState.actors.values()) {
      const position = track.touchedPaths.length > 0
        ? centroidOfPaths(track.touchedPaths)
        : track.lastCentroid
      if (position) {
        samples.push({ position, lastActiveAt: track.lastActiveAt })
      }
    }
    return samples
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
    // A seek that changed the structure (a backward re-fold always does, a forward
    // seek does when it crosses new nodes) leaves the display-collapse stale, so the
    // next tick re-syncs the sim and rebuilds the collapse from the sought tree.
    if (step.structureChanged) {
      structureStale = true
    }
    // A backward-seek REBUILD re-folds the tree to a different shape, so the sim's
    // bodies (carrying positions for the old, now-rewound forest) no longer match.
    // Drop them all and let the next tick's `sync` re-spawn the rebuilt visible set,
    // which re-settles into place. This is the accepted tradeoff: the DATA fold stays
    // exact (the tree is re-folded deterministically), but the LAYOUT positions
    // re-settle from fresh spawns rather than reproducing the prior pixel-exact frame.
    if (seekResult.rebuild) {
      physics.reset()
    }
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
    // Fold the top-level `actorLingerMs` knob (Part C) into the beam scene's actor
    // options, while leaving any finer per-actor tuning the host passed via
    // `beams.actors` intact. An explicit `beams.actors.lingerMs` wins, since it is
    // the more specific surface.
    beamScene = backend.createBeamScene(resolveBeamSceneOptions(options))
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

    // Wire pointer interaction on the live canvas. Every listener stays a thin
    // shell: it computes the canvas-relative screen point and defers the real work
    // to the pure pieces (the camera's pan / zoom / unproject math and the pure
    // `nearestWithinRadius`). Down/move/up implement drag-to-pan with a click-vs-
    // drag threshold; move also drives the hover hit-test; wheel zooms anchored at
    // the cursor. See `handlePointerDown` / `handlePointerMove` / etc.
    const canvas = backend.canvas
    if (canvas) {
      pointerDownListener = (pointerEvent: PointerEvent): void => handlePointerDown(pointerEvent, canvas)
      pointerMoveListener = (pointerEvent: PointerEvent): void => handlePointerMove(pointerEvent, canvas)
      pointerUpListener = (pointerEvent: PointerEvent): void => handlePointerUp(pointerEvent, canvas)
      pointerLeaveListener = (): void => handlePointerLeave()
      wheelListener = (wheelEvent: WheelEvent): void => handleWheel(wheelEvent, canvas)

      canvas.addEventListener('pointerdown', pointerDownListener)
      canvas.addEventListener('pointermove', pointerMoveListener)
      canvas.addEventListener('pointerup', pointerUpListener)
      canvas.addEventListener('pointerleave', pointerLeaveListener)
      // `passive: false` so we can `preventDefault` and stop the page scrolling
      // when the user zooms the forest with the wheel.
      canvas.addEventListener('wheel', wheelListener, { passive: false })
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

  /** The pointer position relative to the canvas top-left, in CSS pixels. */
  function screenPointOf(pointerEvent: PointerEvent | WheelEvent, canvas: HTMLCanvasElement): { x: number, y: number } {
    const rect = canvas.getBoundingClientRect()
    return { x: pointerEvent.clientX - rect.left, y: pointerEvent.clientY - rect.top }
  }

  /**
   * Begins a potential drag: records the press point and captures the pointer so
   * moves keep arriving even if the cursor leaves the canvas mid-drag. Whether
   * this becomes a pan or a click is decided on release by how far the pointer
   * moved (see {@link handlePointerUp}).
   */
  function handlePointerDown(pointerEvent: PointerEvent, canvas: HTMLCanvasElement): void {
    const screenPoint = screenPointOf(pointerEvent, canvas)
    dragOrigin = screenPoint
    dragLast = screenPoint
    dragExceededThreshold = false
    // Keep receiving moves / the up even if the cursor slips off the canvas.
    canvas.setPointerCapture?.(pointerEvent.pointerId)
  }

  /**
   * Handles a move. While a button is held this pans the camera by the per-move
   * screen delta (and, once the move crosses the click threshold, detaches
   * auto-follow so the user's view sticks like a maps app). With no button held it
   * drives the hover hit-test instead. The two are mutually exclusive: a drag
   * suppresses hover so a tooltip never flickers under a pan.
   */
  function handlePointerMove(pointerEvent: PointerEvent, canvas: HTMLCanvasElement): void {
    const screenPoint = screenPointOf(pointerEvent, canvas)

    if (dragOrigin && dragLast) {
      const totalDeltaX = screenPoint.x - dragOrigin.x
      const totalDeltaY = screenPoint.y - dragOrigin.y
      if (Math.hypot(totalDeltaX, totalDeltaY) > CLICK_DRAG_THRESHOLD_PX) {
        dragExceededThreshold = true
        // A deliberate manual pan switches the camera to `manual` so it stops
        // yanking the view back to the active region each frame; the view sticks
        // like a maps app. `setCameraMode('overview'|'follow')` re-engages auto.
        cameraMode = 'manual'
      }
      // Pan by the incremental delta since the last move so the world tracks the
      // cursor 1:1. Even sub-threshold moves pan; the threshold only gates whether
      // the gesture counts as a click on release.
      const moveDeltaX = screenPoint.x - dragLast.x
      const moveDeltaY = screenPoint.y - dragLast.y
      camera.panByScreen(moveDeltaX, moveDeltaY)
      dragLast = screenPoint
      return
    }

    updateHover(screenPoint)
  }

  /**
   * Ends a gesture. If the pointer barely moved (under the click threshold) the
   * press is treated as a click and resolved to the nearest node / actor; a real
   * drag emits nothing (it already panned). Either way the drag state is cleared.
   */
  function handlePointerUp(pointerEvent: PointerEvent, canvas: HTMLCanvasElement): void {
    canvas.releasePointerCapture?.(pointerEvent.pointerId)
    const wasClick = dragOrigin !== null && !dragExceededThreshold
    dragOrigin = null
    dragLast = null
    if (!wasClick) {
      return
    }

    const screenPoint = screenPointOf(pointerEvent, canvas)
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

  /** The cursor left the canvas: abandon any in-flight drag and clear the hover. */
  function handlePointerLeave(): void {
    dragOrigin = null
    dragLast = null
    setHovered(null, null)
  }

  /**
   * Zooms the camera anchored at the cursor on a wheel event, so scrolling up
   * zooms in toward the cursor and down zooms out, clamped by the camera's own
   * limits. Like a manual pan, a wheel zoom switches the camera to `manual` so the
   * user's chosen view sticks. `preventDefault` stops the page from scrolling under it.
   */
  function handleWheel(wheelEvent: WheelEvent, canvas: HTMLCanvasElement): void {
    wheelEvent.preventDefault()
    const screenAnchor = screenPointOf(wheelEvent, canvas)
    // deltaY < 0 is a scroll up (zoom in); raising the factor above 1 zooms in.
    const factor = wheelEvent.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP
    camera.zoomBy(factor, screenAnchor)
    cameraMode = 'manual'
  }

  /**
   * Hit-tests the cursor against the live node positions and emits `nodeHover`
   * only when the result changes. The screen-pixel hit slop is divided by the live
   * zoom so the hover radius is constant on screen at any zoom, mirroring picking.
   */
  function updateHover(screenPoint: { x: number, y: number }): void {
    const worldPoint = camera.screenToWorld(screenPoint)
    const worldRadius = hitRadiusPx / camera.zoom
    const nodePath = nearestWithinRadius(worldPoint, nodeCandidates(), worldRadius)
    setHovered(nodePath, screenPoint)
  }

  /**
   * Updates the hovered node and emits `nodeHover` on a change only (enter, move to
   * a different node, or leave). A move within the same node does not re-emit, so a
   * host tooltip is driven cheaply; the host positions it from its own pointer
   * tracking if it wants per-pixel following.
   */
  function setHovered(path: string | null, screenPoint: { x: number, y: number } | null): void {
    if (path === hoveredPath) {
      return
    }
    hoveredPath = path
    if (path === null || screenPoint === null) {
      emitter.emit('nodeHover', null)
      return
    }
    emitter.emit('nodeHover', { path, screen: { x: screenPoint.x, y: screenPoint.y }})
  }

  /** The live node pick candidates: every simulated node at its drawn position. */
  function nodeCandidates(): PickCandidate[] {
    const candidates: PickCandidate[] = []
    for (const [ path, body ] of bodies) {
      candidates.push({ id: path, position: body.position })
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
      // Drop excluded paths at the ingest boundary so they never reach the
      // timeline (filtering is construction-time for v1). A pathless event (a
      // `pulse`) is actor-level with nothing to filter, so it is always kept.
      const filtered = batch.filter((event) => event.path === undefined || pathFilter(event.path))
      const run = (): void => {
        for (const event of filtered) {
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
      // Drop excluded seed paths before they ever enter the tree, mirroring the
      // ingest filter so seeded structure honors the same blacklist / whitelist.
      const keptPaths = paths.filter((path) => pathFilter(path))
      const run = (): void => {
        // Seed dim structure onto the live tree in place: `seedTree` only adds
        // missing nodes as `seeded` and never downgrades a discovered node, which
        // is exactly the merge we want, so it shows immediately without disturbing
        // anything already lit. Record the paths on the state too, so a later
        // backward seek re-seeds them when it re-folds the tree.
        seedTree(frameState.tree, keptPaths)
        frameState.seededPaths.push(...keptPaths)
        // Seeding adds dim structure to the tree, so the next tick must re-sync the
        // sim (spawning bodies for the newly seeded nodes) and rebuild the collapse.
        structureStale = true
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
    setCameraMode(mode: CameraMode): void {
      cameraMode = mode
    },
    follow(shouldFollow: boolean): void {
      // Legacy boolean shim over the camera mode: follow on -> the Gource camera,
      // follow off -> manual (free view). New code should call `setCameraMode`.
      cameraMode = shouldFollow ? 'follow' : 'manual'
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
        cameraMode,
      }
    },
    highlight(paths: string[], highlightOptions: HighlightOptions = {}): RunewoodHighlight {
      const id = highlightOptions.id ?? `highlight-${nextHighlightId++}`
      const color = highlightOptions.color ?? DEFAULT_HIGHLIGHT_COLOR
      // Register the group immediately. The registry is plain in-memory state the
      // tick reads each frame, so it takes effect on the very next draw whether or
      // not the backend has finished initializing; no queueing needed.
      highlights.set(id, paths, color)
      return {
        id,
        update(nextPaths: string[]): void {
          // Per-file progressive update (e.g. CI revealed another touched file):
          // replace just this group's paths, keeping its color and overlap priority.
          highlights.updatePaths(id, nextPaths)
        },
        clear(): void {
          highlights.remove(id)
        },
      }
    },
    clearHighlights(): void {
      highlights.clear()
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

      // Detach every pointer / wheel listener before the backend (and its canvas)
      // go away, and drop every event subscriber so the controller leaves nothing
      // behind.
      const canvas = backend.canvas
      if (canvas) {
        if (pointerDownListener) {
          canvas.removeEventListener('pointerdown', pointerDownListener)
        }
        if (pointerMoveListener) {
          canvas.removeEventListener('pointermove', pointerMoveListener)
        }
        if (pointerUpListener) {
          canvas.removeEventListener('pointerup', pointerUpListener)
        }
        if (pointerLeaveListener) {
          canvas.removeEventListener('pointerleave', pointerLeaveListener)
        }
        if (wheelListener) {
          canvas.removeEventListener('wheel', wheelListener)
        }
      }
      pointerDownListener = null
      pointerMoveListener = null
      pointerUpListener = null
      pointerLeaveListener = null
      wheelListener = null
      emitter.clear()
      // Drop every live highlight so a torn-down controller leaves no overlay state
      // behind (the scenes that drew the rings are disposed just below).
      highlights.clear()

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

      physics.reset()
    },
  }
}

/** The empty log passed to the reducer on a still / no-events-crossed frame, avoiding a needless copy. */
const EMPTY_LOG: RunewoodEvent[] = []

/** The empty candidate set handed to the label scene when labels are suppressed. */
const EMPTY_LABELS: LabelCandidate[] = []

/**
 * Default click hit slop in screen pixels: how far from a node / actor a click may
 * land and still resolve to it. A few pixels of forgiveness so tapping near a
 * small node still selects it, without grabbing unrelated neighbors.
 */
const DEFAULT_HIT_RADIUS_PX = 16

/**
 * How far (in screen pixels) the pointer may travel between press and release and
 * still count as a click rather than a drag. Beyond this the gesture is a pan, so
 * dragging to navigate never accidentally deep-links via `nodeClick`.
 */
const CLICK_DRAG_THRESHOLD_PX = 4

/**
 * Multiplicative zoom applied per wheel notch: one scroll-up multiplies the zoom
 * by this, one scroll-down divides by it. ~1.1 is a smooth, controllable step
 * that still moves perceptibly per notch.
 */
const WHEEL_ZOOM_STEP = 1.1

/**
 * The default highlight ring color when a host calls
 * {@link RunewoodController.highlight} without one: a warm attention amber. It is a
 * deliberate "watch this" hue that stands clear of the cool dusk background and of
 * the cooler-leaning file palette, so a highlighted set reads at a glance. A host
 * with its own semantics (e.g. green for passing CI, red for failing) overrides it
 * per call via {@link HighlightOptions.color}.
 */
const DEFAULT_HIGHLIGHT_COLOR: Hsl = { h: 38, s: 0.95, l: 0.58 }

/**
 * Resolves the initial camera mode from the construction options. An explicit
 * `cameraMode` wins; otherwise the deprecated `follow` boolean maps (`true` ->
 * `follow`, `false` -> `manual`); with neither set the default is the Gource-style
 * `follow` camera.
 */
function resolveInitialCameraMode(options: RunewoodOptions): CameraMode {
  if (options.cameraMode !== undefined) {
    return options.cameraMode
  }
  if (options.follow !== undefined) {
    return options.follow ? 'follow' : 'manual'
  }
  return 'follow'
}

/**
 * Resolves the force-directed sim's options from the construction options. The
 * explicit {@link RunewoodOptions.physics} block wins field-by-field; its `center`
 * falls back to the deprecated `layout.center` (the one layout field the sim still
 * honors) so a host that pinned the old radial layout's center keeps the same center
 * for the sim. Everything else defaults inside {@link ForceLayout}.
 */
function resolvePhysicsOptions(options: RunewoodOptions): ForceLayoutOptions {
  return {
    ...options.physics,
    center: options.physics?.center ?? options.layout?.center,
  }
}

/**
 * How much faster the sim is stepped under reduced motion: the real frame delta is
 * scaled up so the physics settles almost immediately with little visible glide,
 * honoring the preference for minimal motion while still keeping the positions correct
 * (the sim must keep running so nodes are where the scene expects them). The sim's own
 * `maxStepMs` clamp still bounds any single step, so this never destabilizes it.
 */
const REDUCED_MOTION_STEP_SCALE = 4

/**
 * Folds the top-level {@link RunewoodOptions.actorLingerMs} knob into the beam
 * scene's actor options as `lingerMs`, leaving every other actor / beam tuning the
 * host supplied via `beams` intact. An explicit `beams.actors.lingerMs` is the more
 * specific surface and wins; the top-level knob only fills it in when absent.
 */
function resolveBeamSceneOptions(options: RunewoodOptions): BeamSceneOptions {
  const beams = options.beams ?? {}
  if (options.actorLingerMs === undefined) {
    return beams
  }
  return {
    ...beams,
    actors: {
      lingerMs: options.actorLingerMs,
      ...beams.actors,
    },
  }
}

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
