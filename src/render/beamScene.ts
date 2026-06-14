// Copyright © 2026 Jalapeno Labs

import type { Container } from 'pixi.js'
import type { Vec2 } from '../core/layout'
import type { RunewoodTheme } from '../core/theme'
import type { BeamFieldOptions, ActiveBeam, BeamEndpointResolver } from './beams'
import type { ActorActivity, ActorVisualOptions } from './actors'
import type { ActorMotionOptions } from './actorMotion'

// Core
import { Graphics } from 'pixi.js'

import { hslToRgbInt } from './color'
import { BeamField } from './beams'
import { actorVisualFor } from './actors'
import { ActorMotion } from './actorMotion'

/**
 * The retained beam/particle layer that sits *above* the forest (issue #6, and as
 * the author of #5 asked, a retained layer rather than the immediate-mode
 * `drawBeam`). It mirrors the {@link import('./scene').Scene} pattern: it owns
 * persistent pixi {@link Graphics} parented into a single world container the
 * backend hands it, redraws them in place every frame, and is the only place
 * besides the backend allowed to know about pixi. The pure simulation
 * ({@link BeamField}), the pure actor placement model ({@link actorVisualFor}), and
 * the pure actor motion model ({@link ActorMotion}) decide *what* to draw; this class
 * only translates that onto pixi objects.
 *
 * Two kinds of thing live here, both additively blended for a glow that reads
 * above the forest:
 * - **beams**: the brief tapered flashlight pulses flung from actors to touched
 *   files, drawn from the {@link BeamField}'s active set into one pooled `Graphics`
 *   cleared and refilled each frame. Each beam's endpoints are resolved LIVE every
 *   frame (see below): its source is the firing actor's live eased orb position and
 *   its target is the touched node's live physics position, so the beam flies from the
 *   contributor's orb to the actual file node and tracks it as the sim migrates it.
 * - **actors**: one retained orb `Graphics` per actor, keyed by actor id, created
 *   when an actor first appears and culled once it has fully faded out. The orb does
 *   not snap to its computed placement; it **swoops in** from the open space and
 *   **glides** to rest there via a retained {@link ActorMotion} (the Gource-style
 *   arrival), then stays put until it acts again.
 *
 * ### Actor motion (the "actors teleport and freeze" fix)
 *
 * The placement model ({@link actorVisualFor}) gives each actor the *target* it wants
 * to rest at (the outward recency anchor) plus its presence (lingering fade + idle
 * breath). Rather than snapping the orb there every frame, each actor carries an
 * {@link ActorMotion} that eases its drawn position toward that target with an
 * ease-out and ramps its opacity in on appearance. So an orb fades in fast, glides
 * inward from the open space, comes gently to rest, and then holds (the idle breath
 * still plays on top). The motion is driven by the real frame delta, like the
 * force-directed node sim it rides above.
 *
 * The controller (#9) owns the playhead and the active event window; it spawns
 * beams via {@link spawn}/{@link spawnPulse}, supplies actor activity + the live node
 * position lookup + the frame delta each frame, and calls {@link clear} on a backward
 * seek so transient particles are dropped rather than reversed.
 */
export class BeamScene {
  /** The world container all beam/actor glow is parented into, above the forest. */
  private readonly layer: Container
  /** The pure particle simulation. This class never re-implements its math. */
  private readonly field: BeamField
  /** Tuning for the actor placement model, forwarded verbatim each frame. */
  private readonly actorOptions: ActorVisualOptions
  /** Tuning for the actor motion (glide + opacity ramp + swoop), forwarded to each {@link ActorMotion}. */
  private readonly motionOptions: ActorMotionOptions

  /** One batched graphic holding every live beam this frame, cleared and refilled. */
  private readonly beamGraphics: Graphics
  /** Retained actor orb graphics, keyed by actor id. */
  private readonly actorGraphics: Map<string, Graphics>
  /**
   * Retained per-actor motion state (the eased drawn position + opacity ramp), keyed
   * by actor id. Holds the orb's live position so a beam fired by this actor can
   * resolve its source from where the orb actually is, and so the orb glides rather
   * than teleporting. Culled in lockstep with {@link actorGraphics}.
   */
  private readonly actorMotion: Map<string, ActorMotion>

  /**
   * @param layer the world container for beams/actors, added above the forest
   *   layers so the glow reads on top of the wood.
   */
  constructor(layer: Container, options: BeamSceneOptions = {}) {
    this.layer = layer
    this.field = new BeamField(options.beams)
    this.actorOptions = options.actors ?? {}
    this.motionOptions = options.motion ?? {}

    this.beamGraphics = new Graphics()
    // Additive blend so overlapping beams build toward white, the way real bloom
    // stacks, rather than painting flatly over each other.
    this.beamGraphics.blendMode = 'add'
    this.layer.addChild(this.beamGraphics)

    this.actorGraphics = new Map()
    this.actorMotion = new Map()
  }

  /**
   * The live, eased drawn position of an actor's orb this frame, or `null` if the actor
   * has no live orb (it has not appeared yet or has fully faded). This is the EXACT
   * position the orb is drawn at, read straight off the same retained {@link ActorMotion}
   * the draw uses, so a caller anchoring the actor's label here lands it precisely on the
   * orb rather than on the touched-files centroid (which the orb glides away from). It is
   * valid only after {@link update} has advanced the motion this frame.
   */
  public actorOrbPosition(actor: string): Vec2 | null {
    return this.actorMotion.get(actor)?.drawnPosition ?? null
  }

  /** Spawns a beam from an actor to a touched file (by path; resolved live). See {@link BeamField.spawn}. */
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
   * Actors are advanced FIRST so their orbs have a current drawn position this frame,
   * then the beams are drawn resolving each source from that live orb position and
   * each target from the live `nodePosition` lookup. Beams are drawn into a single
   * cleared graphic (their count swings every frame, so one batched object is cheaper
   * than churning a graphic per beam). Actors are retained per id and culled once
   * fully faded.
   *
   * @param activities the actor activity this frame (drives each orb's target + presence).
   * @param now the playhead time, for the pure placement/presence model.
   * @param deltaMs the real elapsed wall time for the frame, driving the orb glide +
   *   opacity ramp (forward-only motion), like the node sim's step.
   * @param nodePosition the live node position lookup by path, so a beam's target
   *   follows the node as the force sim migrates it; returns `null` for a node that no
   *   longer exists (the beam then ends gracefully).
   * @param theme the active theme (bloom intensity).
   * @param zoom the live camera zoom (world-units-to-pixels), used to floor the actor
   *   orb radius at a constant on-screen size so an actor never shrinks to an
   *   unreadable dot as the forest grows and the camera pulls out.
   */
  public update(
    activities: ActorActivity[],
    now: number,
    deltaMs: number,
    nodePosition: (path: string) => Vec2 | null,
    theme: RunewoodTheme,
    zoom: number,
  ): void {
    // Advance + draw the actor orbs first so their live drawn positions exist for the
    // beams to fire from this same frame.
    this.drawActors(activities, now, deltaMs, theme, zoom)

    // Resolve each beam's source from the actor's live orb position and its target
    // from the live node lookup, so beams fly from the orb to the actual node and
    // track it. An actor with no live orb (faded out) or a missing target node ends
    // the beam gracefully (the resolver returns null and the field drops it).
    const resolver: BeamEndpointResolver = {
      actorSource: (actor) => this.actorMotion.get(actor)?.drawnPosition ?? null,
      nodePosition,
    }
    this.drawBeams(this.field.activeBeams(now, resolver), theme)
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
   * Reconciles the retained actor orbs with the supplied activity: glides each orb
   * toward its modeled target (rather than snapping it there), draws it at its eased
   * position and ramped-in opacity, and culls any retained actor no longer present in
   * `activities` or fully faded so the layer never keeps a dead orb around.
   *
   * The placement model gives the orb its *target* (the outward recency anchor) and
   * presence (lingering fade + idle breath); the retained {@link ActorMotion} eases
   * the drawn position toward that target and ramps opacity in on appearance, so the
   * orb swoops in and glides to rest rather than teleporting. A reappearing actor
   * (its motion was culled when it fully faded) starts a fresh swoop.
   */
  private drawActors(
    activities: ActorActivity[],
    now: number,
    deltaMs: number,
    theme: RunewoodTheme,
    zoom: number,
  ): void {
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
        // Fully faded: cull it (and its motion) rather than draw an invisible orb. A
        // later reappearance starts a fresh swoop from the open space.
        this.removeActor(activity.actor)
        continue
      }
      present.add(activity.actor)

      // The target the orb wants to rest at this frame (the placement model's outward
      // recency position). The retained motion eases the drawn position toward it.
      const target = visual.position
      let motion = this.actorMotion.get(activity.actor)
      if (!motion) {
        // First appearance (or a reappearance after a full fade): start OUT in the
        // open space and swoop in.
        motion = new ActorMotion(target, this.motionOptions)
        this.actorMotion.set(activity.actor, motion)
      }
      // Glide the drawn position toward the target and ramp opacity in. The ramp
      // multiplies the modeled presence so the orb fades in as it swoops, then rides
      // the model's lingering fade + idle breath once arrived.
      const rampAlpha = motion.advance(target, deltaMs)
      const drawn = motion.drawnPosition

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
        .fill({ color, alpha: visual.alpha * rampAlpha * theme.bloomIntensity })
      graphics.position.set(drawn.x, drawn.y)
    }

    // Cull retained actors the controller no longer reports at all (their window
    // dropped them), so a quiet actor's orb does not linger.
    for (const actor of [ ...this.actorGraphics.keys() ]) {
      if (!present.has(actor)) {
        this.removeActor(actor)
      }
    }
  }

  /** Tears down one actor's retained orb graphic and its motion state. */
  private removeActor(actor: string): void {
    const graphics = this.actorGraphics.get(actor)
    if (graphics) {
      graphics.destroy()
      this.actorGraphics.delete(actor)
    }
    // Drop the motion too so a reappearance swoops in fresh rather than resuming from
    // a stale drawn position.
    this.actorMotion.delete(actor)
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
  /** Tuning for the actor swoop-in / glide / ease-to-rest motion. See {@link ActorMotionOptions}. */
  motion?: ActorMotionOptions
}
