// Copyright © 2026 Jalapeno Labs

import type { Hsl } from '../core/theme'
import type { RunewoodAction } from '../types'

/**
 * The Gource-style intent color for each beam action, as a pure lookup.
 *
 * Gource colors its action laser by the verb (`src/action.cpp`): a creation beam is
 * green `(0,1,0)`, a modify beam is warm amber `(1,0.7,0.3)`, and a delete beam is
 * red `(1,0,0)`. Runewood carries two extra actions Gource has no equivalent for, so
 * they get sensible siblings: `scan` (a non-mutating read/grep) is a cool cyan, well
 * clear of the warm mutate colors so "looked at, did not change" reads at a glance,
 * and `pulse` (path-less actor activity) is a violet that matches the actor-local
 * flash it already draws.
 *
 * These are the Gource RGB triples expressed in the engine's canonical {@link Hsl}
 * so the renderer can push them toward white as the additive glow stacks, exactly as
 * it does for every other color. The hue is what carries the "what happened" meaning;
 * saturation and lightness are pinned vivid so a beam reads as a hot colored laser
 * rather than a washed-out streak.
 *
 * Kept pure and table-driven (no branching) so the action -> color mapping is one
 * obvious source of truth and is unit-testable without a GPU. The blend with the
 * actor's identity color (so two actors doing the same action still differ) lives in
 * {@link import('./beams').BeamField}; this module owns only the action half.
 */
export function beamActionColor(action: RunewoodAction): Hsl {
  return colorByAction[action]
}

/**
 * The Gource action hues, in degrees. `create`/`modify`/`delete` are the exact hues
 * of Gource's green/amber/red action beams; `scan` and `pulse` are runewood's own
 * cool/violet additions for actions Gource does not model.
 */
const hueByAction = {
  create: 120, // Gource add green (0, 1, 0)
  modify: 38, // Gource modify amber (1, 0.7, 0.3)
  delete: 0, // Gource remove red (1, 0, 0)
  scan: 190, // runewood: a cool cyan for a non-mutating read, clear of the warm mutate hues
  pulse: 280, // runewood: violet, matching the actor-local pulse flash
} as const satisfies Record<RunewoodAction, number>

/**
 * Saturation and lightness for every beam action color. Pinned high and bright so a
 * beam reads as a vivid laser the additive blend can blow out to a hot white core,
 * the way Gource's beams bloom. Only the hue (the meaning) varies between actions.
 */
const BEAM_SATURATION = 0.85
const BEAM_LIGHTNESS = 0.55

/** The action -> color table, the single source of truth {@link beamActionColor} reads. */
const colorByAction = {
  create: { h: hueByAction.create, s: BEAM_SATURATION, l: BEAM_LIGHTNESS },
  modify: { h: hueByAction.modify, s: BEAM_SATURATION, l: BEAM_LIGHTNESS },
  delete: { h: hueByAction.delete, s: BEAM_SATURATION, l: BEAM_LIGHTNESS },
  scan: { h: hueByAction.scan, s: BEAM_SATURATION, l: BEAM_LIGHTNESS },
  pulse: { h: hueByAction.pulse, s: BEAM_SATURATION, l: BEAM_LIGHTNESS },
} as const satisfies Record<RunewoodAction, Hsl>
