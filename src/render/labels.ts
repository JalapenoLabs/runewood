// Copyright © 2026 Jalapeno Labs

import type { Vec2 } from '../core/layout'

/**
 * The pure level-of-detail (LOD) model for the forest's text labels. It decides
 * *which* labels are shown, how opaque each is, and how its text is truncated,
 * given the camera zoom, how dense the file labels would be, and per-label state.
 * It mirrors the other pure visual modules ({@link import('./nodeVisual')},
 * {@link import('./actors')}): plain inputs in, a plain draw description out, and
 * never a touch of pixi, the DOM, the wall clock, or randomness. A backend turns
 * the results into glyphs; this module only models the policy.
 *
 * The three label kinds are treated very differently, matching how a viewer
 * reads the forest:
 * - **actor** labels (the agent/committer names) are always shown while the actor
 *   is active, since "who is doing this" is the headline. They fade only with the
 *   actor's own activity, never with zoom or density.
 * - **root** labels (the repo/directory-root names) are persistent but subtle:
 *   always shown across every zoom so a viewer can always orient, but at a muted
 *   opacity so they sit behind the live action.
 * - **file** labels are the noisy, optional tier. A freshly touched file shows a
 *   brief label that fades with the same touch-flash window the node uses, and the
 *   whole tier is culled when the camera is zoomed out or when too many files are
 *   lit at once. This is the level-of-detail that keeps the view legible.
 */

/** Which tier a candidate label belongs to. Drives its entire visibility policy. */
export type LabelKind = 'actor' | 'file' | 'root'

/**
 * One label the caller would like drawn, before the LOD model has ruled on it.
 * The caller (the controller, #9) assembles these from the live tree, the spring
 * positions, and the active actor window each frame; this module never reaches
 * into any of those itself.
 */
export type LabelCandidate = {
  kind: LabelKind
  /** A stable id for the label, e.g. the node path or actor id. Useful to callers keying retained glyphs. */
  id: string
  /** The full, untruncated text. The model truncates it; it never mutates this. */
  text: string
  /** World-space anchor the label is drawn at (the node or actor's animated position). */
  position: Vec2
  /**
   * Epoch ms of the file's most recent touch, for the fade. Required for a `file`
   * candidate (its whole visibility rides on the touch flash) and ignored for the
   * other kinds.
   */
  lastTouchedAt?: number
  /**
   * The actor's current presence opacity (`0..1`), as produced by the actor visual
   * model. Required for an `actor` candidate (an actor label is exactly as present
   * as its orb) and ignored for the other kinds.
   */
  actorAlpha?: number
}

/**
 * The model's verdict for one candidate, ready for a backend to draw. `text` is
 * the (possibly truncated) string; `visible` is whether to draw it at all; `alpha`
 * is its opacity once visible; `kind` is echoed back so a retained label layer can
 * style each tier (e.g. subtle roots) without re-deriving it.
 */
export type LabelDecision = {
  kind: LabelKind
  id: string
  text: string
  position: Vec2
  visible: boolean
  alpha: number
}

/** Tuning for {@link decideLabels}. Every field has a sensible default. */
export type LabelLodOptions = {
  /**
   * Camera zoom (world-units-to-pixels) at or above which file labels are allowed
   * to show. Below it the forest is small enough on screen that per-file text is
   * unreadable noise, so the whole file tier is culled and only roots and actors
   * remain. Roots and actors ignore this entirely.
   */
  fileZoomThreshold?: number
  /**
   * The most lit file labels to show at once. Above this the file tier is too
   * dense to read without overlapping, so it is culled wholesale (a simple v1
   * density gate, not per-label overlap resolution). Roots and actors are exempt,
   * so they always survive a dense burst.
   */
  fileDensityCap?: number
  /**
   * How long after a file's touch its label stays visible, in milliseconds. The
   * label is full-opacity at the touch and fades linearly to nothing across this
   * window, matching the node's own touch flash so the text and the glow flash
   * together. Defaults to the node visual's flash window.
   */
  fileFadeMs?: number
  /**
   * The persistent opacity of a root label. Kept well below 1 so repo names read
   * as a subtle, ever-present orientation layer rather than competing with the
   * live file/actor labels.
   */
  rootAlpha?: number
  /** The longest a label's text may be before it is truncated with an ellipsis. */
  maxTextLength?: number
}

const DEFAULT_FILE_ZOOM_THRESHOLD = 0.6
const DEFAULT_FILE_DENSITY_CAP = 40
// Mirrors nodeVisual's DEFAULT_FLASH_MS so a file's label and its glow flash decay together.
const DEFAULT_FILE_FADE_MS = 1_200
const DEFAULT_ROOT_ALPHA = 0.45
const DEFAULT_MAX_TEXT_LENGTH = 24

/** The single trailing glyph a truncated label ends with, in place of the clipped tail. */
const TRUNCATION_ELLIPSIS = '…'

/**
 * Decides the full set of label draws for one frame. Pure and deterministic: it
 * reads only the candidates, the zoom, the playhead `now`, and the options, never
 * the clock or randomness, so a rewound timeline reproduces the exact same labels.
 *
 * The level-of-detail policy:
 * - **actor** labels are kept whenever the actor has any presence (`actorAlpha >
 *   0`) and carry that presence as their alpha, so a label is exactly as visible
 *   as the orb it names and disappears the instant the actor fully fades.
 * - **root** labels are always visible at the subtle `rootAlpha`, regardless of
 *   zoom or how busy the forest is, so a viewer can always read the repo names.
 * - **file** labels are culled as a tier when the camera is below
 *   `fileZoomThreshold` (too small to read) or when more file labels are currently
 *   lit than `fileDensityCap` (too crowded to read). A surviving file label's
 *   alpha follows its touch flash: full at the touch, fading linearly to 0 over
 *   `fileFadeMs`, and a file whose flash has fully decayed is simply not shown.
 *
 * Density is measured from the *lit* file labels (those still inside their fade
 * window), not every file on screen, because only a lit label would be drawn; a
 * forest of thousands of cold files imposes no label cost at all.
 */
export function decideLabels(
  candidates: LabelCandidate[],
  zoom: number,
  now: number,
  options: LabelLodOptions = {},
): LabelDecision[] {
  const fileZoomThreshold = options.fileZoomThreshold ?? DEFAULT_FILE_ZOOM_THRESHOLD
  const fileDensityCap = options.fileDensityCap ?? DEFAULT_FILE_DENSITY_CAP
  const fileFadeMs = options.fileFadeMs ?? DEFAULT_FILE_FADE_MS
  const rootAlpha = options.rootAlpha ?? DEFAULT_ROOT_ALPHA
  const maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH

  // First pass over the file tier: which files are still flashing, and how bright.
  // We need the lit count up front so the density gate can cull the whole tier
  // before deciding any single file label.
  const fileAlphaById = new Map<string, number>()
  for (const candidate of candidates) {
    if (candidate.kind !== 'file') {
      continue
    }
    const alpha = fileFlashAlpha(candidate.lastTouchedAt, now, fileFadeMs)
    if (alpha > 0) {
      fileAlphaById.set(candidate.id, alpha)
    }
  }

  // The two tier-wide gates for file labels. Roots and actors never consult these.
  const zoomedInEnough = zoom >= fileZoomThreshold
  const sparseEnough = fileAlphaById.size <= fileDensityCap
  const fileTierVisible = zoomedInEnough && sparseEnough

  const decisions: LabelDecision[] = []
  for (const candidate of candidates) {
    const decision = decideOne(candidate, {
      now,
      rootAlpha,
      maxTextLength,
      fileTierVisible,
      fileAlphaById,
    })
    decisions.push(decision)
  }
  return decisions
}

/** Everything {@link decideOne} needs that is constant across a frame's candidates. */
type DecisionContext = {
  now: number
  rootAlpha: number
  maxTextLength: number
  /** Whether the file tier survived the zoom + density gates this frame. */
  fileTierVisible: boolean
  /** Pre-computed flash alpha for every currently-lit file, keyed by candidate id. */
  fileAlphaById: Map<string, number>
}

/** Resolves a single candidate to its decision given the frame-wide context. */
function decideOne(candidate: LabelCandidate, context: DecisionContext): LabelDecision {
  const text = truncate(candidate.text, context.maxTextLength)
  const base = {
    kind: candidate.kind,
    id: candidate.id,
    text,
    position: candidate.position,
  }

  if (candidate.kind === 'actor') {
    // An actor label is exactly as present as its orb: shown while it has any
    // alpha, gone the instant it fully fades.
    const alpha = candidate.actorAlpha ?? 0
    return { ...base, visible: alpha > 0, alpha }
  }

  if (candidate.kind === 'root') {
    // Roots are the persistent, subtle orientation layer: always on, always muted.
    return { ...base, visible: true, alpha: context.rootAlpha }
  }

  // File: visible only if the tier survived the LOD gates and this file is still
  // inside its touch-flash window.
  const flashAlpha = context.fileAlphaById.get(candidate.id) ?? 0
  const visible = context.fileTierVisible && flashAlpha > 0
  return { ...base, visible, alpha: flashAlpha }
}

/**
 * A file label's opacity from its most recent touch: full at the touch instant
 * and fading linearly to 0 across `fadeMs`, mirroring the node's touch flash so
 * the label and the glow flash together. A file with no recorded touch, a touch
 * in the future relative to `now`, or one past the window contributes nothing.
 */
function fileFlashAlpha(lastTouchedAt: number | undefined, now: number, fadeMs: number): number {
  if (lastTouchedAt === undefined) {
    return 0
  }
  const elapsed = now - lastTouchedAt
  if (elapsed < 0 || elapsed >= fadeMs) {
    return 0
  }
  return 1 - elapsed / fadeMs
}

/**
 * Shortens `text` to at most `maxLength` characters, replacing the clipped tail
 * with a single ellipsis so the result is never longer than `maxLength`. Text
 * already within the limit is returned untouched. A non-positive limit is a
 * caller bug (no label can be drawn in zero characters), so it is flagged rather
 * than silently producing a bare ellipsis.
 */
function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) {
    console.debug('runewood: label maxTextLength is non-positive, leaving text untruncated', maxLength)
    return text
  }
  if (text.length <= maxLength) {
    return text
  }
  // Reserve one character for the ellipsis so the whole string fits in maxLength.
  return text.slice(0, maxLength - 1) + TRUNCATION_ELLIPSIS
}
