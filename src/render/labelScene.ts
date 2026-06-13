// Copyright © 2026 Jalapeno Labs

import type { Container } from 'pixi.js'
import type { RunewoodTheme } from '../core/theme'
import type { LabelCandidate, LabelLodOptions } from './labels'

// Core
import { Text } from 'pixi.js'

import { hslToRgbInt } from './color'
import { decideLabels } from './labels'

/**
 * The font size, in world units, every label glyph is drawn at. pixi's default
 * {@link Text} size read too large in the playground, so labels are pinned to a
 * deliberate base and then taken 25% smaller per direct user feedback: the text
 * was crowding the forest. {@link LABEL_FONT_SIZE_SCALE} is the reduction factor,
 * kept as its own constant so the "why 0.75" is documented at the call site.
 */
const LABEL_BASE_FONT_SIZE = 16
const LABEL_FONT_SIZE_SCALE = 0.75
const LABEL_FONT_SIZE = LABEL_BASE_FONT_SIZE * LABEL_FONT_SIZE_SCALE

/**
 * The minimum on-screen height, in screen pixels, an *actor* label is ever drawn
 * at. Labels are sized in world units that the camera scales by `zoom`, so an
 * actor's name shrinks to an illegible smear once the camera pulls far out. For
 * actor labels only (the "who is doing what" headline the user must always read),
 * the world font size is floored at `MIN_ACTOR_LABEL_SCREEN_PX / zoom` so the name
 * stays roughly constant on screen. File and root labels keep their plain world
 * font size: per the design they are allowed to shrink and the file tier is culled
 * outright when the camera is too far out (see the LOD model).
 */
const MIN_ACTOR_LABEL_SCREEN_PX = 13

/**
 * The retained label layer that sits *above* the forest and the beams (issue #7):
 * one persistent pixi {@link Text} per label, keyed by candidate id, created when
 * a label first appears and torn down once it is culled or fully faded. It mirrors
 * the {@link import('./scene').Scene} and {@link import('./beamScene').BeamScene}
 * pattern: it owns retained pixi objects parented into one world container the
 * backend hands it, updates them in place every frame, and is the only place
 * besides the backend allowed to know about pixi.
 *
 * The pure model ({@link decideLabels}) decides *which* labels show, their alpha,
 * their truncated text, and their kind; this class only projects those plain
 * decisions onto pixi {@link Text} objects and positions each at its label's
 * animated world anchor. Everything above stays library-free.
 *
 * The controller (#9) owns the playhead, the camera zoom, and assembling the
 * candidate list (file/root nodes from the tree + spring positions, actors from
 * the active window) each frame, then calls {@link update}. Glyphs are kept cheap
 * by retaining and reusing one {@link Text} per id rather than recreating them.
 */
export class LabelScene {
  /** The world container every label glyph is parented into, above the forest and beams. */
  private readonly layer: Container
  /** Tuning for the pure LOD model, forwarded verbatim each frame. */
  private readonly options: LabelLodOptions

  /** Retained label glyphs, keyed by candidate id (node path or actor id). */
  private readonly textById: Map<string, Text>

  /**
   * @param layer the world container for labels, added above the forest and beam
   *   layers so label text reads on top of everything.
   */
  constructor(layer: Container, options: LabelLodOptions = {}) {
    this.layer = layer
    this.options = options
    this.textById = new Map()
  }

  /**
   * Reconciles the retained label glyphs with the model's decision for this frame.
   * Call once per frame between the backend's `beginFrame` and `endFrame`, after
   * the forest and beam scenes so labels layer on top.
   *
   * A visible decision creates or reuses its glyph, sets its text/color/alpha, and
   * positions it at the label's animated world anchor. An invisible decision (a
   * culled file label, a faded actor) drops its retained glyph so the layer never
   * holds a label the model has ruled out.
   *
   * @param candidates every label the caller would like drawn this frame.
   * @param zoom the live camera zoom, driving the file-tier level-of-detail.
   * @param now the playhead time, driving the file touch-flash fade.
   */
  public update(candidates: LabelCandidate[], zoom: number, now: number, theme: RunewoodTheme): void {
    const decisions = decideLabels(candidates, zoom, now, this.options)
    const present = new Set<string>()

    for (const decision of decisions) {
      if (!decision.visible || decision.alpha <= 0) {
        // The model culled it (zoom/density) or it has fully faded: drop the glyph
        // rather than draw an invisible label.
        this.removeLabel(decision.id)
        continue
      }
      present.add(decision.id)

      let text = this.textById.get(decision.id)
      if (!text) {
        text = new Text({ text: decision.text, style: { fontSize: LABEL_FONT_SIZE }})
        this.layer.addChild(text)
        this.textById.set(decision.id, text)
      }
      // Update the glyph in place. The label color is a global theme decision, so
      // every kind shares the theme's label hue; the per-kind distinction is
      // carried by alpha (subtle roots vs full file/actor flashes).
      //
      // Actor labels get a constant-on-screen floor: their world font size is lifted
      // to `MIN_ACTOR_LABEL_SCREEN_PX / zoom` when that exceeds the base, so the
      // name stays readable however far the camera zooms out. Up close the base size
      // wins and nothing changes. File / root labels keep the plain world size.
      const isActor = decision.kind === 'actor'
      const minActorFontSize = isActor && zoom > 0
        ? MIN_ACTOR_LABEL_SCREEN_PX / zoom
        : 0
      text.text = decision.text
      text.style.fill = hslToRgbInt(theme.label)
      text.style.fontSize = Math.max(LABEL_FONT_SIZE, minActorFontSize)
      text.alpha = decision.alpha
      text.position.set(decision.position.x, decision.position.y)
    }

    // Cull any retained glyph the model did not keep this frame (a label whose node
    // left the tree, an actor that dropped out of the window) so none linger.
    for (const id of [ ...this.textById.keys() ]) {
      if (!present.has(id)) {
        this.removeLabel(id)
      }
    }
  }

  /** Removes every retained glyph. Call when tearing the scene down. */
  public clear(): void {
    for (const id of [ ...this.textById.keys() ]) {
      this.removeLabel(id)
    }
  }

  /** Tears down one label's retained glyph if it exists. */
  private removeLabel(id: string): void {
    const text = this.textById.get(id)
    if (text) {
      text.destroy()
      this.textById.delete(id)
    }
  }
}
