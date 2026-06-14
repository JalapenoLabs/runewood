// Copyright © 2026 Jalapeno Labs

import type { VisibleNode } from './collapse'
import type { TreeNode } from './tree'

// Core
import { describe, expect, it } from 'vitest'

import { ForceLayout } from './physics'

/**
 * Builds a minimal {@link TreeNode} for a path. The sim only ever reads `path` off
 * the node (every other force input comes from the `VisibleNode` wrapper), so the
 * rest is filled with inert defaults to keep the fixtures readable.
 */
function nodeFor(path: string, isFile = true): TreeNode {
  const lastSlash = path.lastIndexOf('/')
  return {
    name: lastSlash >= 0 ? path.slice(lastSlash + 1) : path,
    path,
    isFile,
    children: new Map(),
    status: 'discovered',
    touchCount: 0,
    lastTouchedAt: null,
  }
}

/** A visible (non-root) node hanging off `displayParentPath`, the shape `collapseTree` yields. */
function visible(path: string, displayParentPath: string, depth: number): VisibleNode {
  return { node: nodeFor(path), displayParentPath, depth, isForestRoot: false }
}

/** The pinned forest-root visible node (`collapseTree` with `rootVisible`). */
function rootVisible(): VisibleNode {
  return { node: nodeFor('', false), displayParentPath: '', depth: 0, isForestRoot: true }
}

/** Steps the sim `count` times at a fixed millisecond delta, the deterministic drive a test wants. */
function stepTimes(layout: ForceLayout, deltaMs: number, count: number): void {
  for (let index = 0; index < count; index++) {
    layout.step(deltaMs)
  }
}

/** Total kinetic energy proxy: the sum of squared speeds over every body. Falls as the system damps. */
function totalKineticEnergy(layout: ForceLayout): number {
  let energy = 0
  for (const body of layout.state.values()) {
    energy += body.velocity.x * body.velocity.x + body.velocity.y * body.velocity.y
  }
  return energy
}

const FIXED_DELTA_MS = 16

describe('ForceLayout', () => {
  describe('sync', () => {
    it('adds a body for each new visible node and removes bodies for vanished ones', () => {
      const layout = new ForceLayout()
      layout.sync([ visible('repo', '', 1), visible('repo/a.ts', 'repo', 2) ])

      expect(layout.state.has('repo')).toBe(true)
      expect(layout.state.has('repo/a.ts')).toBe(true)
      expect(layout.state.size).toBe(2)

      // The leaf is no longer visible (deleted/collapsed): its body must be dropped.
      layout.sync([ visible('repo', '', 1) ])
      expect(layout.state.has('repo')).toBe(true)
      expect(layout.state.has('repo/a.ts')).toBe(false)
      expect(layout.state.size).toBe(1)
    })

    it('pins the forest root at the configured center with zero velocity', () => {
      const center = { x: 5, y: -7 }
      const layout = new ForceLayout({ center })
      layout.sync([ rootVisible(), visible('repo', '', 1) ])

      const root = layout.state.get('')
      expect(root).toBeDefined()
      expect(root!.position).toEqual(center)

      // After stepping, the pinned root must not have moved or gained velocity, while
      // the repo (pulled by its edge spring) is free to move.
      stepTimes(layout, FIXED_DELTA_MS, 30)
      const rootAfter = layout.state.get('')!
      expect(rootAfter.position).toEqual(center)
      expect(rootAfter.velocity).toEqual({ x: 0, y: 0 })
    })

    it('spawns a new node near its display-parent so it emerges from the branch', () => {
      const layout = new ForceLayout({ spawnOffset: 12 })
      // Seed the parent and let it settle somewhere away from the origin.
      layout.sync([ visible('repo', '', 1) ])
      stepTimes(layout, FIXED_DELTA_MS, 40)
      const parentPosition = { ...layout.state.get('repo')!.position }

      // Now a child appears; it must spawn within ~one spawn-offset of the parent, not
      // at the origin, so it visibly grows out of the branch.
      layout.sync([ visible('repo', '', 1), visible('repo/a.ts', 'repo', 2) ])
      const child = layout.state.get('repo/a.ts')!
      const distanceFromParent = Math.hypot(
        child.position.x - parentPosition.x,
        child.position.y - parentPosition.y,
      )
      expect(distanceFromParent).toBeLessThanOrEqual(12 + 1e-6)
      expect(distanceFromParent).toBeGreaterThan(0)
    })
  })

  describe('step', () => {
    it('pulls a child toward roughly the rest length from its parent', () => {
      const restLength = 100
      // No depth scaling, so the depth-2 child rests at exactly `restLength` from its
      // depth-1 parent, which makes the settled distance easy to assert.
      const layout = new ForceLayout({ restLength, restLengthDepthScale: 0, repulsionStrength: 0 })
      layout.sync([ visible('repo', '', 1), visible('repo/a.ts', 'repo', 2) ])

      // Settle the two-body chain. With repulsion off, the only force on the child is
      // the edge spring, so it must come to rest at ~the rest length from the parent.
      stepTimes(layout, FIXED_DELTA_MS, 400)
      const parent = layout.state.get('repo')!.position
      const child = layout.state.get('repo/a.ts')!.position
      const distance = Math.hypot(child.x - parent.x, child.y - parent.y)
      expect(distance).toBeGreaterThan(restLength * 0.9)
      expect(distance).toBeLessThan(restLength * 1.1)
    })

    it('repels two siblings so they separate', () => {
      const layout = new ForceLayout()
      layout.sync([
        visible('repo', '', 1),
        visible('repo/a.ts', 'repo', 2),
        visible('repo/b.ts', 'repo', 2),
      ])

      const before = layout.state.get('repo/a.ts')!.position
      const otherBefore = layout.state.get('repo/b.ts')!.position
      const separationBefore = Math.hypot(before.x - otherBefore.x, before.y - otherBefore.y)

      stepTimes(layout, FIXED_DELTA_MS, 60)

      const after = layout.state.get('repo/a.ts')!.position
      const otherAfter = layout.state.get('repo/b.ts')!.position
      const separationAfter = Math.hypot(after.x - otherAfter.x, after.y - otherAfter.y)

      // The repulsion must have pushed the siblings further apart than they spawned.
      expect(separationAfter).toBeGreaterThan(separationBefore)
    })

    it('loses kinetic energy under damping and settles a single edge fully to rest', () => {
      // A lone parent + child (repulsion off) has a true equilibrium at the rest
      // length, so the damping must carry it all the way to rest, not just lower it.
      const layout = new ForceLayout({ restLengthDepthScale: 0, repulsionStrength: 0 })
      layout.sync([ visible('repo', '', 1), visible('repo/a.ts', 'repo', 2) ])

      // A few steps in, the edge spring is actively doing work pulling the child out.
      stepTimes(layout, FIXED_DELTA_MS, 8)
      const energyEarly = totalKineticEnergy(layout)
      expect(energyEarly).toBeGreaterThan(0)

      // Far more steps in, damping must have bled the system essentially to rest.
      stepTimes(layout, FIXED_DELTA_MS, 600)
      const energyLate = totalKineticEnergy(layout)

      expect(energyLate).toBeLessThan(energyEarly)
      // Essentially at rest: a per-body speed well under a hundredth of a unit/sec.
      expect(energyLate).toBeLessThan(1e-3)
    })

    it('bleeds kinetic energy out of an excited sibling fan (stays lively, not frozen)', () => {
      // With sibling repulsion on, the fan keeps gently jostling (the always-alive
      // feel the design wants), but damping must still drain the bulk of the initial
      // excitement so it eases toward a calm state rather than ringing forever.
      const layout = new ForceLayout()
      layout.sync([
        visible('repo', '', 1),
        visible('repo/a.ts', 'repo', 2),
        visible('repo/b.ts', 'repo', 2),
        visible('repo/c.ts', 'repo', 2),
      ])

      stepTimes(layout, FIXED_DELTA_MS, 10)
      const energyEarly = totalKineticEnergy(layout)

      stepTimes(layout, FIXED_DELTA_MS, 600)
      const energyLate = totalKineticEnergy(layout)

      // The disturbance must have eased out to a small fraction of its peak.
      expect(energyLate).toBeLessThan(energyEarly * 0.5)
    })

    it('is deterministic: identical structure + deltas yield identical positions', () => {
      const build = (): ForceLayout => {
        const layout = new ForceLayout()
        layout.sync([
          visible('repo', '', 1),
          visible('repo/a.ts', 'repo', 2),
          visible('repo/b.ts', 'repo', 2),
        ])
        stepTimes(layout, FIXED_DELTA_MS, 120)
        return layout
      }

      const first = build()
      const second = build()
      for (const path of [ 'repo', 'repo/a.ts', 'repo/b.ts' ]) {
        expect(second.state.get(path)!.position).toEqual(first.state.get(path)!.position)
      }
    })

    it('a newly synced node migrates outward from its parent over steps', () => {
      const restLength = 120
      const layout = new ForceLayout({ restLength, restLengthDepthScale: 0, spawnOffset: 4 })
      layout.sync([ visible('repo', '', 1) ])
      stepTimes(layout, FIXED_DELTA_MS, 60)
      const parentPosition = { ...layout.state.get('repo')!.position }

      // The child spawns hugging the parent (within the small spawn offset)...
      layout.sync([ visible('repo', '', 1), visible('repo/a.ts', 'repo', 2) ])
      const spawnDistance = Math.hypot(
        layout.state.get('repo/a.ts')!.position.x - parentPosition.x,
        layout.state.get('repo/a.ts')!.position.y - parentPosition.y,
      )

      // ...and the edge spring then carries it out toward the rest length over time.
      stepTimes(layout, FIXED_DELTA_MS, 400)
      const settledParent = layout.state.get('repo')!.position
      const settledChild = layout.state.get('repo/a.ts')!.position
      const settledDistance = Math.hypot(
        settledChild.x - settledParent.x,
        settledChild.y - settledParent.y,
      )

      expect(spawnDistance).toBeLessThan(restLength * 0.5)
      expect(settledDistance).toBeGreaterThan(spawnDistance)
      expect(settledDistance).toBeGreaterThan(restLength * 0.8)
    })

    it('ignores a non-positive or non-finite delta without disturbing the state', () => {
      const layout = new ForceLayout()
      layout.sync([ visible('repo', '', 1), visible('repo/a.ts', 'repo', 2) ])
      // Excite the system, then snapshot.
      stepTimes(layout, FIXED_DELTA_MS, 20)
      const snapshot = new Map(
        [ ...layout.state.entries() ].map(([ path, body ]) => [
          path,
          { x: body.position.x, y: body.position.y, vx: body.velocity.x, vy: body.velocity.y },
        ]),
      )

      layout.step(0)
      layout.step(-5)
      layout.step(Number.NaN)

      for (const [ path, body ] of layout.state) {
        const expected = snapshot.get(path)!
        expect(body.position.x).toBe(expected.x)
        expect(body.position.y).toBe(expected.y)
        expect(body.velocity.x).toBe(expected.vx)
        expect(body.velocity.y).toBe(expected.vy)
      }
    })

    it('clamps a huge delta so one giant step never destabilizes the sim', () => {
      const layout = new ForceLayout({ maxStepMs: 50 })
      layout.sync([
        visible('repo', '', 1),
        visible('repo/a.ts', 'repo', 2),
        visible('repo/b.ts', 'repo', 2),
      ])

      // A pathological 10-second delta (a backgrounded tab) must be clamped, so every
      // body stays finite and on-canvas rather than being flung to infinity.
      layout.step(10_000)
      for (const body of layout.state.values()) {
        expect(Number.isFinite(body.position.x)).toBe(true)
        expect(Number.isFinite(body.position.y)).toBe(true)
        expect(Math.hypot(body.position.x, body.position.y)).toBeLessThan(10_000)
      }
    })
  })

  describe('reset', () => {
    it('drops every body so a rewind re-syncs from scratch', () => {
      const layout = new ForceLayout()
      layout.sync([ visible('repo', '', 1), visible('repo/a.ts', 'repo', 2) ])
      expect(layout.state.size).toBe(2)

      layout.reset()
      expect(layout.state.size).toBe(0)

      // After a reset, a fresh sync re-populates normally (the rewind path).
      layout.sync([ visible('other', '', 1) ])
      expect(layout.state.has('other')).toBe(true)
      expect(layout.state.has('repo')).toBe(false)
    })
  })
})
