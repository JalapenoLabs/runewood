// Copyright © 2026 Jalapeno Labs

import type { Container } from 'pixi.js'
import type { Vec2 } from '../core/layout'
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
 * Because labels now live in a SCREEN-SPACE layer (a direct child of the pixi
 * stage, not inside the camera-zoomed world), this is the glyph's literal font size
 * in screen pixels at every zoom: the text is rasterized once at this true pixel
 * size and never magnified by the camera, so it stays crisp when the user zooms in.
 * There is no longer any `/zoom` counter-scale; the label simply sits at this size
 * and is re-positioned each frame by projecting its node's world anchor to screen.
 */
const LABEL_BASE_SCREEN_PX = 16
const LABEL_FONT_SIZE_SCALE = 0.75
const LABEL_SCREEN_PX = LABEL_BASE_SCREEN_PX * LABEL_FONT_SIZE_SCALE

/**
 * Projects a world-space point to screen pixels. This is exactly the pure camera's
 * `worldToScreen`, narrowed to the one method the label layer needs so the scene
 * stays decoupled from the camera class (and trivially testable with a plain stub).
 */
export type WorldToScreen = (world: Vec2) => Vec2

/**
 * The retained label layer that sits *above* the forest and the beams (issue #7),
 * in SCREEN space: one persistent pixi {@link Text} per label, keyed by candidate
 * id, created when a label first appears and torn down once it is culled or fully
 * faded. It mirrors the {@link import('./scene').Scene} and
 * {@link import('./beamScene').BeamScene} pattern (it owns retained pixi objects
 * parented into one container the backend hands it and updates them in place every
 * frame), with one deliberate difference: its container is parented straight to the
 * stage, OUTSIDE the camera-transformed world, so the camera never scales the text.
 *
 * That screen-space placement is the fix for the blurry-label complaint: a
 * world-space label was rasterized small and then magnified by the camera when
 * zoomed in, so it blurred; here every glyph is rasterized at its true
 * {@link LABEL_SCREEN_PX} pixel size and re-positioned each frame by projecting its
 * node's animated world anchor through the camera's {@link WorldToScreen}. The text
 * is therefore sharp at any zoom, and being outside the world also keeps it clear of
 * the world's bloom / beam-blur filters.
 *
 * The pure model ({@link decideLabels}) still decides *which* labels show, their
 * alpha, their truncated text, and their kind; this class only projects those plain
 * decisions onto pixi {@link Text} objects. Everything above stays library-free.
 */
export class LabelScene {
  /** The screen-space container every label glyph is parented into, above the forest and beams. */
  private readonly layer: Container
  /**
   * The device pixel ratio the renderer draws at, applied as each {@link Text}'s
   * `resolution` so glyphs are rasterized at the display's true pixel density and
   * never look soft on a HiDPI screen.
   */
  private readonly resolution: number
  /** Tuning for the pure LOD model, forwarded verbatim each frame. */
  private readonly options: LabelLodOptions

  /** Retained label glyphs, keyed by candidate id (node path or actor id). */
  private readonly textById: Map<string, Text>

  /**
   * @param layer the SCREEN-SPACE container for labels (a child of the stage, not
   *   the world), added above the forest and beam layers so label text reads on top.
   * @param resolution the renderer's device pixel ratio, used as each glyph's
   *   `resolution` so the text is crisp on HiDPI displays. A non-positive value
   *   falls back to 1.
   */
  constructor(layer: Container, resolution: number, options: LabelLodOptions = {}) {
    this.layer = layer
    this.resolution = resolution > 0 ? resolution : 1
    this.options = options
    this.textById = new Map()
  }

  /**
   * Reconciles the retained label glyphs with the model's decision for this frame.
   * Call once per frame between the backend's `beginFrame` and `endFrame`, after
   * the forest and beam scenes so labels layer on top.
   *
   * A visible decision creates or reuses its glyph, sets its text/color/alpha, and
   * positions it at its node's world anchor PROJECTED to screen pixels via
   * `worldToScreen`, so the glyph tracks its node as the camera pans/zooms while
   * staying a fixed on-screen size. An invisible decision (a culled file label, a
   * faded actor) drops its retained glyph so the layer never holds a label the model
   * has ruled out.
   *
   * @param candidates every label the caller would like drawn this frame, at their
   *   live WORLD positions.
   * @param worldToScreen the camera's world->screen projection, used to place each
   *   glyph in the screen-space layer this frame.
   * @param now the playhead time, driving the file touch-flash fade.
   */
  public update(
    candidates: LabelCandidate[],
    worldToScreen: WorldToScreen,
    now: number,
    theme: RunewoodTheme,
  ): void {
    const decisions = decideLabels(candidates, now, this.options)
    const present = new Set<string>()

    for (const decision of decisions) {
      if (!decision.visible || decision.alpha <= 0) {
        // The model culled it (density) or it has fully faded: drop the glyph rather
        // than draw an invisible label.
        this.removeLabel(decision.id)
        continue
      }
      present.add(decision.id)

      let text = this.textById.get(decision.id)
      if (!text) {
        // Rasterize at the device pixel ratio so the glyph is crisp on HiDPI, and at
        // a fixed screen-pixel font size since the layer is no longer camera-scaled.
        text = new Text({
          text: decision.text,
          resolution: this.resolution,
          style: { fontSize: LABEL_SCREEN_PX },
        })
        this.layer.addChild(text)
        this.textById.set(decision.id, text)
      }
      // Update the glyph in place. The label color is a global theme decision, so
      // every kind shares the theme's label hue; the per-kind distinction is carried
      // by alpha (subtle roots vs full file/actor flashes). The font size is a fixed
      // SCREEN-pixel size (no `/zoom`): the layer sits outside the camera transform,
      // so this is the literal rendered pixel height at any zoom, which is what keeps
      // the text crisp rather than magnified-and-blurry when zoomed in.
      text.text = decision.text
      text.style.fill = hslToRgbInt(theme.label)
      text.style.fontSize = LABEL_SCREEN_PX
      text.alpha = decision.alpha
      // Project the node's live world anchor to screen pixels so the glyph tracks its
      // node through pans and zooms while staying a constant on-screen size.
      const screen = worldToScreen(decision.position)
      text.position.set(screen.x, screen.y)
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
