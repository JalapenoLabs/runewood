// Copyright © 2026 Jalapeno Labs

import type { Vec2 } from '../core/layout'
import type { Hsl } from '../core/theme'

import { colorForActor } from '../core/theme'

/**
 * The pure placement model for actor sprites: the orbs that hover near the files
 * an actor is working on and fade in and out with its activity. It mirrors the
 * node/edge visual modules ({@link import('./nodeVisual')}, {@link import('./edgeVisual')}):
 * it decides *what* an actor looks like (position, opacity, color) from plain
 * inputs, and a backend draws it. Nothing here touches pixi, the DOM, the clock,
 * or randomness.
 *
 * An actor's position anchors on its *most recent* work, then is nudged a SHORT,
 * roughly constant distance into the open space just outside that file, so the actor
 * floats right next to where it is contributing (a short beam from orb to file) like
 * Gource, rather than out at the global periphery. This is the Gource-style placement
 * the user asked for: a contributor hugs its current file, not the canvas corner.
 *
 * Anchoring on recent work (not the all-time centroid) is the fix for "contributors
 * float in the middle": a contributor that touches files spread across the tree has
 * a centroid that averages back to the tree center, so the old centroid anchor sat
 * it dead-center no matter how far out it was actually working. We instead blend the
 * touched-file positions with a strong bias toward the latest touch (see
 * {@link RECENCY_WEIGHT}), so the orb rides out to the leaf the actor is editing now.
 *
 * The outward nudge is a SHORT FIXED offset ({@link DEFAULT_OUTWARD_OFFSET}) along the
 * local outward direction (away from the tree center), NOT a push to "past the cluster
 * radius from the global origin". That global-radius push was the bug behind "orbs flung
 * to the far corner with enormous beams": when an actor's files sat near the center, the
 * cluster radius was small, but for files far out the push scaled to the whole tree and
 * threw the orb to the periphery, miles from its work. A short fixed offset keeps the orb
 * a constant small step outside its file at any tree size, so the beam stays short. A
 * small deterministic drift on top keeps two actors on the same file from stacking
 * exactly. Its fade rises while it is active and decays after its last activity, so an
 * actor that goes quiet dissolves rather than hanging on the canvas. Every value is a
 * pure function of the supplied activity and playhead `now`, so a rewound timeline
 * repaints every actor identically.
 */

/**
 * The live activity of one actor at a moment in time: where it is touching and
 * when it last acted. The controller assembles this from the active event window
 * (the same window that drives the beams), so the actor model never reads the
 * event log itself.
 */
export type ActorActivity = {
  /** Stable actor id; drives the color and the deterministic drift. */
  actor: string
  /**
   * Layout-space positions of the files this actor is currently touching, within
   * the controller's recency window. Empty when the actor has gone quiet but is
   * still fading out; its position then holds at its last known centroid.
   */
  touched: Vec2[]
  /**
   * Layout-space position of the actor's *most-recently-touched* file: the file it
   * is working on right now. The anchor is biased strongly toward this so the orb
   * rides out to where the work currently is, rather than the centroid of every
   * file the actor has touched (which averages to the tree center for spread-out
   * work). Omit when the actor has touched nothing this window (it just went quiet
   * and is fading); the anchor then falls back to the centroid / last-centroid.
   */
  recent?: Vec2
  /** Epoch ms of the actor's most recent activity, for the inactivity fade. */
  lastActiveAt: number
  /**
   * The centroid the actor should fall back to while `touched` is empty (it just
   * went quiet). Lets the controller keep an actor parked where it last worked as
   * it fades, instead of snapping it to the origin. Optional: omit for a brand-new
   * or never-active actor.
   */
  lastCentroid?: Vec2
  /**
   * The actor's current drawn orb position, supplied by the controller from the
   * retained motion. It is the LAST-resort anchor: if a frame can resolve no file
   * position at all (the live file's body has not spawned yet, nothing is touched,
   * and there is no parked centroid), the actor *holds where it already is* rather
   * than being yanked to the tree center. This is the Gource rule made literal: a
   * user is only ever pushed toward its files, never re-seated at the origin, so a
   * momentary "no resolvable file" frame leaves it exactly where it stood. Omit only
   * for an actor that has never been drawn (no orb yet); the controller then skips
   * emitting it for that frame rather than centering it.
   */
  hold?: Vec2
}

/**
 * The pure visual description of an actor, ready for a backend to draw: a
 * world-space `position`, a `0..1` `alpha` (presence, driven by activity), a draw
 * `size` in layout units, and the actor's identity `color`. Library-free, exactly
 * like {@link import('./nodeVisual').NodeVisual}.
 */
export type ActorVisual = {
  /** Layout-space position: the touched-file centroid plus a gentle hashed drift. */
  position: Vec2
  /**
   * Presence opacity, `0..1`. Full while active and through the linger window, then
   * decaying after the long inactivity timeout. A gentle idle breathing modulates it
   * down a little while the actor is parked and waiting (see {@link ActorVisualOptions}).
   */
  alpha: number
  /**
   * Draw size in layout units. While the actor is parked and idle this gently
   * breathes in and out around the base size (the "still here, waiting" pulse),
   * distinct from the punchy node/beam flash on a real edit.
   */
  size: number
  color: Hsl
}

/** Tuning for {@link actorVisualFor}. Every field has a default. */
export type ActorVisualOptions = {
  /**
   * How long after the linger window an actor's sprite takes to fade from full to
   * invisible, in milliseconds. The fade does NOT start at `lastActiveAt`; it starts
   * once {@link lingerMs} has elapsed, so a brief pause never dissolves the actor.
   * Measured against `now`.
   */
  fadeMs?: number
  /**
   * How long an actor stays fully present (parked at its last work, gently idle-
   * pulsing) after its last activity before the fade even begins, in milliseconds.
   * This is the lingering knob (Part C): an LLM agent that edits a file then pauses
   * before the next edit must STAY at its last node rather than fading after a few
   * seconds. Defaults to {@link DEFAULT_LINGER_MS} (effectively "stays for the whole
   * session"); set it shorter to make quiet actors dissolve sooner.
   */
  lingerMs?: number
  /**
   * How long after an actor's last activity the idle breathing begins, in
   * milliseconds. While the actor is freshly active (under this) its orb is steady
   * at full presence; once it has been quiet this long it starts the gentle "still
   * here, waiting" pulse. Kept short so a parked actor visibly breathes, but not so
   * short that an actively-working actor flickers. Defaults to {@link DEFAULT_IDLE_AFTER_MS}.
   */
  idleAfterMs?: number
  /**
   * Period of one idle breath, in milliseconds: a full in-and-out of the pulse. A
   * slow, calm breathing (a couple of seconds) reads as "present and waiting" rather
   * than an alarm. Defaults to {@link DEFAULT_IDLE_PULSE_MS}.
   */
  idlePulseMs?: number
  /**
   * Depth of the idle breathing, `0..1`: the fraction the size and alpha dip at the
   * trough of a breath. Small by design (a gentle swell), distinct from the punchy
   * touch/beam flash on a real edit. `0` disables the pulse. Defaults to
   * {@link DEFAULT_IDLE_PULSE_DEPTH}.
   */
  idlePulseDepth?: number
  /** Draw size of an actor orb, in layout units. */
  size?: number
  /**
   * Peak magnitude of the per-actor deterministic drift off the raw centroid, in
   * layout units. Hashed from the actor id (never randomness) so the same actor
   * always sits at the same offset and two actors on one file separate cleanly.
   */
  drift?: number
  /**
   * The SHORT, roughly constant distance, in layout units, the actor floats just
   * outside its recent file into the open space, measured along the local outward
   * direction (the file's own ray away from the tree center). This is a small FIXED
   * step, NOT a tree-scaled push: the orb sits this far past its file at any tree
   * size, so the beam from orb to file stays short and the actor clearly hugs its
   * work. (The old behavior pushed the orb out to `clusterRadius + margin` from the
   * global origin, which flung it to the canvas periphery whenever its files were far
   * from center, with a beam stretching all the way back; that is the bug this fixes.)
   * An actor working dead-center (anchor at the origin) is offset along its own stable
   * drift direction instead, so it still steps out of the exact middle. `0` places the
   * orb right on its file.
   */
  outwardOffset?: number
  /**
   * The world origin the short outward offset is measured *away from*: the tree center,
   * so the orb steps into the open space on the far side of its file rather than back
   * toward the trunk. Defaults to the layout origin `{ x: 0, y: 0 }`, where the forest
   * is centered.
   */
  origin?: Vec2
}

const DEFAULT_FADE_MS = 3_000
const DEFAULT_SIZE = 10
const DEFAULT_DRIFT = 14

/**
 * How long an actor lingers at full presence after its last activity before the
 * fade begins, in milliseconds (Part C). Defaulted very long (an hour) so that for
 * an active session a contributor effectively never fades from a normal edit-then-
 * pause gap: it stays parked at its last node, idle-pulsing, until it acts again. A
 * host can shorten it to make quiet actors dissolve. This is the fix for "the actor
 * faded away after a few seconds of inactivity".
 */
const DEFAULT_LINGER_MS = 3_600_000

/**
 * How long after the last activity the idle breathing kicks in, in milliseconds. A
 * little under a second: long enough that a mid-edit actor reads as steady, short
 * enough that a parked one starts visibly breathing almost right away.
 */
const DEFAULT_IDLE_AFTER_MS = 800

/** Period of one idle breath (full in-and-out), in milliseconds. A calm ~2.4s cycle. */
const DEFAULT_IDLE_PULSE_MS = 2_400

/**
 * Depth of the idle breath, `0..1`: how far the size and alpha dip at the trough.
 * Gentle (12%) so the orb softly swells and settles, clearly distinct from the
 * punchy full-bright flash a real edit fires on the node and the beam.
 */
const DEFAULT_IDLE_PULSE_DEPTH = 0.12

/**
 * The default SHORT outward offset, in layout units: how far just outside its recent
 * file an actor floats into the open space. A small fixed step (NOT tree-scaled), sized
 * a little larger than a node's hot radius and an orb's own size so the orb reads as
 * hovering right beside its file with a short, crisp beam between them, never flung to
 * the periphery. This is the heart of the "actors hug their files" fix; a judgment call
 * worth tuning to taste.
 */
const DEFAULT_OUTWARD_OFFSET = 60

/**
 * How heavily the anchor favors the actor's most-recent touch over the centroid of
 * everything it is touching, `0..1`. At `1` the anchor is purely the latest file; at
 * `0` it is the plain centroid (the old, buried-in-the-middle behavior). High by
 * design: the whole point is to ride out to where the work *is now*, while the small
 * centroid share keeps the orb from snapping hard between rapid touches. A judgment
 * call worth tuning to taste.
 */
const RECENCY_WEIGHT = 0.8

/**
 * Computes the full visual of an actor at playhead time `now`. Pure and
 * deterministic: it reads only the activity, the time, and the options, never
 * `Date.now()` or randomness.
 *
 * The mapping:
 * - **position** anchors on the actor's most-recent touch (blended with the
 *   touched-files centroid, biased toward the latest file by {@link RECENCY_WEIGHT}),
 *   or `lastCentroid` while the actor is quiet, or its held orb position (never the
 *   origin) as a last resort. That
 *   anchor is then nudged a SHORT fixed `outwardOffset` into the open space along its
 *   local outward direction (away from the tree center), so the actor hugs its file
 *   with a short beam at any tree size, and finally nudged by a small per-actor drift
 *   hashed from the actor id so co-located actors don't overlap.
 * - **alpha** stays full through the `lingerMs` window after the last activity (so a
 *   brief edit-then-pause gap never fades the actor out, Part C), then decays
 *   linearly to 0 over `fadeMs`. A gentle idle breath modulates it down a little
 *   while the actor is parked and waiting.
 * - **size** is the orb's base size, gently breathing in and out around it once the
 *   actor goes idle (the "still here, waiting" pulse), distinct from the punchy
 *   edit flash. **color** is the actor's constant identity hue.
 */
export function actorVisualFor(activity: ActorActivity, now: number, options: ActorVisualOptions = {}): ActorVisual {
  const fadeMs = options.fadeMs ?? DEFAULT_FADE_MS
  const lingerMs = options.lingerMs ?? DEFAULT_LINGER_MS
  const idleAfterMs = options.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS
  const idlePulseMs = options.idlePulseMs ?? DEFAULT_IDLE_PULSE_MS
  const idlePulseDepth = options.idlePulseDepth ?? DEFAULT_IDLE_PULSE_DEPTH
  const size = options.size ?? DEFAULT_SIZE
  const drift = options.drift ?? DEFAULT_DRIFT
  const outwardOffset = options.outwardOffset ?? DEFAULT_OUTWARD_OFFSET
  const origin = options.origin ?? { x: 0, y: 0 }

  // Anchor on where the actor is working *now*: the most-recent file, blended only
  // lightly with the centroid of everything it is touching. This is the fix for the
  // orb sitting dead-center: a spread-out contributor's centroid averages back to the
  // tree center, but its latest touch is out at a leaf, so the recency-biased anchor
  // rides out there with the work.
  const anchor = anchorOf(activity)
  const floated = floatOutsideFile(anchor, origin, outwardOffset, activity.actor)
  const driftOffset = actorDrift(activity.actor, drift)
  const position = {
    x: floated.x + driftOffset.x,
    y: floated.y + driftOffset.y,
  }

  // Presence: full through the linger window, then fading. A brief edit-then-pause
  // gap therefore does NOT dissolve the actor (Part C); it stays parked.
  const presence = lingeringFade(activity.lastActiveAt, now, lingerMs, fadeMs)
  // The idle breathing: a gentle swell once the actor has been quiet a moment, the
  // "still here, waiting" read. It modulates both alpha and size by the same factor
  // so the orb softly breathes; it is bounded and distinct from the punchy edit flash.
  const breath = idleBreath(activity.lastActiveAt, now, idleAfterMs, idlePulseMs, idlePulseDepth)

  return {
    position,
    alpha: presence * breath,
    size: size * breath,
    color: colorForActor(activity.actor),
  }
}

/**
 * The actor's anchor before the outward push: a recency-weighted blend of its
 * most-recent touch and the centroid of everything it is touching. The blend leans
 * hard toward the recent touch ({@link RECENCY_WEIGHT}), so the orb tracks the file
 * being edited now rather than the average of every file the actor has touched (the
 * average is what pinned it to the tree center for cross-tree work).
 *
 * Falls back gracefully, and NEVER to the tree center: with no recent touch it is
 * the plain centroid; with no touches at all it is the parked `lastCentroid` (a
 * quiet, fading actor); with none of those it is the actor's current orb position
 * (`hold`), so a frame that can resolve no file leaves the actor exactly where it
 * already stood rather than yanking it to the origin. The origin is used only as a
 * logged, should-never-happen guard for an actor with no history and no orb at all
 * (the controller skips emitting that case upstream, so it is unreachable in
 * practice).
 */
function anchorOf(activity: ActorActivity): Vec2 {
  const centroid = centroidOf(activity.touched, activity.lastCentroid, activity.hold)
  if (!activity.recent) {
    return centroid
  }
  return {
    x: activity.recent.x * RECENCY_WEIGHT + centroid.x * (1 - RECENCY_WEIGHT),
    y: activity.recent.y * RECENCY_WEIGHT + centroid.y * (1 - RECENCY_WEIGHT),
  }
}

/**
 * Floats the `anchor` a SHORT fixed `offset` into the open space just outside its file,
 * stepping along the local outward direction (the unit ray from `origin`, the tree
 * center, through the anchor). So the orb lands `offset` beyond its recent file, hugging
 * it with a short beam, at ANY tree size.
 *
 * This deliberately does NOT scale to the tree (the old `clusterRadius + margin` push
 * from the global origin). That scaling is exactly what flung an actor to the canvas
 * periphery when its files sat far from center, stretching the beam across the whole
 * view. A constant step keeps the orb a fixed small distance off its file instead.
 *
 * When the anchor coincides with the origin there is no outward direction to step along,
 * so the actor's stable hashed drift direction is used instead, nudging a dead-center
 * actor out of the exact middle by the same short offset in its own consistent direction.
 */
function floatOutsideFile(anchor: Vec2, origin: Vec2, offset: number, actor: string): Vec2 {
  const directionX = anchor.x - origin.x
  const directionY = anchor.y - origin.y
  const anchorRadius = Math.hypot(directionX, directionY)

  if (anchorRadius === 0) {
    // Anchor is the tree center: no outward ray. Step out along the actor's own hashed
    // drift direction so it still leaves the exact middle deterministically.
    const fallback = actorDrift(actor, 1)
    const fallbackLength = Math.hypot(fallback.x, fallback.y) || 1
    return {
      x: anchor.x + (fallback.x / fallbackLength) * offset,
      y: anchor.y + (fallback.y / fallbackLength) * offset,
    }
  }

  // Step the SHORT fixed `offset` further out along the file's own outward ray, so the
  // orb sits just past its file in the open space rather than scaled out to the periphery.
  return {
    x: anchor.x + (directionX / anchorRadius) * offset,
    y: anchor.y + (directionY / anchorRadius) * offset,
  }
}

/**
 * The centroid (mean) of the touched-file positions. Falls back, in order and NEVER
 * to the tree center: to `lastCentroid` when the actor is touching nothing this
 * window (it just went quiet but is still fading), then to `hold` (its current orb
 * position) when there is no parked centroid either, so a frame that resolves no file
 * keeps the actor exactly where it already is. The origin is returned only when there
 * is no history AND no orb whatsoever, an unexpected state the controller filters out
 * upstream; it is logged because it should never be reached, not silently centered.
 */
function centroidOf(touched: Vec2[], lastCentroid: Vec2 | undefined, hold: Vec2 | undefined): Vec2 {
  if (touched.length === 0) {
    if (lastCentroid) {
      return lastCentroid
    }
    if (hold) {
      // No file and no parked centroid: hold the actor where it already is rather
      // than pulling it to the center. This is the Gource "only ever pushed toward
      // files" rule for the one-frame gap before a brand-new file's body spawns.
      return hold
    }
    console.debug('runewood: actor has no touched files, no last centroid, and no held position; placing at origin')
    return { x: 0, y: 0 }
  }

  let sumX = 0
  let sumY = 0
  for (const position of touched) {
    sumX += position.x
    sumY += position.y
  }
  return { x: sumX / touched.length, y: sumY / touched.length }
}

/**
 * The presence opacity for a lingering actor (Part C). It stays full (`1`) for the
 * whole `lingerMs` window after the last activity, so a brief edit-then-pause gap
 * never fades the actor out, then decays linearly to `0` over `fadeMs` once the
 * linger has elapsed. Clamped so a long-idle actor reads as gone, not negative. An
 * actor acting in the future relative to `now` (which the controller should never
 * produce) is treated as fully present rather than over-bright.
 *
 * With the default very-long `lingerMs`, an actor in an active session effectively
 * never fades from a normal pause; a host that wants quiet actors to dissolve sets a
 * shorter `lingerMs`.
 */
function lingeringFade(lastActiveAt: number, now: number, lingerMs: number, fadeMs: number): number {
  const elapsed = now - lastActiveAt
  if (elapsed <= lingerMs) {
    // Inside the linger window (including any future-dated activity): fully present.
    return 1
  }
  // Past the linger: fade over `fadeMs` from the end of the linger window.
  const sinceFadeStart = elapsed - lingerMs
  const remaining = 1 - sinceFadeStart / fadeMs
  return Math.max(0, Math.min(1, remaining))
}

/**
 * The idle breathing factor for an actor (Part C): a gentle, bounded swell of size
 * and alpha that reads as "this contributor is here, waiting". It is exactly `1`
 * (no breathing) while the actor is freshly active (within `idleAfterMs` of its last
 * activity) so a working actor stays steady, then eases into a slow cosine breath
 * once it goes quiet. The breath stays within `[1 - depth, 1]`, so it only ever dims
 * the orb a little and never brightens it past full, keeping it clearly distinct from
 * the punchy, full-bright flash a real edit fires on the node and the beam.
 *
 * Pure: the phase is derived from the elapsed playhead time, never the wall clock,
 * so a rewound timeline reproduces the exact same breath.
 */
function idleBreath(
  lastActiveAt: number,
  now: number,
  idleAfterMs: number,
  idlePulseMs: number,
  idlePulseDepth: number,
): number {
  const elapsed = now - lastActiveAt
  if (idlePulseDepth <= 0 || idlePulseMs <= 0 || elapsed <= idleAfterMs) {
    return 1
  }
  // A cosine that starts at the top of the breath (factor 1) the instant idling
  // begins and dips to `1 - depth` at the trough, half a period later. Phase is the
  // time spent idling, so the breath is continuous and seek-exact.
  const idleElapsed = elapsed - idleAfterMs
  const phase = (idleElapsed / idlePulseMs) * Math.PI * 2
  // cos goes 1 -> -1 -> 1; map it to 1 -> (1 - depth) -> 1 so the orb only dims.
  const breath = 1 - idlePulseDepth * (1 - Math.cos(phase)) / 2
  return breath
}

/**
 * One actor's target position, the unit {@link separateActorTargets} operates on.
 * The `actor` id is carried so a perfectly-coincident pair can be split along a
 * stable, per-actor direction rather than randomly.
 */
export type ActorTarget = {
  actor: string
  position: Vec2
}

/**
 * Gentle mutual repulsion between actor targets so two contributors working near
 * each other do not stack into one orb (Gource's `RUser::applyForceUser` personal
 * space, ported pure). Any pair closer than `personalSpace` is pushed apart along the
 * line between them by half the shortfall each, so the pair ends up roughly
 * `personalSpace` apart while staying centered on where they were. A perfectly
 * coincident pair (no line between them) is split along each actor's stable hashed
 * direction so the result is deterministic, never random like Gource's jitter.
 *
 * This complements the per-actor {@link actorDrift} (which already offsets each actor
 * by a constant hashed nudge): drift keeps a single actor's orb off its exact file,
 * while this resolves the remaining overlap between DIFFERENT actors whose files
 * happen to sit on top of each other. It is a pure function of its inputs (a single
 * relaxation pass, no clock, no randomness), so a rewound timeline separates the same
 * actors identically. `personalSpace <= 0` disables it (returns the inputs unchanged).
 */
export function separateActorTargets(targets: ActorTarget[], personalSpace: number): Vec2[] {
  const positions = targets.map((target) => ({ x: target.position.x, y: target.position.y }))
  if (personalSpace <= 0) {
    return positions
  }

  for (let outer = 0; outer < targets.length; outer++) {
    for (let inner = outer + 1; inner < targets.length; inner++) {
      const first = positions[outer]
      const second = positions[inner]
      let directionX = second.x - first.x
      let directionY = second.y - first.y
      let distance = Math.hypot(directionX, directionY)

      if (distance >= personalSpace) {
        continue
      }

      if (distance < 1e-6) {
        // Perfectly coincident: there is no line to push along, so split the pair
        // along each actor's own stable hashed direction (deterministic, unlike
        // Gource's random kick) so two orbs on the exact same file still separate. The
        // gap is treated as zero (they fully open to `personalSpace`); the drift only
        // gives the direction, so its raw length must not leak into the push distance.
        const firstDrift = actorDrift(targets[outer].actor, 1)
        const driftLength = Math.hypot(firstDrift.x, firstDrift.y) || 1
        directionX = -firstDrift.x / driftLength
        directionY = -firstDrift.y / driftLength
        distance = 0
      }
      else {
        directionX /= distance
        directionY /= distance
      }

      // `directionX/Y` are now a unit vector along the separation line. Push each target
      // half of the shortfall apart along it, so the midpoint stays put and the pair
      // opens up to `personalSpace`.
      const push = (personalSpace - distance) / 2
      first.x -= directionX * push
      first.y -= directionY * push
      second.x += directionX * push
      second.y += directionY * push
    }
  }

  return positions
}

/**
 * A stable per-actor positional nudge, hashed from the actor id so the same actor
 * always sits at the same small offset off the raw centroid. This keeps two
 * actors working the same file from drawing exactly on top of each other, and
 * gives each actor a consistent "personal space" around its files. Mirrors the
 * layout jitter: two unit values in [-1, 1] from disjoint hash bit fields.
 */
function actorDrift(actor: string, amount: number): Vec2 {
  if (amount === 0) {
    return { x: 0, y: 0 }
  }
  const hash = hashString(actor)
  const unitX = ((hash & 0xffff) / 0xffff) * 2 - 1
  const unitY = (((hash >>> 16) & 0xffff) / 0xffff) * 2 - 1
  return { x: unitX * amount, y: unitY * amount }
}

/**
 * FNV-1a 32-bit hash of a string. Stable, fast, and dependency-free; mirrors the
 * hash used by the layout jitter, the theme, and the beam field so the engine
 * keeps one hashing story and every offset is deterministic, never random.
 */
function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return hash >>> 0
}
