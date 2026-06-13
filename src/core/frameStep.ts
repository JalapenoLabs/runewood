// Copyright © 2026 Jalapeno Labs

import type { RunewoodEvent } from '../types'
import type { TreeNode } from './tree'
import type { Vec2 } from './layout'
import type { AdvanceResult } from './timeline'

import { applyEvent, createTree, seedTree } from './tree'

/**
 * The pure, time-injected core of the controller's render loop. Issue #9 calls
 * for the RAF/pixi wiring to be a thin impure shell around a unit-testable
 * reducer; this module is that reducer.
 *
 * Given the prior logical state (the folded tree, the actor-activity tracking,
 * and the last playhead) plus the timeline's `advance`/`seek` result for this
 * tick, it returns the next logical state and the lists of beams and pulses the
 * shell should spawn into the {@link import('../render/beamScene').BeamScene}. It
 * touches no DOM, no pixi, no `requestAnimationFrame`, and no wall clock: every
 * value derives from the inputs and the playhead time the caller passes, so a
 * replayed timeline reduces identically and the whole loop stays deterministic.
 *
 * The shell keeps the forward-only visual state (the layout springs, the beam
 * particle pool, the camera easing) and drives those from the spawn lists and the
 * tree this reducer returns; this module only owns the *logical* state, which is
 * always a pure fold of the event log up to the playhead.
 */

/**
 * The recency tracking for one actor, accumulated as the playhead crosses the
 * actor's events forward. The shell turns this into an
 * {@link import('../render/actors').ActorActivity} each frame (resolving the
 * touched paths to their live spring positions), which in turn drives the actor
 * orbs and the actor labels.
 *
 * Positions are intentionally *not* stored here: a path's drawn position is the
 * animated spring position, which only the shell knows. The reducer tracks the
 * touched *paths* and the timing; the shell resolves paths to {@link Vec2}.
 */
export type ActorTrack = {
  /** Stable actor id, echoed for convenience when the shell iterates the map. */
  actor: string
  /**
   * The paths this actor has touched within the recency window, most-recent
   * first is not guaranteed; the shell treats the set as unordered. Pathless
   * pulses do not add a path (they have no file to point at) but still refresh
   * {@link lastActiveAt}.
   */
  touchedPaths: string[]
  /** Epoch ms of this actor's most recent event, for the inactivity fade. */
  lastActiveAt: number
  /**
   * The centroid of the actor's touched-file positions at its last active frame,
   * carried so the shell can park a now-quiet actor where it last worked while it
   * fades. The shell writes this from the live spring positions; the reducer only
   * carries it across ticks and clears it on a rebuild.
   */
  lastCentroid?: Vec2
}

/**
 * The full logical state the reducer threads from frame to frame. The shell holds
 * one of these alongside its forward-only visual state (springs, beam pool,
 * camera) and feeds it back in each tick.
 */
export type FrameState = {
  /** The forest, folded from every event with `at <= playhead`. */
  tree: TreeNode
  /** Per-actor recency tracking, keyed by actor id. */
  actors: Map<string, ActorTrack>
  /** The playhead time the tree and actor tracking currently reflect. */
  playhead: number
  /**
   * The host-supplied seed paths (dim, undiscovered structure). Carried on the
   * state so a backward-seek re-fold can re-seed the *original* set, even for paths
   * a now-rewound event had since promoted to `discovered`. The shell appends to
   * this whenever the host calls `seed`.
   */
  seededPaths: string[]
}

/**
 * A beam to spawn: an actor reaching a touched file. Mirrors `BeamScene.spawn`'s
 * input minus the resolved positions (the shell looks the path up in the springs).
 */
export type BeamSpawnRequest = {
  /** Event time in epoch ms; the particles are born here. */
  at: number
  actor: string
  /** The event's action, which tints the beam toward an action color. */
  action: RunewoodEvent['action']
  /** The touched node's path; the shell resolves it to a spring position. */
  path: string
}

/** A pulse to spawn: actor-local activity with no file target. */
export type PulseSpawnRequest = {
  at: number
  actor: string
  action: RunewoodEvent['action']
}

/**
 * What one {@link stepFrame} produced: the next logical state plus the spawn
 * lists the shell should feed into the beam scene, and whether the shell must
 * clear its transient particles (a backward-seek rebuild).
 */
export type FrameStep = {
  state: FrameState
  /** Beams to spawn this tick, in event order. Empty on a rebuild or a still frame. */
  beams: BeamSpawnRequest[]
  /** Pulses to spawn this tick, in event order. Empty on a rebuild or a still frame. */
  pulses: PulseSpawnRequest[]
  /**
   * Set when the playhead moved backward: the shell must clear its beam particle
   * field (transient effects are not rewound, per the issue) and let the springs
   * re-converge on the re-folded tree. Never set together with non-empty spawn
   * lists.
   */
  clearParticles: boolean
}

/** Tuning for the actor recency window. */
export type FrameStepOptions = {
  /**
   * How long after an actor's last event its touched paths stay in the window, in
   * milliseconds. Past this, a path is forgotten so a long-quiet actor stops
   * pointing at files it touched ages ago. The actor's fade itself lives in the
   * actor visual model; this only bounds how far back the touched-path set reaches.
   */
  activityWindowMs?: number
}

const DEFAULT_ACTIVITY_WINDOW_MS = 4_000

/**
 * Builds the initial logical state: an empty forest seeded with the given paths
 * (dim, undiscovered structure) and no actor activity, parked at the supplied
 * playhead. The shell calls this once on init and after a `seed`.
 */
export function createFrameState(seedPaths: string[] = [], playhead = 0): FrameState {
  const tree = createTree()
  if (seedPaths.length > 0) {
    seedTree(tree, seedPaths)
  }
  return { tree, actors: new Map(), playhead, seededPaths: [ ...seedPaths ]}
}

/**
 * Advances the logical state by one tick from the timeline's result.
 *
 * - A **forward** advance (`result.rebuild === false`) folds each newly-crossed
 *   event into the existing tree, accumulates actor activity, and emits a beam
 *   for every path-targeting event and a pulse for every pathless one.
 * - A **backward** seek (`result.rebuild === true`) re-folds the tree from
 *   scratch over `allEvents` up to the new playhead (the deterministic fold makes
 *   that exact), rebuilds the actor window from that same slice, and asks the
 *   shell to clear its transient particles. No beams or pulses are emitted: the
 *   issue is explicit that transient effects are cleared on a rewind, not replayed.
 *
 * Pure: the only time read is `result.playhead`; no wall clock, no randomness.
 *
 * @param state the prior logical state to advance.
 * @param result the timeline's `advance`/`seek` result for this tick.
 * @param allEvents the full sorted log (`timeline.getEvents()`), needed only to
 *   re-fold on a rebuild; ignored on a forward step.
 */
export function stepFrame(
  state: FrameState,
  result: AdvanceResult | SeekResult,
  allEvents: RunewoodEvent[],
  options: FrameStepOptions = {},
): FrameStep {
  const activityWindowMs = options.activityWindowMs ?? DEFAULT_ACTIVITY_WINDOW_MS

  if (result.rebuild) {
    return rebuildToPlayhead(state, result.playhead, allEvents, activityWindowMs)
  }

  return advanceForward(state, result, activityWindowMs)
}

/**
 * The shape `Timeline.seek` returns, widened with the `playhead` and empty
 * `crossed` the reducer reads. The controller adapts a bare `{ rebuild }` seek
 * into this before calling {@link stepFrame} (it knows the sought playhead from
 * `timeline.time`), so the reducer takes one uniform result type.
 */
export type SeekResult = {
  playhead: number
  rebuild: boolean
  crossed: RunewoodEvent[]
}

/** Folds this tick's crossed events forward into the existing state. */
function advanceForward(state: FrameState, result: AdvanceResult, activityWindowMs: number): FrameStep {
  const beams: BeamSpawnRequest[] = []
  const pulses: PulseSpawnRequest[] = []

  // Drop touched paths that have aged out of the window before this tick's events
  // refresh it, so a quiet actor's pointer set shrinks rather than growing forever.
  pruneActorWindow(state.actors, result.playhead, activityWindowMs)

  for (const event of result.crossed) {
    const node = applyEvent(state.tree, event)
    accumulateActor(state.actors, event, node)

    if (node) {
      // A path-targeting event (the node folded in): a beam from the actor to the
      // file it touched.
      beams.push({ at: event.at, actor: event.actor, action: event.action, path: node.path })
    }
    else if (event.action === 'pulse') {
      // A pathless pulse: an actor-local burst, no file to reach for.
      pulses.push({ at: event.at, actor: event.actor, action: event.action })
    }
    // Any other event that produced no node (a malformed pathless non-pulse) is
    // already logged by applyEvent and spawns nothing.
  }

  return {
    state: {
      tree: state.tree,
      actors: state.actors,
      playhead: result.playhead,
      seededPaths: state.seededPaths,
    },
    beams,
    pulses,
    clearParticles: false,
  }
}

/**
 * Re-folds the whole logical state at `playhead` from the full log. Used on a
 * backward seek: rather than try to "un-apply" events, the deterministic fold
 * lets us rebuild the exact tree and actor window for the new time from scratch.
 */
function rebuildToPlayhead(
  previous: FrameState,
  playhead: number,
  allEvents: RunewoodEvent[],
  activityWindowMs: number,
): FrameStep {
  // Re-fold the tree from scratch up to the new playhead. We re-seed the host's
  // original seed set first (carried on the state) so a rewind past an event that
  // had promoted a seeded path to `discovered` correctly folds it back to dim.
  const tree = createTree()
  if (previous.seededPaths.length > 0) {
    seedTree(tree, previous.seededPaths)
  }

  const actors = new Map<string, ActorTrack>()
  for (const event of allEvents) {
    if (event.at > playhead) {
      break
    }
    const node = applyEvent(tree, event)
    accumulateActor(actors, event, node)
  }

  // Prune the rebuilt window to the recency horizon at the new playhead, so the
  // window after a seek matches what a forward pass to that time would have left.
  pruneActorWindow(actors, playhead, activityWindowMs)

  return {
    state: { tree, actors, playhead, seededPaths: previous.seededPaths },
    beams: [],
    pulses: [],
    clearParticles: true,
  }
}

/**
 * Records one event against its actor's tracking: refreshes `lastActiveAt` and,
 * for a path-targeting event, adds the touched path to the window (de-duplicated
 * so a hammered file appears once). A pathless pulse refreshes the timing but
 * adds no path, since it points at no file.
 */
function accumulateActor(actors: Map<string, ActorTrack>, event: RunewoodEvent, node: TreeNode | null): void {
  let track = actors.get(event.actor)
  if (!track) {
    track = { actor: event.actor, touchedPaths: [], lastActiveAt: event.at }
    actors.set(event.actor, track)
  }

  track.lastActiveAt = Math.max(track.lastActiveAt, event.at)

  if (node && !track.touchedPaths.includes(node.path)) {
    track.touchedPaths.push(node.path)
  }
}

/**
 * Drops touched paths older than the recency window from every actor, and the
 * `lastCentroid` of an actor that has gone fully quiet so a stale centroid does
 * not strand its fading orb. An actor whose window has fully emptied is kept (its
 * orb is still fading out from `lastActiveAt`); the shell decides when its alpha
 * reaches zero and culls it.
 *
 * Because the reducer does not store per-path timestamps (the tree already holds
 * `lastTouchedAt` on each node), pruning uses the actor's own `lastActiveAt`: a
 * whole actor that has not acted within the window has its touched-path set
 * cleared, which is the granularity the actor orb needs (it points at the
 * centroid of a currently-active actor's files, not at per-file recency).
 */
function pruneActorWindow(actors: Map<string, ActorTrack>, now: number, activityWindowMs: number): void {
  for (const track of actors.values()) {
    if (now - track.lastActiveAt >= activityWindowMs) {
      track.touchedPaths = []
    }
  }
}
