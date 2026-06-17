// Copyright © 2026 Jalapeno Labs

import type { WorldBounds } from './camera'
import type { RecentNodeSample, RecentActorSample } from './cameraMode'

// Core
import { describe, expect, it } from 'vitest'

// Subject under test
import { recentActivityBounds, isAutoCameraMode, followActorBounds } from './cameraMode'

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

/** The close-up follow distance and padding the controller passes for click-to-follow. */
const FOLLOW_MIN_HALF_EXTENT = 160
const FOLLOW_PADDING = 80

describe('followActorBounds', () => {
  it('frames a lone actor in a box of the minimum half-extent (plus padding) around its orb', () => {
    // An actor touching nothing is framed at the steady close-up distance: a box of
    // FOLLOW_MIN_HALF_EXTENT on each side of the orb, then padded, centered on the orb.
    const bounds = followActorBounds({
      actorPosition: { x: 100, y: -50 },
      touchedPositions: [],
      minHalfExtent: FOLLOW_MIN_HALF_EXTENT,
      padding: FOLLOW_PADDING,
    })

    // 160 half-extent + 80 padding = 240 on every side of (100, -50).
    expect(bounds).toEqual({
      min: { x: 100 - 240, y: -50 - 240 },
      max: { x: 100 + 240, y: -50 + 240 },
    })
  })

  it('keeps the box centered on the orb so the followed actor stays centered', () => {
    const bounds = followActorBounds({
      actorPosition: { x: 100, y: -50 },
      touchedPositions: [],
      minHalfExtent: FOLLOW_MIN_HALF_EXTENT,
      padding: FOLLOW_PADDING,
    })

    // The midpoint of the framed box is exactly the actor's orb, so the camera centers
    // on (and tracks) the actor.
    const centerX = (bounds!.min.x + bounds!.max.x) / 2
    const centerY = (bounds!.min.y + bounds!.max.y) / 2
    expect(centerX).toBe(100)
    expect(centerY).toBe(-50)
  })

  it('grows the box to include the files the actor is touching when they reach past the minimum', () => {
    // A touched file far to the right pushes the box out past the minimum half-extent
    // on that side, while the minimum still floors the other sides around the orb.
    const bounds = followActorBounds({
      actorPosition: { x: 0, y: 0 },
      touchedPositions: [
        { x: 500, y: 0 },
        { x: 0, y: 20 },
      ],
      minHalfExtent: FOLLOW_MIN_HALF_EXTENT,
      padding: FOLLOW_PADDING,
    })

    // Right edge is driven by the far file (500 + 80 padding); the left / top / bottom
    // are still floored by the minimum half-extent around the orb (160 + 80 padding).
    expect(bounds).toEqual({
      min: { x: -240, y: -240 },
      max: { x: 580, y: 240 },
    })
  })

  it('does not shrink below the minimum when a touched file sits right beside the actor', () => {
    // A nearby file inside the minimum box must not tighten the framing: the minimum
    // half-extent still governs, so the follow zoom stays steady instead of snapping in.
    const bounds = followActorBounds({
      actorPosition: { x: 0, y: 0 },
      touchedPositions: [{ x: 10, y: -10 }],
      minHalfExtent: FOLLOW_MIN_HALF_EXTENT,
      padding: FOLLOW_PADDING,
    })

    expect(bounds).toEqual({
      min: { x: -240, y: -240 },
      max: { x: 240, y: 240 },
    })
  })

  it('returns null when the actor has no live position, signalling auto-release', () => {
    // A null orb position means the followed actor faded out / is gone; the function
    // returns null so the controller drops the follow and reverts to its camera mode.
    const bounds = followActorBounds({
      actorPosition: null,
      touchedPositions: [{ x: 5, y: 5 }],
      minHalfExtent: FOLLOW_MIN_HALF_EXTENT,
      padding: FOLLOW_PADDING,
    })

    expect(bounds).toBeNull()
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
