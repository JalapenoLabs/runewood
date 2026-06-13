// Copyright © 2026 Jalapeno Labs

import type { NodeStatus, TreeNode } from '../core/tree'
import type { HeatOptions } from '../core/layout'
import type { Hsl, RunewoodTheme } from '../core/theme'

// Core
import { nodeHeat } from '../core/layout'
import { colorForPath } from '../core/theme'

/**
 * The pure visual description of a single node, ready for a backend to draw. It
 * is deliberately library-free: a `radius` in world units, a canonical {@link Hsl}
 * color, a `0..1` `alpha`, and a `0..1` `brightness` the renderer adds on top of
 * the base color as an additive glow. A backend turns these into a soft glowing
 * disc; this module never touches pixi, the DOM, or the clock.
 *
 * `brightness` is kept separate from `alpha` on purpose. `alpha` is how present
 * the node is (a seeded node is faint, a deleted node fades to nothing), while
 * `brightness` is how *hot* it is right now (a freshly touched node spikes white
 * then cools). A backend can map them independently: alpha to the disc's opacity,
 * brightness to the strength of the additive bloom.
 */
export type NodeVisual = {
  /** Radius in world units, derived from the node's heat. */
  radius: number
  /** Base color: vivid file hue from its extension, or the neutral theme hub color for a directory. */
  color: Hsl
  /** Presence opacity, `0..1`. Seeded nodes are dim; deleted nodes fade toward 0. */
  alpha: number
  /** Additive glow strength, `0..1`. Rises with heat and spikes on a fresh touch. */
  brightness: number
}

/**
 * Tuning for {@link nodeVisualFor}. Every field has a default so the common call
 * is `nodeVisualFor(node, now, theme)`. Times are in milliseconds to match the
 * absolute `lastTouchedAt` on a {@link TreeNode} and the playhead `now`.
 */
export type NodeVisualOptions = {
  /** How heat maps to radius. Forwarded verbatim to {@link nodeHeat}. */
  heat?: HeatOptions
  /** Opacity of a seeded (known-but-untouched) node. Discovered nodes are fully opaque. */
  seededAlpha?: number
  /**
   * How long a deleted node takes to fade from full to invisible, in
   * milliseconds. The fade is measured from the node's `lastTouchedAt` (the
   * delete event's time) against `now`.
   */
  deleteFadeMs?: number
  /**
   * How long a touch flash lasts before it has fully decayed back to baseline,
   * in milliseconds. Within this window after `lastTouchedAt` the node's
   * brightness is lifted toward 1.
   */
  flashMs?: number
  /**
   * Peak extra brightness a flash adds at the instant of a touch, `0..1`. It
   * decays linearly to 0 over {@link flashMs}.
   */
  flashStrength?: number
}

const DEFAULT_SEEDED_ALPHA = 0.28
const DEFAULT_DELETE_FADE_MS = 4_000
const DEFAULT_FLASH_MS = 1_200
const DEFAULT_FLASH_STRENGTH = 1

/**
 * Baseline glow that scales with heat alone, before any flash is added. A hot,
 * idle node still glows softly; this keeps it from going flat between touches.
 */
const HEAT_BRIGHTNESS_WEIGHT = 0.6

/**
 * Computes the full visual description of a node at playhead time `now`. Pure and
 * deterministic: it reads only the node, the supplied time, the theme, and the
 * options, never `Date.now()` or randomness, so a rewound timeline repaints every
 * node identically.
 *
 * The mapping:
 * - **radius** comes straight from {@link nodeHeat} (touch count + recency), so
 *   sizing logic lives in one place.
 * - **color** is the file's vivid extension hue ({@link colorForPath}) for a leaf,
 *   or the theme's neutral hub color for a directory, so directories read as
 *   structural wood and files as their language.
 * - **alpha** is driven by {@link NodeStatus}: a seeded node is dimmed to
 *   `seededAlpha`, a discovered node is fully present, and a deleted node fades
 *   from full to 0 over `deleteFadeMs` since its delete.
 * - **brightness** is a heat-scaled baseline plus a short-lived flash that spikes
 *   on a fresh touch and decays linearly over `flashMs`.
 */
export function nodeVisualFor(
  node: TreeNode,
  now: number,
  theme: RunewoodTheme,
  options: NodeVisualOptions = {},
): NodeVisual {
  const seededAlpha = options.seededAlpha ?? DEFAULT_SEEDED_ALPHA
  const deleteFadeMs = options.deleteFadeMs ?? DEFAULT_DELETE_FADE_MS
  const flashMs = options.flashMs ?? DEFAULT_FLASH_MS
  const flashStrength = options.flashStrength ?? DEFAULT_FLASH_STRENGTH

  const { heat, radius } = nodeHeat(node, now, options.heat)

  // Directories carry no language, so they take the theme's neutral, desaturated
  // hub color and read as the structural wood the files hang from. Files take
  // their vivid extension color, so folder vs file is obvious at a glance.
  const color = node.isFile
    ? colorForPath(node.path)
    : { ...theme.hub }

  const alpha = alphaForStatus(node.status, node.lastTouchedAt, now, seededAlpha, deleteFadeMs)

  // Baseline glow tracks heat so a busy node stays warm between touches; the
  // flash rides on top and decays back to that baseline.
  const baselineBrightness = heat * HEAT_BRIGHTNESS_WEIGHT
  const flash = touchFlash(node.lastTouchedAt, now, flashMs, flashStrength)
  const brightness = Math.min(1, baselineBrightness + flash)

  return { radius, color, alpha, brightness }
}

/**
 * The presence opacity for a node given its status. Seeded nodes are dimmed to a
 * faint constant; discovered nodes are fully opaque; deleted nodes fade linearly
 * from full to 0 over `deleteFadeMs` measured from their delete time. A deleted
 * node with no recorded touch time (which should not happen, since a delete event
 * stamps `lastTouchedAt`) is treated as fully faded so it never lingers visibly.
 */
function alphaForStatus(
  status: NodeStatus,
  lastTouchedAt: number | null,
  now: number,
  seededAlpha: number,
  deleteFadeMs: number,
): number {
  if (status === 'seeded') {
    return seededAlpha
  }
  if (status === 'discovered') {
    return 1
  }

  // Deleted: fade out over the window since the delete landed.
  if (lastTouchedAt === null) {
    console.debug('runewood: deleted node has no lastTouchedAt, treating as fully faded')
    return 0
  }
  const elapsed = now - lastTouchedAt
  const remaining = 1 - elapsed / deleteFadeMs
  return Math.max(0, Math.min(1, remaining))
}

/**
 * The short-lived brightness spike from a node's most recent touch. It is
 * `flashStrength` at the instant of the touch and decays linearly to 0 over
 * `flashMs`; before the touch or after the window it contributes nothing. A node
 * that has never been touched (`lastTouchedAt === null`) never flashes.
 */
function touchFlash(
  lastTouchedAt: number | null,
  now: number,
  flashMs: number,
  flashStrength: number,
): number {
  if (lastTouchedAt === null) {
    return 0
  }
  const elapsed = now - lastTouchedAt
  if (elapsed < 0 || elapsed >= flashMs) {
    return 0
  }
  const decay = 1 - elapsed / flashMs
  return flashStrength * decay
}
