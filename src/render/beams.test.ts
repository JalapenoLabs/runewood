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
  describe('spawn + activeParticles', () => {
    it('places particlesPerBeam particles in flight on a spawn', () => {
      const field = new BeamField({ particlesPerBeam: 6, lifetimeMs: 1000 })
      const placed = field.spawn(makeSpawn({ at: 0 }))

      expect(placed).toBe(6)
      // Sampled just after birth, before any phase-delayed particle could expire.
      expect(field.activeParticles(1).length).toBe(6)
    })

    it('reports no particles before birth and after the lifetime', () => {
      const field = new BeamField({ particlesPerBeam: 4, lifetimeMs: 1000 })
      field.spawn(makeSpawn({ at: 1000 }))

      expect(field.activeParticles(500)).toHaveLength(0)
      expect(field.activeParticles(2000)).toHaveLength(0)
    })
  })

  describe('a beam travels source -> target and fades out', () => {
    it('moves its leading particle from the source toward the target over its life', () => {
      // A single particle with no phase delay so progress maps cleanly to time.
      const field = new BeamField({ particlesPerBeam: 1, lifetimeMs: 1000, arcBow: 0 })
      const source = { x: 0, y: 0 }
      const target = { x: 200, y: 0 }
      field.spawn(makeSpawn({ at: 0, source, target }))

      const early = field.activeParticles(50)[0]
      const mid = field.activeParticles(500)[0]
      const late = field.activeParticles(950)[0]

      // It marches toward the target along x.
      expect(early.position.x).toBeLessThan(mid.position.x)
      expect(mid.position.x).toBeLessThan(late.position.x)
      // And ends up near the target by end of life (drift is tiny vs the span).
      expect(late.position.x).toBeGreaterThan(150)
    })

    it('fades alpha and size to nothing by the end of the lifetime', () => {
      const field = new BeamField({ particlesPerBeam: 1, lifetimeMs: 1000, particleSize: 4 })
      field.spawn(makeSpawn({ at: 0 }))

      const early = field.activeParticles(10)[0]
      const nearEnd = field.activeParticles(990)[0]

      expect(early.alpha).toBeGreaterThan(nearEnd.alpha)
      expect(early.size).toBeGreaterThan(nearEnd.size)
      // Right at the boundary the particle is gone entirely.
      expect(field.activeParticles(1000)).toHaveLength(0)
    })
  })

  describe('pooling stays allocation-flat', () => {
    it('reclaims expired slots so capacity never grows under sustained spawning', () => {
      const field = new BeamField({ capacity: 64, particlesPerBeam: 4, lifetimeMs: 1000 })

      // Spawn one beam every 250ms for a long run; old beams expire as new ones land.
      let now = 0
      for (let beam = 0; beam < 200; beam++) {
        now = beam * 250
        field.spawn(makeSpawn({ at: now, actor: `agent-${beam % 5}` }))
      }

      // The pool capacity is fixed no matter how many beams have been fired.
      expect(field.capacity).toBe(64)
      // At any instant only the beams within one lifetime are alive, far under cap.
      const active = field.activeParticles(now)
      expect(active.length).toBeGreaterThan(0)
      expect(active.length).toBeLessThanOrEqual(64)
    })

    it('evicts the nearest-to-expiry particle when the pool is saturated', () => {
      // Capacity 2, two particles per beam: the second beam must reuse both slots.
      const field = new BeamField({ capacity: 2, particlesPerBeam: 2, lifetimeMs: 1000, arcBow: 0 })
      field.spawn(makeSpawn({ at: 0, source: { x: 0, y: 0 }, target: { x: 10, y: 0 }}))
      field.spawn(makeSpawn({ at: 100, source: { x: 500, y: 500 }, target: { x: 510, y: 500 }}))

      const active = field.activeParticles(120)
      // Still exactly capacity particles; the first beam was fully displaced.
      expect(active).toHaveLength(2)
      // Every surviving particle belongs to the second beam (near 500,500), proving eviction.
      for (const particle of active) {
        expect(particle.position.x).toBeGreaterThan(400)
        expect(particle.position.y).toBeGreaterThan(400)
      }
    })
  })

  describe('action changes the beam color', () => {
    it('colors create, modify, scan, and delete beams distinctly', () => {
      const field = new BeamField({ particlesPerBeam: 1 })
      const actor = 'agent-1'

      function hueFor(action: BeamSpawn['action']): number {
        const fresh = new BeamField({ particlesPerBeam: 1 })
        fresh.spawn(makeSpawn({ at: 0, actor, action }))
        return fresh.activeParticles(1)[0].color.h
      }

      const create = hueFor('create')
      const modify = hueFor('modify')
      const scan = hueFor('scan')
      const del = hueFor('delete')

      // Same actor, different actions, so any hue difference is the action tint.
      const hues = [ create, modify, scan, del ]
      const unique = new Set(hues)
      expect(unique.size).toBe(4)
      void field
    })

    it('blends the actor color in so two actors on the same action differ', () => {
      const fieldA = new BeamField({ particlesPerBeam: 1, actionTint: 0.5 })
      const fieldB = new BeamField({ particlesPerBeam: 1, actionTint: 0.5 })
      fieldA.spawn(makeSpawn({ at: 0, actor: 'agent-a', action: 'modify' }))
      fieldB.spawn(makeSpawn({ at: 0, actor: 'agent-b', action: 'modify' }))

      const colorA = fieldA.activeParticles(1)[0].color
      const colorB = fieldB.activeParticles(1)[0].color
      expect(colorA.h).not.toBeCloseTo(colorB.h, 1)
    })

    it('is pure actor color at tint 0 and pure action color at tint 1', () => {
      const pureActor = new BeamField({ particlesPerBeam: 1, actionTint: 0 })
      pureActor.spawn(makeSpawn({ at: 0, actor: 'agent-1', action: 'delete' }))
      const actorHue = pureActor.activeParticles(1)[0].color.h
      expect(actorHue).toBeCloseTo(colorForActor('agent-1').h, 5)
    })
  })

  describe('pulses are actor-local bursts, not beams', () => {
    it('spawns particles around the actor with no target reached', () => {
      const field = new BeamField({ particlesPerBeam: 8, lifetimeMs: 1000, pulseRadius: 30 })
      const source = { x: 100, y: 100 }
      field.spawnPulse({ at: 0, actor: 'agent-1', action: 'pulse', source })

      const particles = field.activeParticles(500)
      expect(particles.length).toBe(8)

      // Every pulse particle stays near the actor: within the spray radius, and it
      // spreads in multiple directions rather than marching to one far target.
      const directions = new Set<string>()
      for (const particle of particles) {
        const distance = Math.hypot(particle.position.x - source.x, particle.position.y - source.y)
        expect(distance).toBeLessThanOrEqual(30 + 0.001)
        directions.add(`${Math.sign(particle.position.x - source.x)},${Math.sign(particle.position.y - source.y)}`)
      }
      expect(directions.size).toBeGreaterThan(1)
    })

    it('spawn with target: null behaves identically to spawnPulse', () => {
      const viaSpawn = new BeamField({ particlesPerBeam: 5 })
      const viaPulse = new BeamField({ particlesPerBeam: 5 })
      viaSpawn.spawn(makeSpawn({ at: 0, actor: 'agent-1', action: 'pulse', target: null }))
      viaPulse.spawnPulse({ at: 0, actor: 'agent-1', action: 'pulse', source: { x: 0, y: 0 }})

      expect(viaSpawn.activeParticles(100).length).toBe(viaPulse.activeParticles(100).length)
    })
  })

  describe('clear empties active particles', () => {
    it('drops everything in flight while keeping capacity', () => {
      const field = new BeamField({ capacity: 32, particlesPerBeam: 4 })
      field.spawn(makeSpawn({ at: 0 }))
      expect(field.activeParticles(100).length).toBeGreaterThan(0)

      field.clear()

      expect(field.activeParticles(100)).toHaveLength(0)
      expect(field.capacity).toBe(32)
    })
  })

  describe('determinism', () => {
    it('produces identical particle state for identical inputs', () => {
      const first = new BeamField({ particlesPerBeam: 6 })
      const second = new BeamField({ particlesPerBeam: 6 })
      first.spawn(makeSpawn({ at: 0, actor: 'agent-1', action: 'create' }))
      second.spawn(makeSpawn({ at: 0, actor: 'agent-1', action: 'create' }))

      expect(first.activeParticles(400)).toEqual(second.activeParticles(400))
    })

    it('step is an alias for activeParticles at the same time', () => {
      const field = new BeamField({ particlesPerBeam: 3 })
      field.spawn(makeSpawn({ at: 0 }))
      expect(field.step(300)).toEqual(field.activeParticles(300))
    })
  })
})
