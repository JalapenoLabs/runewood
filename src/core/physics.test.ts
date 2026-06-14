// Copyright © 2026 Jalapeno Labs

import type { VisibleNode } from './collapse'
import type { TreeNode } from './tree'
import type { Vec2, NodePhysics } from './layout'

// Core
import { describe, expect, it } from 'vitest'

import { ForceLayout, buildSpatialGrid } from './physics'

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

    it('repels nodes from DIFFERENT parents so branches separate and stop crossing', () => {
      // The tangle fix: the old sibling-only repulsion let two children of different
      // parents overlap and cross. Now repulsion is global-but-local, so two nodes that
      // belong to different branches but sit close together must still push apart.
      const layout = new ForceLayout({ repulsionCutoff: 1_000 })
      layout.sync([
        visible('repoA', '', 1),
        visible('repoB', '', 1),
        visible('repoA/leaf.ts', 'repoA', 2),
        visible('repoB/leaf.ts', 'repoB', 2),
      ])

      // Force the two cross-branch leaves to start nearly coincident (they belong to
      // different parents, the case the old sibling-only pass ignored entirely).
      layout.state.get('repoA/leaf.ts')!.position = { x: 100, y: 0 }
      layout.state.get('repoB/leaf.ts')!.position = { x: 104, y: 0 }
      const separationBefore = Math.hypot(
        layout.state.get('repoA/leaf.ts')!.position.x - layout.state.get('repoB/leaf.ts')!.position.x,
        layout.state.get('repoA/leaf.ts')!.position.y - layout.state.get('repoB/leaf.ts')!.position.y,
      )

      stepTimes(layout, FIXED_DELTA_MS, 30)

      const separationAfter = Math.hypot(
        layout.state.get('repoA/leaf.ts')!.position.x - layout.state.get('repoB/leaf.ts')!.position.x,
        layout.state.get('repoA/leaf.ts')!.position.y - layout.state.get('repoB/leaf.ts')!.position.y,
      )
      // The cross-branch pair was pushed apart, the whole point of broadening repulsion.
      expect(separationAfter).toBeGreaterThan(separationBefore)
    })

    it('does NOT repel nodes farther apart than the cutoff (keeps the grid local and cheap)', () => {
      // Past the cutoff the force is dropped entirely, so two distant nodes never
      // interact. With both pinned far apart and the springs disabled, neither moves.
      const layout = new ForceLayout({ repulsionCutoff: 100, springStiffness: 0 })
      layout.sync([
        visible('repoA', '', 1),
        visible('repoB', '', 1),
      ])
      // Place the two repo roots well beyond the 100-unit cutoff.
      layout.state.get('repoA')!.position = { x: 0, y: 0 }
      layout.state.get('repoB')!.position = { x: 500, y: 0 }

      stepTimes(layout, FIXED_DELTA_MS, 40)

      // Neither moved: out of cutoff range, and the spring is off, so no force at all.
      expect(layout.state.get('repoA')!.position).toEqual({ x: 0, y: 0 })
      expect(layout.state.get('repoB')!.position).toEqual({ x: 500, y: 0 })
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

/** A bodies map of the shape {@link buildSpatialGrid} consumes, from path -> position pairs. */
function bodiesFrom(entries: Array<[ string, Vec2 ]>): Map<string, NodePhysics> {
  const bodies = new Map<string, NodePhysics>()
  for (const [ path, position ] of entries) {
    bodies.set(path, { position, velocity: { x: 0, y: 0 }})
  }
  return bodies
}

/** All paths in a grid cell, for order-independent membership assertions. */
function pathsIn(cell: { members: Array<{ path: string }> } | undefined): string[] {
  return (cell?.members ?? []).map((member) => member.path).sort()
}

describe('buildSpatialGrid', () => {
  it('bins bodies into cells of the given side by floor-dividing their position', () => {
    // Cell side 100: (10,10) and (90,90) share cell (0,0); (150,10) is cell (1,0).
    const grid = buildSpatialGrid(bodiesFrom([
      [ 'a', { x: 10, y: 10 }],
      [ 'b', { x: 90, y: 90 }],
      [ 'c', { x: 150, y: 10 }],
    ]), 100)

    expect(pathsIn(grid.cells.get('0,0'))).toEqual([ 'a', 'b' ])
    expect(pathsIn(grid.cells.get('1,0'))).toEqual([ 'c' ])
    // No empty cells are materialized.
    expect(grid.cells.size).toBe(2)
  })

  it('handles negative coordinates by flooring toward negative infinity', () => {
    // Math.floor(-1/100) is -1, so a node at (-1,-1) lands in cell (-1,-1), not (0,0).
    const grid = buildSpatialGrid(bodiesFrom([
      [ 'neg', { x: -1, y: -1 }],
      [ 'pos', { x: 1, y: 1 }],
    ]), 100)

    expect(pathsIn(grid.cells.get('-1,-1'))).toEqual([ 'neg' ])
    expect(pathsIn(grid.cells.get('0,0'))).toEqual([ 'pos' ])
  })

  it('neighborhoodOf yields each adjacent cell-pair exactly once across a full sweep', () => {
    // A 3x3 block of occupied cells, one body each. Sweeping every cell's neighborhood
    // must enumerate every UNORDERED pair of touching cells exactly once (the property
    // that lets the repulsion apply an equal-and-opposite force without double-counting).
    const entries: Array<[ string, Vec2 ]> = []
    for (let cellX = 0; cellX < 3; cellX++) {
      for (let cellY = 0; cellY < 3; cellY++) {
        // Center each body in its 100-unit cell so it bins unambiguously.
        entries.push([ `${cellX},${cellY}`, { x: cellX * 100 + 50, y: cellY * 100 + 50 }])
      }
    }
    const grid = buildSpatialGrid(bodiesFrom(entries), 100)

    const seenPairs = new Set<string>()
    for (const cell of grid.cells.values()) {
      const neighborhood = grid.neighborhoodOf(cell.cellX, cell.cellY)
      // The own cell is always first.
      expect(neighborhood[0]).toBe(cell)
      for (let index = 1; index < neighborhood.length; index++) {
        const neighbor = neighborhood[index]
        const key = [ `${cell.cellX},${cell.cellY}`, `${neighbor.cellX},${neighbor.cellY}` ].sort().join('|')
        // A given unordered cell-pair must never be produced twice.
        expect(seenPairs.has(key)).toBe(false)
        seenPairs.add(key)
        // Neighbors are genuinely adjacent (within one cell on each axis).
        expect(Math.abs(neighbor.cellX - cell.cellX)).toBeLessThanOrEqual(1)
        expect(Math.abs(neighbor.cellY - cell.cellY)).toBeLessThanOrEqual(1)
      }
    }

    // A 3x3 grid has 12 horizontal/vertical + 8 diagonal = 20 adjacent unordered pairs.
    expect(seenPairs.size).toBe(20)
  })

  it('floors a non-positive cell size to 1 rather than scattering bodies into nonsense cells', () => {
    // A zero cell size would divide-by-zero every coordinate; the guard floors it to 1,
    // so each integer coordinate still lands in its own sensible cell.
    const grid = buildSpatialGrid(bodiesFrom([
      [ 'a', { x: 3, y: 4 }],
      [ 'b', { x: 3, y: 5 }],
    ]), 0)

    expect(pathsIn(grid.cells.get('3,4'))).toEqual([ 'a' ])
    expect(pathsIn(grid.cells.get('3,5'))).toEqual([ 'b' ])
  })
})
