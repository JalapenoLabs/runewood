// Copyright © 2026 Jalapeno Labs

import type { RunewoodAction } from '../types'
import type { Vec2 } from '../core/layout'
import type { Hsl } from '../core/theme'

import { colorForActor } from '../core/theme'

/**
 * The signature "vis" effect: glowing particles arcing from an actor to the file
 * it just touched. This module is the pure, forward-only *visual* simulation
 * behind that effect. It owns a fixed pool of particles and, given spawns and a
 * playhead time, reports exactly which particles are in flight, where they are,
 * and how bright and large they are. A backend turns those into additive glow
 * sprites; nothing here touches pixi, the DOM, the clock, or randomness.
 *
 * Why a pool and not a fresh array each frame: a busy timeline spawns hundreds of
 * particles a second, and allocating per frame would thrash the GC mid-animation.
 * The pool is sized once up front; spawning reuses the oldest-expired slot, so the
 * working set is allocation-flat no matter how long the visualization runs. The
 * active count rises and falls with activity, but the pool's capacity never grows.
 *
 * Determinism: per the issue, transient particle effects are not rewound. On a
 * backward seek the controller calls {@link BeamField.clear} and the active set
 * empties; replaying forward respawns them. Every value a particle reports is a
 * pure function of its spawn parameters and `now`, so no wall clock or RNG ever
 * leaks in. Any spread/jitter between the particles of one beam is hashed from a
 * stable key (actor + target + particle index), never `Math.random`.
 */
export class BeamField {
  /** The fixed particle pool. Slots are reused; the array length never changes. */
  private readonly pool: Particle[]
  /** Tuning, resolved once at construction so the hot path reads plain numbers. */
  private readonly options: ResolvedBeamOptions
  /**
   * Round-robin cursor into the pool for the next spawn. We scan from here for a
   * free (expired) slot so reuse spreads evenly across the pool instead of
   * hammering slot 0, which keeps long-lived bursts from starving newer spawns.
   */
  private nextSlot: number

  /**
   * @param options pool capacity and particle tuning. Capacity is the hard cap on
   *   simultaneously live particles; once full, a new spawn evicts the
   *   nearest-to-expiry slot so the freshest activity always wins.
   */
  constructor(options: BeamFieldOptions = {}) {
    this.options = resolveOptions(options)
    this.pool = Array.from({ length: this.options.capacity }, makeDeadParticle)
    this.nextSlot = 0
  }

  /** The fixed number of particle slots. Never changes after construction. */
  get capacity(): number {
    return this.pool.length
  }

  /**
   * Spawns one beam: a small stream of particles travelling from `source` (the
   * actor) to `target` (the touched node), born at `at` and colored by the action
   * blended with the actor's identity color. A {@link pulse}-style spawn (no
   * target) is expressed by passing `target: null`, which scatters the particles
   * locally around the actor instead of sending them anywhere (see
   * {@link BeamField.spawnPulse}).
   *
   * Returns the number of particles actually placed (always
   * `options.particlesPerBeam`), so callers can assert pooling behavior.
   */
  spawn(spawn: BeamSpawn): number {
    const count = this.options.particlesPerBeam
    const color = blendActionColor(spawn.action, spawn.actor, this.options.actionTint)

    for (let index = 0; index < count; index++) {
      const slot = this.claimSlot(spawn.at)
      writeParticle(slot, spawn, color, index, this.options)
    }
    return count
  }

  /**
   * Spawns an actor-local burst for a `pulse` event (activity with no file
   * target). The particles are born at the actor and drift outward in a stable,
   * hashed spray rather than reaching for a node. This is a thin convenience over
   * {@link spawn} with `target: null`, made explicit because the issue calls out
   * pulses as a distinct visual.
   */
  spawnPulse(spawn: PulseSpawn): number {
    return this.spawn({ ...spawn, target: null })
  }

  /**
   * The particles currently alive at playhead time `now`, as fresh read-only
   * snapshots a backend can draw. A particle is alive while `now` is within
   * `[bornAt, bornAt + lifetimeMs)`; outside that window it is treated as a free
   * slot and skipped. Positions interpolate source -> target along a gentle arc,
   * alpha and size decay to nothing by end of life.
   *
   * This neither mutates the pool nor allocates per-particle scratch beyond the
   * returned snapshots, so it is safe to call many times for one frame.
   */
  activeParticles(now: number): ActiveParticle[] {
    const active: ActiveParticle[] = []
    for (const particle of this.pool) {
      const sample = sampleParticle(particle, now, this.options)
      if (sample) {
        active.push(sample)
      }
    }
    return active
  }

  /**
   * Convenience alias matching the issue's `step(now)` naming: advancing the
   * field is stateless (every value derives from `now`), so stepping is just
   * reading the active set at the new time. Kept so the controller can call
   * whichever name reads clearest at its site.
   */
  step(now: number): ActiveParticle[] {
    return this.activeParticles(now)
  }

  /**
   * Empties the field: every slot is marked dead so no particle is in flight.
   * The controller calls this on a backward seek, where reversing transient
   * particles is neither meaningful nor desired (the issue: clear, don't reverse).
   * Capacity is untouched, so the pool stays allocation-flat across the clear.
   */
  clear(): void {
    for (const particle of this.pool) {
      killParticle(particle)
    }
    this.nextSlot = 0
  }

  /**
   * Finds a slot for a new particle born at `at`: the first dead slot scanning
   * round-robin from {@link nextSlot}. If every slot is still alive (a saturated
   * pool), it evicts the one nearest to expiry, so the freshest activity always
   * displaces the stalest. Advances the cursor so successive spawns spread out.
   */
  private claimSlot(at: number): Particle {
    const size = this.pool.length

    for (let probe = 0; probe < size; probe++) {
      const index = (this.nextSlot + probe) % size
      const particle = this.pool[index]
      if (at >= particle.bornAt + particle.lifetimeMs) {
        this.nextSlot = (index + 1) % size
        return particle
      }
    }

    // Pool saturated: evict the particle whose life ends soonest.
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
 * One pooled particle. This is the engine's mutable slot, written on spawn and
 * sampled (never mutated) on read, so a single slot is reused across its whole
 * life. Positions are layout-space; `lifetimeMs` is how long it lives from
 * `bornAt`. A dead slot has `lifetimeMs === 0` so `now >= bornAt + 0` is always
 * true and it reads as free.
 */
type Particle = {
  bornAt: number
  lifetimeMs: number
  source: Vec2
  /** The touched node, or `null` for a pulse (actor-local burst). */
  target: Vec2 | null
  color: Hsl
  /** Hashed unit drift applied along the whole flight, breaking up the stream. */
  drift: Vec2
  /** Hashed arc bow magnitude in layout units; bends the path off the straight line. */
  bow: number
  /** Fraction `0..1` of the lifetime this particle is offset from its siblings, for a trailing stream. */
  phase: number
}

/**
 * A read-only snapshot of a live particle at a given time, in the plain shape a
 * backend draws: a world-space `position`, an `alpha` and `size` already faded
 * for the moment, and the blended `color`. Returned by {@link BeamField.activeParticles}.
 */
export type ActiveParticle = {
  position: Vec2
  /** Presence opacity, `0..1`, fading to 0 by end of life. */
  alpha: number
  /** Draw size in layout units, shrinking toward 0 by end of life. */
  size: number
  color: Hsl
}

/** A beam spawn: an actor reaching a file, or (with `target: null`) a local pulse. */
export type BeamSpawn = {
  /** Event time in epoch ms; the particles are born here. */
  at: number
  /** Stable actor id; drives the actor color and the per-beam jitter hash. */
  actor: string
  /** The action that fired, which tints the beam toward an action color. */
  action: RunewoodAction
  /** Layout-space actor position the beam starts from. */
  source: Vec2
  /** Layout-space touched-node position the beam reaches, or `null` for a pulse. */
  target: Vec2 | null
}

/** A pulse spawn: actor-local activity with no file target. {@link target} is implied `null`. */
export type PulseSpawn = Omit<BeamSpawn, 'target'>

/** Construction tuning for a {@link BeamField}. Every field has a default. */
export type BeamFieldOptions = {
  /** Maximum simultaneously live particles. The pool is sized to this once. */
  capacity?: number
  /** How many particles one {@link BeamField.spawn} emits. */
  particlesPerBeam?: number
  /** How long a particle lives from its birth, in milliseconds. */
  lifetimeMs?: number
  /** Peak draw size of a particle at birth, in layout units. */
  particleSize?: number
  /** How far a pulse's particles spray from the actor, in layout units. */
  pulseRadius?: number
  /** Peak perpendicular bow of a beam's arc, in layout units. 0 draws straight beams. */
  arcBow?: number
  /** How strongly the action color tints the actor color, `0..1`. 0 is pure actor, 1 is pure action. */
  actionTint?: number
}

/** {@link BeamFieldOptions} with every default resolved, for the hot path. */
type ResolvedBeamOptions = Required<BeamFieldOptions>

const DEFAULT_CAPACITY = 2_048
const DEFAULT_PARTICLES_PER_BEAM = 6
const DEFAULT_LIFETIME_MS = 1_400
const DEFAULT_PARTICLE_SIZE = 3
const DEFAULT_PULSE_RADIUS = 28
const DEFAULT_ARC_BOW = 26
const DEFAULT_ACTION_TINT = 0.5

/**
 * The hue each action contributes to its beams, in degrees. These read as
 * intent: green for creation, amber for a modify, cyan for a non-mutating scan,
 * red for a delete, violet for a path-less pulse. The actor's own hue is blended
 * in (see {@link blendActionColor}) so two actors doing the same action still
 * read as distinct.
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
    particlesPerBeam: options.particlesPerBeam ?? DEFAULT_PARTICLES_PER_BEAM,
    lifetimeMs: options.lifetimeMs ?? DEFAULT_LIFETIME_MS,
    particleSize: options.particleSize ?? DEFAULT_PARTICLE_SIZE,
    pulseRadius: options.pulseRadius ?? DEFAULT_PULSE_RADIUS,
    arcBow: options.arcBow ?? DEFAULT_ARC_BOW,
    actionTint: options.actionTint ?? DEFAULT_ACTION_TINT,
  }
}

/**
 * Blends an action's intent hue with the actor's identity color, so a beam reads
 * as both "what happened" (the action) and "who did it" (the actor). The blend is
 * a straight per-channel lerp toward the action color by `tint`: at `tint = 0`
 * the beam is pure actor color, at `1` pure action color, and the default `0.5`
 * splits the difference. Pure: same inputs always yield the same color.
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
function makeDeadParticle(): Particle {
  return {
    bornAt: 0,
    lifetimeMs: 0,
    source: { x: 0, y: 0 },
    target: null,
    color: { h: 0, s: 0, l: 0 },
    drift: { x: 0, y: 0 },
    bow: 0,
    phase: 0,
  }
}

/** Marks a slot free by zeroing its lifetime, without dropping the object (pool reuse). */
function killParticle(particle: Particle): void {
  particle.lifetimeMs = 0
}

/**
 * Writes a freshly spawned particle into a pooled slot in place. All per-particle
 * variation (drift direction, arc bow, stream phase) is hashed from a stable key
 * (actor + target + particle index) so it stays deterministic across a replay; no
 * randomness is consulted. A pulse particle (`target === null`) instead gets a
 * radial drift so it sprays around the actor.
 */
function writeParticle(
  particle: Particle,
  spawn: BeamSpawn,
  color: Hsl,
  index: number,
  options: ResolvedBeamOptions,
): void {
  const key = beamKey(spawn, index)
  const hash = hashString(key)

  particle.bornAt = spawn.at
  particle.lifetimeMs = options.lifetimeMs
  particle.source = { x: spawn.source.x, y: spawn.source.y }
  particle.target = spawn.target ? { x: spawn.target.x, y: spawn.target.y } : null
  particle.color = color
  particle.phase = ((hash >>> 24) & 0xff) / 0xff

  // Two independent unit values in [-1, 1] from disjoint bit fields of the hash,
  // so a particle's drift and bow do not move in lockstep.
  const unitA = ((hash & 0xffff) / 0xffff) * 2 - 1
  const unitB = (((hash >>> 16) & 0xffff) / 0xffff) * 2 - 1

  if (particle.target === null) {
    // Pulse: spray radially around the actor in an even fan. The base angle is the
    // particle's slot around the circle (so a burst always covers all directions),
    // with a hashed jitter on top so it reads organic rather than mechanical. Both
    // are deterministic; no randomness.
    const slotAngle = (index / Math.max(1, options.particlesPerBeam)) * Math.PI * 2
    const jitter = unitA * (Math.PI / options.particlesPerBeam)
    const angle = slotAngle + jitter
    particle.drift = {
      x: Math.cos(angle) * options.pulseRadius,
      y: Math.sin(angle) * options.pulseRadius,
    }
    particle.bow = 0
    return
  }

  // Beam: a small lateral drift breaks the stream off a single line, and a hashed
  // bow bends the arc so beams read as flung vis rather than rulers.
  particle.drift = { x: unitA * options.pulseRadius * 0.4, y: unitB * options.pulseRadius * 0.4 }
  particle.bow = unitA * options.arcBow
}

/** The stable per-particle key: who, to where, which particle. Drives all hashed jitter. */
function beamKey(spawn: BeamSpawn, index: number): string {
  const targetKey = spawn.target ? `${spawn.target.x},${spawn.target.y}` : 'pulse'
  return `${spawn.actor}|${spawn.action}|${spawn.source.x},${spawn.source.y}|${targetKey}|${index}`
}

/**
 * Samples one pool slot at `now`, returning a drawable snapshot if it is alive or
 * `null` if it is a free/expired slot. The progress along the beam eases from 0 at
 * birth to 1 at end of life (offset per particle by its `phase` so the stream
 * trails), the alpha and size fade out over the same window, and the position
 * follows a quadratic arc from source toward target (or drifts out from the actor
 * for a pulse).
 */
function sampleParticle(particle: Particle, now: number, options: ResolvedBeamOptions): ActiveParticle | null {
  const elapsed = now - particle.bornAt
  if (elapsed < 0 || elapsed >= particle.lifetimeMs) {
    return null
  }

  const life = elapsed / particle.lifetimeMs

  // Each particle starts a little later than the last (its phase), so a single
  // beam reads as a trailing stream rather than one synchronized blob. Progress is
  // clamped to [0, 1] so a phase-delayed particle simply sits at the source until
  // its share of the life begins.
  const delay = particle.phase * PHASE_SPREAD
  const progress = Math.min(1, Math.max(0, (life - delay) / (1 - delay)))

  // Fade is independent of progress: presence and size decay smoothly to nothing
  // by the end of life regardless of how far along the path the particle is.
  const fade = 1 - life
  const alpha = fade
  const size = options.particleSize * fade

  const position = particle.target === null
    ? pulsePosition(particle, progress)
    : beamPosition(particle, progress)

  return { position, alpha, size, color: particle.color }
}

/**
 * How much of the lifetime the per-particle phase can delay a particle's start.
 * At 0.4 the latest particle in a beam begins at most 40% of the way through the
 * life, so the stream stays a stream without any particle dying before it moves.
 */
const PHASE_SPREAD = 0.4

/**
 * Position of a beam particle at `progress` along its flight: a quadratic arc from
 * `source` to `target`, bowed perpendicular to the straight line by the particle's
 * hashed `bow`, plus the small along-flight drift that thickens the stream. The
 * bow peaks at the midpoint and is zero at both ends so the beam still lands on the
 * node.
 */
function beamPosition(particle: Particle, progress: number): Vec2 {
  const source = particle.source
  const target = particle.target!

  const straightX = source.x + (target.x - source.x) * progress
  const straightY = source.y + (target.y - source.y) * progress

  // Perpendicular of the source->target direction, bowed by a parabola that is 0
  // at the ends and 1 at the midpoint, so the arc bulges but still hits the node.
  const directionX = target.x - source.x
  const directionY = target.y - source.y
  const length = Math.hypot(directionX, directionY) || 1
  const perpendicularX = -directionY / length
  const perpendicularY = directionX / length
  const bowAmount = particle.bow * 4 * progress * (1 - progress)

  return {
    x: straightX + perpendicularX * bowAmount + particle.drift.x * progress,
    y: straightY + perpendicularY * bowAmount + particle.drift.y * progress,
  }
}

/**
 * Position of a pulse particle at `progress`: it starts on the actor and drifts
 * out along its hashed radial `drift` so a path-less event reads as a local burst
 * blooming off the orb rather than a beam reaching anywhere.
 */
function pulsePosition(particle: Particle, progress: number): Vec2 {
  return {
    x: particle.source.x + particle.drift.x * progress,
    y: particle.source.y + particle.drift.y * progress,
  }
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
