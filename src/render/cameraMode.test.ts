// Copyright © 2026 Jalapeno Labs

import type { WorldBounds } from './camera'
import type { RecentNodeSample, RecentActorSample } from './cameraMode'

// Core
import { describe, expect, it } from 'vitest'

// Subject under test
import { recentActivityBounds, isAutoCameraMode } from './cameraMode'

/**
 * A distinctive fallback box the caller would hold a quiet view at, so a test can
 * assert "nothing recent -> the fallback is returned unchanged" by identity-ish
 * equality rather than guessing a computed shape.
 */
const FALLBACK: WorldBounds = {
  min: { x: -111, y: -222 },
  max: { x: 333, y: 444 },
}

/** A 5 second recency window with 10 units of padding, the shape the controller passes. */
const WINDOW_MS = 5_000
const PADDING = 10

describe('recentActivityBounds', () => {
  it('includes only the nodes touched within the window and pads the box around them', () => {
    const nodes: RecentNodeSample[] = [
      // Inside the window: these define the box.
      { position: { x: 0, y: 0 }, lastTouchedAt: 9_000 },
      { position: { x: 100, y: 40 }, lastTouchedAt: 8_000 },
      // Far older than the window: must be excluded even though it is far away.
      { position: { x: -5_000, y: -5_000 }, lastTouchedAt: 1_000 },
    ]

    const bounds = recentActivityBounds(nodes, [], {
      playhead: 10_000,
      windowMs: WINDOW_MS,
      padding: PADDING,
      fallback: FALLBACK,
    })

    // The excluded ancient node (at -5000,-5000) must not drag the box out; the box
    // is the two recent nodes (0,0)-(100,40) padded by 10 on every side.
    expect(bounds).toEqual({
      min: { x: -10, y: -10 },
      max: { x: 110, y: 50 },
    })
  })

  it('treats a node touched exactly at the window edge as still recent', () => {
    const nodes: RecentNodeSample[] = [
      // playhead - lastTouchedAt === windowMs: the boundary is inclusive.
      { position: { x: 20, y: 20 }, lastTouchedAt: 5_000 },
    ]

    const bounds = recentActivityBounds(nodes, [], {
      playhead: 10_000,
      windowMs: WINDOW_MS,
      padding: PADDING,
      fallback: FALLBACK,
    })

    expect(bounds).toEqual({
      min: { x: 10, y: 10 },
      max: { x: 30, y: 30 },
    })
  })

  it('excludes a node one millisecond past the window edge', () => {
    const nodes: RecentNodeSample[] = [
      // Just outside the window, and the only candidate -> nothing recent.
      { position: { x: 20, y: 20 }, lastTouchedAt: 4_999 },
    ]

    const bounds = recentActivityBounds(nodes, [], {
      playhead: 10_000,
      windowMs: WINDOW_MS,
      padding: PADDING,
      fallback: FALLBACK,
    })

    expect(bounds).toBe(FALLBACK)
  })

  it('excludes a never-touched node (null lastTouchedAt)', () => {
    const nodes: RecentNodeSample[] = [
      { position: { x: 1, y: 1 }, lastTouchedAt: null },
    ]

    const bounds = recentActivityBounds(nodes, [], {
      playhead: 10_000,
      windowMs: WINDOW_MS,
      padding: PADDING,
      fallback: FALLBACK,
    })

    expect(bounds).toBe(FALLBACK)
  })

  it('includes recently-active actors so the worker stays framed', () => {
    // The only recent node sits at the origin; a recent actor working far to the
    // right must widen the box to keep the worker (and its beams) on screen.
    const nodes: RecentNodeSample[] = [
      { position: { x: 0, y: 0 }, lastTouchedAt: 9_500 },
    ]
    const actors: RecentActorSample[] = [
      { position: { x: 200, y: -60 }, lastActiveAt: 9_800 },
      // An actor that went quiet long ago must not stretch the frame back to it.
      { position: { x: -9_000, y: 9_000 }, lastActiveAt: 100 },
    ]

    const bounds = recentActivityBounds(nodes, actors, {
      playhead: 10_000,
      windowMs: WINDOW_MS,
      padding: PADDING,
      fallback: FALLBACK,
    })

    // Box spans the origin node and the active actor (0,0)..(200,-60), padded.
    expect(bounds).toEqual({
      min: { x: -10, y: -70 },
      max: { x: 210, y: 10 },
    })
  })

  it('falls back to the held framing when nothing is recently active', () => {
    const nodes: RecentNodeSample[] = [
      { position: { x: 0, y: 0 }, lastTouchedAt: 1_000 },
    ]
    const actors: RecentActorSample[] = [
      { position: { x: 50, y: 50 }, lastActiveAt: 500 },
    ]

    const bounds = recentActivityBounds(nodes, actors, {
      playhead: 100_000,
      windowMs: WINDOW_MS,
      padding: PADDING,
      fallback: FALLBACK,
    })

    // Everything aged out -> the caller's last framing is returned untouched, so the
    // live camera gently holds its view rather than snapping to the origin.
    expect(bounds).toBe(FALLBACK)
  })

  it('returns the fallback for an empty forest with no samples at all', () => {
    const bounds = recentActivityBounds([], [], {
      playhead: 0,
      windowMs: WINDOW_MS,
      padding: PADDING,
      fallback: FALLBACK,
    })

    expect(bounds).toBe(FALLBACK)
  })

  it('includes a future-dated sample (touched at the playhead, delta <= 0)', () => {
    // A node touched exactly at (or slightly ahead of) the playhead is maximally
    // recent and must always be in frame.
    const nodes: RecentNodeSample[] = [
      { position: { x: 5, y: 5 }, lastTouchedAt: 10_000 },
    ]

    const bounds = recentActivityBounds(nodes, [], {
      playhead: 10_000,
      windowMs: WINDOW_MS,
      padding: PADDING,
      fallback: FALLBACK,
    })

    expect(bounds).toEqual({
      min: { x: -5, y: -5 },
      max: { x: 15, y: 15 },
    })
  })
})

describe('isAutoCameraMode', () => {
  it('reports overview and follow as auto-framing modes', () => {
    expect(isAutoCameraMode('overview')).toBe(true)
    expect(isAutoCameraMode('follow')).toBe(true)
  })

  it('reports manual as not auto-framing', () => {
    expect(isAutoCameraMode('manual')).toBe(false)
  })
})
