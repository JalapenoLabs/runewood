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
 * brightness to how far the core is pushed toward white.
 *
 * `glow` is the strength of the single soft additive glow sprite the backend
 * scales under the crisp core (the redesign replaced the old hard-edged middle
 * halo disc with one cheap radial-gradient sprite, so the "nice big glow" look
 * survives even with the heavy bloom post-process off). A hot node carries a
 * faint *steady* glow between touches; a fresh touch spikes it. It fully settles
 * to zero on an idle, cold node, so nothing leaves a lingering half-faded ring.
 */
export type NodeVisual = {
  /**
   * Radius in world units: the node's roughly-constant baseline size scaled by a
   * transient touch *pulse*. The baseline does not grow with cumulative touches;
   * instead each touch briefly swells the radius and it eases back to baseline over
   * {@link NodeVisualOptions.pulseMs}, so a busy file throbs rather than ballooning.
   */
  radius: number
  /** Base color: vivid file hue from its extension, or the neutral theme hub color for a directory. */
  color: Hsl
  /** Presence opacity, `0..1`. Seeded nodes are dim; deleted nodes fade toward 0. */
  alpha: number
  /** How far the core is pushed toward white, `0..1`. Rises with heat and spikes on a fresh touch. */
  brightness: number
  /**
   * Strength of the soft additive glow sprite drawn under the core, `0..1`. A
   * heat-scaled steady baseline plus the same touch flash that drives brightness,
   * so a busy node blooms and an idle cold node settles to no glow at all.
   */
  glow: number
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
  /**
   * How long the transient size pulse lasts before the radius has fully eased back
   * to baseline, in milliseconds. Within this window after `lastTouchedAt` the
   * node's radius is briefly swelled (peaking at the touch). Kept short (~0.5-0.8s)
   * so a touch reads as a snappy throb, not a slow swell.
   */
  pulseMs?: number
  /**
   * Peak fraction the radius swells by at the instant of a touch. `0.6` means the
   * node grows to 1.6x its baseline on a touch, then eases back to 1x over
   * {@link pulseMs}. This is the *pulse* the user asked for in place of the old
   * cumulative growth.
   */
  pulseStrength?: number
}

const DEFAULT_SEEDED_ALPHA = 0.28
const DEFAULT_DELETE_FADE_MS = 4_000
const DEFAULT_FLASH_MS = 1_200
const DEFAULT_FLASH_STRENGTH = 1

/**
 * How long the touch size-pulse takes to ease back to baseline, in milliseconds.
 * ~0.65s lands in the user's requested 0.5-0.8s window: a quick, snappy throb on
 * each edit rather than a lingering swell. A judgment call worth tuning to taste.
 */
const DEFAULT_PULSE_MS = 650

/**
 * Peak fraction the radius swells by at the instant of a touch. `0.6` grows the
 * node to 1.6x its baseline, then eases back to 1x over {@link DEFAULT_PULSE_MS}.
 * Big enough to read clearly as a pulse, small enough not to dominate the forest.
 */
const DEFAULT_PULSE_STRENGTH = 0.6

/**
 * Baseline brightness (how far the core is pushed toward white) that scales with
 * heat alone, before any flash is added. A hot, idle node's core stays a touch
 * brighter; this keeps it from going flat between touches.
 */
const HEAT_BRIGHTNESS_WEIGHT = 0.6

/**
 * Baseline glow-sprite strength that scales with heat alone, before any flash is
 * added. A hot, idle node keeps a soft, *steady* glow so it still reads as a
 * glowing orb between touches even with the bloom post-process off, while a cold
 * idle node settles to no glow at all (heat is 0, so this contributes nothing).
 * Kept below 1 so the steady glow is a gentle halo, not a full flare; the touch
 * flash is what spikes it bright.
 */
const HEAT_GLOW_WEIGHT = 0.5

/**
 * Computes the full visual description of a node at playhead time `now`. Pure and
 * deterministic: it reads only the node, the supplied time, the theme, and the
 * options, never `Date.now()` or randomness, so a rewound timeline repaints every
 * node identically.
 *
 * The mapping:
 * - **radius** is the node's roughly-constant baseline size from {@link nodeHeat}
 *   scaled by a transient touch *pulse*: each touch briefly swells it and it eases
 *   back to baseline over `pulseMs`. The baseline no longer grows with cumulative
 *   touches, so a busy file throbs on each edit instead of permanently ballooning.
 * - **color** is the file's vivid extension hue ({@link colorForPath}) for a leaf,
 *   or the theme's neutral hub color for a directory, so directories read as
 *   structural wood and files as their language.
 * - **alpha** is driven by {@link NodeStatus}: a seeded node is dimmed to
 *   `seededAlpha`, a discovered node is fully present, and a deleted node fades
 *   from full to 0 over `deleteFadeMs` since its delete.
 * - **brightness** is a heat-scaled baseline plus a short-lived flash that spikes
 *   on a fresh touch and decays linearly over `flashMs`.
 * - **glow** is the soft additive glow sprite's strength: a (separate) heat-scaled
 *   baseline plus the same touch flash, so a busy node blooms and an idle cold
 *   node settles to nothing (its heat is 0). This is what carries the big-glow
 *   look the user liked even when the heavy bloom post-process is off.
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
  const pulseMs = options.pulseMs ?? DEFAULT_PULSE_MS
  const pulseStrength = options.pulseStrength ?? DEFAULT_PULSE_STRENGTH

  // `baseRadius` is the calm resting size; it no longer grows with cumulative
  // touches. The transient pulse swells it on a touch and eases it back, so the
  // node throbs per edit rather than ballooning permanently.
  const { heat, radius: baseRadius } = nodeHeat(node, now, options.heat)
  const radius = baseRadius * (1 + touchPulse(node.lastTouchedAt, now, pulseMs, pulseStrength))

  // Directories carry no language, so they take the theme's neutral, desaturated
  // hub color and read as the structural wood the files hang from. Files take
  // their vivid extension color, so folder vs file is obvious at a glance.
  const color = node.isFile
    ? colorForPath(node.path)
    : { ...theme.hub }

  const alpha = alphaForStatus(node.status, node.lastTouchedAt, now, seededAlpha, deleteFadeMs)

  // The touch flash drives both the core's brightness and the glow sprite's
  // strength: it spikes at the instant of a touch and decays linearly to exactly
  // zero over `flashMs`, so a touched node flares then fully settles, never
  // leaving a lingering half-faded ring.
  const flash = touchFlash(node.lastTouchedAt, now, flashMs, flashStrength)

  // Both brightness and glow ride a heat-scaled baseline so a busy node stays warm
  // between touches; the flash rides on top of each and decays back to its
  // baseline. A cold idle node has heat 0, so both collapse to zero: just a crisp
  // core, no glow.
  const brightness = Math.min(1, heat * HEAT_BRIGHTNESS_WEIGHT + flash)
  const glow = Math.min(1, heat * HEAT_GLOW_WEIGHT + flash)

  return { radius, color, alpha, brightness, glow }
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

/**
 * The transient size-pulse fraction from a node's most recent touch: how much to
 * swell the radius right now, on top of its baseline. It is `pulseStrength` at the
 * instant of the touch and eases smoothly back to 0 over `pulseMs`, so a touched
 * node throbs out then settles to its baseline size rather than growing for good.
 * Before the touch or after the window it contributes nothing; a node that has
 * never been touched (`lastTouchedAt === null`) never pulses.
 *
 * The ease is quadratic (the linear decay squared) so the swell falls off gently
 * near the end of the window, reading as a soft settle rather than a hard stop.
 */
function touchPulse(
  lastTouchedAt: number | null,
  now: number,
  pulseMs: number,
  pulseStrength: number,
): number {
  if (lastTouchedAt === null) {
    return 0
  }
  const elapsed = now - lastTouchedAt
  if (elapsed < 0 || elapsed >= pulseMs) {
    return 0
  }
  const remaining = 1 - elapsed / pulseMs
  return pulseStrength * remaining * remaining
}
