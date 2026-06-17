// Copyright © 2026 Jalapeno Labs

import type { Vec2 } from '../core/layout'
import type { Hsl } from '../core/theme'

import { colorForActor } from '../core/theme'

/**
 * A faithful port of Gource's `RUser` (its `src/user.cpp`): the physics model for a
 * contributor's avatar (an "actor" here, the little orb). In Gource a user is a body
 * with a `position` and an `accel` (acceleration that doubles as its velocity carrier)
 * that, every frame, accelerates toward the file(s) it is acting on, is repelled by
 * other users crowding its personal space, has its acceleration clamped to a max
 * speed, integrates `pos += accel * dt`, and then bleeds the acceleration off by a
 * friction term. The net effect, with no hand-authored animation, is exactly what
 * Gource shows: a user flies toward the file it just touched and rolls smoothly to a
 * stop, like a ball on a pool table, purely from the physics. When it has nothing to
 * act on it simply coasts to rest where it last was (the friction) and fades out after
 * an idle period.
 *
 * This replaces runewood's earlier hand-built approximation (a swoop-in animation, an
 * opacity ramp, a lingering fade, an outward push to "just outside the file", and an
 * idle breathing pulse). None of those exist in Gource; the accelerate / brake /
 * friction loop produces the fly-in and the ease-to-rest on its own, and the user
 * rests right next to its file because it brakes within {@link DEFAULT_ACTION_DIST}
 * rather than driving onto it. So the orb naturally hugs its work with a short beam,
 * the very thing the outward-push hack was faking.
 *
 * ### What is pure vs. forward-only
 *
 * Like Gource (and like the node force-sim runewood already rides above), the motion
 * is deliberately **forward-only visual state**: {@link ActorUser} retains its position
 * and acceleration across frames and evolves them under the real frame delta, so a
 * backward seek lets it re-settle rather than reproducing pixel-exact prior frames.
 * The only **pure, playhead-exact** piece is the alpha fade ({@link actorAlpha}, the
 * port of Gource's `RUser::getAlpha`), so an actor's presence is reproducible on a
 * rewind even though its exact position is not. The controller owns one
 * {@link ActorUser} per live actor (inside the beam scene) and feeds it each frame's
 * action targets, the other users, and the delta.
 */

/**
 * The live activity of one actor at a moment in time: the files it is currently acting
 * on and when it last acted. The controller assembles this from the active event window
 * (the same window that drives the beams), so the actor model never reads the event log
 * itself. This is the runewood analogue of the `RAction`s on a Gource `RUser`: each
 * touched-file position is one action target the user drives toward.
 */
export type ActorActivity = {
  /** Stable actor id; drives the color and the deterministic separation direction. */
  actor: string
  /**
   * Layout-space positions of the files this actor is acting on, **most-recent first**:
   * `touched[0]` is the file it is touching right now (its current action target), and
   * any further entries are the immediately-preceding files within the controller's short
   * recency window. The user chases the FIRST entry (the current file) and only leans
   * gently toward the rest, so it visibly travels to each new file as the work moves
   * instead of parking at the static average of everything it has touched (the old
   * behavior, which made a busy actor rest in the dense middle and bounce between files).
   * Empty when the actor has gone quiet: it then has no force pulling it and coasts to a
   * stop under friction.
   */
  touched: Vec2[]
  /** Epoch ms of the actor's most recent activity, for the idle fade (Gource's `last_action`). */
  lastActiveAt: number
}

/**
 * The pure visual description of an actor, ready for a backend to draw: a world-space
 * `position` (the user's live physics position), a `0..1` `alpha` (its idle fade), a
 * draw `size` in layout units, and the actor's identity `color`. Library-free, exactly
 * like {@link import('./nodeVisual').NodeVisual}.
 */
export type ActorVisual = {
  /** Layout-space position: the user's live physics position this frame. */
  position: Vec2
  /** Presence opacity, `0..1`: full while acting, fading out after the idle time (Gource's `getAlpha`). */
  alpha: number
  /** Draw size in layout units. */
  size: number
  color: Hsl
}

/**
 * Tuning for the actor physics + fade, every field defaulting to Gource's own value
 * (from its `gource_settings.cpp` and `user.cpp`). These stay configurable on purpose:
 * Gource itself exposes the friction and the idle time as settings, and a host driving
 * a live LLM-agent feed wants a *longer* idle time than Gource's three seconds, since
 * an agent often pauses between edits and should stay put (not fade) across that gap.
 */
export type ActorUserOptions = {
  /**
   * Distance, in layout units, beyond which a user accelerates toward its action target
   * (Gource's `gGourceBeamDist`). Past this the pull grows with the overshoot, so a
   * far-away user flies in fast; this is also Gource's threshold for an action becoming
   * "active". Defaults to {@link DEFAULT_BEAM_DIST}.
   */
  beamDist?: number
  /**
   * Distance, in layout units, within which a user brakes (is repelled) from its action
   * target so it rests just beside the file rather than on top of it (Gource's
   * `gGourceActionDist`). The gap between this and {@link beamDist} is the dead zone the
   * user coasts to rest in, giving the short orb-to-file beam for free. Defaults to
   * {@link DEFAULT_ACTION_DIST}.
   */
  actionDist?: number
  /**
   * Distance, in layout units, within which two users repel each other so their orbs do
   * not stack (Gource's `gGourcePersonalSpaceDist`, `applyForceUser`). Defaults to
   * {@link DEFAULT_PERSONAL_SPACE_DIST}; `0` disables the separation.
   */
  personalSpaceDist?: number
  /**
   * Maximum speed the acceleration is clamped to each frame, in layout units per second
   * (Gource's `max_user_speed`). Caps how fast a user can fly toward its file. Defaults
   * to {@link DEFAULT_MAX_USER_SPEED}.
   */
  maxUserSpeed?: number
  /**
   * Friction coefficient that bleeds the acceleration off each frame as
   * `accel *= max(0, 1 - friction * dt)` (Gource's `user_friction`). Higher friction
   * stops the user sooner; this is what rolls it to rest. runewood defaults this WELL
   * ABOVE Gource's `1`: Gource's weak friction lets a user keep ~98% of its momentum per
   * frame, so in our integration it overshoots its file and oscillates back and forth
   * between the files it just touched (the user's "springy / bouncy" complaint). A
   * heavier friction makes the user GLIDE in and settle without that bounce, which is the
   * Gource-on-screen feel we are after. Defaults to {@link DEFAULT_FRICTION}.
   */
  friction?: number
  /**
   * Critical-damping coefficient on the action pull, in per-second units. The pull toward
   * the current file (and the brake within {@link actionDist}) is a spring; left undamped
   * it overshoots and oscillates. This subtracts a velocity-proportional term from the
   * action force (`accel -= approachDamping * velocity`) so the user eases to rest beside
   * its file instead of springing past it and oscillating. Higher is more glide-and-rest,
   * lower is springier. Defaults to {@link DEFAULT_APPROACH_DAMPING}; `0` restores the raw
   * (springy) Gource pull.
   */
  approachDamping?: number
  /**
   * How long after its last action, in milliseconds, a user stays fully present before
   * it begins fading (Gource's `user_idle_time`, in seconds, here exposed in ms). An
   * LLM agent that edits then pauses should STAY visible across that gap, so a host
   * raises this well above Gource's three seconds for a live feed. Defaults to
   * {@link DEFAULT_IDLE_MS}; the controller wires its `actorLingerMs` option here.
   */
  idleMs?: number
  /**
   * How long the fade from full to invisible takes once the idle time has elapsed, in
   * milliseconds (Gource fades over one second). Defaults to {@link DEFAULT_FADE_MS}.
   */
  fadeMs?: number
  /** Draw size of an actor orb, in layout units. */
  size?: number
}

/**
 * Gource's `gGourceBeamDist` (its `user.cpp`): beyond this a user accelerates toward
 * its action target, and an action this close becomes "active". In layout units.
 */
const DEFAULT_BEAM_DIST = 100

/**
 * Gource's `gGourceActionDist` (its `user.cpp`): within this a user is repelled from
 * its action target so it brakes to rest beside the file, not on it. In layout units.
 */
const DEFAULT_ACTION_DIST = 50

/** Gource's `gGourcePersonalSpaceDist` (its `user.cpp`): user-to-user repulsion radius, in layout units. */
const DEFAULT_PERSONAL_SPACE_DIST = 100

/** Gource's `max_user_speed` (its `gource_settings.cpp`): the acceleration clamp, in layout units per second. */
const DEFAULT_MAX_USER_SPEED = 500

/**
 * The per-second acceleration-bleed coefficient. Gource ships `user_friction = 1`, but at
 * that value a user keeps most of its momentum each frame and overshoots its file, bouncing
 * back and forth between recently-touched files in our integration. runewood damps harder so
 * the user glides in and settles smoothly (the user wants smooth, not springy); see
 * {@link ActorUserOptions.friction}.
 */
const DEFAULT_FRICTION = 6

/**
 * Default critical-damping coefficient on the action pull (per second). Sized so the
 * approach to a file is essentially critically damped at the {@link DEFAULT_FRICTION}
 * friction: the user eases up to its resting band and stops, rather than springing past it
 * and oscillating. See {@link ActorUserOptions.approachDamping}.
 */
const DEFAULT_APPROACH_DAMPING = 8

/**
 * How strongly the user leans toward the files it touched just BEFORE its current one,
 * relative to the full pull toward the current file (`touched[0]`). Kept small so the user
 * decisively follows the file it is acting on right now and only drifts a little toward its
 * immediate predecessors, instead of parking at the average of the whole set (which left it
 * stranded in the dense middle, barely moving while beams kept firing).
 */
const TRAILING_TARGET_WEIGHT = 0.15

/**
 * Gource's `user_idle_time` of three seconds (its `gource_settings.cpp`), in ms: how
 * long a quiet user stays fully present before the fade begins. A host driving a live
 * agent feed raises this so a paused agent stays put rather than dissolving.
 */
const DEFAULT_IDLE_MS = 3_000

/** Gource fades a now-idle user out over one second (its `RUser::getAlpha`), here in ms. */
const DEFAULT_FADE_MS = 1_000

/** Default actor orb draw size, in layout units. */
const DEFAULT_SIZE = 10

/**
 * The presence opacity of an actor at playhead time `now`: a faithful port of Gource's
 * `RUser::getAlpha`. The user is fully present (`1`) until it has been idle longer than
 * `idleMs`, after which it fades linearly to `0` over `fadeMs`, then stays gone. Pure
 * and playhead-exact (it reads only the last-active time and `now`), so an actor's
 * presence reproduces on a rewind even though its physics position does not.
 *
 * An actor whose last action is in the future relative to `now` (which the controller
 * should never produce) is treated as fully present rather than over-bright.
 */
export function actorAlpha(
  lastActiveAt: number,
  now: number,
  idleMs: number = DEFAULT_IDLE_MS,
  fadeMs: number = DEFAULT_FADE_MS,
): number {
  const idleElapsed = now - lastActiveAt
  if (idleElapsed <= idleMs) {
    return 1
  }
  if (fadeMs <= 0) {
    return 0
  }
  const remaining = 1 - (idleElapsed - idleMs) / fadeMs
  return Math.max(0, Math.min(1, remaining))
}

/**
 * One contributor's avatar as a Gource `RUser`: a retained physics body that flies
 * toward the files it is acting on and rolls to a stop, ported from Gource's
 * `src/user.cpp`. The beam scene owns one per live actor and {@link step}s it each
 * frame with that actor's action targets, the other users (for separation), and the
 * real frame delta. The drawn orb is read straight off {@link position}, and a beam
 * this actor fires resolves its source from the same {@link position}.
 *
 * This is forward-only visual state (it carries `position` and `accel` across frames),
 * so it lives here in the render layer and re-settles on a rewind, never in the
 * replayable fold. Only the alpha fade ({@link actorAlpha}) is pure.
 */
export class ActorUser {
  /** The actor's stable id, driving its color and its deterministic separation direction. */
  public readonly actor: string

  /**
   * The user's live world position, integrated each frame (Gource's `pos`). Read by the
   * scene to place the orb and by a beam to resolve its source endpoint.
   */
  private pos: Vec2

  /**
   * The user's acceleration, which also carries its velocity across frames (Gource's
   * `accel`): forces add into it, it is clamped to the max speed, it advances the
   * position, and friction bleeds it off. Starts at rest.
   */
  private accel: Vec2

  /**
   * Whether this frame's {@link applyForceToActions} braked the user against its current
   * file (it was inside `actionDist`). Set there, consumed and reset in {@link step}: when
   * set, the integrator applies the extra {@link ActorUserOptions.approachDamping} so the
   * user critically damps to rest beside the file rather than springing back out and
   * oscillating. Coasting frames (no brake) settle on friction alone.
   */
  private brakedTowardTarget: boolean

  private readonly options: Required<ActorUserOptions>

  /**
   * @param actor the actor's stable id.
   * @param spawn where the user first appears (Gource spawns a user at a file's
   *   position). It then flies toward its action targets from here.
   */
  constructor(actor: string, spawn: Vec2, options: ActorUserOptions = {}) {
    this.actor = actor
    this.pos = { x: spawn.x, y: spawn.y }
    this.accel = { x: 0, y: 0 }
    this.brakedTowardTarget = false
    this.options = {
      beamDist: options.beamDist ?? DEFAULT_BEAM_DIST,
      actionDist: options.actionDist ?? DEFAULT_ACTION_DIST,
      personalSpaceDist: options.personalSpaceDist ?? DEFAULT_PERSONAL_SPACE_DIST,
      maxUserSpeed: options.maxUserSpeed ?? DEFAULT_MAX_USER_SPEED,
      friction: options.friction ?? DEFAULT_FRICTION,
      approachDamping: options.approachDamping ?? DEFAULT_APPROACH_DAMPING,
      idleMs: options.idleMs ?? DEFAULT_IDLE_MS,
      fadeMs: options.fadeMs ?? DEFAULT_FADE_MS,
      size: options.size ?? DEFAULT_SIZE,
    }
  }

  /** The user's live world position. Read by the scene to draw the orb and by beams to source from it. */
  public get position(): Vec2 {
    return this.pos
  }

  /**
   * Adds the force pulling this user toward its action target, a damped variant of Gource's
   * `applyForceToActions` + `applyForceAction`. Unlike Gource (which averages all of its
   * active actions, parking a busy user in the dense middle of everything it touched), the
   * user chases its CURRENT file: `targets[0]`, the file it is acting on right now. It only
   * leans gently toward the immediately-preceding files ({@link TRAILING_TARGET_WEIGHT}), so
   * it visibly travels to each new file as the work moves instead of bouncing between a
   * static spread (the user's "springy / barely moves" complaints).
   *
   * Beyond `beamDist` it accelerates toward the current file, harder the farther it is;
   * within `actionDist` it brakes so it rests just beside the file rather than driving onto
   * it; between the two it coasts. Either way the pull is critically damped by
   * {@link ActorUserOptions.approachDamping} (a velocity-proportional term), so the user
   * EASES to rest beside its file rather than overshooting and oscillating. With no targets
   * there is no force and it rolls to a stop under friction (the idle case).
   */
  public applyForceToActions(targets: Vec2[]): void {
    if (targets.length === 0) {
      return
    }

    // Chase the CURRENT file (the first, most-recent target), leaning only slightly toward
    // the immediately-preceding ones, so the user follows the file it is acting on now
    // rather than the average of the whole window. With a single target this is just it.
    const target = this.weightedTarget(targets)

    const directionX = target.x - this.pos.x
    const directionY = target.y - this.pos.y
    const distance = Math.hypot(directionX, directionY)

    // Coincident with the target: nudge out deterministically (Gource kicks randomly;
    // we use the actor's stable hashed direction so a rewind is reproducible).
    if (distance < 1e-3) {
      const escape = hashedUnit(this.actor)
      this.accel.x += escape.x
      this.accel.y += escape.y
      return
    }

    const unitX = directionX / distance
    const unitY = directionY / distance

    if (distance < this.options.actionDist) {
      // Within the action distance: repel (brake) so the user rests beside the file.
      const brake = this.options.actionDist - distance
      this.accel.x -= brake * unitX
      this.accel.y -= brake * unitY
      this.brakedTowardTarget = true
      return
    }

    if (distance > this.options.beamDist) {
      // Beyond the beam distance: accelerate toward the file, harder the farther it is.
      const pull = distance - this.options.beamDist
      this.accel.x += pull * unitX
      this.accel.y += pull * unitY
    }
    // In the dead zone between actionDist and beamDist: no pull, the user coasts (its
    // momentum and the friction carry it to rest in the band).
  }

  /**
   * The point the user actually chases: its current file ({@link applyForceToActions}'s
   * `targets[0]`) plus a small lean toward the immediately-preceding files, normalized so
   * the weights sum to one. Chasing the current file (rather than the plain average of the
   * whole window) is what makes the user follow its live work instead of parking in the
   * middle of everything it has touched.
   */
  private weightedTarget(targets: Vec2[]): Vec2 {
    const [ current, ...trailing ] = targets
    if (trailing.length === 0) {
      return current
    }

    let weightSum = 1
    let sumX = current.x
    let sumY = current.y
    for (const previous of trailing) {
      sumX += previous.x * TRAILING_TARGET_WEIGHT
      sumY += previous.y * TRAILING_TARGET_WEIGHT
      weightSum += TRAILING_TARGET_WEIGHT
    }
    return { x: sumX / weightSum, y: sumY / weightSum }
  }

  /**
   * Adds the user-to-user separation force from one other user, the port of Gource's
   * `applyForceUser`: any other user closer than `personalSpaceDist` is repelled along
   * the line between them, harder the more they overlap, so two contributors working
   * near each other never stack into one orb. Perfectly coincident users are pushed
   * apart along this user's stable hashed direction (Gource kicks randomly; we stay
   * deterministic so a rewind is reproducible). `personalSpaceDist <= 0` disables it.
   */
  public applyForceUser(other: ActorUser): void {
    if (other === this || this.options.personalSpaceDist <= 0) {
      return
    }

    const directionX = other.pos.x - this.pos.x
    const directionY = other.pos.y - this.pos.y
    const distance = Math.hypot(directionX, directionY)

    if (distance < 1e-3) {
      const escape = hashedUnit(this.actor)
      this.accel.x -= escape.x
      this.accel.y -= escape.y
      return
    }

    if (distance < this.options.personalSpaceDist) {
      const push = this.options.personalSpaceDist - distance
      this.accel.x -= push * (directionX / distance)
      this.accel.y -= push * (directionY / distance)
    }
  }

  /**
   * Integrates one frame, the port of the tail of Gource's `RUser::logic` with runewood's
   * added approach damping: clamp the acceleration to the max speed, advance
   * `pos += accel * dt`, bleed the acceleration off by the friction
   * (`accel *= max(0, 1 - friction * dt)`), and (when the user braked against its file this
   * frame) apply the extra critical {@link ActorUserOptions.approachDamping} so it eases to
   * rest beside the file instead of springing past it. Call AFTER the per-frame forces
   * ({@link applyForceToActions}, {@link applyForceUser}) have been added. `dt` is the real
   * elapsed wall time for the frame, in seconds; a non-positive or non-finite delta holds
   * the user still rather than corrupting it.
   */
  public step(deltaSeconds: number): void {
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) {
      // A paused or malformed frame: leave the body untouched (but clear the brake flag so
      // a stale brake from the prior frame cannot leak into the next live step).
      this.brakedTowardTarget = false
      return
    }

    // Clamp the acceleration to the max speed (Gource clamps `accel` itself).
    const speed = Math.hypot(this.accel.x, this.accel.y)
    const maxSpeed = this.options.maxUserSpeed
    if (speed > maxSpeed) {
      const scale = maxSpeed / speed
      this.accel.x *= scale
      this.accel.y *= scale
    }

    // Integrate position, then bleed the acceleration off by friction so the user
    // rolls smoothly to a stop instead of drifting forever.
    this.pos.x += this.accel.x * deltaSeconds
    this.pos.y += this.accel.y * deltaSeconds

    let bleed = this.options.friction
    if (this.brakedTowardTarget) {
      // Braking against the file this frame: damp harder so the user critically settles
      // into its resting band beside the file rather than overshooting and oscillating
      // back and forth between the files it just touched. Framerate-independent: it is
      // folded into the same `1 - rate * dt` bleed the friction already uses.
      bleed += this.options.approachDamping
    }
    const retained = Math.max(0, 1 - bleed * deltaSeconds)
    this.accel.x *= retained
    this.accel.y *= retained

    // Consume the brake flag: each frame's forces set it afresh.
    this.brakedTowardTarget = false
  }

  /** The full visual of this user this frame: its live position, idle fade, size, and identity color. */
  public visualAt(now: number, lastActiveAt: number): ActorVisual {
    return {
      position: { x: this.pos.x, y: this.pos.y },
      alpha: actorAlpha(lastActiveAt, now, this.options.idleMs, this.options.fadeMs),
      size: this.options.size,
      color: colorForActor(this.actor),
    }
  }
}

/**
 * A stable unit vector hashed from an actor id, used as the deterministic escape
 * direction when two bodies sit exactly on top of each other (where Gource kicks in a
 * random direction). Hashing the id keeps the split reproducible on a rewind, so the
 * engine never relies on randomness. Mirrors the hash the layout jitter and theme use.
 */
function hashedUnit(actor: string): Vec2 {
  const hash = hashString(actor)
  const unitX = ((hash & 0xffff) / 0xffff) * 2 - 1
  const unitY = (((hash >>> 16) & 0xffff) / 0xffff) * 2 - 1
  const length = Math.hypot(unitX, unitY) || 1
  return { x: unitX / length, y: unitY / length }
}

/**
 * FNV-1a 32-bit hash of a string. Stable, fast, and dependency-free; mirrors the hash
 * used by the layout jitter, the theme, and the beam field so the engine keeps one
 * hashing story and every offset is deterministic, never random.
 */
function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return hash >>> 0
}
