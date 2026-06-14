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
 *   batched graphic beats one persistent object per beam). Each is a *stack* of
 *   additive tapered triangles (see {@link BEAM_GLOW_LAYERS}): a bright thin core
 *   over a couple of wider, dimmer layers, so the beam reads as a soft glow of light
 *   rather than a hard-edged wedge. Wide and bright at the actor, narrowing to the
 *   file, fading over its short lifetime.
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
   * Refills the single batched beam graphic from the active set. Each beam is drawn
   * as a *stack* of additive tapered triangles rather than one flat one, which is
   * what turns the old hard "sharp triangle" into a glowy pulse of light: a bright,
   * thin core triangle with a couple of progressively wider, dimmer triangles layered
   * under it. Because the layers are additively blended, the overlap sums to a hot
   * bright core that falls off softly to the sides, the way real light blooms, so the
   * beam reads as snappy and polished instead of a flat wedge with a hard edge.
   *
   * Each triangle spans the beam's current width at the actor (source) end and
   * narrows to the touched file (target), so the beam still reads as a flashlight
   * cone narrowing onto the file. A degenerate zero-length beam (source == target)
   * is skipped since it has no direction to give width.
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

      // The unit perpendicular to the beam, to spread each layer's source-end width
      // symmetrically across the beam on both sides.
      const perpendicularX = -directionY / length
      const perpendicularY = directionX / length
      const color = hslToRgbInt(beam.color)

      // Stack the soft layers widest-and-dimmest first so the bright thin core lands
      // on top. The additive blend sums the overlap into a hot core with a soft
      // falloff to the edges. The theme's bloom scales the whole stack so a restrained
      // theme glows gently; the beam's own lifetime fade rides in `beam.alpha`.
      for (const layer of BEAM_GLOW_LAYERS) {
        const halfWidth = (beam.width * layer.widthScale) / 2
        const leftX = beam.source.x + perpendicularX * halfWidth
        const leftY = beam.source.y + perpendicularY * halfWidth
        const rightX = beam.source.x - perpendicularX * halfWidth
        const rightY = beam.source.y - perpendicularY * halfWidth

        this.beamGraphics
          .poly([ leftX, leftY, rightX, rightY, beam.target.x, beam.target.y ])
          .fill({ color, alpha: beam.alpha * layer.alphaScale * theme.bloomIntensity })
      }
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

/**
 * The additive layers each beam is drawn from, widest-and-dimmest first so the
 * bright thin core lands on top. Stacking these with an additive blend turns the
 * flat "sharp triangle" into a soft glow: the wide low-alpha layers spread a haze to
 * the sides while the narrow high-alpha core stays hot, and the sums fall off softly
 * from the center out. `widthScale` is a multiple of the beam's current width;
 * `alphaScale` is a multiple of its current alpha. Tuned so the core reads crisp and
 * the halo trails off gently; a judgment call worth tuning to taste.
 */
const BEAM_GLOW_LAYERS = [
  { widthScale: 2.6, alphaScale: 0.18 },
  { widthScale: 1.7, alphaScale: 0.30 },
  { widthScale: 1.0, alphaScale: 0.85 },
] as const

/** Construction options for a {@link BeamScene}; forwards tuning to the pure models. */
export type BeamSceneOptions = {
  beams?: BeamFieldOptions
  actors?: ActorVisualOptions
}
