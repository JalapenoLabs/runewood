// Copyright © 2026 Jalapeno Labs

import type { Hsl } from './theme'

/**
 * A live "watch this" overlay over a set of nodes (issue #180). A host registers
 * a group of paths to make glow with a breathing pulse, and the group stays lit
 * until the host removes it. The canonical use is Seraphim's watch page lighting
 * up every file a pull request touched while its CI runs, then clearing them when
 * CI finishes.
 *
 * Unlike everything else in `core`, a highlight is explicitly NOT part of the
 * replayable event fold: it is a "now" concern the host drives imperatively, its
 * animation runs on wall/frame time (not the playhead), and it survives a
 * pause/seek untouched. This registry is the pure, time-injected heart of that
 * feature: it owns the membership and color of each group and answers "what is the
 * effective highlight for this path", while the controller owns the wall clock and
 * the renderer turns the answer into a ring.
 *
 * It stays free of pixi, the DOM, and the clock so it can be unit-tested in
 * isolation; {@link highlightPulse} is a separate pure function the renderer feeds
 * the wall-clock animation time so the glow breathes.
 */
export type HighlightGroup = {
  /** Stable id of the group, so a host can update or remove exactly this set later. */
  id: string
  /** The node paths this group lights up. Membership is a set; order is irrelevant. */
  paths: Set<string>
  /** The color the ring is drawn in for every path in this group. */
  color: Hsl
}

/**
 * The effective highlight for one node: the color to draw its ring in and the id
 * of the group that resolved it. Returned by {@link HighlightRegistry.highlightFor}
 * so the renderer knows both how to color the ring and which group owns it.
 */
export type HighlightResolution = {
  /** The resolved ring color (the winning group's color). */
  color: Hsl
  /** The id of the group that owns this node's highlight. */
  groupId: string
}

/**
 * The mutable set of highlight groups, resolving each node to its effective
 * highlight. Insertion order is preserved (it is a `Map`), and on an overlap the
 * **most-recently-added** group wins: a host that lights a node under two PRs sees
 * the newer one's color, which is the intuitive "latest concern on top" behavior.
 * Re-adding an existing id replaces that group in place AND moves it to the front
 * of the resolution order, so updating a group also makes it win an overlap.
 *
 * All methods are synchronous and pure of any clock; the breathing animation is
 * the separate {@link highlightPulse}, which the renderer drives off the wall
 * clock. This keeps the registry trivially testable.
 */
export class HighlightRegistry {
  /**
   * The groups, keyed by id. A `Map` so iteration order is the insertion order,
   * which {@link highlightFor} walks in reverse to give the most-recently-added
   * group priority on an overlapping path.
   */
  private readonly groups: Map<string, HighlightGroup> = new Map()

  /**
   * Adds a new highlight group, or replaces an existing one with the same id.
   * Replacing deletes the old entry first so the re-added group lands at the END
   * of the insertion order, which makes it win any overlap (most-recent wins) and
   * keeps "update" and "re-add" consistent.
   */
  public set(id: string, paths: Iterable<string>, color: Hsl): void {
    // Drop any prior entry so a replacement re-inserts at the back of the order,
    // not in its old slot; this is what makes the updated group win an overlap.
    this.groups.delete(id)
    this.groups.set(id, { id, paths: new Set(paths), color })
  }

  /**
   * Replaces just the path set of an existing group, keeping its color and its
   * place in the resolution order. This is the per-file progressive update a host
   * uses as work lands (e.g. adding a newly-touched file to the lit PR). A no-op
   * with a debug note if the id is unknown, since there is nothing to update.
   */
  public updatePaths(id: string, paths: Iterable<string>): void {
    const group = this.groups.get(id)
    if (!group) {
      console.debug('runewood: updatePaths called for unknown highlight group, ignoring', id)
      return
    }
    group.paths = new Set(paths)
  }

  /**
   * Removes the group with this id. Returns whether a group was actually removed,
   * so a caller can tell a real clear from a stale handle firing twice.
   */
  public remove(id: string): boolean {
    return this.groups.delete(id)
  }

  /** Drops every group, clearing all highlights at once. */
  public clear(): void {
    this.groups.clear()
  }

  /** Whether any group is currently registered, so the renderer can skip work when none are. */
  public get isEmpty(): boolean {
    return this.groups.size === 0
  }

  /**
   * The effective highlight for a node path, or `null` if no group contains it.
   * Resolves an overlap deterministically by **most-recently-added wins**: the
   * groups are walked in reverse insertion order and the first one containing the
   * path is returned, so the newest concern shows on top.
   */
  public highlightFor(path: string): HighlightResolution | null {
    // Walk newest-first so the most-recently-added group wins an overlapping path.
    const ordered = [ ...this.groups.values() ]
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const group = ordered[index]
      if (group.paths.has(path)) {
        return { color: group.color, groupId: group.id }
      }
    }
    return null
  }

  /**
   * The union of every highlighted path across all groups, so the renderer can
   * iterate exactly the nodes that need a ring without scanning the whole forest.
   * A path lit by several groups appears once.
   */
  public highlightedPaths(): Set<string> {
    const union = new Set<string>()
    for (const group of this.groups.values()) {
      for (const path of group.paths) {
        union.add(path)
      }
    }
    return union
  }
}

/** Tuning for {@link highlightPulse}; every field has a default so the common call is `highlightPulse(time)`. */
export type HighlightPulseOptions = {
  /**
   * The full breathing period in milliseconds: how long one dim -> bright -> dim
   * cycle takes. ~1.6s reads as a calm, deliberate "watch this" breath rather than
   * a frantic blink.
   */
  periodMs?: number
  /**
   * The trough intensity, `0..1`: how dim the pulse gets at its quietest. Kept
   * above zero so a highlighted node never fully drops its ring between breaths;
   * the host wants it visibly lit the whole time CI runs, just breathing.
   */
  floor?: number
}

/** Default breathing period: one calm dim -> bright -> dim cycle in milliseconds. */
const DEFAULT_PERIOD_MS = 1_600

/**
 * Default trough intensity: the ring never dims below this, so a highlighted node
 * stays clearly lit the whole time, breathing between this floor and full.
 */
const DEFAULT_FLOOR = 0.35

/**
 * The breathing intensity of a highlight ring at wall-clock animation time
 * `animationTimeMs`, in `[floor, 1]`. It is a smooth cosine breath: a full, soft
 * dim -> bright -> dim cycle every `periodMs`, never a hard blink. Pure and
 * clock-free (the time is injected), so the renderer feeds it the controller's
 * wall/frame animation clock and the ring breathes on real time independent of
 * the playhead.
 *
 * The cosine is remapped from its native `[-1, 1]` to `[floor, 1]` so the pulse
 * spends equal time rising and falling and rests above the floor at its quietest.
 */
export function highlightPulse(animationTimeMs: number, options: HighlightPulseOptions = {}): number {
  const periodMs = options.periodMs ?? DEFAULT_PERIOD_MS
  const floor = options.floor ?? DEFAULT_FLOOR

  // A cosine breath: phase 0 sits at the bright peak, half a period at the floor.
  // `(1 - cos) / 2` maps the native [-1, 1] to a [0, 1] that rises and falls
  // symmetrically; then we lift the trough to `floor` so the ring stays visible.
  const phase = (animationTimeMs / periodMs) * Math.PI * 2
  const unit = (1 - Math.cos(phase)) / 2
  return floor + (1 - floor) * unit
}
