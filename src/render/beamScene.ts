// Copyright © 2026 Jalapeno Labs

import type { Container, Renderer, Texture } from 'pixi.js'
import type { Vec2 } from '../core/layout'
import type { RunewoodTheme } from '../core/theme'
import type { BeamFieldOptions, ActiveBeam, BeamEndpointResolver } from './beams'
import type { ActorActivity, ActorUserOptions } from './actors'
import type { AvatarResolver } from './avatarRegistry'

// Core
import { Graphics, Sprite } from 'pixi.js'

import { colorForActor } from '../core/theme'
import { hslToRgbInt } from './color'
import { buildBeamTexture } from './glowTexture'
import { beamPlacement } from './beamGeometry'
import { BeamField } from './beams'
import { ActorUser } from './actors'
import { AvatarTextureCache } from './avatarTexture'

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
 * - **beams**: the brief, glowing colored lasers flung from actors to touched files,
 *   Gource's action beam (`src/action.cpp`). Each is one tinted, rotated, scaled
 *   `Sprite` of the baked beam-gradient texture ({@link buildBeamTexture}), drawn from
 *   the {@link BeamField}'s active set: the gradient stretches along the line so the
 *   beam is brightest at its core and softens to nothing at the user and file ends,
 *   the additive blend makes it bloom, and its lifetime fade dims it out. Each beam's
 *   endpoints are resolved LIVE every frame (see below): its source is the firing
 *   actor's live user position and its target is the touched node's live physics
 *   position, so the laser flies from the contributor's orb to the actual file node
 *   and tracks it as the sim migrates it. A `pulse` (path-less) beam reaches a short
 *   nudge off the orb, so it reads as a small actor-local burst rather than a laser.
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

  /**
   * The one baked beam-gradient texture (Gource's `beam.png`), shared by every beam
   * sprite: tinted to the beam color, stretched along the line, additively blended.
   * `null` when no renderer was supplied (a headless backend), in which case beams are
   * simply not drawn.
   */
  private readonly beamTexture: Texture | null
  /**
   * A pool of retained beam `Sprite`s, grown on demand and reused frame to frame. Each
   * frame's live beams claim the first N sprites (positioned, rotated, scaled, tinted),
   * and any leftover from a busier previous frame are hidden, so the layer never churns
   * a sprite per beam yet stays allocation-flat once the pool has reached its high-water
   * mark. Empty when there is no beam texture to draw.
   */
  private readonly beamSprites: Sprite[]
  /** Retained actor orb graphics, keyed by actor id. */
  private readonly actorGraphics: Map<string, Graphics>
  /**
   * The host's avatar resolver (an actor id -> image URL, or null for the colored-orb
   * fallback), already flattened to a plain function by the controller so the render
   * layer stays framework-agnostic. `undefined` when the host supplied no avatars at
   * all, in which case every actor draws its orb exactly as before. See
   * {@link import('../runewood').RunewoodOptions.resolveAvatar}.
   */
  private readonly avatarResolve: AvatarResolver | undefined
  /**
   * The lazy, URL-keyed avatar texture cache, built on the FIRST actor that resolves to a
   * real avatar URL (see {@link avatarTextureFor}) and `null` until then, so a forest that
   * only ever draws colored orbs never allocates it even when a resolver is wired.
   */
  private avatarTextures: AvatarTextureCache | null
  /**
   * Retained per-actor avatar sprites, keyed by actor id: the circular image drawn in
   * place of the orb once its texture has loaded. Created on the first frame an actor's
   * avatar texture is ready and culled with the rest of the actor's graphics.
   */
  private readonly avatarSprites: Map<string, Sprite>
  /**
   * Retained per-actor avatar ring graphics, keyed by actor id: the colored border drawn
   * around the avatar in the actor's hashed {@link colorForActor} color, so an avatared
   * actor still reads as that actor at a glance. Paired with {@link avatarSprites}.
   */
  private readonly avatarRings: Map<string, Graphics>
  /**
   * Retained per-actor circular mask graphics, keyed by actor id: a filled circle that
   * clips the square avatar texture into a disc. One mask per sprite (a pixi mask is a
   * single display object), sized + positioned with its sprite each frame. Paired with
   * {@link avatarSprites}.
   */
  private readonly avatarMasks: Map<string, Graphics>
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
   * @param renderer the live renderer, used once to bake the shared beam-gradient
   *   texture every beam sprite reuses. `undefined` on a headless backend, in which
   *   case beams are not drawn (the field still simulates, actors still render).
   */
  constructor(layer: Container, renderer?: Renderer, options: BeamSceneOptions = {}) {
    this.layer = layer
    this.field = new BeamField(options.beams)
    this.actorOptions = options.actors ?? {}

    // Bake the one shared beam-gradient texture up front (Gource's beam.png). Every
    // live beam is then a cheap tinted sprite of it, additively blended, so there is
    // no per-beam geometry to rebuild and no blur filter to run.
    this.beamTexture = renderer ? buildBeamTexture(renderer) : null
    this.beamSprites = []

    this.actorGraphics = new Map()
    this.actorUsers = new Map()

    // Avatars are opt-in and lazy: the resolver is held, but the texture cache is built
    // only once an actor actually resolves to a real avatar URL, so a forest of colored
    // orbs never allocates it.
    this.avatarResolve = options.resolveAvatar
    this.avatarTextures = null
    this.avatarSprites = new Map()
    this.avatarRings = new Map()
    this.avatarMasks = new Map()
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
   * controller supplies, so only the beam field is emptied and every pooled beam
   * sprite is hidden until the next forward play respawns them.
   */
  public clear(): void {
    this.field.clear()
    for (const sprite of this.beamSprites) {
      sprite.visible = false
    }
  }

  /** Removes every retained graphic. Call when tearing the scene down. */
  public dispose(): void {
    for (const sprite of this.beamSprites) {
      sprite.destroy()
    }
    this.beamSprites.length = 0
    // An avatared actor may have only avatar graphics (no orb), so tear down the union of
    // both retained sets, not just the orbs.
    const retained = new Set<string>([ ...this.actorGraphics.keys(), ...this.avatarSprites.keys() ])
    for (const actor of retained) {
      this.removeActor(actor)
    }
  }

  /**
   * Draws the active beams as Gource's glowing colored lasers, one tinted `Sprite` of
   * the baked beam-gradient texture per beam. Each beam is centered on the midpoint of
   * the line from the actor (source) to the file (target), rotated to that line, scaled
   * so the texture's gradient stretches along the full length and spans the beam's
   * current width, tinted to the beam color, and additively blended so overlapping
   * beams bloom toward white. The gradient itself supplies the soft falloff to the user
   * and file ends (it is transparent at both edges, hot in the core), so the laser reads
   * as a beam of light rather than a flat bar, with no per-beam geometry or blur pass.
   *
   * The sprites are drawn from a reused pool ({@link beamSprites}): this frame's beams
   * claim the first N sprites and any extra left over from a busier previous frame are
   * hidden, so the layer stays allocation-flat once the pool has reached its peak size.
   * The lifetime fade rides in `beam.alpha` and the theme's bloom scales the whole
   * field's brightness. A degenerate zero-length beam (source == target) and a frame
   * with no baked texture (headless backend) draw nothing.
   */
  private drawBeams(beams: ActiveBeam[], theme: RunewoodTheme): void {
    if (!this.beamTexture) {
      return
    }

    let drawn = 0
    for (const beam of beams) {
      const placement = beamPlacement(beam.source, beam.target, beam.width)
      if (!placement) {
        // Zero-length beam: no direction to orient the laser, so skip it.
        continue
      }

      const sprite = this.beamSpriteAt(drawn)
      sprite.visible = true
      sprite.tint = hslToRgbInt(beam.color)
      sprite.alpha = beam.alpha * theme.bloomIntensity
      sprite.position.set(placement.center.x, placement.center.y)
      sprite.rotation = placement.rotation
      // Anchor-centered, so width/length stretch the texture symmetrically about the
      // midpoint along the line and across it. The texture's own pixel size is divided
      // out so the sprite spans exactly the beam's length and width in world units.
      sprite.width = placement.length
      sprite.height = placement.width
      drawn++
    }

    // Hide any pooled sprites a busier previous frame used but this frame did not, so
    // stale lasers from the last frame never linger.
    for (let index = drawn; index < this.beamSprites.length; index++) {
      this.beamSprites[index].visible = false
    }
  }

  /**
   * The pooled beam sprite at `index`, creating it (and growing the pool) on first use.
   * Every beam sprite shares the one baked beam texture, is anchor-centered so it
   * stretches symmetrically about the beam midpoint, and is additively blended for the
   * glow. The pool only ever grows to the high-water mark of simultaneously live beams.
   */
  private beamSpriteAt(index: number): Sprite {
    let sprite = this.beamSprites[index]
    if (!sprite) {
      sprite = new Sprite(this.beamTexture ?? undefined)
      sprite.anchor.set(0.5)
      // Additive blend so overlapping beams build toward white, the way real bloom
      // stacks, rather than painting flatly over each other.
      sprite.blendMode = 'add'
      this.layer.addChild(sprite)
      this.beamSprites[index] = sprite
    }
    return sprite
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

      const radius = Math.max(visual.size, minWorldRadius)

      // When the host gave this actor an avatar and its image has finished loading, draw
      // the circular avatar (image + colored ring) in place of the orb; otherwise (no
      // avatar, still loading, or load failed) fall back to the colored orb. Either way the
      // drawn thing rides the same `visual.alpha` idle fade and `visual.position`.
      const avatarTexture = this.avatarTextureFor(activity.actor)
      if (avatarTexture) {
        this.drawAvatar(activity.actor, avatarTexture, visual.position, radius, visual.alpha)
        this.hideOrb(activity.actor)
      }
      else {
        this.drawOrb(activity.actor, visual.position, radius, visual.alpha, theme)
        this.hideAvatar(activity.actor)
      }
    }

    // Cull retained actors the controller no longer reports at all (their window
    // dropped them), so a quiet actor's orb / avatar does not linger. An avatared actor
    // may have only avatar graphics (no orb), so the cull set is the union of both maps.
    const retained = new Set<string>([ ...this.actorGraphics.keys(), ...this.avatarSprites.keys() ])
    for (const actor of retained) {
      if (!present.has(actor)) {
        this.removeActor(actor)
      }
    }
  }

  /**
   * The ready avatar texture for an actor this frame, or `null` to draw the colored-orb
   * fallback. `null` whenever the host configured no avatars, this actor resolves to no
   * URL, or its image has not loaded yet / failed to load. The cache kicks the lazy load
   * on the first ask and returns the texture the frame after it resolves.
   */
  private avatarTextureFor(actor: string): Texture | null {
    if (!this.avatarResolve) {
      return null
    }
    const url = this.avatarResolve(actor)
    if (!url) {
      return null
    }
    // First avatar URL ever seen: stand up the cache now (lazily), so an all-orbs forest
    // never allocates it even though the resolver is always wired.
    this.avatarTextures ??= new AvatarTextureCache()
    return this.avatarTextures.get(url)
  }

  /**
   * Draws an actor as a circular avatar at `position`: a colored ring in the actor's
   * hashed {@link colorForActor} color around the image, the image itself clipped to a
   * disc by a circular mask, all riding the idle-fade `alpha`. The sprite, ring, and
   * mask are retained per actor and reused each frame. Unlike the additive orb, the
   * avatar is drawn with normal blending so the photo reads true rather than glowing white.
   */
  private drawAvatar(actor: string, texture: Texture, position: Vec2, radius: number, alpha: number): void {
    let sprite = this.avatarSprites.get(actor)
    let ring = this.avatarRings.get(actor)
    let mask = this.avatarMasks.get(actor)
    if (!sprite || !ring || !mask) {
      sprite = new Sprite()
      sprite.anchor.set(0.5)
      ring = new Graphics()
      mask = new Graphics()
      // The mask is parented under the sprite and clips it to a circle; the ring rides
      // above the masked image as its colored border. Add the ring last so it reads on top.
      this.layer.addChild(sprite)
      this.layer.addChild(ring)
      sprite.mask = mask
      sprite.addChild(mask)
      this.avatarSprites.set(actor, sprite)
      this.avatarRings.set(actor, ring)
      this.avatarMasks.set(actor, mask)
    }

    // Point the sprite at the (possibly newly-loaded) texture, then scale the square
    // image so its diameter is 2 * radius in world units regardless of the source pixels.
    if (sprite.texture !== texture) {
      sprite.texture = texture
    }
    const sourceSize = Math.max(texture.width, texture.height, 1)
    const scale = (radius * 2) / sourceSize
    sprite.scale.set(scale)
    sprite.position.set(position.x, position.y)
    sprite.alpha = alpha

    // The mask is a sprite-local circle (the sprite's anchor is its center), drawn in the
    // sprite's pre-scale coordinate space, so its radius is the source half-size.
    mask.clear()
    mask.circle(0, 0, sourceSize / 2).fill({ color: 0xffffff })

    // The colored identity ring sits in world space around the avatar, its width floored so
    // it stays visible as the camera pulls out. It fades with the avatar.
    const ringWidth = Math.max(radius * AVATAR_RING_WIDTH_FRACTION, 1)
    ring.clear()
    ring
      .circle(position.x, position.y, radius)
      .stroke({ color: hslToRgbInt(colorForActor(actor)), width: ringWidth, alpha })
  }

  /** Hides an actor's avatar graphics without destroying them (it fell back to the orb this frame). */
  private hideAvatar(actor: string): void {
    const sprite = this.avatarSprites.get(actor)
    if (sprite) {
      sprite.visible = false
    }
    const ring = this.avatarRings.get(actor)
    if (ring) {
      ring.visible = false
    }
  }

  /** Draws the colored additive orb fallback for an actor, getting-or-creating its retained graphic. */
  private drawOrb(actor: string, position: Vec2, radius: number, alpha: number, theme: RunewoodTheme): void {
    let graphics = this.actorGraphics.get(actor)
    if (!graphics) {
      graphics = new Graphics()
      graphics.blendMode = 'add'
      this.layer.addChild(graphics)
      this.actorGraphics.set(actor, graphics)
    }
    graphics.visible = true
    graphics.clear()
    graphics
      .circle(0, 0, radius)
      .fill({ color: hslToRgbInt(colorForActor(actor)), alpha: alpha * theme.bloomIntensity })
    graphics.position.set(position.x, position.y)
  }

  /** Hides an actor's orb graphic without destroying it (its avatar was drawn this frame). */
  private hideOrb(actor: string): void {
    const graphics = this.actorGraphics.get(actor)
    if (graphics) {
      graphics.visible = false
    }
  }

  /** Tears down one actor's retained orb + avatar graphics and its physics body. */
  private removeActor(actor: string): void {
    const graphics = this.actorGraphics.get(actor)
    if (graphics) {
      graphics.destroy()
      this.actorGraphics.delete(actor)
    }
    // The mask is a child of the sprite, so destroying the sprite with `children: true`
    // takes the mask down too; destroy the ring separately. Clear the mask binding first.
    const sprite = this.avatarSprites.get(actor)
    if (sprite) {
      sprite.mask = null
      sprite.destroy({ children: true })
      this.avatarSprites.delete(actor)
      this.avatarMasks.delete(actor)
    }
    const ring = this.avatarRings.get(actor)
    if (ring) {
      ring.destroy()
      this.avatarRings.delete(actor)
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
 * The fraction of an actor's drawn radius the avatar's identity ring is thick. A
 * small fraction keeps the colored border a crisp rim around the photo rather than a
 * heavy donut, and it is floored at one pixel in {@link BeamScene} so it stays visible
 * as the camera pulls out.
 */
const AVATAR_RING_WIDTH_FRACTION = 0.18

/** Construction options for a {@link BeamScene}; forwards tuning to the pure models. */
export type BeamSceneOptions = {
  beams?: BeamFieldOptions
  /**
   * Tuning for the actor physics + idle fade (the Gource `RUser` constants: beam /
   * action / personal-space distances, max speed, friction, idle and fade times). Every
   * field defaults to Gource's own value. See {@link ActorUserOptions}.
   */
  actors?: ActorUserOptions
  /**
   * The host's avatar resolver: an actor id -> image URL (a data URI is fine), or
   * `null` / `undefined` for the colored-orb fallback. The controller flattens its
   * {@link import('../runewood').RunewoodOptions.resolveAvatar} option and its
   * {@link import('../runewood').RunewoodController.setAvatar} overrides into this one
   * function. Omitted means no avatars: every actor draws the colored orb, exactly as
   * before, at zero extra cost. See {@link AvatarResolver}.
   */
  resolveAvatar?: AvatarResolver
}
