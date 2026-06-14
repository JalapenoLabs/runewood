// Copyright © 2026 Jalapeno Labs

import type { BeamSpawn } from './beams'

// Core
import { describe, expect, it } from 'vitest'

import { colorForActor } from '../core/theme'
import { BeamField } from './beams'

/** A baseline beam spawn the tests tweak per case. Source at origin, target out right. */
function makeSpawn(overrides: Partial<BeamSpawn> = {}): BeamSpawn {
  return {
    at: overrides.at ?? 1000,
    actor: overrides.actor ?? 'agent-1',
    action: overrides.action ?? 'modify',
    source: overrides.source ?? { x: 0, y: 0 },
    target: overrides.target === undefined ? { x: 100, y: 0 } : overrides.target,
  }
}

describe('BeamField', () => {
  describe('spawn + activeBeams', () => {
    it('places exactly one beam in flight on a spawn', () => {
      const field = new BeamField({ lifetimeMs: 1000 })
      const placed = field.spawn(makeSpawn({ at: 0 }))

      expect(placed).toBe(1)
      expect(field.activeBeams(1)).toHaveLength(1)
    })

    it('reports no beams before birth and after the lifetime', () => {
      const field = new BeamField({ lifetimeMs: 1000 })
      field.spawn(makeSpawn({ at: 1000 }))

      expect(field.activeBeams(500)).toHaveLength(0)
      expect(field.activeBeams(2000)).toHaveLength(0)
    })

    it('connects the actor source to the touched target with fixed endpoints', () => {
      const field = new BeamField({ lifetimeMs: 1000 })
      const source = { x: 10, y: 20 }
      const target = { x: 200, y: 60 }
      field.spawn(makeSpawn({ at: 0, source, target }))

      // A flashlight pulse does not travel: the endpoints are the actor and the
      // file for the whole life, only the width/alpha change.
      const early = field.activeBeams(50)[0]
      const late = field.activeBeams(700)[0]
      expect(early.source).toEqual(source)
      expect(early.target).toEqual(target)
      expect(late.source).toEqual(source)
      expect(late.target).toEqual(target)
    })
  })

  describe('a beam is bright + wide at spawn and tapers + fades to nothing', () => {
    it('starts bright and wide, then thins and dims, reaching zero by end of life', () => {
      const field = new BeamField({ lifetimeMs: 1000, beamWidth: 16 })
      field.spawn(makeSpawn({ at: 0 }))

      const spawnSample = field.activeBeams(1)[0]
      const mid = field.activeBeams(500)[0]
      const nearEnd = field.activeBeams(990)[0]

      // Bright + wide at birth.
      expect(spawnSample.alpha).toBeGreaterThan(0.9)
      expect(spawnSample.width).toBeGreaterThan(14)

      // Both fall monotonically toward nothing.
      expect(mid.alpha).toBeLessThan(spawnSample.alpha)
      expect(mid.width).toBeLessThan(spawnSample.width)
      expect(nearEnd.alpha).toBeLessThan(mid.alpha)
      expect(nearEnd.width).toBeLessThan(mid.width)

      // The width and alpha approach zero as the life ends.
      expect(nearEnd.alpha).toBeLessThan(0.05)
      expect(nearEnd.width).toBeLessThan(1)
    })

    it('is fully gone (no active beam) exactly at the lifetime boundary', () => {
      const field = new BeamField({ lifetimeMs: 1000 })
      field.spawn(makeSpawn({ at: 0 }))
      // Right at the boundary the beam has fully faded and freed its slot.
      expect(field.activeBeams(1000)).toHaveLength(0)
    })
  })

  describe('pooling stays allocation-flat', () => {
    it('reclaims expired slots so capacity never grows under sustained spawning', () => {
      const field = new BeamField({ capacity: 64, lifetimeMs: 1000 })

      // Spawn one beam every 250ms for a long run; old beams expire as new ones land.
      let now = 0
      for (let beam = 0; beam < 200; beam++) {
        now = beam * 250
        field.spawn(makeSpawn({ at: now, actor: `agent-${beam % 5}` }))
      }

      // The pool capacity is fixed no matter how many beams have been fired.
      expect(field.capacity).toBe(64)
      // At any instant only the beams within one lifetime are alive, far under cap.
      const active = field.activeBeams(now)
      expect(active.length).toBeGreaterThan(0)
      expect(active.length).toBeLessThanOrEqual(64)
    })

    it('evicts the nearest-to-expiry beam when the pool is saturated', () => {
      // Capacity 1: the second beam must reuse the only slot, displacing the first.
      const field = new BeamField({ capacity: 1, lifetimeMs: 1000 })
      field.spawn(makeSpawn({ at: 0, source: { x: 0, y: 0 }, target: { x: 10, y: 0 }}))
      field.spawn(makeSpawn({ at: 100, source: { x: 500, y: 500 }, target: { x: 510, y: 500 }}))

      const active = field.activeBeams(120)
      // Still exactly capacity beams; the first was fully displaced.
      expect(active).toHaveLength(1)
      // The survivor is the second beam (anchored near 500,500), proving eviction.
      expect(active[0].source.x).toBeGreaterThan(400)
      expect(active[0].source.y).toBeGreaterThan(400)
    })
  })

  describe('action changes the beam color', () => {
    it('colors create, modify, scan, and delete beams distinctly', () => {
      const actor = 'agent-1'

      function hueFor(action: BeamSpawn['action']): number {
        const fresh = new BeamField()
        fresh.spawn(makeSpawn({ at: 0, actor, action }))
        return fresh.activeBeams(1)[0].color.h
      }

      const create = hueFor('create')
      const modify = hueFor('modify')
      const scan = hueFor('scan')
      const del = hueFor('delete')

      // Same actor, different actions, so any hue difference is the action tint.
      const unique = new Set([ create, modify, scan, del ])
      expect(unique.size).toBe(4)
    })

    it('blends the actor color in so two actors on the same action differ', () => {
      const fieldA = new BeamField({ actionTint: 0.5 })
      const fieldB = new BeamField({ actionTint: 0.5 })
      fieldA.spawn(makeSpawn({ at: 0, actor: 'agent-a', action: 'modify' }))
      fieldB.spawn(makeSpawn({ at: 0, actor: 'agent-b', action: 'modify' }))

      const colorA = fieldA.activeBeams(1)[0].color
      const colorB = fieldB.activeBeams(1)[0].color
      expect(colorA.h).not.toBeCloseTo(colorB.h, 1)
    })

    it('is pure actor color at tint 0', () => {
      const pureActor = new BeamField({ actionTint: 0 })
      pureActor.spawn(makeSpawn({ at: 0, actor: 'agent-1', action: 'delete' }))
      const actorHue = pureActor.activeBeams(1)[0].color.h
      expect(actorHue).toBeCloseTo(colorForActor('agent-1').h, 5)
    })
  })

  describe('pulses are actor-local flashes, not beams that reach a node', () => {
    it('targets a short hashed nudge off the actor, within the pulse radius', () => {
      const field = new BeamField({ lifetimeMs: 1000, pulseRadius: 30 })
      const source = { x: 100, y: 100 }
      field.spawnPulse({ at: 0, actor: 'agent-1', action: 'pulse', source })

      const beams = field.activeBeams(500)
      expect(beams).toHaveLength(1)

      const beam = beams[0]
      expect(beam.source).toEqual(source)
      // The pulse flash reaches only the short pulse radius off the actor.
      const reach = Math.hypot(beam.target.x - source.x, beam.target.y - source.y)
      expect(reach).toBeCloseTo(30, 5)
    })

    it('spawn with target: null behaves identically to spawnPulse', () => {
      const viaSpawn = new BeamField()
      const viaPulse = new BeamField()
      viaSpawn.spawn(makeSpawn({ at: 0, actor: 'agent-1', action: 'pulse', target: null }))
      viaPulse.spawnPulse({ at: 0, actor: 'agent-1', action: 'pulse', source: { x: 0, y: 0 }})

      expect(viaSpawn.activeBeams(100)).toEqual(viaPulse.activeBeams(100))
    })
  })

  describe('clear empties active beams', () => {
    it('drops everything in flight while keeping capacity', () => {
      const field = new BeamField({ capacity: 32 })
      field.spawn(makeSpawn({ at: 0 }))
      expect(field.activeBeams(100).length).toBeGreaterThan(0)

      field.clear()

      expect(field.activeBeams(100)).toHaveLength(0)
      expect(field.capacity).toBe(32)
    })
  })

  describe('determinism', () => {
    it('produces identical beam state for identical inputs', () => {
      const first = new BeamField()
      const second = new BeamField()
      first.spawn(makeSpawn({ at: 0, actor: 'agent-1', action: 'create' }))
      second.spawn(makeSpawn({ at: 0, actor: 'agent-1', action: 'create' }))

      expect(first.activeBeams(400)).toEqual(second.activeBeams(400))
    })

    it('step is an alias for activeBeams at the same time', () => {
      const field = new BeamField()
      field.spawn(makeSpawn({ at: 0 }))
      expect(field.step(300)).toEqual(field.activeBeams(300))
    })
  })
})
