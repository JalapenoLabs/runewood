// Copyright © 2026 Jalapeno Labs

import type { RunewoodAction } from '../types'
import type { Vec2 } from '../core/layout'
import type { Hsl } from '../core/theme'

import { colorForActor } from '../core/theme'

/**
 * The signature "vis" effect: a brief tapered beam of light flung from an actor to
 * the file it just touched. This module is the pure, forward-only *visual* model
 * behind that effect. It owns a fixed pool of beams and, given spawns and a
 * playhead time, reports exactly which beams are alive, how wide and bright they are
 * right now, and what color. A backend draws each as a soft additive tapered triangle
 * (wide and bright at the actor, narrowing to the file); nothing here touches pixi,
 * the DOM, the clock, or randomness.
 *
 * ### Live endpoints (the "beams point at the middle and miss" fix)
 *
 * A beam no longer stores frozen endpoints. It stores a *reference*: the **actor** it
 * was flung from and the **target node path** it reaches. The actual endpoints are
 * resolved LIVE every frame the beam is drawn, via a {@link BeamEndpointResolver} the
 * caller supplies from the live positions:
 * - the SOURCE is the actor's live orb position (its eased, drawn position), not a
 *   stale centroid that averages to the screen center, and
 * - the TARGET is the node's live physics position, looked up by path each frame, so
 *   the beam follows the node as the force sim migrates it outward instead of pointing
 *   at where the node briefly was at spawn.
 *
 * A beam whose target node no longer resolves (its path was rewound / collapsed away)
 * ends gracefully: it is simply dropped from the active set rather than drawn to a
 * stale point. A `pulse` (path-less actor-local flash) has no node target; its target
 * is a short, deterministic nudge off its own live source, so it reads as a quick
 * local flicker on the orb wherever the orb currently is.
 *
 * The redesign (issue: "beams are little bullets"): a spawn is ONE beam, not a cloud
 * of particles. It is bright and wide at birth and thins + fades to nothing over a
 * short lifetime, then frees its slot.
 *
 * Why a pool and not a fresh array each frame: a busy timeline spawns many beams a
 * second, and allocating per frame would thrash the GC mid-animation. The pool is
 * sized once up front; spawning reuses the oldest-expired slot, so the working set
 * is allocation-flat no matter how long the visualization runs.
 *
 * Determinism: per the issue, transient effects are not rewound. On a backward
 * seek the controller calls {@link BeamField.clear} and the active set empties;
 * replaying forward respawns them. The lifetime fade a beam reports is a pure
 * function of its spawn time and `now`; only the endpoints come from live positions
 * (which are themselves forward-only by design).
 */
export class BeamField {
  /** The fixed beam pool. Slots are reused; the array length never changes. */
  private readonly pool: Beam[]
  /** Tuning, resolved once at construction so the hot path reads plain numbers. */
  private readonly options: ResolvedBeamOptions
  /**
   * Round-robin cursor into the pool for the next spawn. We scan from here for a
   * free (expired) slot so reuse spreads evenly across the pool instead of
   * hammering slot 0, which keeps long-lived bursts from starving newer spawns.
   */
  private nextSlot: number

  /**
   * @param options pool capacity and beam tuning. Capacity is the hard cap on
   *   simultaneously live beams; once full, a new spawn evicts the
   *   nearest-to-expiry slot so the freshest activity always wins.
   */
  constructor(options: BeamFieldOptions = {}) {
    this.options = resolveOptions(options)
    this.pool = Array.from({ length: this.options.capacity }, makeDeadBeam)
    this.nextSlot = 0
  }

  /** The fixed number of beam slots. Never changes after construction. */
  get capacity(): number {
    return this.pool.length
  }

  /**
   * Spawns one beam from the `actor` (resolved live to its orb position) to the node
   * at `targetPath` (resolved live to its physics position), born at `at` and colored
   * by the action blended with the actor's identity color. A {@link spawnPulse}-style
   * spawn (no node target) is expressed by passing `targetPath: null`, which fires a
   * short actor-local flash instead of reaching for a node.
   *
   * Returns `1` (always one beam per spawn now), so a caller can still assert that
   * a spawn placed a beam.
   */
  spawn(spawn: BeamSpawn): number {
    const color = blendActionColor(spawn.action, spawn.actor, this.options.actionTint)
    const slot = this.claimSlot(spawn.at)
    writeBeam(slot, spawn, color, this.options)
    return 1
  }

  /**
   * Spawns an actor-local flash for a `pulse` event (activity with no file target).
   * Modeled as a tiny beam whose target is a short hashed nudge off the actor's live
   * source, so a path-less event reads as a quick local flicker on the orb rather than
   * a beam reaching anywhere. A thin convenience over {@link spawn} with
   * `targetPath: null`.
   */
  spawnPulse(spawn: PulseSpawn): number {
    return this.spawn({ ...spawn, targetPath: null })
  }

  /**
   * The beams currently alive at playhead time `now`, as fresh read-only snapshots a
   * backend can draw. A beam is alive while `now` is within
   * `[bornAt, bornAt + lifetimeMs)`; outside that window it is treated as a free slot
   * and skipped. Each live beam's endpoints are resolved THIS frame through `resolve`:
   * the source from the actor's live orb position and the target from the node's live
   * position. A beam whose target node no longer resolves (rewound / collapsed away)
   * is dropped so it ends gracefully rather than drawing to a stale point.
   *
   * This neither mutates the pool nor allocates beyond the returned snapshots, so it
   * is safe to call many times for one frame.
   */
  activeBeams(now: number, resolve: BeamEndpointResolver): ActiveBeam[] {
    const active: ActiveBeam[] = []
    for (const beam of this.pool) {
      const sample = sampleBeam(beam, now, resolve, this.options)
      if (sample) {
        active.push(sample)
      }
    }
    return active
  }

  /**
   * Convenience alias matching the issue's `step(now)` naming: advancing the field
   * is stateless (every value derives from `now` + the live resolver), so stepping is
   * just reading the active set at the new time.
   */
  step(now: number, resolve: BeamEndpointResolver): ActiveBeam[] {
    return this.activeBeams(now, resolve)
  }

  /**
   * Empties the field: every slot is marked dead so no beam is in flight. The
   * controller calls this on a backward seek, where reversing transient effects is
   * neither meaningful nor desired (the issue: clear, don't reverse). Capacity is
   * untouched, so the pool stays allocation-flat across the clear.
   */
  clear(): void {
    for (const beam of this.pool) {
      killBeam(beam)
    }
    this.nextSlot = 0
  }

  /**
   * Finds a slot for a new beam born at `at`: the first dead slot scanning
   * round-robin from {@link nextSlot}. If every slot is still alive (a saturated
   * pool), it evicts the one nearest to expiry, so the freshest activity always
   * displaces the stalest. Advances the cursor so successive spawns spread out.
   */
  private claimSlot(at: number): Beam {
    const size = this.pool.length

    for (let probe = 0; probe < size; probe++) {
      const index = (this.nextSlot + probe) % size
      const beam = this.pool[index]
      if (at >= beam.bornAt + beam.lifetimeMs) {
        this.nextSlot = (index + 1) % size
        return beam
      }
    }

    // Pool saturated: evict the beam whose life ends soonest.
    let evictIndex = 0
    let earliestDeath = Infinity
    for (let index = 0; index < size; index++) {
      const death = this.pool[index].bornAt + this.pool[index].lifetimeMs
      if (death < earliestDeath) {
        earliestDeath = death
        evictIndex = index
      }
    }
    this.nextSlot = (evictIndex + 1) % size
    return this.pool[evictIndex]
  }
}

/**
 * Resolves a beam's live endpoints each frame. The scene/controller supplies this
 * from the live positions it owns:
 * - `actorSource(actor)` returns the actor's live orb (drawn, eased) position, or
 *   `null` if the actor is no longer present.
 * - `nodePosition(path)` returns the node's live physics position, or `null` if the
 *   node no longer exists (rewound / collapsed away).
 *
 * Returning `null` from either ends the beam gracefully (it is dropped from the
 * active set) rather than drawing it to a stale or origin point.
 */
export type BeamEndpointResolver = {
  /** The actor's live orb (drawn) position, or `null` when the actor is gone. */
  actorSource: (actor: string) => Vec2 | null
  /** The node's live physics position, or `null` when the node no longer exists. */
  nodePosition: (path: string) => Vec2 | null
}

/**
 * Resolves one beam's live endpoints from a {@link BeamEndpointResolver}: the source
 * from the actor and the target from either the node path (a real beam) or a
 * deterministic short nudge off the live source (a pulse). Returns `null` when the
 * source actor is gone or a real beam's target node no longer exists, so the caller
 * drops the beam gracefully.
 *
 * Kept pure and exported so the live-endpoint resolution is unit-testable in
 * isolation from the pool and the pixi scene.
 */
export function resolveBeamEndpoints(
  beam: BeamEndpointReference,
  resolve: BeamEndpointResolver,
  pulseRadius: number,
): { source: Vec2, target: Vec2 } | null {
  const source = resolve.actorSource(beam.actor)
  if (!source) {
    // The actor's orb is gone (faded out / dropped): nothing to fling a beam from.
    return null
  }

  if (beam.targetPath === null) {
    // Pulse: a short flash off the live source in a stable hashed direction, so it
    // flickers on the orb wherever the orb currently is.
    const angle = pulseAngleFor(beam.actor, beam.action)
    return {
      source,
      target: {
        x: source.x + Math.cos(angle) * pulseRadius,
        y: source.y + Math.sin(angle) * pulseRadius,
      },
    }
  }

  const target = resolve.nodePosition(beam.targetPath)
  if (!target) {
    // The target node was rewound / collapsed away: end the beam gracefully.
    return null
  }
  return { source, target }
}

/** The reference fields a beam carries for live endpoint resolution: who, and what it reaches. */
export type BeamEndpointReference = {
  /** Stable actor id; the live source is the actor's orb position. */
  actor: string
  /** The action that fired; drives the deterministic pulse direction for a path-less beam. */
  action: RunewoodAction
  /** The touched node's path the beam reaches, or `null` for an actor-local pulse. */
  targetPath: string | null
}

/**
 * One pooled beam. This is the engine's mutable slot, written on spawn and sampled
 * (never mutated) on read, so a single slot is reused across its whole life. It holds
 * the *reference* (actor + target path) the endpoints are resolved from live each
 * frame, never frozen coordinates; `lifetimeMs` is how long it lives from `bornAt`. A
 * dead slot has `lifetimeMs === 0` so `now >= bornAt + 0` is always true and it reads
 * as free.
 */
type Beam = {
  bornAt: number
  lifetimeMs: number
  /** Stable actor id; the live source is the actor's orb position. */
  actor: string
  /** The action that fired; tints the color and drives the pulse direction. */
  action: RunewoodAction
  /** The touched-file path the beam reaches, or `null` for an actor-local pulse. */
  targetPath: string | null
  color: Hsl
  /** Peak width at the source end, in layout units, before the lifetime fade. */
  width: number
}

/**
 * A read-only snapshot of a live beam at a given time, in the plain shape a backend
 * draws: the two live layout-space endpoints (resolved this frame), the current
 * `width` at the source end, an `alpha` already faded for the moment, and the blended
 * `color`. Returned by {@link BeamField.activeBeams}.
 */
export type ActiveBeam = {
  /** The actor end of the beam (wide), the actor's live orb position. */
  source: Vec2
  /** The touched-file end of the beam (the taper's point), the node's live position. */
  target: Vec2
  /** Presence opacity, `0..1`, fading to 0 by end of life. */
  alpha: number
  /** Current width at the source end in layout units, thinning toward 0 by end of life. */
  width: number
  color: Hsl
}

/** A beam spawn: an actor reaching a file by path, or (with `targetPath: null`) a local pulse flash. */
export type BeamSpawn = {
  /** Event time in epoch ms; the beam is born here. */
  at: number
  /** Stable actor id; drives the actor color, the live source, and the pulse hash. */
  actor: string
  /** The action that fired, which tints the beam toward an action color. */
  action: RunewoodAction
  /** The touched-node path the beam reaches (resolved live), or `null` for a pulse. */
  targetPath: string | null
}

/** A pulse spawn: actor-local activity with no file target. {@link BeamSpawn.targetPath} is implied `null`. */
export type PulseSpawn = Omit<BeamSpawn, 'targetPath'>

/** Construction tuning for a {@link BeamField}. Every field has a default. */
export type BeamFieldOptions = {
  /** Maximum simultaneously live beams. The pool is sized to this once. */
  capacity?: number
  /** How long a beam lives from its birth, in milliseconds. */
  lifetimeMs?: number
  /** Peak width at the source (actor) end at birth, in layout units. */
  beamWidth?: number
  /** How far a pulse flash reaches off the actor, in layout units. */
  pulseRadius?: number
  /** How strongly the action color tints the actor color, `0..1`. 0 is pure actor, 1 is pure action. */
  actionTint?: number
}

/** {@link BeamFieldOptions} with every default resolved, for the hot path. */
type ResolvedBeamOptions = Required<BeamFieldOptions>

const DEFAULT_CAPACITY = 512
// ~0.8s lands in the user's requested 0.6-1s window: a brief flashlight pulse that
// is gone quickly, not a lingering stream.
const DEFAULT_LIFETIME_MS = 800
const DEFAULT_BEAM_WIDTH = 14
const DEFAULT_PULSE_RADIUS = 26
const DEFAULT_ACTION_TINT = 0.5

/**
 * The hue each action contributes to its beams, in degrees. These read as intent:
 * green for creation, amber for a modify, cyan for a non-mutating scan, red for a
 * delete, violet for a path-less pulse. The actor's own hue is blended in (see
 * {@link blendActionColor}) so two actors doing the same action still read as
 * distinct.
 */
const hueByAction = {
  create: 130,
  modify: 45,
  scan: 190,
  delete: 5,
  pulse: 280,
} as const satisfies Record<RunewoodAction, number>

/** Fixed saturation/lightness for action tints, matching the forest's vivid palette. */
const ACTION_SATURATION = 0.7
const ACTION_LIGHTNESS = 0.55

/** Fills in every {@link BeamFieldOptions} default in one place. */
function resolveOptions(options: BeamFieldOptions): ResolvedBeamOptions {
  return {
    capacity: options.capacity ?? DEFAULT_CAPACITY,
    lifetimeMs: options.lifetimeMs ?? DEFAULT_LIFETIME_MS,
    beamWidth: options.beamWidth ?? DEFAULT_BEAM_WIDTH,
    pulseRadius: options.pulseRadius ?? DEFAULT_PULSE_RADIUS,
    actionTint: options.actionTint ?? DEFAULT_ACTION_TINT,
  }
}

/**
 * Blends an action's intent hue with the actor's identity color, so a beam reads
 * as both "what happened" (the action) and "who did it" (the actor). The blend is
 * a straight per-channel lerp toward the action color by `tint`: at `tint = 0` the
 * beam is pure actor color, at `1` pure action color, and the default `0.5` splits
 * the difference. Pure: same inputs always yield the same color.
 */
function blendActionColor(action: RunewoodAction, actor: string, tint: number): Hsl {
  const actorColor = colorForActor(actor)
  const actionColor: Hsl = { h: hueByAction[action], s: ACTION_SATURATION, l: ACTION_LIGHTNESS }

  // Hue is angular, so lerp along the shorter way around the wheel rather than
  // numerically, which would make a 350->10 blend swing through the cold side.
  const hue = lerpHue(actorColor.h, actionColor.h, tint)
  return {
    h: hue,
    s: actorColor.s + (actionColor.s - actorColor.s) * tint,
    l: actorColor.l + (actionColor.l - actorColor.l) * tint,
  }
}

/** Shortest-arc hue interpolation in degrees, so a blend never swings the long way round the wheel. */
function lerpHue(from: number, to: number, amount: number): number {
  const delta = ((to - from) % 360 + 540) % 360 - 180
  return ((from + delta * amount) % 360 + 360) % 360
}

/** A fresh, already-dead pool slot. Zero lifetime means it always reads as free. */
function makeDeadBeam(): Beam {
  return {
    bornAt: 0,
    lifetimeMs: 0,
    actor: '',
    action: 'pulse',
    targetPath: null,
    color: { h: 0, s: 0, l: 0 },
    width: 0,
  }
}

/** Marks a slot free by zeroing its lifetime, without dropping the object (pool reuse). */
function killBeam(beam: Beam): void {
  beam.lifetimeMs = 0
}

/**
 * Writes a freshly spawned beam into a pooled slot in place. The slot stores the
 * *reference* (actor + target path) the live resolver reads each frame, never frozen
 * coordinates: a real beam reaches `spawn.targetPath`; a pulse (`targetPath === null`)
 * has no node and flashes a short nudge off its own live source at draw time.
 */
function writeBeam(beam: Beam, spawn: BeamSpawn, color: Hsl, options: ResolvedBeamOptions): void {
  beam.bornAt = spawn.at
  beam.lifetimeMs = options.lifetimeMs
  beam.actor = spawn.actor
  beam.action = spawn.action
  beam.targetPath = spawn.targetPath
  beam.color = color
  beam.width = options.beamWidth
}

/**
 * Samples one pool slot at `now`, resolving its live endpoints, and returning a
 * drawable snapshot if it is alive and its endpoints resolve, or `null` if it is a
 * free/expired slot OR its endpoints no longer resolve (the actor faded out, or the
 * target node was rewound away). The width and alpha both fall to nothing by end of
 * life: the beam is wide and bright at birth and thins + fades to a point as it dies,
 * while its endpoints track the live actor orb and node every frame.
 */
function sampleBeam(
  beam: Beam,
  now: number,
  resolve: BeamEndpointResolver,
  options: ResolvedBeamOptions,
): ActiveBeam | null {
  const elapsed = now - beam.bornAt
  if (elapsed < 0 || elapsed >= beam.lifetimeMs) {
    return null
  }

  const endpoints = resolveBeamEndpoints(beam, resolve, options.pulseRadius)
  if (!endpoints) {
    // The actor or target node is gone this frame: end the beam gracefully.
    return null
  }

  const life = elapsed / beam.lifetimeMs
  // Fade is linear to zero by end of life so the beam dissolves fully rather than
  // popping out. Width follows the same fall so the beam visibly thins as it fades.
  const fade = 1 - life

  return {
    source: endpoints.source,
    target: endpoints.target,
    alpha: fade,
    width: beam.width * fade,
    color: beam.color,
  }
}

/**
 * The deterministic flash direction for a pulse, in radians: a stable hashed angle
 * off the actor + action, so a path-less event always flickers the same way on the
 * orb (never randomly), wherever the orb currently is.
 */
function pulseAngleFor(actor: string, action: RunewoodAction): number {
  const hash = hashString(`${actor}|${action}|pulse`)
  return ((hash & 0xffff) / 0xffff) * Math.PI * 2
}

/**
 * FNV-1a 32-bit hash of a string. Stable, fast, and dependency-free; mirrors the
 * hash used by the layout jitter and the theme so the engine keeps one hashing
 * story and every "random-looking" offset is actually deterministic.
 */
function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return hash >>> 0
}
