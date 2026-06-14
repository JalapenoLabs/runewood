// Copyright © 2026 Jalapeno Labs

import type { Container } from 'pixi.js'
import type { RunewoodTheme } from '../core/theme'
import type { BeamFieldOptions, ActiveBeam } from './beams'
import type { ActorActivity, ActorVisualOptions } from './actors'

// Core
import { Graphics } from 'pixi.js'

import { hslToRgbInt } from './color'
import { BeamField } from './beams'
import { actorVisualFor } from './actors'

/**
 * The retained beam/particle layer that sits *above* the forest (issue #6, and as
 * the author of #5 asked, a retained layer rather than the immediate-mode
 * `drawBeam`). It mirrors the {@link import('./scene').Scene} pattern: it owns
 * persistent pixi {@link Graphics} parented into a single world container the
 * backend hands it, redraws them in place every frame, and is the only place
 * besides the backend allowed to know about pixi. The pure simulation
 * ({@link BeamField}) and the pure actor model ({@link actorVisualFor}) decide
 * *what* to draw; this class only translates that onto pixi objects.
 *
 * Two kinds of thing live here, both additively blended for a glow that reads
 * above the forest:
 * - **beams**: the brief tapered flashlight pulses flung from actors to touched
 *   files, drawn from the {@link BeamField}'s active set into one pooled `Graphics`
 *   cleared and refilled each frame (the live beam count is volatile, so one
 *   batched graphic beats one persistent object per beam). Each is a soft additive
 *   tapered triangle: wide and bright at the actor, narrowing to the file, fading
 *   over its short lifetime.
 * - **actors**: one retained orb `Graphics` per actor, keyed by actor id, created
 *   when an actor first appears and culled once it has fully faded out.
 *
 * The controller (#9) owns the playhead and the active event window; it spawns
 * beams via {@link spawn}/{@link spawnPulse}, supplies actor activity each frame,
 * and calls {@link clear} on a backward seek so transient particles are dropped
 * rather than reversed.
 */
export class BeamScene {
  /** The world container all beam/actor glow is parented into, above the forest. */
  private readonly layer: Container
  /** The pure particle simulation. This class never re-implements its math. */
  private readonly field: BeamField
  /** Tuning for the actor visual model, forwarded verbatim each frame. */
  private readonly actorOptions: ActorVisualOptions

  /** One batched graphic holding every live beam this frame, cleared and refilled. */
  private readonly beamGraphics: Graphics
  /** Retained actor orb graphics, keyed by actor id. */
  private readonly actorGraphics: Map<string, Graphics>

  /**
   * @param layer the world container for beams/actors, added above the forest
   *   layers so the glow reads on top of the wood.
   */
  constructor(layer: Container, options: BeamSceneOptions = {}) {
    this.layer = layer
    this.field = new BeamField(options.beams)
    this.actorOptions = options.actors ?? {}

    this.beamGraphics = new Graphics()
    // Additive blend so overlapping beams build toward white, the way real bloom
    // stacks, rather than painting flatly over each other.
    this.beamGraphics.blendMode = 'add'
    this.layer.addChild(this.beamGraphics)

    this.actorGraphics = new Map()
  }

  /** Spawns a beam from an actor to a touched file. See {@link BeamField.spawn}. */
  public spawn(spawn: Parameters<BeamField['spawn']>[0]): void {
    this.field.spawn(spawn)
  }

  /** Spawns an actor-local pulse burst (no target). See {@link BeamField.spawnPulse}. */
  public spawnPulse(spawn: Parameters<BeamField['spawnPulse']>[0]): void {
    this.field.spawnPulse(spawn)
  }

  /**
   * Redraws every live particle and actor at playhead time `now`. Call once per
   * frame between the backend's `beginFrame` and `endFrame`, after the forest
   * scene's own update so the beams layer on top.
   *
   * Beams are drawn into a single cleared graphic (their count swings every frame,
   * so one batched object is cheaper than churning a graphic per beam). Actors are
   * retained per id and culled once fully faded.
   *
   * @param zoom the live camera zoom (world-units-to-pixels), used to floor the
   *   actor orb radius at a constant on-screen size so an actor never shrinks to an
   *   unreadable dot as the forest grows and the camera pulls out.
   */
  public update(activities: ActorActivity[], now: number, theme: RunewoodTheme, zoom: number): void {
    this.drawBeams(this.field.activeBeams(now), theme)
    this.drawActors(activities, now, theme, zoom)
  }

  /**
   * Drops all in-flight beams (a backward seek; the issue says clear, don't
   * reverse). Actors are left to fade on their own from the activity the
   * controller supplies, so only the beam field and its graphic are emptied.
   */
  public clear(): void {
    this.field.clear()
    this.beamGraphics.clear()
  }

  /** Removes every retained graphic. Call when tearing the scene down. */
  public dispose(): void {
    this.beamGraphics.destroy()
    for (const actor of [ ...this.actorGraphics.keys() ]) {
      this.removeActor(actor)
    }
  }

  /**
   * Refills the single batched beam graphic from the active set. Each beam is a
   * soft additive tapered triangle: two points spanning the beam's current width at
   * the actor (source) end and one point at the touched file (target), so it reads
   * as a flashlight cone narrowing onto the file rather than a stream of bullets.
   * A degenerate zero-length beam (source == target, e.g. a beam to a node sitting
   * on the actor) is skipped since it has no direction to give width.
   */
  private drawBeams(beams: ActiveBeam[], theme: RunewoodTheme): void {
    this.beamGraphics.clear()
    for (const beam of beams) {
      const directionX = beam.target.x - beam.source.x
      const directionY = beam.target.y - beam.source.y
      const length = Math.hypot(directionX, directionY)
      if (length === 0) {
        continue
      }

      // The unit perpendicular to the beam, to spread the wide source end across
      // the beam's current half-width on each side.
      const perpendicularX = -directionY / length
      const perpendicularY = directionX / length
      const halfWidth = beam.width / 2

      const leftX = beam.source.x + perpendicularX * halfWidth
      const leftY = beam.source.y + perpendicularY * halfWidth
      const rightX = beam.source.x - perpendicularX * halfWidth
      const rightY = beam.source.y - perpendicularY * halfWidth

      const color = hslToRgbInt(beam.color)
      this.beamGraphics
        .poly([ leftX, leftY, rightX, rightY, beam.target.x, beam.target.y ])
        // Bloom scales with the theme so a restrained theme glows gently; alpha
        // already carries the beam's own lifetime fade.
        .fill({ color, alpha: beam.alpha * theme.bloomIntensity })
    }
  }

  /**
   * Reconciles the retained actor orbs with the supplied activity: redraws each
   * actor's orb at its modeled position/alpha, and culls any retained actor no
   * longer present in `activities` or fully faded so the layer never keeps a dead
   * orb around.
   */
  private drawActors(activities: ActorActivity[], now: number, theme: RunewoodTheme, zoom: number): void {
    const present = new Set<string>()

    // Floor the orb radius at a constant on-screen size. Orbs are drawn in world
    // units that the camera scales by `zoom`, so a "little opus dude" shrinks to an
    // unreadable dot once the camera pulls far out as the repo grows. Dividing the
    // screen-pixel floor by the live zoom yields the world radius that lands on
    // exactly that many screen pixels, so an actor stays roughly constant on screen
    // and you can always tell who is doing what. The `max` only ever enlarges a
    // too-small orb; up close the world size wins and nothing changes.
    const minWorldRadius = zoom > 0
      ? MIN_ACTOR_SCREEN_PX / zoom
      : 0

    for (const activity of activities) {
      const visual = actorVisualFor(activity, now, this.actorOptions)
      if (visual.alpha <= 0) {
        // Fully faded: cull it rather than draw an invisible orb.
        this.removeActor(activity.actor)
        continue
      }
      present.add(activity.actor)

      let graphics = this.actorGraphics.get(activity.actor)
      if (!graphics) {
        graphics = new Graphics()
        graphics.blendMode = 'add'
        this.layer.addChild(graphics)
        this.actorGraphics.set(activity.actor, graphics)
      }

      const radius = Math.max(visual.size, minWorldRadius)
      const color = hslToRgbInt(visual.color)
      graphics.clear()
      graphics
        .circle(0, 0, radius)
        .fill({ color, alpha: visual.alpha * theme.bloomIntensity })
      graphics.position.set(visual.position.x, visual.position.y)
    }

    // Cull retained actors the controller no longer reports at all (their window
    // dropped them), so a quiet actor's orb does not linger.
    for (const actor of [ ...this.actorGraphics.keys() ]) {
      if (!present.has(actor)) {
        this.removeActor(actor)
      }
    }
  }

  /** Tears down one actor's retained orb graphic. */
  private removeActor(actor: string): void {
    const graphics = this.actorGraphics.get(actor)
    if (graphics) {
      graphics.destroy()
      this.actorGraphics.delete(actor)
    }
  }
}

/**
 * The minimum on-screen radius, in screen pixels, an actor orb is ever drawn at.
 * The world radius is floored at `MIN_ACTOR_SCREEN_PX / zoom` so an actor stays
 * roughly this size on screen no matter how far the camera zooms out, keeping the
 * "who is doing what" orb readable as the forest grows around it.
 */
const MIN_ACTOR_SCREEN_PX = 9

/** Construction options for a {@link BeamScene}; forwards tuning to the pure models. */
export type BeamSceneOptions = {
  beams?: BeamFieldOptions
  actors?: ActorVisualOptions
}
