// Copyright © 2026 Jalapeno Labs

import type { RunewoodEvent } from '../types'

// Core
import { describe, expect, it } from 'vitest'

import { Timeline } from './timeline'

function event(overrides: Partial<RunewoodEvent>): RunewoodEvent {
  return {
    at: 1000,
    actor: 'agent-1',
    action: 'modify',
    path: 'repo/src/main.rs',
    ...overrides,
  }
}

/** A small, deliberately out-of-order log to prove the constructor sorts. */
function sampleLog(): RunewoodEvent[] {
  return [
    event({ at: 3000, path: 'repo/c.ts' }),
    event({ at: 1000, path: 'repo/a.ts' }),
    event({ at: 2000, path: 'repo/b.ts' }),
  ]
}

describe('Timeline construction', () => {
  it('sorts the initial log by time and parks the playhead on the first event', () => {
    const timeline = new Timeline(sampleLog())

    expect(timeline.firstEventTime).toBe(1000)
    expect(timeline.lastEventTime).toBe(3000)
    expect(timeline.time).toBe(1000)
    expect(timeline.getEvents().map((entry) => entry.at)).toEqual([ 1000, 2000, 3000 ])
  })

  it('copies the input log so later caller mutations do not leak in', () => {
    const log = sampleLog()
    const timeline = new Timeline(log)
    log.push(event({ at: 9999 }))

    expect(timeline.lastEventTime).toBe(3000)
  })

  it('parks at zero with no first/last bounds when the log is empty', () => {
    const timeline = new Timeline()

    expect(timeline.time).toBe(0)
    expect(timeline.firstEventTime).toBeNull()
    expect(timeline.lastEventTime).toBeNull()
    expect(timeline.duration()).toBe(0)
    expect(timeline.progress()).toBe(0)
  })
})

describe('Timeline.advance', () => {
  it('does not move while paused', () => {
    const timeline = new Timeline(sampleLog())
    const result = timeline.advance(5000)

    expect(result.playhead).toBe(1000)
    expect(result.crossed).toEqual([])
  })

  it('crosses exactly the events within the forward step, in time order', () => {
    const timeline = new Timeline(sampleLog())
    timeline.play()

    // From 1000, a 1500ms step lands at 2500, crossing the event at 2000 only.
    const result = timeline.advance(1500)

    expect(result.playhead).toBe(2500)
    expect(result.crossed.map((entry) => entry.at)).toEqual([ 2000 ])
    expect(result.rebuild).toBe(false)
  })

  it('treats the interval as half-open: the starting event is not re-crossed', () => {
    const timeline = new Timeline(sampleLog())
    timeline.play()

    // Starting exactly on the 1000 event, stepping to 2000 should cross 2000 but
    // not re-cross the 1000 the playhead already sits on.
    const result = timeline.advance(1000)

    expect(result.crossed.map((entry) => entry.at)).toEqual([ 2000 ])
  })

  it('scales the step by speed', () => {
    const fast = new Timeline(sampleLog())
    fast.play()
    fast.setSpeed(2)

    // 800ms of wall time at 2x covers 1600ms, 1000 -> 2600, crossing only 2000.
    const fastResult = fast.advance(800)
    expect(fastResult.playhead).toBe(2600)
    expect(fastResult.crossed.map((entry) => entry.at)).toEqual([ 2000 ])

    const slow = new Timeline(sampleLog())
    slow.play()
    slow.setSpeed(0.5)

    // 800ms at 0.5x covers 400ms, 1000 -> 1400, crossing nothing.
    const slowResult = slow.advance(800)
    expect(slowResult.playhead).toBe(1400)
    expect(slowResult.crossed).toEqual([])
  })

  it('clamps to the last event so playback stops at the end of the log', () => {
    const timeline = new Timeline(sampleLog())
    timeline.play()

    const result = timeline.advance(999999)

    expect(result.playhead).toBe(3000)
    expect(result.crossed.map((entry) => entry.at)).toEqual([ 2000, 3000 ])

    // A further step past the end crosses nothing and holds at the bound.
    const again = timeline.advance(5000)
    expect(again.playhead).toBe(3000)
    expect(again.crossed).toEqual([])
  })

  it('rejects a negative delta without moving the playhead', () => {
    const timeline = new Timeline(sampleLog())
    timeline.play()
    timeline.advance(1500)

    const result = timeline.advance(-500)

    expect(result.playhead).toBe(2500)
    expect(result.crossed).toEqual([])
    expect(result.rebuild).toBe(false)
  })
})

describe('Timeline.setSpeed', () => {
  it('keeps the current speed when given a non-positive or non-finite value', () => {
    const timeline = new Timeline(sampleLog())
    timeline.setSpeed(3)
    expect(timeline.speed).toBe(3)

    timeline.setSpeed(0)
    timeline.setSpeed(-2)
    timeline.setSpeed(Number.POSITIVE_INFINITY)
    timeline.setSpeed(Number.NaN)

    expect(timeline.speed).toBe(3)
  })
})

describe('Timeline.seek', () => {
  it('clamps a forward seek to the last event and does not signal a rebuild', () => {
    const timeline = new Timeline(sampleLog())

    const result = timeline.seek(50000)

    expect(timeline.time).toBe(3000)
    expect(result.rebuild).toBe(false)
  })

  it('clamps a seek before the first event up to the first bound', () => {
    const timeline = new Timeline(sampleLog())
    timeline.seek(2500)

    const result = timeline.seek(-1000)

    expect(timeline.time).toBe(1000)
    expect(result.rebuild).toBe(true)
  })

  it('signals a rebuild only when the playhead actually moves backward', () => {
    const timeline = new Timeline(sampleLog())
    timeline.seek(2500)

    const backward = timeline.seek(1200)
    expect(timeline.time).toBe(1200)
    expect(backward.rebuild).toBe(true)

    const forward = timeline.seek(2800)
    expect(timeline.time).toBe(2800)
    expect(forward.rebuild).toBe(false)
  })

  it('detaches from live follow', () => {
    const timeline = new Timeline(sampleLog())
    timeline.followLive(true)
    expect(timeline.live).toBe(true)

    timeline.seek(1500)
    expect(timeline.live).toBe(false)
  })
})

describe('Timeline.append and live follow', () => {
  it('keeps the log time-sorted when an out-of-order event arrives', () => {
    const timeline = new Timeline(sampleLog())

    timeline.append(event({ at: 2500, path: 'repo/late.ts' }))

    expect(timeline.getEvents().map((entry) => entry.at)).toEqual([ 1000, 2000, 2500, 3000 ])
  })

  it('tracks the newest event while following live', () => {
    const timeline = new Timeline(sampleLog())
    timeline.followLive(true)
    expect(timeline.time).toBe(3000)

    timeline.append(event({ at: 4000, path: 'repo/d.ts' }))
    expect(timeline.time).toBe(4000)
    expect(timeline.lastEventTime).toBe(4000)
  })

  it('leaves the playhead parked after a manual seek detaches it from live', () => {
    const timeline = new Timeline(sampleLog())
    timeline.followLive(true)

    // The user scrubs back: this detaches from live.
    timeline.seek(1500)
    expect(timeline.live).toBe(false)

    // A live event arrives, but the parked playhead must not jump to it.
    timeline.append(event({ at: 4000, path: 'repo/d.ts' }))
    expect(timeline.time).toBe(1500)

    // Re-enabling follow snaps the playhead back to the newest event.
    timeline.followLive(true)
    expect(timeline.time).toBe(4000)
  })

  it('does not drag the playhead backward when a late event is older than it', () => {
    const timeline = new Timeline(sampleLog())
    timeline.followLive(true)
    expect(timeline.time).toBe(3000)

    timeline.append(event({ at: 2500, path: 'repo/straggler.ts' }))
    expect(timeline.time).toBe(3000)
  })
})

describe('Timeline.progress and duration', () => {
  it('reports the span and the elapsed fraction', () => {
    const timeline = new Timeline(sampleLog())
    expect(timeline.duration()).toBe(2000)
    expect(timeline.progress()).toBe(0)

    timeline.seek(2000)
    expect(timeline.progress()).toBe(0.5)

    timeline.seek(3000)
    expect(timeline.progress()).toBe(1)
  })

  it('returns zero progress for a single-event log with no span', () => {
    const timeline = new Timeline([ event({ at: 5000 }) ])

    expect(timeline.duration()).toBe(0)
    expect(timeline.progress()).toBe(0)
  })
})

describe('Timeline.crossedBetween', () => {
  it('returns events in the half-open interval (after, through], regardless of play state', () => {
    const timeline = new Timeline(sampleLog())

    // Never played, so the playhead never moved; crossedBetween must still report
    // events purely from the interval. This is the live-follow folding path: the
    // playhead is moved by append, not advance, and the controller folds the gap.
    const crossed = timeline.crossedBetween(1000, 3000)

    expect(crossed.map((entry) => entry.at)).toEqual([ 2000, 3000 ])
  })

  it('excludes the lower bound and includes the upper bound', () => {
    const timeline = new Timeline(sampleLog())

    expect(timeline.crossedBetween(2000, 2000)).toEqual([])
    expect(timeline.crossedBetween(1999, 2000).map((entry) => entry.at)).toEqual([ 2000 ])
    expect(timeline.crossedBetween(0, 1000).map((entry) => entry.at)).toEqual([ 1000 ])
  })

  it('returns an empty array for an inverted or empty interval', () => {
    const timeline = new Timeline(sampleLog())

    expect(timeline.crossedBetween(3000, 1000)).toEqual([])
    expect(timeline.crossedBetween(5000, 9000)).toEqual([])
  })

  it('folds a live-appended event the moment the playhead pins to it', () => {
    // The exact frozen-canvas scenario: an empty, following timeline gets a live
    // append, which jumps the playhead to the new event. The controller folds
    // (lastFolded, now] and must see that event even though nothing ever "played".
    const timeline = new Timeline()
    timeline.followLive(true)

    const lastFolded = timeline.time
    timeline.append(event({ at: 4000, path: 'repo/live.ts' }))

    expect(timeline.time).toBe(4000)
    const crossed = timeline.crossedBetween(lastFolded, timeline.time)
    expect(crossed.map((entry) => entry.path)).toEqual([ 'repo/live.ts' ])
  })

  // The binary-search rewrite must keep the exact same (after, through] semantics,
  // so these pin down the boundary and duplicate-time behavior the search hinges on.
  it('returns the same contiguous slice the linear filter would, with duplicate timestamps', () => {
    // Several events share at=2000; the half-open interval must include every one
    // of them when 2000 is the upper bound and exclude every one when it is the
    // lower bound, which is exactly where an off-by-one in the search would show.
    const timeline = new Timeline([
      event({ at: 1000, path: 'a' }),
      event({ at: 2000, path: 'b' }),
      event({ at: 2000, path: 'c' }),
      event({ at: 2000, path: 'd' }),
      event({ at: 3000, path: 'e' }),
    ])

    expect(timeline.crossedBetween(1000, 2000).map((entry) => entry.path)).toEqual([ 'b', 'c', 'd' ])
    expect(timeline.crossedBetween(2000, 3000).map((entry) => entry.path)).toEqual([ 'e' ])
    expect(timeline.crossedBetween(2000, 2000)).toEqual([])
  })

  it('collects from the first event past the lower bound through the upper, in order', () => {
    const timeline = new Timeline([
      event({ at: 100, path: 'a' }),
      event({ at: 200, path: 'b' }),
      event({ at: 300, path: 'c' }),
      event({ at: 400, path: 'd' }),
      event({ at: 500, path: 'e' }),
    ])

    // A window that starts and ends mid-log: only the strictly-greater-than lower
    // bound through the inclusive upper bound, contiguous and time-ordered.
    expect(timeline.crossedBetween(150, 400).map((entry) => entry.path)).toEqual([ 'b', 'c', 'd' ])

    // A lower bound landing exactly on an event excludes that event but keeps the rest.
    expect(timeline.crossedBetween(200, 500).map((entry) => entry.path)).toEqual([ 'c', 'd', 'e' ])
  })

  it('returns an empty slice when the whole log is at or before the lower bound', () => {
    const timeline = new Timeline([
      event({ at: 100 }),
      event({ at: 200 }),
    ])
    expect(timeline.crossedBetween(200, 900)).toEqual([])
    expect(timeline.crossedBetween(500, 900)).toEqual([])
  })

  it('returns the whole log when the window spans before the first through after the last', () => {
    const timeline = new Timeline([
      event({ at: 100, path: 'a' }),
      event({ at: 200, path: 'b' }),
      event({ at: 300, path: 'c' }),
    ])
    expect(timeline.crossedBetween(0, 9999).map((entry) => entry.path)).toEqual([ 'a', 'b', 'c' ])
  })
})
