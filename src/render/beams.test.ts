// Copyright © 2026 Jalapeno Labs

import type { Vec2 } from '../core/layout'
import type { BeamSpawn, BeamEndpointResolver, BeamEndpointReference } from './beams'

// Core
import { describe, expect, it } from 'vitest'

import { colorForActor } from '../core/theme'
import { BeamField, resolveBeamEndpoints } from './beams'

/** A baseline beam spawn the tests tweak per case. Reaches the file at `node`. */
function makeSpawn(overrides: Partial<BeamSpawn> = {}): BeamSpawn {
  return {
    at: overrides.at ?? 1000,
    actor: overrides.actor ?? 'agent-1',
    action: overrides.action ?? 'modify',
    targetPath: overrides.targetPath === undefined ? 'repo/file.ts' : overrides.targetPath,
  }
}

/**
 * A live endpoint resolver backed by plain maps, standing in for the scene's live
 * actor-orb and node-position lookups. An actor or path absent from its map resolves
 * to `null`, exactly as a faded-out actor or rewound-away node would.
 */
function makeResolver(
  actors: Record<string, Vec2>,
  nodes: Record<string, Vec2>,
): BeamEndpointResolver {
  return {
    actorSource: (actor) => actors[actor] ?? null,
    nodePosition: (path) => nodes[path] ?? null,
  }
}

/** The default resolver: one actor at the origin, one node out to the right. */
function defaultResolver(): BeamEndpointResolver {
  return makeResolver({ 'agent-1': { x: 0, y: 0 }}, { 'repo/file.ts': { x: 100, y: 0 }})
}

describe('BeamField', () => {
  describe('spawn + activeBeams', () => {
    it('places exactly one beam in flight on a spawn', () => {
      const field = new BeamField({ lifetimeMs: 1000 })
      const placed = field.spawn(makeSpawn({ at: 0 }))

      expect(placed).toBe(1)
      expect(field.activeBeams(1, defaultResolver())).toHaveLength(1)
    })

    it('reports no beams before birth and after the lifetime', () => {
      const field = new BeamField({ lifetimeMs: 1000 })
      field.spawn(makeSpawn({ at: 1000 }))

      expect(field.activeBeams(500, defaultResolver())).toHaveLength(0)
      expect(field.activeBeams(2000, defaultResolver())).toHaveLength(0)
    })

    it('resolves the source from the actor orb and the target from the node, live each frame', () => {
      const field = new BeamField({ lifetimeMs: 1000 })
      field.spawn(makeSpawn({ at: 0, actor: 'agent-1', targetPath: 'repo/file.ts' }))

      // First frame: the actor orb and node sit at one pair of live positions.
      const early = field.activeBeams(50, makeResolver(
        { 'agent-1': { x: 10, y: 20 }},
        { 'repo/file.ts': { x: 200, y: 60 }},
      ))[0]
      expect(early.source).toEqual({ x: 10, y: 20 })
      expect(early.target).toEqual({ x: 200, y: 60 })

      // Later frame: the orb glided and the node migrated; the SAME beam now reports the
      // new live endpoints, proving it follows them rather than holding spawn-time ones.
      const late = field.activeBeams(700, makeResolver(
        { 'agent-1': { x: 40, y: 25 }},
        { 'repo/file.ts': { x: 320, y: 90 }},
      ))[0]
      expect(late.source).toEqual({ x: 40, y: 25 })
      expect(late.target).toEqual({ x: 320, y: 90 })
    })

    it('drops a beam whose target node no longer resolves (rewound away)', () => {
      const field = new BeamField({ lifetimeMs: 1000 })
      field.spawn(makeSpawn({ at: 0, actor: 'agent-1', targetPath: 'repo/gone.ts' }))

      // The actor is still present but the target node has vanished from the lookup:
      // the beam ends gracefully rather than drawing to a stale / origin point.
      const beams = field.activeBeams(50, makeResolver({ 'agent-1': { x: 0, y: 0 }}, {}))
      expect(beams).toHaveLength(0)
    })

    it('drops a beam whose firing actor orb is gone (faded out)', () => {
      const field = new BeamField({ lifetimeMs: 1000 })
      field.spawn(makeSpawn({ at: 0, actor: 'agent-1', targetPath: 'repo/file.ts' }))

      // The node still exists but the actor's orb has faded out: nothing to fling from.
      const beams = field.activeBeams(50, makeResolver({}, { 'repo/file.ts': { x: 100, y: 0 }}))
      expect(beams).toHaveLength(0)
    })
  })

  describe('a beam is bright + wide at spawn and tapers + fades to nothing', () => {
    it('starts bright and wide, then thins and dims, reaching zero by end of life', () => {
      const field = new BeamField({ lifetimeMs: 1000, beamWidth: 16 })
      field.spawn(makeSpawn({ at: 0 }))

      const spawnSample = field.activeBeams(1, defaultResolver())[0]
      const mid = field.activeBeams(500, defaultResolver())[0]
      const nearEnd = field.activeBeams(990, defaultResolver())[0]

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
      expect(field.activeBeams(1000, defaultResolver())).toHaveLength(0)
    })
  })

  describe('pooling stays allocation-flat', () => {
    it('reclaims expired slots so capacity never grows under sustained spawning', () => {
      const field = new BeamField({ capacity: 64, lifetimeMs: 1000 })

      // A resolver that places every actor and node somewhere, so every live beam draws.
      const resolver: BeamEndpointResolver = {
        actorSource: () => ({ x: 0, y: 0 }),
        nodePosition: () => ({ x: 100, y: 0 }),
      }

      // Spawn one beam every 250ms for a long run; old beams expire as new ones land.
      let now = 0
      for (let beam = 0; beam < 200; beam++) {
        now = beam * 250
        field.spawn(makeSpawn({ at: now, actor: `agent-${beam % 5}` }))
      }

      // The pool capacity is fixed no matter how many beams have been fired.
      expect(field.capacity).toBe(64)
      // At any instant only the beams within one lifetime are alive, far under cap.
      const active = field.activeBeams(now, resolver)
      expect(active.length).toBeGreaterThan(0)
      expect(active.length).toBeLessThanOrEqual(64)
    })

    it('evicts the nearest-to-expiry beam when the pool is saturated', () => {
      // Capacity 1: the second beam must reuse the only slot, displacing the first.
      const field = new BeamField({ capacity: 1, lifetimeMs: 1000 })
      field.spawn(makeSpawn({ at: 0, actor: 'agent-first', targetPath: 'repo/first.ts' }))
      field.spawn(makeSpawn({ at: 100, actor: 'agent-second', targetPath: 'repo/second.ts' }))

      const resolver = makeResolver(
        { 'agent-first': { x: 0, y: 0 }, 'agent-second': { x: 500, y: 500 }},
        { 'repo/first.ts': { x: 10, y: 0 }, 'repo/second.ts': { x: 510, y: 500 }},
      )
      const active = field.activeBeams(120, resolver)
      // Still exactly capacity beams; the first was fully displaced.
      expect(active).toHaveLength(1)
      // The survivor is the second beam (its actor orb near 500,500), proving eviction.
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
        return fresh.activeBeams(1, defaultResolver())[0].color.h
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

      const resolverA = makeResolver({ 'agent-a': { x: 0, y: 0 }}, { 'repo/file.ts': { x: 100, y: 0 }})
      const resolverB = makeResolver({ 'agent-b': { x: 0, y: 0 }}, { 'repo/file.ts': { x: 100, y: 0 }})
      const colorA = fieldA.activeBeams(1, resolverA)[0].color
      const colorB = fieldB.activeBeams(1, resolverB)[0].color
      expect(colorA.h).not.toBeCloseTo(colorB.h, 1)
    })

    it('is pure actor color at tint 0', () => {
      const pureActor = new BeamField({ actionTint: 0 })
      pureActor.spawn(makeSpawn({ at: 0, actor: 'agent-1', action: 'delete' }))
      const actorHue = pureActor.activeBeams(1, defaultResolver())[0].color.h
      expect(actorHue).toBeCloseTo(colorForActor('agent-1').h, 5)
    })
  })

  describe('pulses are actor-local flashes, not beams that reach a node', () => {
    it('targets a short hashed nudge off the live actor source, within the pulse radius', () => {
      const field = new BeamField({ lifetimeMs: 1000, pulseRadius: 30 })
      field.spawnPulse({ at: 0, actor: 'agent-1', action: 'pulse' })

      // The pulse has no node target; its source is the live actor orb and its target a
      // short nudge off it, so it flickers on the orb wherever the orb currently is.
      const source = { x: 100, y: 100 }
      const beams = field.activeBeams(500, makeResolver({ 'agent-1': source }, {}))
      expect(beams).toHaveLength(1)

      const beam = beams[0]
      expect(beam.source).toEqual(source)
      const reach = Math.hypot(beam.target.x - source.x, beam.target.y - source.y)
      expect(reach).toBeCloseTo(30, 5)
    })

    it('follows the live actor source: the pulse flash tracks the orb as it moves', () => {
      const field = new BeamField({ lifetimeMs: 1000, pulseRadius: 30 })
      field.spawnPulse({ at: 0, actor: 'agent-1', action: 'pulse' })

      // Same beam, different live orb positions on two frames: the flash rides the orb.
      const first = field.activeBeams(100, makeResolver({ 'agent-1': { x: 0, y: 0 }}, {}))[0]
      const second = field.activeBeams(200, makeResolver({ 'agent-1': { x: 400, y: 0 }}, {}))[0]
      expect(first.source).toEqual({ x: 0, y: 0 })
      expect(second.source).toEqual({ x: 400, y: 0 })
      // The hashed flash direction is stable, so the target keeps the same offset off
      // the (now-moved) source.
      const firstOffset = { x: first.target.x - 0, y: first.target.y - 0 }
      const secondOffset = { x: second.target.x - 400, y: second.target.y - 0 }
      expect(secondOffset.x).toBeCloseTo(firstOffset.x, 5)
      expect(secondOffset.y).toBeCloseTo(firstOffset.y, 5)
    })

    it('spawn with targetPath: null behaves identically to spawnPulse', () => {
      const viaSpawn = new BeamField()
      const viaPulse = new BeamField()
      viaSpawn.spawn(makeSpawn({ at: 0, actor: 'agent-1', action: 'pulse', targetPath: null }))
      viaPulse.spawnPulse({ at: 0, actor: 'agent-1', action: 'pulse' })

      const resolver = makeResolver({ 'agent-1': { x: 0, y: 0 }}, {})
      expect(viaSpawn.activeBeams(100, resolver)).toEqual(viaPulse.activeBeams(100, resolver))
    })
  })

  describe('clear empties active beams', () => {
    it('drops everything in flight while keeping capacity', () => {
      const field = new BeamField({ capacity: 32 })
      field.spawn(makeSpawn({ at: 0 }))
      expect(field.activeBeams(100, defaultResolver()).length).toBeGreaterThan(0)

      field.clear()

      expect(field.activeBeams(100, defaultResolver())).toHaveLength(0)
      expect(field.capacity).toBe(32)
    })
  })

  describe('determinism', () => {
    it('produces identical beam state for identical inputs', () => {
      const first = new BeamField()
      const second = new BeamField()
      first.spawn(makeSpawn({ at: 0, actor: 'agent-1', action: 'create' }))
      second.spawn(makeSpawn({ at: 0, actor: 'agent-1', action: 'create' }))

      expect(first.activeBeams(400, defaultResolver())).toEqual(second.activeBeams(400, defaultResolver()))
    })

    it('step is an alias for activeBeams at the same time', () => {
      const field = new BeamField()
      field.spawn(makeSpawn({ at: 0 }))
      expect(field.step(300, defaultResolver())).toEqual(field.activeBeams(300, defaultResolver()))
    })
  })
})

describe('resolveBeamEndpoints', () => {
  const resolver = makeResolver(
    { 'agent-1': { x: 5, y: 5 }},
    { 'repo/file.ts': { x: 200, y: 0 }},
  )

  it('resolves a real beam to the live actor source and live node target', () => {
    const reference: BeamEndpointReference = { actor: 'agent-1', action: 'modify', targetPath: 'repo/file.ts' }
    const endpoints = resolveBeamEndpoints(reference, resolver, 30)
    expect(endpoints).toEqual({ source: { x: 5, y: 5 }, target: { x: 200, y: 0 }})
  })

  it('returns null when the firing actor orb is gone', () => {
    const reference: BeamEndpointReference = { actor: 'agent-missing', action: 'modify', targetPath: 'repo/file.ts' }
    expect(resolveBeamEndpoints(reference, resolver, 30)).toBeNull()
  })

  it('returns null when a real beam\'s target node no longer exists', () => {
    const reference: BeamEndpointReference = { actor: 'agent-1', action: 'modify', targetPath: 'repo/gone.ts' }
    expect(resolveBeamEndpoints(reference, resolver, 30)).toBeNull()
  })

  it('resolves a pulse to a short nudge off the live source, within the pulse radius', () => {
    const reference: BeamEndpointReference = { actor: 'agent-1', action: 'pulse', targetPath: null }
    const endpoints = resolveBeamEndpoints(reference, resolver, 30)
    expect(endpoints).not.toBeNull()
    expect(endpoints!.source).toEqual({ x: 5, y: 5 })
    const reach = Math.hypot(endpoints!.target.x - 5, endpoints!.target.y - 5)
    expect(reach).toBeCloseTo(30, 5)
  })

  it('gives a pulse a deterministic flash direction (same reference, same offset)', () => {
    const reference: BeamEndpointReference = { actor: 'agent-1', action: 'pulse', targetPath: null }
    const first = resolveBeamEndpoints(reference, resolver, 30)
    const second = resolveBeamEndpoints(reference, resolver, 30)
    expect(first).toEqual(second)
  })
})
