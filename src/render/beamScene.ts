// Copyright © 2026 Jalapeno Labs

import type { Container } from 'pixi.js'
import type { Vec2 } from '../core/layout'
import type { RunewoodTheme } from '../core/theme'
import type { BeamFieldOptions, ActiveBeam, BeamEndpointResolver } from './beams'
import type { ActorActivity, ActorUserOptions } from './actors'

// Core
import { BlurFilter, Graphics } from 'pixi.js'

import { hslToRgbInt } from './color'
import { BeamField } from './beams'
import { ActorUser } from './actors'

/**
 * The retained beam/particle layer that sits *above* the forest (issue #6, and as
 * the author of #5 asked, a retained layer rather than the immediate-mode
 * `drawBeam`). It mirrors the {@link import('./scene').Scene} pattern: it owns
 * persistent pixi {@link Graphics} parented into a single world container the
 * backend hands it, redraws them in place every frame, and is the only place
 * besides the backend allowed to know about pixi. The pure beam simulation
 * ({@link BeamField}) and the Gource actor physics ({@link ActorUser}) decide *what* to
 * draw; this class only translates that onto pixi objects.
 *
 * Two kinds of thing live here, both additively blended for a glow that reads
 * above the forest:
 * - **beams**: the brief, soft flashlight cones flung from actors to touched files,
 *   drawn from the {@link BeamField}'s active set into one pooled `Graphics` cleared
 *   and refilled each frame, then blurred into a fuzzy glow. The cone's single point
 *   sits at the actor and it fans out onto the file, like a flashlight hitting it. Each
 *   beam's endpoints are resolved LIVE every frame (see below): its source is the firing
 *   actor's live user position and its target is the touched node's live physics
 *   position, so the beam flies from the contributor's orb to the actual file node and
 *   tracks it as the sim migrates it.
 * - **actors**: one retained orb `Graphics` per actor, keyed by actor id, created
 *   when an actor first appears and culled once it has fully faded out. The orb is a
 *   Gource {@link ActorUser}: a physics body that accelerates toward the files it is
 *   acting on, brakes to rest just beside them, separates from other actors, and rolls
 *   to a stop under friction, fading out after it goes idle.
 *
 * ### Actor motion (the faithful Gource `RUser` port)
 *
 * Each actor is an {@link ActorUser} (the port of Gource's `src/user.cpp`): a retained
 * physics body with a position and an acceleration. Every frame the controller hands it
 * the live positions of the files it is acting on (resolved from the node sim, current
 * file first) and the other actors; the user accelerates toward its CURRENT file when
 * beyond its beam distance, brakes within its action distance, repels actors inside its
 * personal space, clamps to its max speed, integrates its position, and bleeds the
 * acceleration off by a heavy friction plus an approach damping. So an actor naturally
 * glides to the file it is touching now and eases to rest beside it (a short beam) without
 * springing or bouncing between files, with no hand-authored animation, and coasts to a
 * stop and fades when it goes quiet. The motion is driven by the real frame delta, like
 * the force-directed node sim it rides above; only the fade is a pure function of the playhead.
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
  /** Tuning for the actor physics + fade (Gource's `RUser` constants), forwarded to each {@link ActorUser}. */
  private readonly actorOptions: ActorUserOptions

  /** One batched graphic holding every live beam this frame, cleared and refilled. */
  private readonly beamGraphics: Graphics
  /** Retained actor orb graphics, keyed by actor id. */
  private readonly actorGraphics: Map<string, Graphics>
  /**
   * Retained per-actor physics bodies (Gource `RUser`s), keyed by actor id. Each holds
   * its live position so a beam fired by this actor can resolve its source from where
   * the orb actually is, and so the orb flies and rolls to rest under the physics rather
   * than teleporting. Culled in lockstep with {@link actorGraphics}.
   */
  private readonly actorUsers: Map<string, ActorUser>

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
    // Soften the whole beam layer with one cheap blur pass so each cone reads as a fuzzy glow of
    // light fanning onto the file rather than a crisp wedge with hard edges (the "make it blurred"
    // ask). One filter covers every beam at once (they share this single batched graphic), so it is
    // far cheaper than blurring per beam, and it rides UNDER the actor orbs, which are separate
    // children of the layer and stay sharp. See {@link BEAM_BLUR_STRENGTH}.
    this.beamGraphics.filters = [ new BlurFilter({ strength: BEAM_BLUR_STRENGTH }) ]
    this.layer.addChild(this.beamGraphics)

    this.actorGraphics = new Map()
    this.actorUsers = new Map()
  }

  /**
   * The live position of an actor's orb this frame, or `null` if the actor has no live
   * orb (it has not appeared yet or has fully faded). This is the EXACT position the orb
   * is drawn at, read straight off the same retained {@link ActorUser} the draw uses, so
   * a caller anchoring the actor's label here lands it precisely on the orb. It is valid
   * only after {@link update} has stepped the physics this frame.
   */
  public actorOrbPosition(actor: string): Vec2 | null {
    return this.actorUsers.get(actor)?.position ?? null
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
      actorSource: (actor) => this.actorUsers.get(actor)?.position ?? null,
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
   * as a *stack* of additive tapered triangles rather than one flat one, which (with
   * the layer's blur filter on top) turns the old hard "sharp triangle" into a glowy
   * cone of light: a bright, thin core triangle with a couple of progressively wider,
   * dimmer triangles layered under it. Because the layers are additively blended, the
   * overlap sums to a hot bright center that falls off softly to the sides, the way
   * real light blooms, so the beam reads as a soft flashlight cone rather than a flat
   * wedge with a hard edge.
   *
   * The cone now points the OTHER way (the swap): its single APEX vertex sits at the
   * actor (source) and the two width-spread vertices sit at the touched file (target),
   * so the beam starts as a point at the contributor and FANS OUT onto the file, like a
   * flashlight cone hitting it, instead of being wide at the actor and narrowing to the
   * file. The width is therefore spread at the TARGET end. A degenerate zero-length beam
   * (source == target) is skipped since it has no direction to give width.
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

      // The unit perpendicular to the beam, to spread each layer's width symmetrically
      // across the beam on both sides at the TARGET (file) end, the cone's wide base.
      const perpendicularX = -directionY / length
      const perpendicularY = directionX / length
      const color = hslToRgbInt(beam.color)

      // Stack the soft layers widest-and-dimmest first so the bright thin core lands
      // on top. The additive blend sums the overlap into a hot core with a soft
      // falloff to the edges, and the layer's blur filter softens the whole thing into
      // a fuzzy glow. The theme's bloom scales the whole stack so a restrained theme
      // glows gently; the beam's own lifetime fade rides in `beam.alpha`.
      //
      // The width is spread at the TARGET (file) end and the single apex sits at the
      // SOURCE (actor), so the cone fans out onto the file (the swap).
      for (const layer of BEAM_GLOW_LAYERS) {
        const halfWidth = (beam.width * layer.widthScale) / 2
        const leftX = beam.target.x + perpendicularX * halfWidth
        const leftY = beam.target.y + perpendicularY * halfWidth
        const rightX = beam.target.x - perpendicularX * halfWidth
        const rightY = beam.target.y - perpendicularY * halfWidth

        this.beamGraphics
          .poly([ beam.source.x, beam.source.y, leftX, leftY, rightX, rightY ])
          .fill({ color, alpha: beam.alpha * layer.alphaScale * theme.bloomIntensity })
      }
    }
  }

  /**
   * Steps and draws the retained actor users from the supplied activity (Gource's
   * `RUser` loop). For each actor it gets-or-creates an {@link ActorUser}, applies the
   * pull toward the files it is acting on and the repulsion from the other actors, steps
   * the physics by the real frame delta, then draws the orb at the user's live position
   * with its idle fade. Any retained actor no longer present in `activities` or fully
   * faded is culled so the layer never keeps a dead orb around.
   *
   * Forces are applied to every user FIRST and the bodies stepped SECOND (Gource's
   * order), so a frame's separation reads the start-of-frame positions and the users
   * move together rather than in a position-dependent sequence.
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

    // Resolve (and spawn) the live user for every actor reported this frame. A
    // brand-new actor spawns at the average of the files it is acting on (Gource spawns
    // a user at a file position) so it appears beside its work and flies in from there;
    // with no resolvable file it spawns at the origin and the forces carry it out.
    const stepping: { activity: ActorActivity, user: ActorUser }[] = []
    for (const activity of activities) {
      present.add(activity.actor)
      let user = this.actorUsers.get(activity.actor)
      if (!user) {
        user = new ActorUser(activity.actor, spawnPositionFor(activity.touched), this.actorOptions)
        this.actorUsers.set(activity.actor, user)
      }
      stepping.push({ activity, user })
    }

    // Apply this frame's forces to every user before stepping any of them, so the
    // user-to-user separation reads the start-of-frame positions (Gource's order).
    for (const { activity, user } of stepping) {
      user.applyForceToActions(activity.touched)
      for (const other of stepping) {
        user.applyForceUser(other.user)
      }
    }

    // Integrate every user, then draw it at its live position with its idle fade.
    const deltaSeconds = deltaMs / 1000
    for (const { activity, user } of stepping) {
      user.step(deltaSeconds)
      const visual = user.visualAt(now, activity.lastActiveAt)
      if (visual.alpha <= 0) {
        // Fully faded: cull it rather than draw an invisible orb. A later reappearance
        // spawns a fresh user beside its new work.
        this.removeActor(activity.actor)
        continue
      }

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

  /** Tears down one actor's retained orb graphic and its physics body. */
  private removeActor(actor: string): void {
    const graphics = this.actorGraphics.get(actor)
    if (graphics) {
      graphics.destroy()
      this.actorGraphics.delete(actor)
    }
    // Drop the user too so a reappearance spawns fresh rather than resuming from a stale
    // physics body.
    this.actorUsers.delete(actor)
  }
}

/**
 * Where a brand-new actor user spawns: the average of the files it is acting on this
 * frame, so it appears beside its work and the action forces fly it in from there. With
 * no resolvable file (it reported activity with nothing touched yet) it spawns at the
 * origin and is carried out by the forces as its files resolve.
 */
function spawnPositionFor(touched: Vec2[]): Vec2 {
  if (touched.length === 0) {
    return { x: 0, y: 0 }
  }
  let sumX = 0
  let sumY = 0
  for (const target of touched) {
    sumX += target.x
    sumY += target.y
  }
  return { x: sumX / touched.length, y: sumY / touched.length }
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

/**
 * The blur radius, in pixels, applied to the whole beam layer so each cone reads as a fuzzy glow of
 * light fanning onto the file rather than a crisp triangle (the "make it blurred" ask). One pass
 * over the single batched beam graphic softens every beam at once for the cost of one filter, and it
 * sits under the (separate, still-sharp) actor orbs. Tuned for a noticeably soft edge without
 * smearing the cone into a featureless blob; raise it for a fuzzier beam, lower it for a crisper one.
 */
const BEAM_BLUR_STRENGTH = 6

/** Construction options for a {@link BeamScene}; forwards tuning to the pure models. */
export type BeamSceneOptions = {
  beams?: BeamFieldOptions
  /**
   * Tuning for the actor physics + idle fade (the Gource `RUser` constants: beam /
   * action / personal-space distances, max speed, friction, idle and fade times). Every
   * field defaults to Gource's own value. See {@link ActorUserOptions}.
   */
  actors?: ActorUserOptions
}
