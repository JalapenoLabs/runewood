// Copyright © 2026 Jalapeno Labs

import type { Container } from 'pixi.js'
import type { RunewoodTheme } from '../core/theme'
import type { LabelCandidate, LabelLodOptions } from './labels'

// Core
import { Text } from 'pixi.js'

import { hslToRgbInt } from './color'
import { decideLabels } from './labels'

/**
 * The on-screen height, in *screen pixels*, every label glyph is drawn at. pixi's
 * default {@link Text} size read too large in the playground, so labels are pinned
 * to a deliberate base and then taken 25% smaller per direct user feedback: the
 * text was crowding the forest. {@link LABEL_FONT_SIZE_SCALE} is the reduction
 * factor, kept as its own constant so the "why 0.75" is documented at the call site.
 *
 * Crucially this is a *screen* size, not a world size: per direct user feedback,
 * every label (file, root, AND actor) must stay the same size on screen as the
 * camera zooms, navigates, and pans, rather than shrinking with the world when the
 * camera pulls out. The world font size is therefore divided by the live `zoom`
 * (see {@link update}), so the rendered glyph lands on exactly this many screen
 * pixels at any zoom. At `zoom === 1` it is exactly this size; at half zoom the
 * world font doubles to keep the screen size constant.
 */
const LABEL_BASE_SCREEN_PX = 16
const LABEL_FONT_SIZE_SCALE = 0.75
const LABEL_SCREEN_PX = LABEL_BASE_SCREEN_PX * LABEL_FONT_SIZE_SCALE

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
   * @param zoom the live camera zoom, used to counter-scale every glyph so each
   *   label keeps a constant on-screen size regardless of how far the camera pulls
   *   out (the file-tier LOD is now a pure density gate, independent of zoom).
   * @param now the playhead time, driving the file touch-flash fade.
   */
  public update(candidates: LabelCandidate[], zoom: number, now: number, theme: RunewoodTheme): void {
    const decisions = decideLabels(candidates, now, this.options)
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
        text = new Text({ text: decision.text })
        this.layer.addChild(text)
        this.textById.set(decision.id, text)
      }
      // Update the glyph in place. The label color is a global theme decision, so
      // every kind shares the theme's label hue; the per-kind distinction is
      // carried by alpha (subtle roots vs full file/actor flashes).
      //
      // Constant on-screen size for EVERY kind: the glyph is authored in world units
      // that the camera scales by `zoom`, so dividing the screen-pixel target by the
      // live zoom yields the world font size that lands on exactly `LABEL_SCREEN_PX`
      // screen pixels at any zoom. File, root, and actor labels therefore never
      // shrink as the camera pulls out (the user's explicit ask); the LOD model still
      // governs *which* labels show. A non-positive zoom (degenerate) falls back to
      // the raw screen size so a label is never lost to a divide-by-zero.
      const worldFontSize = zoom > 0
        ? LABEL_SCREEN_PX / zoom
        : LABEL_SCREEN_PX
      text.text = decision.text
      text.style.fill = hslToRgbInt(theme.label)
      text.style.fontSize = worldFontSize
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
