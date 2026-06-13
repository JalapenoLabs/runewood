// Copyright © 2026 Jalapeno Labs

import type { RunewoodEvent } from '../types'

/**
 * What a single `advance` step produced. The renderer reads this to decide what
 * to do next:
 *
 * - `playhead`: where the clock now sits, in epoch milliseconds.
 * - `crossed`: events the playhead newly passed *moving forward*, in time order,
 *   so the renderer can spawn their effects. Empty when the playhead did not
 *   move forward (paused at a bound, or a backward step).
 * - `rebuild`: set when the playhead moved backward. "Events newly crossed" is a
 *   forward-only idea, so a backward move instead tells the caller to re-fold the
 *   tree from scratch at `playhead` (the deterministic fold makes that exact).
 *   `crossed` is always empty when `rebuild` is true.
 */
export type AdvanceResult = {
  playhead: number
  crossed: RunewoodEvent[]
  rebuild: boolean
}

/**
 * The default playhead position for an empty log. With no events there is no
 * timeline to sit on, so the clock parks at zero until the first `append`.
 */
const EMPTY_PLAYHEAD = 0

/**
 * A pure playback clock over a time-sorted event log. It owns the playhead, the
 * `playing` flag, and the `speed` multiplier, and decides which slice of the log
 * is "active now". It never touches the DOM or WebGL and never reads the wall
 * clock: time enters only through `advance(deltaMs)`, which the controller's RAF
 * loop drives. That keeps seeking exact and the whole thing unit-testable.
 *
 * The log is kept sorted by `at` at all times. `append` inserts in order so live
 * ingestion (which can arrive slightly out of order) stays consistent with an
 * upfront replay log.
 */
export class Timeline {
  private readonly events: RunewoodEvent[]
  private playhead: number
  private playingFlag: boolean
  private speedMultiplier: number
  private following: boolean

  /**
   * @param initialEvents an upfront replay log. Copied and sorted, so the caller
   *   keeps ownership of its array. Omit for a purely live (appended) timeline.
   */
  constructor(initialEvents: RunewoodEvent[] = []) {
    this.events = [ ...initialEvents ].sort((left, right) => left.at - right.at)
    this.playhead = this.events.length > 0 ? this.events[0].at : EMPTY_PLAYHEAD
    this.playingFlag = false
    this.speedMultiplier = 1
    this.following = false
  }

  /** Whether the clock is advancing. `advance` only moves the playhead while true. */
  get playing(): boolean {
    return this.playingFlag
  }

  /** The current playback rate. 1 is real time, 2 is double speed, 0.5 is half. */
  get speed(): number {
    return this.speedMultiplier
  }

  /** The current playhead time in epoch milliseconds. */
  get time(): number {
    return this.playhead
  }

  /** Whether the clock is pinned to the newest event (see `followLive`). */
  get live(): boolean {
    return this.following
  }

  /** Epoch ms of the earliest event, or `null` when the log is empty. */
  get firstEventTime(): number | null {
    return this.events.length > 0 ? this.events[0].at : null
  }

  /** Epoch ms of the latest event, or `null` when the log is empty. */
  get lastEventTime(): number | null {
    return this.events.length > 0 ? this.events[this.events.length - 1].at : null
  }

  /** Start advancing on subsequent `advance` calls. */
  play(): void {
    this.playingFlag = true
  }

  /** Stop advancing. The playhead holds its position. */
  pause(): void {
    this.playingFlag = false
  }

  /**
   * Set the playback rate. A non-finite or non-positive multiplier is rejected:
   * zero would freeze playback (use `pause`) and a negative value would smuggle
   * backward motion into the forward-only `advance` path. Both signal a caller
   * bug, so we warn and keep the current speed rather than fail silently.
   */
  setSpeed(multiplier: number): void {
    if (!Number.isFinite(multiplier) || multiplier <= 0) {
      console.debug('runewood: ignoring invalid timeline speed, keeping current', multiplier)
      return
    }
    this.speedMultiplier = multiplier
  }

  /**
   * Jump the playhead to an absolute time, clamped to `[firstEventTime,
   * lastEventTime]`. A manual seek always detaches from live follow until
   * `followLive(true)` re-attaches it. Returns whether the move was backward,
   * which is the caller's signal to re-fold the tree (see `AdvanceResult.rebuild`).
   */
  seek(time: number): { rebuild: boolean } {
    if (!Number.isFinite(time)) {
      console.debug('runewood: ignoring non-finite seek target', time)
      return { rebuild: false }
    }
    this.following = false
    const target = this.clampToBounds(time)
    const movedBackward = target < this.playhead
    this.playhead = target
    return { rebuild: movedBackward }
  }

  /**
   * Append a live event, keeping the log time-sorted. When following live, the
   * playhead jumps forward to the new event so the view tracks the newest
   * activity; a prior manual `seek` (which cleared `following`) leaves the
   * playhead where the user parked it.
   */
  append(event: RunewoodEvent): void {
    const insertionIndex = this.findInsertionIndex(event.at)
    this.events.splice(insertionIndex, 0, event)

    if (this.following && event.at > this.playhead) {
      this.playhead = event.at
    }
  }

  /**
   * Pin the playhead to the newest event (or release it). Enabling jumps to the
   * latest event immediately so the view catches up; disabling simply stops
   * future `append`s from dragging the playhead along.
   */
  followLive(shouldFollow: boolean): void {
    this.following = shouldFollow
    if (shouldFollow && this.events.length > 0) {
      this.playhead = this.events[this.events.length - 1].at
    }
  }

  /**
   * Advance the playhead by `deltaMs * speed` (only while playing) and report the
   * events newly crossed moving forward. The playhead clamps to the last event,
   * so playback naturally stops at the end of the log. `deltaMs` is wall time
   * supplied by the caller's RAF loop; this module never reads a clock itself.
   *
   * A negative `deltaMs` would move backward, which is `seek`'s job, not this
   * forward stepper's; we reject it (warn, no movement) rather than fold a
   * backward path into the "events crossed" contract.
   */
  advance(deltaMs: number): AdvanceResult {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      console.debug('runewood: ignoring invalid advance delta', deltaMs)
      return { playhead: this.playhead, crossed: [], rebuild: false }
    }
    if (!this.playingFlag || this.events.length === 0) {
      return { playhead: this.playhead, crossed: [], rebuild: false }
    }

    const previousPlayhead = this.playhead
    const target = this.clampToBounds(previousPlayhead + deltaMs * this.speedMultiplier)
    this.playhead = target

    // Half-open interval `(previous, target]`: events exactly at the previous
    // position were already crossed on the step that landed there, and an event
    // exactly at the new target counts as crossed now.
    const crossed = this.events.filter((event) => {
      return event.at > previousPlayhead && event.at <= target
    })
    return { playhead: target, crossed, rebuild: false }
  }

  /**
   * Events in the half-open interval `(afterExclusive, throughInclusive]`, in time
   * order. Unlike `advance`, this neither moves the playhead nor depends on the
   * `playing` flag: it is how the controller folds the tree up to the current
   * playhead no matter how the playhead got there, whether a forward `play` moved
   * it or a live `append` pinned it to the newest event. Returns an empty array
   * when the interval is empty or inverted.
   */
  crossedBetween(afterExclusive: number, throughInclusive: number): RunewoodEvent[] {
    if (throughInclusive <= afterExclusive) {
      return []
    }
    // The log is kept sorted by `at`, so the crossed slice is contiguous: binary
    // search the first event strictly past `afterExclusive`, then walk forward
    // collecting until one exceeds `throughInclusive`. This is O(log n + k) in the
    // number of crossed events `k`, versus the O(n) full-array filter it replaces,
    // which matters when the controller folds this every frame over a long log.
    const start = this.firstIndexAfter(afterExclusive)
    const crossed: RunewoodEvent[] = []
    for (let index = start; index < this.events.length; index++) {
      const event = this.events[index]
      if (event.at > throughInclusive) {
        break
      }
      crossed.push(event)
    }
    return crossed
  }

  /** Fraction of the timeline elapsed, 0..1. Returns 0 for an empty or zero-length log. */
  progress(): number {
    const span = this.duration()
    if (span <= 0) {
      return 0
    }
    // firstEventTime is non-null here because duration() > 0 implies events exist.
    return (this.playhead - (this.firstEventTime ?? 0)) / span
  }

  /** Total time span of the log in milliseconds (`last - first`), or 0 when empty. */
  duration(): number {
    if (this.events.length === 0) {
      return 0
    }
    return this.events[this.events.length - 1].at - this.events[0].at
  }

  /**
   * Drop the oldest events so at most `maxEvents` remain, for a long-running live
   * feed that would otherwise grow without bound. The retained window is still a
   * contiguous, time-sorted tail of the log, so the fold over it stays exact; only
   * history older than the window is forgotten. The playhead is nudged forward to
   * the new earliest event if trimming dropped the event it was sitting on, so it
   * never points before the retained log.
   *
   * A non-positive or non-finite cap is rejected (warn, no change): "retain at
   * most zero events" is never a real intent and would throw the log away.
   */
  trimToCount(maxEvents: number): void {
    if (!Number.isFinite(maxEvents) || maxEvents <= 0) {
      console.debug('runewood: ignoring invalid timeline retention cap, keeping full log', maxEvents)
      return
    }
    const excess = this.events.length - maxEvents
    if (excess <= 0) {
      return
    }
    this.events.splice(0, excess)
    const earliest = this.events[0].at
    if (this.playhead < earliest) {
      this.playhead = earliest
    }
  }

  /** A defensive copy of the sorted log, for callers that re-fold on a rebuild. */
  getEvents(): RunewoodEvent[] {
    return [ ...this.events ]
  }

  /** Clamps an arbitrary time into the log's `[first, last]` window. */
  private clampToBounds(time: number): number {
    const first = this.firstEventTime
    const last = this.lastEventTime
    if (first === null || last === null) {
      return EMPTY_PLAYHEAD
    }
    if (time < first) {
      return first
    }
    if (time > last) {
      return last
    }
    return time
  }

  /**
   * Binary-searches the index of the first event whose time is strictly greater
   * than `at`, i.e. the lower bound of the half-open `(at, ...]` slice. Returns
   * `events.length` when every event is at or before `at`. The log is sorted by
   * `at`, so this is the O(log n) lookup {@link crossedBetween} uses to skip
   * straight to the start of the crossed window instead of scanning from zero.
   */
  private firstIndexAfter(at: number): number {
    let low = 0
    let high = this.events.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (this.events[mid].at > at) {
        high = mid
      }
      else {
        low = mid + 1
      }
    }
    return low
  }

  /**
   * First index whose event time is strictly greater than `at`, i.e. where a new
   * event with that time should be spliced in to keep the log sorted. A linear
   * scan is fine: live appends are near-sorted, so this almost always lands at
   * the end after touching only the last few entries.
   */
  private findInsertionIndex(at: number): number {
    for (let index = this.events.length - 1; index >= 0; index--) {
      if (this.events[index].at <= at) {
        return index + 1
      }
    }
    return 0
  }
}
