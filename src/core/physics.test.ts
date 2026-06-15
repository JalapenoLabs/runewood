// Copyright © 2026 Jalapeno Labs

import type { VisibleNode } from './collapse'
import type { TreeNode } from './tree'
import type { Vec2, NodePhysics } from './layout'
import type { NodeMeta, ForceLayoutOptions } from './physics'

// Core
import { describe, expect, it } from 'vitest'

import {
  ForceLayout,
  buildSpatialGrid,
  countSiblings,
  collisionRadiusFor,
  shouldCollide,
  fanSpreadForces,
  antiFoldbackForce,
  untangleGroupForces,
  clampSpeed,
  zoomImpulse,
} from './physics'

/**
 * Builds a minimal {@link TreeNode} for a path. The sim reads `path`, `isFile`, and `touchCount`
 * off the node (every other force input comes from the `VisibleNode` wrapper), so the rest is
 * filled with inert defaults to keep the fixtures readable. `touchCount` is exposed so a test can
 * make a node "heavily edited" and assert its collision radius grows.
 */
function nodeFor(path: string, isFile: boolean, touchCount = 0): TreeNode {
  const lastSlash = path.lastIndexOf('/')
  return {
    name: lastSlash >= 0 ? path.slice(lastSlash + 1) : path,
    path,
    isFile,
    children: new Map(),
    status: 'discovered',
    touchCount,
    lastTouchedAt: null,
  }
}

/** A visible *directory* hanging off `displayParentPath`, the shape `collapseTree` yields. */
function dir(path: string, displayParentPath: string, depth: number): VisibleNode {
  return { node: nodeFor(path, false), displayParentPath, depth, isForestRoot: false }
}

/** A visible *file* hanging off `displayParentPath`, the shape `collapseTree` yields. */
function file(path: string, displayParentPath: string, depth: number): VisibleNode {
  return { node: nodeFor(path, true), displayParentPath, depth, isForestRoot: false }
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

/**
 * The distance between two bodies in a settled layout, by path. A convenience for the collision /
 * overlap assertions, which all reduce to "are these two centers at least their summed radii apart".
 */
function distanceBetween(layout: ForceLayout, leftPath: string, rightPath: string): number {
  const left = layout.state.get(leftPath)!.position
  const right = layout.state.get(rightPath)!.position
  return Math.hypot(left.x - right.x, left.y - right.y)
}

const FIXED_DELTA_MS = 16

/** A fully-defaulted options object, for the pure helpers that take `Required<ForceLayoutOptions>`. */
function defaultedOptions(overrides: ForceLayoutOptions = {}): Required<ForceLayoutOptions> {
  // Construct a layout and read back its resolved options shape by re-deriving the same defaults
  // the constructor uses. We keep this list in sync with the constructor; a drift would surface as
  // a failing `collisionRadiusFor` expectation below.
  return {
    center: { x: 0, y: 0 },
    restLength: 120,
    restLengthDepthScale: 0.35,
    siblingRestScale: 1,
    springStiffness: 26,
    outwardBias: 0.18,
    untangleStrength: 0.35,
    fileRestLength: 40,
    collisionStiffness: 240,
    collisionMargin: 10,
    directoryRadius: 1.6,
    fileRadius: 1.1,
    damping: 0.9,
    maxStepMs: 50,
    spawnOffset: 12,
    wobbleMaxSpeed: 220,
    ...overrides,
  }
}

describe('collisionRadiusFor', () => {
  it('gives a file a SMALLER collision radius than a directory of the same base size', () => {
    const options = defaultedOptions()
    const directoryRadius = collisionRadiusFor(dir('repo/sub', 'repo', 2), options)
    const fileRadius = collisionRadiusFor(file('repo/a.ts', 'repo', 2), options)

    // Files pack tighter as satellites; directories are the slightly larger structural skeleton.
    expect(fileRadius).toBeLessThan(directoryRadius)
  })

  it('matches the drawn base size scaled by the per-kind factor (stable, no touch pulse)', () => {
    const options = defaultedOptions()
    // An untouched node's steady base radius is the default 7. A directory scales it by 1.6.
    const untouched = collisionRadiusFor(dir('repo/sub', 'repo', 2), options)
    expect(untouched).toBeCloseTo(7 * options.directoryRadius)
  })

  it('grows with a node\'s touch importance, matching the larger drawn disc of a busy node', () => {
    const options = defaultedOptions()
    const calm = collisionRadiusFor(dir('repo/calm', 'repo', 2), options)
    // A heavily-edited directory draws a touch larger (the saturating importance bump), so its
    // collision radius must grow to match, or busy nodes would visibly overlap.
    const busy = { node: nodeFor('repo/busy', false, 50), displayParentPath: 'repo', depth: 2, isForestRoot: false }
    expect(collisionRadiusFor(busy, options)).toBeGreaterThan(calm)
  })
})

describe('shouldCollide', () => {
  const dirMeta = (displayParentPath: string): NodeMeta => ({
    displayParentPath,
    isFile: false,
    depth: 2,
    siblingCount: 1,
    collisionRadius: 10,
  })
  const fileMeta = (displayParentPath: string): NodeMeta => ({
    displayParentPath,
    isFile: true,
    depth: 2,
    siblingCount: 1,
    collisionRadius: 5,
  })

  it('always collides two directories, regardless of parentage (the global skeleton spread)', () => {
    expect(shouldCollide('a/x', dirMeta('a'), 'b/y', dirMeta('b'))).toBe(true)
  })

  it('collides two files only when they share a directory (one satellite cluster)', () => {
    expect(shouldCollide('a/x.ts', fileMeta('a'), 'a/y.ts', fileMeta('a'))).toBe(true)
    expect(shouldCollide('a/x.ts', fileMeta('a'), 'b/y.ts', fileMeta('b'))).toBe(false)
  })

  it('collides a file with its OWN directory but not a stranger directory', () => {
    // The file `a/x.ts` lives in directory `a`: it collides with `a` (held just outside it) ...
    expect(shouldCollide('a/x.ts', fileMeta('a'), 'a', dirMeta(''))).toBe(true)
    // ... but not with an unrelated directory `b` it merely sits near.
    expect(shouldCollide('a/x.ts', fileMeta('a'), 'b', dirMeta(''))).toBe(false)
  })
})

describe('countSiblings', () => {
  it('counts directory-siblings and file-siblings of a parent on SEPARATE rings', () => {
    const counts = countSiblings([
      dir('repo', '', 1),
      dir('repo/a', 'repo', 2),
      dir('repo/b', 'repo', 2),
      file('repo/x.ts', 'repo', 2),
    ])

    // Two directory children and one file child under `repo`, counted as two separate rings.
    expect(counts.get('dir:repo')).toBe(2)
    expect(counts.get('file:repo')).toBe(1)
  })

  it('excludes the forest root (it is not a simulated body)', () => {
    const counts = countSiblings([ rootVisible(), dir('repo', '', 1) ])
    // Only the one repo root is counted, under the empty-string center; the forest root is skipped.
    expect(counts.get('dir:')).toBe(1)
  })
})

describe('ForceLayout', () => {
  describe('sync', () => {
    it('adds a body for each new visible node and removes bodies for vanished ones', () => {
      const layout = new ForceLayout()
      layout.sync([ dir('repo', '', 1), file('repo/a.ts', 'repo', 2) ])

      expect(layout.state.has('repo')).toBe(true)
      expect(layout.state.has('repo/a.ts')).toBe(true)
      expect(layout.state.size).toBe(2)

      // The leaf is no longer visible (deleted/collapsed): its body must be dropped.
      layout.sync([ dir('repo', '', 1) ])
      expect(layout.state.has('repo')).toBe(true)
      expect(layout.state.has('repo/a.ts')).toBe(false)
      expect(layout.state.size).toBe(1)
    })

    it('pins the forest root at the configured center with zero velocity', () => {
      const center = { x: 5, y: -7 }
      const layout = new ForceLayout({ center })
      layout.sync([ rootVisible(), dir('repo', '', 1) ])

      const root = layout.state.get('')
      expect(root).toBeDefined()
      expect(root!.position).toEqual(center)

      // After stepping, the pinned root must not have moved or gained velocity, while the repo
      // (pulled by its edge spring) is free to move.
      stepTimes(layout, FIXED_DELTA_MS, 30)
      const rootAfter = layout.state.get('')!
      expect(rootAfter.position).toEqual(center)
      expect(rootAfter.velocity).toEqual({ x: 0, y: 0 })
    })

    it('spawns a new node near its display-parent so it emerges from the branch', () => {
      const layout = new ForceLayout({ spawnOffset: 12 })
      // Seed the parent and let it settle somewhere away from the origin.
      layout.sync([ dir('repo', '', 1) ])
      stepTimes(layout, FIXED_DELTA_MS, 40)
      const parentPosition = { ...layout.state.get('repo')!.position }

      // Now a child appears; it must spawn within ~one spawn-offset of the parent, not at the
      // origin, so it visibly grows out of the branch.
      layout.sync([ dir('repo', '', 1), dir('repo/sub', 'repo', 2) ])
      const child = layout.state.get('repo/sub')!
      const distanceFromParent = Math.hypot(
        child.position.x - parentPosition.x,
        child.position.y - parentPosition.y,
      )
      expect(distanceFromParent).toBeLessThanOrEqual(12 + 1e-6)
      expect(distanceFromParent).toBeGreaterThan(0)
    })
  })

  describe('collision (real, size-aware no-overlap)', () => {
    it('pushes two overlapping directories apart to touching and settles near it (no overlap)', () => {
      // Two directories started overlapping, held together by an edge spring whose rest length is
      // exactly their touch distance: this is the real regime where collision and spring balance.
      // Collision must separate them out of overlap, and the opposing spring must keep them from
      // flying apart, so they settle right around the touch distance: touching, not overlapping.
      const radius = collisionRadiusFor(dir('repoA', '', 1), defaultedOptions())
      const minSeparation = radius * 2 + defaultedOptions().collisionMargin

      // Both repo roots hang off the undrawn center; pull them toward a rest length equal to the
      // touch distance so the equilibrium is exactly "touching". The outward bias is off so the
      // only horizontal forces are the spring and collision.
      const layout = new ForceLayout({ restLength: minSeparation, outwardBias: 0 })
      layout.sync([ dir('repoA', '', 1), dir('repoB', '', 1) ])
      layout.state.get('repoA')!.position = { x: -1, y: 0 }
      layout.state.get('repoB')!.position = { x: 1, y: 0 }

      stepTimes(layout, FIXED_DELTA_MS, 1_500)

      const separation = distanceBetween(layout, 'repoA', 'repoB')
      // They reached (at least) the touch distance: no overlap ...
      expect(separation).toBeGreaterThanOrEqual(minSeparation - 1.0)
      // ... and the spring kept them from flying apart, so they settle near touch, not far past it.
      expect(separation).toBeLessThan(minSeparation * 2)
    })

    it('exerts ZERO collision force on two well-separated directories', () => {
      // Past the touch distance the collision force is exactly zero. With the spring + outward bias
      // off and the two directories comfortably apart, neither may move at all.
      const layout = new ForceLayout({ springStiffness: 0, outwardBias: 0 })
      layout.sync([ dir('repoA', '', 1), dir('repoB', '', 1) ])
      layout.state.get('repoA')!.position = { x: 0, y: 0 }
      layout.state.get('repoB')!.position = { x: 500, y: 0 }

      stepTimes(layout, FIXED_DELTA_MS, 60)

      // Neither moved: they never overlapped, so collision contributed nothing and no other force
      // is active.
      expect(layout.state.get('repoA')!.position).toEqual({ x: 0, y: 0 })
      expect(layout.state.get('repoB')!.position).toEqual({ x: 500, y: 0 })
    })

    it('separates a whole crowded ring of sibling directories so none overlap', () => {
      // Six children of one parent. After settling, EVERY pair of them must be at least their
      // summed collision radii apart: the headline "the nodes are aware of each other" guarantee.
      const layout = new ForceLayout()
      const siblings = [ 'a', 'b', 'c', 'd', 'e', 'f' ]
      layout.sync([
        rootVisible(),
        dir('repo', '', 1),
        ...siblings.map((name) => dir(`repo/${name}`, 'repo', 2)),
      ])
      stepTimes(layout, FIXED_DELTA_MS, 1_500)

      const radius = collisionRadiusFor(dir('repo/a', 'repo', 2), defaultedOptions())
      const minSeparation = radius * 2 // summed radii; the margin is breathing room on top

      for (let leftIndex = 0; leftIndex < siblings.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < siblings.length; rightIndex++) {
          const separation = distanceBetween(layout, `repo/${siblings[leftIndex]}`, `repo/${siblings[rightIndex]}`)
          expect(separation).toBeGreaterThanOrEqual(minSeparation - 1e-3)
        }
      }
    })

    it('does NOT let a file from one directory collide with a file from another directory', () => {
      // Files only cluster with their OWN directory's files. Two files in different dirs, started
      // overlapping with every other force off, must not push apart.
      const layout = new ForceLayout({ springStiffness: 0, outwardBias: 0 })
      layout.sync([
        dir('repoA', '', 1),
        dir('repoB', '', 1),
        file('repoA/x.ts', 'repoA', 2),
        file('repoB/y.ts', 'repoB', 2),
      ])
      layout.state.get('repoA/x.ts')!.position = { x: 100, y: 0 }
      layout.state.get('repoB/y.ts')!.position = { x: 101, y: 0 }

      stepTimes(layout, FIXED_DELTA_MS, 30)

      // Neither file moved: cross-directory files exert no collision on each other.
      expect(layout.state.get('repoA/x.ts')!.position).toEqual({ x: 100, y: 0 })
      expect(layout.state.get('repoB/y.ts')!.position).toEqual({ x: 101, y: 0 })
    })

    it('separates the files of ONE directory so its satellite cluster does not overlap', () => {
      const layout = new ForceLayout({ outwardBias: 0 })
      layout.sync([
        dir('repo', '', 1),
        file('repo/a.ts', 'repo', 2),
        file('repo/b.ts', 'repo', 2),
      ])
      // Start the two siblings overlapping.
      layout.state.get('repo/a.ts')!.position = { x: 50, y: 0 }
      layout.state.get('repo/b.ts')!.position = { x: 51, y: 0 }

      stepTimes(layout, FIXED_DELTA_MS, 400)

      const radius = collisionRadiusFor(file('repo/a.ts', 'repo', 2), defaultedOptions())
      const separation = distanceBetween(layout, 'repo/a.ts', 'repo/b.ts')
      // The two file siblings ended at least their summed radii apart: a non-overlapping cluster.
      expect(separation).toBeGreaterThanOrEqual(radius * 2 - 1e-3)
    })
  })

  describe('sibling-count rest length', () => {
    it('rests a child on a WIDER ring when it has more siblings (six > one)', () => {
      const buildAndSettle = (siblingNames: string[]): number => {
        // The untangle force is disabled here so this isolates the sibling-count rest length /
        // collision mechanism under test: a tidy fan (the untangle force's job) packs siblings more
        // efficiently and would otherwise let the crowded ring settle slightly tighter, which is its
        // own behavior, covered by the dedicated untangle tests below.
        const layout = new ForceLayout({ untangleStrength: 0 })
        layout.sync([
          rootVisible(),
          dir('repo', '', 1),
          ...siblingNames.map((name) => dir(`repo/${name}`, 'repo', 2)),
        ])
        stepTimes(layout, FIXED_DELTA_MS, 1_200)
        const repo = layout.state.get('repo')!.position
        // The mean distance of the children from their parent: the ring radius they settled on.
        let total = 0
        for (const name of siblingNames) {
          const child = layout.state.get(`repo/${name}`)!.position
          total += Math.hypot(child.x - repo.x, child.y - repo.y)
        }
        return total / siblingNames.length
      }

      const loneRing = buildAndSettle([ 'only' ])
      const crowdedRing = buildAndSettle([ 'a', 'b', 'c', 'd', 'e', 'f' ])

      // A parent with six children pushes them out to a meaningfully larger ring than a lone child,
      // so the bigger circumference has room to seat all six without overlap.
      expect(crowdedRing).toBeGreaterThan(loneRing)
    })

    it('a lone child stays near the base rest length (the sibling widening does not inflate it)', () => {
      // With one child, the sibling-count floor is well under the base depth rest length, so the
      // child rests at ~the base rest length, exactly as a simple two-body chain would.
      const restLength = 120
      const layout = new ForceLayout({ restLength, restLengthDepthScale: 0, outwardBias: 0 })
      layout.sync([ dir('repo', '', 1), dir('repo/only', 'repo', 2) ])
      stepTimes(layout, FIXED_DELTA_MS, 600)

      const distance = distanceBetween(layout, 'repo', 'repo/only')
      expect(distance).toBeGreaterThan(restLength * 0.9)
      expect(distance).toBeLessThan(restLength * 1.2)
    })
  })

  describe('fluid outward growth (the gentle bias)', () => {
    it('grows a child directory OUTWARD, away from the center, not collapsing inward', () => {
      // A pinned center, a repo root, and one child directory under it. Wherever the repo root
      // settles, its child must end up FURTHER from the center (outward) and on the parent's far
      // side from the center, never folded back inward across the trunk.
      const layout = new ForceLayout({ center: { x: 0, y: 0 }})
      layout.sync([ rootVisible(), dir('repo', '', 1), dir('repo/child', 'repo', 2) ])
      stepTimes(layout, FIXED_DELTA_MS, 800)

      const repo = layout.state.get('repo')!.position
      const child = layout.state.get('repo/child')!.position
      const repoDistance = Math.hypot(repo.x, repo.y)
      const childDistance = Math.hypot(child.x, child.y)

      // The child sits further out than its parent: the branch grew away from the center.
      expect(childDistance).toBeGreaterThan(repoDistance)

      // The parent -> child step must have a POSITIVE component along the trunk's outward ray
      // (center -> repo): the child grew outward, not back toward the center.
      const outwardX = repo.x / (repoDistance || 1)
      const outwardY = repo.y / (repoDistance || 1)
      const stepX = child.x - repo.x
      const stepY = child.y - repo.y
      const outwardComponent = stepX * outwardX + stepY * outwardY
      expect(outwardComponent).toBeGreaterThan(0)
    })
  })

  describe('file clustering', () => {
    it('rests a file CLOSER to its directory than a child directory does', () => {
      // Same parent, one file and one child directory. The file must settle much nearer the parent
      // (a tight satellite) than the directory (which spreads like a sub-tree).
      const layout = new ForceLayout()
      layout.sync([
        rootVisible(),
        dir('repo', '', 1),
        dir('repo/sub', 'repo', 2),
        file('repo/a.ts', 'repo', 2),
      ])
      stepTimes(layout, FIXED_DELTA_MS, 600)

      const fileDistance = distanceBetween(layout, 'repo', 'repo/a.ts')
      const dirDistance = distanceBetween(layout, 'repo', 'repo/sub')
      expect(fileDistance).toBeLessThan(dirDistance)
    })
  })

  describe('step', () => {
    it('pulls a child directory toward roughly the rest length from its parent', () => {
      const restLength = 100
      // No depth scaling, the outward bias off, and one lone child (so no sibling widening): the
      // child rests at ~`restLength` from its parent, an easy settled distance to assert.
      const layout = new ForceLayout({
        restLength,
        restLengthDepthScale: 0,
        outwardBias: 0,
      })
      layout.sync([ dir('repo', '', 1), dir('repo/sub', 'repo', 2) ])

      stepTimes(layout, FIXED_DELTA_MS, 600)
      const distance = distanceBetween(layout, 'repo', 'repo/sub')
      expect(distance).toBeGreaterThan(restLength * 0.9)
      expect(distance).toBeLessThan(restLength * 1.15)
    })

    it('loses kinetic energy under damping and settles a single edge fully to rest', () => {
      // A lone parent + child (collision irrelevant for two well-separated bodies, outward off) has
      // a true equilibrium at the rest length, so damping must carry it all the way to rest.
      const layout = new ForceLayout({
        restLengthDepthScale: 0,
        outwardBias: 0,
      })
      layout.sync([ dir('repo', '', 1), dir('repo/sub', 'repo', 2) ])

      // A few steps in, the edge spring is actively doing work pulling the child out.
      stepTimes(layout, FIXED_DELTA_MS, 8)
      const energyEarly = totalKineticEnergy(layout)
      expect(energyEarly).toBeGreaterThan(0)

      // Far more steps in, damping must have bled the system essentially to rest.
      stepTimes(layout, FIXED_DELTA_MS, 1_400)
      const energyLate = totalKineticEnergy(layout)

      expect(energyLate).toBeLessThan(energyEarly)
      // Essentially at rest: a per-body speed well under a hundredth of a unit/sec.
      expect(energyLate).toBeLessThan(1e-3)
    })

    it('bleeds kinetic energy out of an excited sibling fan (eases toward calm, not frozen)', () => {
      // With the sibling fan + collision on, the group keeps gently jostling (the always-alive feel
      // the design wants), but damping must still drain the bulk of the initial excitement so it
      // eases toward a calm state rather than ringing forever.
      const layout = new ForceLayout()
      layout.sync([
        dir('repo', '', 1),
        dir('repo/a', 'repo', 2),
        dir('repo/b', 'repo', 2),
        dir('repo/c', 'repo', 2),
      ])

      stepTimes(layout, FIXED_DELTA_MS, 10)
      const energyEarly = totalKineticEnergy(layout)

      stepTimes(layout, FIXED_DELTA_MS, 800)
      const energyLate = totalKineticEnergy(layout)

      // The disturbance must have eased out to a small fraction of its peak.
      expect(energyLate).toBeLessThan(energyEarly * 0.5)
    })

    it('is deterministic: identical structure + deltas yield identical positions', () => {
      const build = (): ForceLayout => {
        const layout = new ForceLayout()
        layout.sync([
          dir('repo', '', 1),
          dir('repo/a', 'repo', 2),
          dir('repo/b', 'repo', 2),
        ])
        stepTimes(layout, FIXED_DELTA_MS, 120)
        return layout
      }

      const first = build()
      const second = build()
      for (const path of [ 'repo', 'repo/a', 'repo/b' ]) {
        expect(second.state.get(path)!.position).toEqual(first.state.get(path)!.position)
      }
    })

    it('ignores a non-positive or non-finite delta without disturbing the state', () => {
      const layout = new ForceLayout()
      layout.sync([ dir('repo', '', 1), dir('repo/sub', 'repo', 2) ])
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
        dir('repo', '', 1),
        dir('repo/a', 'repo', 2),
        dir('repo/b', 'repo', 2),
      ])

      // A pathological 10-second delta (a backgrounded tab) must be clamped, so every body stays
      // finite and on-canvas rather than being flung to infinity.
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
      layout.sync([ dir('repo', '', 1), file('repo/a.ts', 'repo', 2) ])
      expect(layout.state.size).toBe(2)

      layout.reset()
      expect(layout.state.size).toBe(0)

      // After a reset, a fresh sync re-populates normally (the rewind path).
      layout.sync([ dir('other', '', 1) ])
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
    // A 3x3 block of occupied cells, one body each. Sweeping every cell's neighborhood must
    // enumerate every UNORDERED pair of touching cells exactly once (the property that lets the
    // collision apply an equal-and-opposite force without double-counting).
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
    // A zero cell size would divide-by-zero every coordinate; the guard floors it to 1, so each
    // integer coordinate still lands in its own sensible cell.
    const grid = buildSpatialGrid(bodiesFrom([
      [ 'a', { x: 3, y: 4 }],
      [ 'b', { x: 3, y: 5 }],
    ]), 0)

    expect(pathsIn(grid.cells.get('3,4'))).toEqual([ 'a' ])
    expect(pathsIn(grid.cells.get('3,5'))).toEqual([ 'b' ])
  })
})

/** The signed angle of `point` around `center`, in (-pi, pi]. Reads a child's angle for the fan tests. */
function angleAround(center: Vec2, point: Vec2): number {
  return Math.atan2(point.y - center.y, point.x - center.x)
}

/** The absolute angular separation between two points around a shared center, in [0, pi]. */
function angularGap(center: Vec2, left: Vec2, right: Vec2): number {
  let delta = angleAround(center, right) - angleAround(center, left)
  while (delta > Math.PI) {
    delta -= Math.PI * 2
  }
  while (delta <= -Math.PI) {
    delta += Math.PI * 2
  }
  return Math.abs(delta)
}

/**
 * Advances sibling children a few explicit-Euler steps under ONLY the fan-spread force (the parent
 * is the fixed anchor), so a test can assert their angular gap actually opens over time, not just
 * that the instantaneous force points the right way. A tiny step keeps the integration well-behaved.
 */
function stepFanSpread(parent: Vec2, children: Vec2[], scale: number, steps: number): Vec2[] {
  const positions = children.map((child) => ({ x: child.x, y: child.y }))
  const stepSize = 0.0005
  for (let iteration = 0; iteration < steps; iteration++) {
    const forces = fanSpreadForces(parent, positions, scale)
    for (let index = 0; index < positions.length; index++) {
      positions[index].x += forces[index].x * stepSize
      positions[index].y += forces[index].y * stepSize
    }
  }
  return positions
}

describe('fanSpreadForces', () => {
  it('spreads two siblings at nearly the same angle apart, widening their gap over several steps', () => {
    const parent: Vec2 = { x: 0, y: 0 }
    // Two children at radius 100, both near angle 0 (a tiny 0.05 rad apart): badly crowded.
    const children: Vec2[] = [
      { x: 100, y: 0 },
      { x: 100 * Math.cos(0.05), y: 100 * Math.sin(0.05) },
    ]

    const gapBefore = angularGap(parent, children[0], children[1])
    const settled = stepFanSpread(parent, children, 50, 200)
    const gapAfter = angularGap(parent, settled[0], settled[1])

    // The fan emerged: stepping under the spreading force alone opened the wedge between them.
    expect(gapAfter).toBeGreaterThan(gapBefore)
  })

  it('applies opposing, purely tangential pushes to a crowded pair (one each way around the parent)', () => {
    const parent: Vec2 = { x: 0, y: 0 }
    // Two children near angle 0, very close in angle, at the same radius. The lower one (negative
    // angle) is pushed further negative in angle, the upper (positive) further positive.
    const lower: Vec2 = { x: 100 * Math.cos(-0.04), y: 100 * Math.sin(-0.04) }
    const upper: Vec2 = { x: 100 * Math.cos(0.04), y: 100 * Math.sin(0.04) }
    const forces = fanSpreadForces(parent, [ lower, upper ], 50)

    // The two children move in OPPOSITE angular directions: the lower child's force points
    // clockwise (decreasing angle) and the upper's counter-clockwise (increasing angle). The
    // angular direction of a force is the sign of (offset cross force).
    const crossLower = lower.x * forces[0].y - lower.y * forces[0].x
    const crossUpper = upper.x * forces[1].y - upper.y * forces[1].x
    expect(crossLower).toBeLessThan(0)
    expect(crossUpper).toBeGreaterThan(0)

    // Each push is purely tangential (perpendicular to that child's own radial axis), so the radial
    // (dot) component is essentially zero.
    const radialLower = lower.x * forces[0].x + lower.y * forces[0].y
    const radialUpper = upper.x * forces[1].x + upper.y * forces[1].y
    expect(Math.abs(radialLower)).toBeLessThan(1e-9)
    expect(Math.abs(radialUpper)).toBeLessThan(1e-9)
  })

  it('leaves an evenly-fanned group essentially at rest (a good fan needs ~no spreading)', () => {
    const parent: Vec2 = { x: 0, y: 0 }
    // Four siblings 90 deg apart: a perfect fan, whose adjacent gaps (pi/2) meet the even-gap
    // threshold (2*pi / 4 = pi/2) exactly, so none push.
    const radius = 100
    const children: Vec2[] = [ 0, 1, 2, 3 ].map((quarter) => {
      const angle = (quarter * Math.PI) / 2
      return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) }
    })
    const forces = fanSpreadForces(parent, children, 50)

    for (const force of forces) {
      expect(Math.hypot(force.x, force.y)).toBeLessThan(1e-9)
    }
  })

  it('returns a zero force for a lone child (no sibling to fan against)', () => {
    const forces = fanSpreadForces({ x: 0, y: 0 }, [{ x: 100, y: 0 }], 50)
    expect(forces).toHaveLength(1)
    expect(forces[0]).toEqual({ x: 0, y: 0 })
  })

  it('produces no spreading force at all when the scale is zero (the disabled fan)', () => {
    const parent: Vec2 = { x: 0, y: 0 }
    const children: Vec2[] = [
      { x: 100, y: 0 },
      { x: 100 * Math.cos(0.05), y: 100 * Math.sin(0.05) },
    ]
    const forces = fanSpreadForces(parent, children, 0)
    for (const force of forces) {
      expect(Math.hypot(force.x, force.y)).toBe(0)
    }
  })
})

describe('antiFoldbackForce', () => {
  const outward: Vec2 = { x: 1, y: 0 }

  it('pushes a child folded back inward of its parent toward the outward side', () => {
    const parent: Vec2 = { x: 0, y: 0 }
    // The child sits on the INWARD side of the parent (negative x along the outward axis): folded
    // back. It must be pushed back outward (positive x).
    const child: Vec2 = { x: -30, y: 5 }
    const force = antiFoldbackForce(parent, outward, child, 10)

    expect(force.x).toBeGreaterThan(0)
    // The push is purely along the outward axis, so it has no off-axis (y) component here.
    expect(force.y).toBeCloseTo(0, 12)
  })

  it('grows with how far inward the child has folded', () => {
    const parent: Vec2 = { x: 0, y: 0 }
    const slight = antiFoldbackForce(parent, outward, { x: -10, y: 0 }, 10)
    const deep = antiFoldbackForce(parent, outward, { x: -40, y: 0 }, 10)
    expect(deep.x).toBeGreaterThan(slight.x)
  })

  it('leaves a child already on the outward side untouched', () => {
    const parent: Vec2 = { x: 0, y: 0 }
    const child: Vec2 = { x: 50, y: 10 }
    const force = antiFoldbackForce(parent, outward, child, 10)
    expect(force).toEqual({ x: 0, y: 0 })
  })

  it('returns zero when the parent has no defined outward direction', () => {
    const force = antiFoldbackForce({ x: 0, y: 0 }, null, { x: -50, y: 0 }, 10)
    expect(force).toEqual({ x: 0, y: 0 })
  })

  it('returns zero when the scale is zero (the disabled untangle force)', () => {
    const force = antiFoldbackForce({ x: 0, y: 0 }, outward, { x: -50, y: 0 }, 0)
    expect(force).toEqual({ x: 0, y: 0 })
  })
})

describe('untangleGroupForces', () => {
  it('produces no force at all when the strength scale is zero', () => {
    const parent: Vec2 = { x: 0, y: 0 }
    const children: Vec2[] = [
      { x: 100, y: 0 },
      { x: 100 * Math.cos(0.05), y: 100 * Math.sin(0.05) },
    ]
    const forces = untangleGroupForces(parent, { x: 1, y: 0 }, children, 0)

    expect(forces).toHaveLength(2)
    for (const force of forces) {
      expect(Math.hypot(force.x, force.y)).toBe(0)
    }
  })

  it('combines the fan spreading and the anti-foldback into one force per child', () => {
    const parent: Vec2 = { x: 0, y: 0 }
    const outward: Vec2 = { x: 1, y: 0 }
    // Two crowded children, both slightly INWARD of the parent (negative x) so both terms engage:
    // the fan spreads them in y, the anti-foldback pushes them back out in +x.
    const children: Vec2[] = [
      { x: -100 * Math.cos(0.04), y: -100 * Math.sin(0.04) },
      { x: -100 * Math.cos(0.04), y: 100 * Math.sin(0.04) },
    ]
    const forces = untangleGroupForces(parent, outward, children, 50)

    // Both get pushed back outward (anti-foldback, +x) and apart in y (fan), so neither force is
    // zero and the y components oppose.
    expect(forces[0].x).toBeGreaterThan(0)
    expect(forces[1].x).toBeGreaterThan(0)
    expect(Math.sign(forces[0].y)).not.toBe(Math.sign(forces[1].y))
  })
})

describe('clampSpeed', () => {
  it('passes a vector under the cap through unchanged', () => {
    // Magnitude 5 < cap 10, so the gesture's full kick is imparted as-is.
    expect(clampSpeed({ x: 3, y: 4 }, 10)).toEqual({ x: 3, y: 4 })
  })

  it('clamps a vector over the cap to the cap magnitude, preserving its direction', () => {
    // Magnitude 10, capped to 5: the (3, 4)/5 direction is kept while each component halves.
    const result = clampSpeed({ x: 6, y: 8 }, 5)
    expect(Math.hypot(result.x, result.y)).toBeCloseTo(5, 10)
    expect(result.x).toBeCloseTo(3, 10)
    expect(result.y).toBeCloseTo(4, 10)
  })

  it('returns a zero kick for a non-finite component (a NaN delta upstream)', () => {
    expect(clampSpeed({ x: Number.NaN, y: 1 }, 10)).toEqual({ x: 0, y: 0 })
    expect(clampSpeed({ x: 1, y: Number.POSITIVE_INFINITY }, 10)).toEqual({ x: 0, y: 0 })
  })

  it('returns a zero kick for a non-positive cap', () => {
    expect(clampSpeed({ x: 3, y: 4 }, 0)).toEqual({ x: 0, y: 0 })
    expect(clampSpeed({ x: 3, y: 4 }, -5)).toEqual({ x: 0, y: 0 })
  })
})

describe('zoomImpulse', () => {
  it('pushes the forest outward (away from the anchor) when zooming in', () => {
    // The center sits to the +x of the anchor (offset (10, 0)); zooming in (factor 2) must kick the
    // nodes the OTHER way, in -x, away from the anchor, so they spring back outward.
    const impulse = zoomImpulse({ x: 10, y: 0 }, 2, 1)
    expect(impulse.x).toBeLessThan(0)
    expect(impulse.y).toBeCloseTo(0, 10)
  })

  it('pulls the forest inward (toward the center) when zooming out', () => {
    // Same geometry, zooming out (factor 0.5) flips the sign: the kick points toward +x (the center).
    const impulse = zoomImpulse({ x: 10, y: 0 }, 0.5, 1)
    expect(impulse.x).toBeGreaterThan(0)
    expect(impulse.y).toBeCloseTo(0, 10)
  })

  it('scales with the size of the zoom step (a hard zoom kicks harder than a gentle one)', () => {
    const gentle = zoomImpulse({ x: 10, y: 0 }, 1.1, 1)
    const hard = zoomImpulse({ x: 10, y: 0 }, 4, 1)
    expect(Math.abs(hard.x)).toBeGreaterThan(Math.abs(gentle.x))
  })

  it('returns a zero impulse when the anchor sits on the center (no radial direction)', () => {
    expect(zoomImpulse({ x: 0, y: 0 }, 2, 1)).toEqual({ x: 0, y: 0 })
  })

  it('returns a zero impulse for a unit or non-positive factor', () => {
    expect(zoomImpulse({ x: 10, y: 0 }, 1, 1)).toEqual({ x: 0, y: 0 })
    expect(zoomImpulse({ x: 10, y: 0 }, 0, 1)).toEqual({ x: 0, y: 0 })
    expect(zoomImpulse({ x: 10, y: 0 }, -2, 1)).toEqual({ x: 0, y: 0 })
  })
})

describe('ForceLayout.applyImpulse', () => {
  it('adds the kick velocity to every non-pinned body and leaves the pinned root untouched', () => {
    const layout = new ForceLayout()
    layout.sync([ rootVisible(), dir('api', '', 1), dir('docs', '', 1) ])

    layout.applyImpulse({ x: 5, y: -3 })

    // The pinned root is held at the center and never integrated, so it must carry no velocity.
    expect(layout.state.get('')!.velocity).toEqual({ x: 0, y: 0 })
    // Every non-pinned body, all starting at rest, gained exactly the kick.
    expect(layout.state.get('api')!.velocity).toEqual({ x: 5, y: -3 })
    expect(layout.state.get('docs')!.velocity).toEqual({ x: 5, y: -3 })
  })

  it('caps the imparted velocity at wobbleMaxSpeed so a fast gesture cannot blow up the sim', () => {
    const layout = new ForceLayout({ wobbleMaxSpeed: 10 })
    layout.sync([ dir('api', '', 1) ])

    // A requested kick of magnitude 100 along +x must saturate at the cap of 10.
    layout.applyImpulse({ x: 100, y: 0 })

    const velocity = layout.state.get('api')!.velocity
    expect(Math.hypot(velocity.x, velocity.y)).toBeCloseTo(10, 10)
    expect(velocity.x).toBeCloseTo(10, 10)
  })

  it('settles back to rest after a kick (the springs + damping decay the wobble)', () => {
    const layout = new ForceLayout()
    layout.sync([ rootVisible(), dir('api', '', 1), dir('docs', '', 1) ])
    // Let the spawn arrangement settle first so the only energy measured is the kick's.
    stepTimes(layout, FIXED_DELTA_MS, 400)

    layout.applyImpulse({ x: 80, y: 80 })
    const energyRightAfterKick = totalKineticEnergy(layout)
    expect(energyRightAfterKick).toBeGreaterThan(0)

    // A couple of seconds of stepping must bleed the kick's energy away to a small fraction.
    stepTimes(layout, FIXED_DELTA_MS, 400)
    const energyAfterSettling = totalKineticEnergy(layout)
    expect(energyAfterSettling).toBeLessThan(energyRightAfterKick * 0.05)
  })

  it('is a no-op for a zero or non-finite impulse', () => {
    const layout = new ForceLayout()
    layout.sync([ dir('api', '', 1) ])

    layout.applyImpulse({ x: 0, y: 0 })
    expect(layout.state.get('api')!.velocity).toEqual({ x: 0, y: 0 })

    layout.applyImpulse({ x: Number.NaN, y: 0 })
    expect(layout.state.get('api')!.velocity).toEqual({ x: 0, y: 0 })
  })
})
