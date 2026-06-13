// Copyright © 2026 Jalapeno Labs

import type { PickCandidate } from './picking'

// Core
import { describe, expect, it } from 'vitest'

import { nearestWithinRadius } from './picking'

describe('nearestWithinRadius', () => {
  it('returns the id of a candidate within the radius', () => {
    const candidates: PickCandidate[] = [
      { id: 'repo/a.ts', position: { x: 10, y: 10 }},
    ]

    const hit = nearestWithinRadius({ x: 12, y: 11 }, candidates, 5)

    expect(hit).toBe('repo/a.ts')
  })

  it('returns null when every candidate is outside the radius', () => {
    const candidates: PickCandidate[] = [
      { id: 'repo/a.ts', position: { x: 100, y: 100 }},
      { id: 'repo/b.ts', position: { x: -80, y: 40 }},
    ]

    const hit = nearestWithinRadius({ x: 0, y: 0 }, candidates, 10)

    expect(hit).toBeNull()
  })

  it('picks the closer of two candidates both within the radius', () => {
    const candidates: PickCandidate[] = [
      { id: 'far', position: { x: 8, y: 0 }},
      { id: 'near', position: { x: 3, y: 0 }},
    ]

    const hit = nearestWithinRadius({ x: 0, y: 0 }, candidates, 20)

    expect(hit).toBe('near')
  })

  it('treats a candidate exactly on the radius boundary as a hit', () => {
    const candidates: PickCandidate[] = [
      { id: 'edge', position: { x: 5, y: 0 }},
    ]

    const hit = nearestWithinRadius({ x: 0, y: 0 }, candidates, 5)

    expect(hit).toBe('edge')
  })

  it('returns null for an empty candidate set', () => {
    expect(nearestWithinRadius({ x: 0, y: 0 }, [], 100)).toBeNull()
  })

  it('rejects a negative radius rather than matching anything', () => {
    const candidates: PickCandidate[] = [
      { id: 'repo/a.ts', position: { x: 0, y: 0 }},
    ]

    const hit = nearestWithinRadius({ x: 0, y: 0 }, candidates, -1)

    expect(hit).toBeNull()
  })
})
