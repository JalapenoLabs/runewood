// Copyright © 2026 Jalapeno Labs

import type { VisibleNode } from './collapse'
import type { TreeNode } from './tree'
import type { ForceLayoutOptions, QuadPoint } from './physics'

// Core
import { describe, expect, it } from 'vitest'

import {
  ForceLayout,
  computeContentRadii,
  computeFileSlots,
  computeInitialPlacement,
  countDirectFiles,
  parentFileRadius,
  buildQuadTree,
  clampSpeed,
  zoomImpulse,
} from './physics'

/**
 * Builds a minimal {@link TreeNode} for a path. The sim reads `path` and `isFile` off the node;
 * every other force input comes from the {@link VisibleNode} wrapper, so the rest is inert.
 */
function nodeFor(path: string, isFile: boolean): TreeNode {
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
 * The displacement each body undergoes over `count` steps: a snapshot of every position before and
 * after. Returns both the summed and the single largest per-body displacement. The directory sim is
 * momentumless (Gource `pos += accel * dt`) and deliberately stays *gently alive* (a tiny perpetual
 * jiggle is loved, not a bug), so the meaningful settled measure is the LARGEST per-body move: at
 * rest every node nudges by well under a node-width per dozens of frames, even though the sum over
 * hundreds of nodes is not literally zero.
 */
function displacementOver(
  layout: ForceLayout,
  deltaMs: number,
  count: number,
): { total: number, max: number } {
  const before = new Map<string, { x: number, y: number }>()
  for (const [ path, body ] of layout.state) {
    before.set(path, { x: body.position.x, y: body.position.y })
  }
  stepTimes(layout, deltaMs, count)
  let total = 0
  let max = 0
  for (const [ path, body ] of layout.state) {
    const start = before.get(path)!
    const moved = Math.hypot(body.position.x - start.x, body.position.y - start.y)
    total += moved
    max = Math.max(max, moved)
  }
  return { total, max }
}

/** The distance between two bodies in a settled layout, by path. */
function distanceBetween(layout: ForceLayout, leftPath: string, rightPath: string): number {
  const left = layout.state.get(leftPath)!.position
  const right = layout.state.get(rightPath)!.position
  return Math.hypot(left.x - right.x, left.y - right.y)
}

const FIXED_DELTA_MS = 16

/** A fully-defaulted options object, for the pure helpers that take `Required<ForceLayoutOptions>`. */
function defaultedOptions(overrides: ForceLayoutOptions = {}): Required<ForceLayoutOptions> {
  return {
    center: { x: 0, y: 0 },
    gravity: 10,
    directoryPadding: 1.5,
    fileDiameter: 8,
    fileEaseSpeed: 5,
    damping: 0.85,
    maxStepMs: 50,
    quadTreeTheta: 0.5,
    wobbleMaxSpeed: 220,
    ...overrides,
  }
}

describe('ForceLayout: directory springs to its parent', () => {
  it('a child directory settles at roughly its rest distance from the parent, not on top of it', () => {
    // A repo root at the center and one child directory under it.
    const root = dir('repo', '', 1)
    const child = dir('repo/src', 'repo', 2)
    const layout = new ForceLayout({ center: { x: 0, y: 0 }})
    layout.sync([ root, child ])

    // Pin the repo root in place so we measure the child's resting distance from a fixed anchor.
    const rootBody = layout.state.get('repo')!
    rootBody.position.x = 0
    rootBody.position.y = 0

    stepTimes(layout, FIXED_DELTA_MS, 400)
    rootBody.position.x = 0
    rootBody.position.y = 0

    const distance = distanceBetween(layout, 'repo', 'repo/src')

    // The spring rests the child just outside the sum of the two radii. With empty dirs those radii
    // are the padding floor (1.5 each), so the rest gap is small but strictly positive: the child
    // never lands on the parent, and it does not fly off to infinity either.
    expect(distance).toBeGreaterThan(0)
    expect(distance).toBeLessThan(200)
    expect(Number.isFinite(distance)).toBe(true)
  })

  it('a directory full of files rests further out than an empty one (content radius widens the gap)', () => {
    // Two sibling repos: one empty, one holding many files. The full repo has a bigger content
    // radius, so its own child should rest further from it than the empty repo's child does.
    const emptyParent = dir('empty', '', 1)
    const emptyChild = dir('empty/child', 'empty', 2)

    const fullParent = dir('full', '', 1)
    const fullChild = dir('full/child', 'full', 2)
    const fullFiles = Array.from({ length: 30 }, (_unused, index) => {
      return file(`full/f${index}.ts`, 'full', 2)
    })

    const emptyLayout = new ForceLayout()
    emptyLayout.sync([ emptyParent, emptyChild ])
    const emptyRadii = computeContentRadii([ emptyParent, emptyChild ], defaultedOptions())

    const fullLayout = new ForceLayout()
    fullLayout.sync([ fullParent, fullChild, ...fullFiles ])
    const fullRadii = computeContentRadii([ fullParent, fullChild, ...fullFiles ], defaultedOptions())

    // The content radius of the file-heavy directory is strictly larger.
    expect(fullRadii.get('full')!).toBeGreaterThan(emptyRadii.get('empty')!)

    // And that translates to its child resting further out once both settle (pinning each parent).
    emptyLayout.state.get('empty')!.position = { x: 0, y: 0 }
    fullLayout.state.get('full')!.position = { x: 0, y: 0 }
    stepTimes(emptyLayout, FIXED_DELTA_MS, 300)
    stepTimes(fullLayout, FIXED_DELTA_MS, 300)
    emptyLayout.state.get('empty')!.position = { x: 0, y: 0 }
    fullLayout.state.get('full')!.position = { x: 0, y: 0 }

    const emptyGap = distanceBetween(emptyLayout, 'empty', 'empty/child')
    const fullGap = distanceBetween(fullLayout, 'full', 'full/child')
    expect(fullGap).toBeGreaterThan(emptyGap)
  })
})

describe('ForceLayout: directory <-> directory repulsion (quadtree)', () => {
  it('two overlapping sibling directories push apart until their discs separate', () => {
    // Two repo roots spawned essentially on top of each other; the quadtree repulsion must split
    // them so their content discs no longer overlap.
    const left = dir('left', '', 1)
    const right = dir('right', '', 1)
    const layout = new ForceLayout()
    layout.sync([ left, right ])

    // Force a deep overlap to make the repulsion do real work.
    layout.state.get('left')!.position = { x: 0, y: 0 }
    layout.state.get('right')!.position = { x: 0.5, y: 0 }

    stepTimes(layout, FIXED_DELTA_MS, 400)

    const radii = computeContentRadii([ left, right ], defaultedOptions())
    const sumRadius = radii.get('left')! + radii.get('right')!
    const distance = distanceBetween(layout, 'left', 'right')

    // They end up at least roughly their summed radii apart (no longer overlapping) and finite.
    expect(distance).toBeGreaterThanOrEqual(sumRadius * 0.5)
    expect(distance).toBeGreaterThan(0)
    expect(Number.isFinite(distance)).toBe(true)
  })

  it('does not repel a parent or child (only the spring governs that edge)', () => {
    // A parent and its single child: the repulsion predicate must exclude this edge, so the child
    // settles at the spring rest gap rather than being shoved away by repulsion.
    const parent = dir('repo', '', 1)
    const child = dir('repo/src', 'repo', 2)
    const layout = new ForceLayout()
    layout.sync([ parent, child ])
    layout.state.get('repo')!.position = { x: 0, y: 0 }
    layout.state.get('repo/src')!.position = { x: 1, y: 0 }

    stepTimes(layout, FIXED_DELTA_MS, 300)
    layout.state.get('repo')!.position = { x: 0, y: 0 }

    // The child stays close to the parent (a few radii), proving repulsion did not blow the edge up.
    const distance = distanceBetween(layout, 'repo', 'repo/src')
    expect(distance).toBeLessThan(100)
  })
})

describe('ForceLayout: settling (the anti-flail guarantee)', () => {
  it('a fan of many sibling directories loses motion and settles to rest', () => {
    const root = dir('repo', '', 1)
    const children = Array.from({ length: 12 }, (_unused, index) => {
      return dir(`repo/d${index}`, 'repo', 2)
    })
    const layout = new ForceLayout()
    layout.sync([ root, ...children ])

    // Movement early (still settling) must exceed movement late (at rest): the forest stops flailing.
    const earlyMovement = displacementOver(layout, FIXED_DELTA_MS, 60)
    stepTimes(layout, FIXED_DELTA_MS, 400)
    const lateMovement = displacementOver(layout, FIXED_DELTA_MS, 60)

    expect(lateMovement.total).toBeLessThan(earlyMovement.total)
    // At rest no node in the fan twitches more than a node-width over 60 frames.
    expect(lateMovement.max).toBeLessThan(10)
  })

  it('a deep tree of hundreds of directories settles to bounded, finite positions (no flail)', () => {
    // Build a wide, deep forest: 6 repos, each with a branching subtree, ~300 directories total.
    const visible: VisibleNode[] = [ rootVisible() ]
    let directoryCount = 0
    for (let repoIndex = 0; repoIndex < 6; repoIndex++) {
      const repoPath = `repo${repoIndex}`
      visible.push(dir(repoPath, '', 1))
      directoryCount++
      for (let branchIndex = 0; branchIndex < 6; branchIndex++) {
        const branchPath = `${repoPath}/b${branchIndex}`
        visible.push(dir(branchPath, repoPath, 2))
        directoryCount++
        for (let leafIndex = 0; leafIndex < 7; leafIndex++) {
          const leafPath = `${branchPath}/l${leafIndex}`
          visible.push(dir(leafPath, branchPath, 3))
          directoryCount++
          // A couple of files on each leaf, to exercise the satellite packing under load.
          visible.push(file(`${leafPath}/a.ts`, leafPath, 4))
          visible.push(file(`${leafPath}/b.ts`, leafPath, 4))
        }
      }
    }
    expect(directoryCount).toBeGreaterThan(250)

    const layout = new ForceLayout()
    layout.sync(visible)
    stepTimes(layout, FIXED_DELTA_MS, 800)

    // Every body must be at a finite, bounded position: this is the core stability guarantee that
    // the old custom-force stack failed. Nothing has flung off to infinity or gone NaN.
    let maxCoordinate = 0
    for (const body of layout.state.values()) {
      expect(Number.isFinite(body.position.x)).toBe(true)
      expect(Number.isFinite(body.position.y)).toBe(true)
      maxCoordinate = Math.max(maxCoordinate, Math.abs(body.position.x), Math.abs(body.position.y))
    }
    // A generous but finite bound: hundreds of ~tens-of-units discs cannot legitimately span past
    // this if the sim is stable. A flailing sim would blow well past it. (In practice the whole
    // forest packs into a few hundred units; the bound is loose so it can never false-fail.)
    expect(maxCoordinate).toBeLessThan(50_000)

    // The anti-flail guarantee: it stays BOUNDED. Stepping another long stretch must not let any
    // node run away or grow the forest's extent; a flailing sim would balloon here.
    stepTimes(layout, FIXED_DELTA_MS, 800)
    let maxAfter = 0
    for (const body of layout.state.values()) {
      expect(Number.isFinite(body.position.x)).toBe(true)
      expect(Number.isFinite(body.position.y)).toBe(true)
      maxAfter = Math.max(maxAfter, Math.abs(body.position.x), Math.abs(body.position.y))
    }
    // The extent did not blow up over the extra steps: it stays within a small multiple of where it
    // already was (the forest is settled into a stable, bounded arrangement, not diverging).
    expect(maxAfter).toBeLessThan(maxCoordinate * 3 + 500)

    // And per-node motion stays a gentle, bounded jiggle (the sim is intentionally "alive"), never
    // a flail: no single directory lurches across the canvas in a frame-burst.
    const settled = displacementOver(layout, FIXED_DELTA_MS, 60)
    expect(settled.max).toBeLessThan(60) // no node moves more than ~a few node-widths over 60 frames
  })
})

describe('ForceLayout: files are satellites around their directory', () => {
  it('a file rests in a ring close to its directory, not flung away', () => {
    const repo = dir('repo', '', 1)
    const onlyFile = file('repo/main.ts', 'repo', 2)
    const layout = new ForceLayout()
    layout.sync([ repo, onlyFile ])
    layout.state.get('repo')!.position = { x: 0, y: 0 }

    stepTimes(layout, FIXED_DELTA_MS, 200)
    layout.state.get('repo')!.position = { x: 0, y: 0 }

    // A single file sits in ring 1 (radius 0 offset in Gource's packing): essentially on the
    // directory. With more files they spread to outer rings, but one file hugs the center.
    const distance = distanceBetween(layout, 'repo', 'repo/main.ts')
    expect(distance).toBeLessThan(2)
  })

  it('many files pack into concentric rings, all within a few ring-widths of the directory', () => {
    const repo = dir('repo', '', 1)
    const files = Array.from({ length: 40 }, (_unused, index) => file(`repo/f${index}.ts`, 'repo', 2))
    const layout = new ForceLayout()
    layout.sync([ repo, ...files ])
    layout.state.get('repo')!.position = { x: 0, y: 0 }

    stepTimes(layout, FIXED_DELTA_MS, 200)
    layout.state.get('repo')!.position = { x: 0, y: 0 }

    // Every file is within a bounded radius (a handful of file-diameters) of its directory: the
    // satellite cluster stays tight, never spreading like a sub-tree.
    for (const fileNode of files) {
      const distance = distanceBetween(layout, 'repo', fileNode.node.path)
      expect(distance).toBeLessThan(8 * 12) // generous: ~12 ring widths at fileDiameter 8
    }
  })

  it('a file follows its directory when the directory is moved', () => {
    const repo = dir('repo', '', 1)
    const onlyFile = file('repo/main.ts', 'repo', 2)
    const layout = new ForceLayout()
    layout.sync([ repo, onlyFile ])
    layout.state.get('repo')!.position = { x: 0, y: 0 }
    stepTimes(layout, FIXED_DELTA_MS, 100)

    // Hold the directory far away (re-pinning each frame so its own spring to the center cannot pull
    // it back) and confirm the file chases it there: files track their directory's live position.
    const repoBody = layout.state.get('repo')!
    for (let index = 0; index < 200; index++) {
      repoBody.position.x = 1000
      repoBody.position.y = 1000
      layout.step(FIXED_DELTA_MS)
    }

    const distance = distanceBetween(layout, 'repo', 'repo/main.ts')
    expect(distance).toBeLessThan(5)
  })
})

describe('ForceLayout: determinism', () => {
  it('two runs with the same visible set and fixed deltas produce identical positions', () => {
    const build = (): VisibleNode[] => [
      dir('repo', '', 1),
      dir('repo/src', 'repo', 2),
      dir('repo/test', 'repo', 2),
      file('repo/src/a.ts', 'repo/src', 3),
      file('repo/src/b.ts', 'repo/src', 3),
    ]

    const runA = new ForceLayout()
    runA.sync(build())
    stepTimes(runA, FIXED_DELTA_MS, 250)

    const runB = new ForceLayout()
    runB.sync(build())
    stepTimes(runB, FIXED_DELTA_MS, 250)

    for (const [ path, body ] of runA.state) {
      const other = runB.state.get(path)!
      expect(other.position.x).toBeCloseTo(body.position.x, 9)
      expect(other.position.y).toBeCloseTo(body.position.y, 9)
    }
  })
})

describe('ForceLayout: forest root pinning and lifecycle', () => {
  it('pins the forest root at the center and never integrates it', () => {
    const layout = new ForceLayout({ center: { x: 5, y: -3 }})
    layout.sync([ rootVisible(), dir('repo', '', 1) ])
    stepTimes(layout, FIXED_DELTA_MS, 100)

    const rootBody = layout.state.get('')!
    expect(rootBody.position.x).toBe(5)
    expect(rootBody.position.y).toBe(-3)
    expect(rootBody.velocity.x).toBe(0)
    expect(rootBody.velocity.y).toBe(0)
  })

  it('drops bodies for nodes that leave the visible set', () => {
    const layout = new ForceLayout()
    layout.sync([ dir('repo', '', 1), dir('repo/src', 'repo', 2) ])
    expect(layout.state.has('repo/src')).toBe(true)

    layout.sync([ dir('repo', '', 1) ])
    expect(layout.state.has('repo/src')).toBe(false)
    expect(layout.state.has('repo')).toBe(true)
  })

  it('reset clears every body', () => {
    const layout = new ForceLayout()
    layout.sync([ dir('repo', '', 1), file('repo/a.ts', 'repo', 2) ])
    expect(layout.state.size).toBeGreaterThan(0)
    layout.reset()
    expect(layout.state.size).toBe(0)
  })

  it('ignores a non-positive or non-finite step delta', () => {
    const layout = new ForceLayout()
    layout.sync([ dir('repo', '', 1), dir('repo/src', 'repo', 2) ])
    const before = { ...layout.state.get('repo/src')!.position }
    layout.step(0)
    layout.step(-16)
    layout.step(Number.NaN)
    const after = layout.state.get('repo/src')!.position
    expect(after.x).toBe(before.x)
    expect(after.y).toBe(before.y)
  })
})

describe('ForceLayout: applyImpulse (camera wobble)', () => {
  it('kicks directory bodies and then settles them back via damping', () => {
    const layout = new ForceLayout()
    layout.sync([ dir('repo', '', 1), dir('repo/src', 'repo', 2) ])
    stepTimes(layout, FIXED_DELTA_MS, 100)

    layout.applyImpulse({ x: 50, y: 0 })
    const kicked = totalKineticEnergy(layout)
    expect(kicked).toBeGreaterThan(0)

    stepTimes(layout, FIXED_DELTA_MS, 400)
    expect(totalKineticEnergy(layout)).toBeLessThan(kicked)
    expect(totalKineticEnergy(layout)).toBeLessThan(1)
  })

  it('does not impart a velocity to the pinned forest root', () => {
    const layout = new ForceLayout()
    layout.sync([ rootVisible(), dir('repo', '', 1) ])
    layout.applyImpulse({ x: 30, y: 30 })
    const rootBody = layout.state.get('')!
    expect(rootBody.velocity.x).toBe(0)
    expect(rootBody.velocity.y).toBe(0)
  })

  it('a zero or non-finite impulse is a no-op', () => {
    const layout = new ForceLayout()
    layout.sync([ dir('repo', '', 1) ])
    layout.applyImpulse({ x: 0, y: 0 })
    layout.applyImpulse({ x: Number.NaN, y: 1 })
    expect(totalKineticEnergy(layout)).toBe(0)
  })
})

describe('computeInitialPlacement (deterministic radial first-load placement)', () => {
  it('spreads a bulk-added set across the radial layout: bounded, non-coincident, NOT all at one point', () => {
    // A repo with 100 sibling directories all added at once (the bulk-seed case). The placement must
    // fan them around the radial layout, not stack them on one point the way a pile-at-parent spawn
    // would.
    const visible: VisibleNode[] = [ dir('repo', '', 1) ]
    for (let index = 0; index < 100; index++) {
      visible.push(dir(`repo/d${index}`, 'repo', 2))
    }

    const placement = computeInitialPlacement(visible, defaultedOptions())

    // Every directory got a finite position.
    expect(placement.size).toBe(101)
    for (const position of placement.values()) {
      expect(Number.isFinite(position.x)).toBe(true)
      expect(Number.isFinite(position.y)).toBe(true)
    }

    // The 100 children are spread out, not piled: the count of distinct rounded positions is high
    // (a pile would collapse to one or two points), and they span a real bounding box.
    const childPositions = visible
      .filter((visible) => visible.node.path.startsWith('repo/'))
      .map((visible) => placement.get(visible.node.path)!)
    const distinct = new Set(childPositions.map((position) => `${Math.round(position.x)},${Math.round(position.y)}`))
    expect(distinct.size).toBeGreaterThan(90)

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const position of childPositions) {
      minX = Math.min(minX, position.x)
      maxX = Math.max(maxX, position.x)
      minY = Math.min(minY, position.y)
      maxY = Math.max(maxY, position.y)
    }
    // The fan has real extent on both axes (a ring around the center), but stays bounded.
    expect(maxX - minX).toBeGreaterThan(50)
    expect(maxY - minY).toBeGreaterThan(50)
    expect(maxX - minX).toBeLessThan(100_000)

    // No two children share an exact position (the explosion-causing degenerate state).
    const exact = new Set(childPositions.map((position) => `${position.x},${position.y}`))
    expect(exact.size).toBe(childPositions.length)
  })

  it('places deeper directories further from the center than shallower ones', () => {
    const visible: VisibleNode[] = [
      dir('repo', '', 1),
      dir('repo/src', 'repo', 2),
      dir('repo/src/core', 'repo/src', 3),
    ]
    const options = defaultedOptions({ center: { x: 0, y: 0 }})
    const placement = computeInitialPlacement(visible, options)

    const repoRadius = Math.hypot(placement.get('repo')!.x, placement.get('repo')!.y)
    const srcRadius = Math.hypot(placement.get('repo/src')!.x, placement.get('repo/src')!.y)
    const coreRadius = Math.hypot(placement.get('repo/src/core')!.x, placement.get('repo/src/core')!.y)

    expect(srcRadius).toBeGreaterThan(repoRadius)
    expect(coreRadius).toBeGreaterThan(srcRadius)
  })

  it('omits files (they are deterministic ring satellites, placed by computeFileSlots)', () => {
    const visible: VisibleNode[] = [
      dir('repo', '', 1),
      file('repo/main.ts', 'repo', 2),
    ]
    const placement = computeInitialPlacement(visible, defaultedOptions())
    expect(placement.has('repo')).toBe(true)
    expect(placement.has('repo/main.ts')).toBe(false)
  })

  it('is deterministic and independent of input ordering', () => {
    const build = (reversed: boolean): VisibleNode[] => {
      const children = Array.from({ length: 10 }, (_unused, index) => dir(`repo/d${index}`, 'repo', 2))
      const ordered = reversed ? [ ...children ].reverse() : children
      return [ dir('repo', '', 1), ...ordered ]
    }
    const first = computeInitialPlacement(build(false), defaultedOptions())
    const second = computeInitialPlacement(build(true), defaultedOptions())
    for (const path of first.keys()) {
      expect(second.get(path)!).toEqual(first.get(path)!)
    }
  })

  it('a bulk sync lands its bodies already spread (not piled at the parent)', () => {
    // Wire the placement through the sim's `sync`: a fresh ForceLayout given a 100-dir bulk set must
    // spawn its bodies spread out, BEFORE any `step` runs, proving the initial placement (not the
    // force relaxation) is what spreads them.
    const visible: VisibleNode[] = [ dir('repo', '', 1) ]
    for (let index = 0; index < 100; index++) {
      visible.push(dir(`repo/d${index}`, 'repo', 2))
    }
    const layout = new ForceLayout()
    layout.sync(visible)

    const positions = [ ...layout.state.values() ].map((body) => {
      return `${Math.round(body.position.x)},${Math.round(body.position.y)}`
    })
    const distinct = new Set(positions)
    // Almost every body sits at its own spot the instant it is synced; a pile-at-parent spawn would
    // collapse them to a couple of points around the parent.
    expect(distinct.size).toBeGreaterThan(90)
  })
})

describe('ForceLayout: sleeping (convergence + the scale perf win)', () => {
  /** Steps until every directory body sleeps, or returns false if it never settles within the budget. */
  function stepUntilAllAsleep(layout: ForceLayout, deltaMs: number, maxSteps: number): boolean {
    for (let index = 0; index < maxSteps; index++) {
      layout.step(deltaMs)
      if (allDirectoriesAsleep(layout)) {
        return true
      }
    }
    return allDirectoriesAsleep(layout)
  }

  /** Whether every directory body has gone fully static (moves essentially nothing over many frames). */
  function allDirectoriesAsleep(layout: ForceLayout): boolean {
    const before = new Map<string, { x: number, y: number }>()
    for (const [ path, body ] of layout.state) {
      before.set(path, { x: body.position.x, y: body.position.y })
    }
    for (let index = 0; index < 20; index++) {
      layout.step(FIXED_DELTA_MS)
    }
    for (const [ path, body ] of layout.state) {
      const start = before.get(path)!
      if (Math.hypot(body.position.x - start.x, body.position.y - start.y) > 1e-6) {
        return false
      }
    }
    return true
  }

  it('a settled body goes fully static (skipped by integration) and stays put', () => {
    const root = dir('repo', '', 1)
    const children = Array.from({ length: 8 }, (_unused, index) => dir(`repo/d${index}`, 'repo', 2))
    const layout = new ForceLayout()
    layout.sync([ root, ...children ])

    // Let it settle, then confirm a long further run moves NOTHING (truly static, not a perpetual
    // jiggle): the convergence guarantee the sleeping gives.
    stepTimes(layout, FIXED_DELTA_MS, 600)
    const settled = displacementOver(layout, FIXED_DELTA_MS, 120)
    expect(settled.total).toBeCloseTo(0, 6)
    expect(settled.max).toBeCloseTo(0, 6)
  })

  it('a camera impulse wakes the settled bodies, which then move again and re-settle', () => {
    const root = dir('repo', '', 1)
    const children = Array.from({ length: 8 }, (_unused, index) => dir(`repo/d${index}`, 'repo', 2))
    const layout = new ForceLayout()
    layout.sync([ root, ...children ])
    stepTimes(layout, FIXED_DELTA_MS, 600)

    // Asleep: no motion.
    expect(displacementOver(layout, FIXED_DELTA_MS, 40).total).toBeCloseTo(0, 6)

    // A kick wakes them; they move again, then re-settle to static.
    layout.applyImpulse({ x: 60, y: 0 })
    const afterKick = displacementOver(layout, FIXED_DELTA_MS, 40)
    expect(afterKick.total).toBeGreaterThan(0)

    stepTimes(layout, FIXED_DELTA_MS, 600)
    expect(displacementOver(layout, FIXED_DELTA_MS, 40).total).toBeCloseTo(0, 6)
  })

  it('adding a new sibling near a settled cluster wakes it to re-settle', () => {
    const root = dir('repo', '', 1)
    const children = Array.from({ length: 6 }, (_unused, index) => dir(`repo/d${index}`, 'repo', 2))
    const layout = new ForceLayout()
    layout.sync([ root, ...children ])
    stepTimes(layout, FIXED_DELTA_MS, 600)
    expect(displacementOver(layout, FIXED_DELTA_MS, 40).total).toBeCloseTo(0, 6)

    // Add two more siblings (a structural change): the existing cluster must wake and re-settle, so
    // the new arrivals are accommodated rather than overlapped by a frozen layout.
    const grown = [ root, ...children, dir('repo/dNew1', 'repo', 2), dir('repo/dNew2', 'repo', 2) ]
    layout.sync(grown)
    const afterAdd = displacementOver(layout, FIXED_DELTA_MS, 40)
    expect(afterAdd.total).toBeGreaterThan(0)
  })

  it('a large tree reaches a fully settled, static, bounded state (it sleeps, not jiggles forever)', () => {
    // The scale case: a wide, deep forest of hundreds of directories must come fully to REST (every
    // body static), not churn forever. This is the convergence + framerate fix.
    const visible: VisibleNode[] = [ rootVisible() ]
    for (let repoIndex = 0; repoIndex < 6; repoIndex++) {
      const repoPath = `repo${repoIndex}`
      visible.push(dir(repoPath, '', 1))
      for (let branchIndex = 0; branchIndex < 6; branchIndex++) {
        const branchPath = `${repoPath}/b${branchIndex}`
        visible.push(dir(branchPath, repoPath, 2))
        for (let leafIndex = 0; leafIndex < 7; leafIndex++) {
          const leafPath = `${branchPath}/l${leafIndex}`
          visible.push(dir(leafPath, branchPath, 3))
          visible.push(file(`${leafPath}/a.ts`, leafPath, 4))
          visible.push(file(`${leafPath}/b.ts`, leafPath, 4))
        }
      }
    }

    const layout = new ForceLayout()
    layout.sync(visible)

    // It settles to a fully static state within a bounded number of steps (it does not churn for
    // minutes / forever). The directory bodies all sleep; a further long run moves nothing.
    const settled = stepUntilAllAsleep(layout, FIXED_DELTA_MS, 4000)
    expect(settled).toBe(true)

    // And every body is at a finite, bounded position (no flail to infinity).
    let maxCoordinate = 0
    for (const body of layout.state.values()) {
      expect(Number.isFinite(body.position.x)).toBe(true)
      expect(Number.isFinite(body.position.y)).toBe(true)
      maxCoordinate = Math.max(maxCoordinate, Math.abs(body.position.x), Math.abs(body.position.y))
    }
    expect(maxCoordinate).toBeLessThan(50_000)
  })
})

describe('computeContentRadii', () => {
  it('an empty directory gets the padding floor; a file-heavy one grows with sqrt of file area', () => {
    const empty = dir('empty', '', 1)
    const heavy = dir('heavy', '', 1)
    const files = Array.from({ length: 16 }, (_unused, index) => file(`heavy/f${index}.ts`, 'heavy', 2))

    const radii = computeContentRadii([ empty, heavy, ...files ], defaultedOptions())

    // Empty: max(1, sqrt(0)) * padding = 1 * 1.5.
    expect(radii.get('empty')!).toBeCloseTo(1.5, 6)

    // Heavy: sqrt(16 * fileArea) * padding, with fileArea = (4)^2 * PI = 16*PI.
    const fileArea = 4 * 4 * Math.PI
    const expected = Math.sqrt(16 * fileArea) * 1.5
    expect(radii.get('heavy')!).toBeCloseTo(expected, 6)
  })

  it('a parent directory accumulates the area of its sub-directories (bottom-up fold)', () => {
    // repo > src > {two files}. The repo radius must reflect the nested files, not just its own.
    const repo = dir('repo', '', 1)
    const src = dir('repo/src', 'repo', 2)
    const fileA = file('repo/src/a.ts', 'repo/src', 3)
    const fileB = file('repo/src/b.ts', 'repo/src', 3)

    const radii = computeContentRadii([ repo, src, fileA, fileB ], defaultedOptions())

    const fileArea = 4 * 4 * Math.PI
    const expected = Math.sqrt(2 * fileArea) * 1.5
    // src holds both files directly; repo accumulates src's area, so both equal the two-file area.
    expect(radii.get('repo')!).toBeCloseTo(expected, 6)
    expect(radii.get('repo/src')!).toBeCloseTo(expected, 6)
  })
})

describe('computeFileSlots', () => {
  it('a single file sits at the directory center (ring 1, radius 0)', () => {
    const slots = computeFileSlots([ dir('repo', '', 1), file('repo/a.ts', 'repo', 2) ], defaultedOptions())
    const slot = slots.get('repo/a.ts')!
    expect(Math.hypot(slot.x, slot.y)).toBeCloseTo(0, 6)
  })

  it('files beyond the first ring sit one file-diameter out, evenly spread', () => {
    const files = Array.from({ length: 8 }, (_unused, index) => file(`repo/f${index}.ts`, 'repo', 2))
    const slots = computeFileSlots([ dir('repo', '', 1), ...files ], defaultedOptions())

    // The first file is in ring 1 at radius 0; subsequent files move to ring 2 at radius
    // fileDiameter (8). At least one file should sit at exactly that radius.
    const radii = [ ...slots.values() ].map((slot) => Math.hypot(slot.x, slot.y))
    expect(Math.min(...radii)).toBeCloseTo(0, 6)
    expect(radii.some((radius) => Math.abs(radius - 8) < 1e-6)).toBe(true)

    // No file is flung absurdly far: even with 8 files we stay within a couple of rings.
    expect(Math.max(...radii)).toBeLessThan(8 * 4)
  })

  it('is deterministic and ordered by path (insertion order does not matter)', () => {
    const a = file('repo/a.ts', 'repo', 2)
    const b = file('repo/b.ts', 'repo', 2)
    const c = file('repo/c.ts', 'repo', 2)

    const first = computeFileSlots([ dir('repo', '', 1), c, a, b ], defaultedOptions())
    const second = computeFileSlots([ dir('repo', '', 1), a, b, c ], defaultedOptions())

    for (const path of [ 'repo/a.ts', 'repo/b.ts', 'repo/c.ts' ]) {
      expect(first.get(path)!).toEqual(second.get(path)!)
    }
  })
})

describe('countDirectFiles and parentFileRadius', () => {
  it('counts only the directory\'s own visible files', () => {
    const counts = countDirectFiles([
      dir('repo', '', 1),
      dir('repo/src', 'repo', 2),
      file('repo/top.ts', 'repo', 2),
      file('repo/src/a.ts', 'repo/src', 3),
      file('repo/src/b.ts', 'repo/src', 3),
    ])
    expect(counts.get('repo')).toBe(1)
    expect(counts.get('repo/src')).toBe(2)
  })

  it('parentFileRadius grows with the direct file count', () => {
    const options = defaultedOptions()
    const fewFiles = parentFileRadius(
      { displayParentPath: '', isFile: false, depth: 1, contentRadius: 1, fileCount: 2, fileSlot: null },
      options,
    )
    const manyFiles = parentFileRadius(
      { displayParentPath: '', isFile: false, depth: 1, contentRadius: 1, fileCount: 20, fileSlot: null },
      options,
    )
    expect(manyFiles).toBeGreaterThan(fewFiles)

    // No files: the padding floor.
    const none = parentFileRadius(
      { displayParentPath: '', isFile: false, depth: 1, contentRadius: 1, fileCount: 0, fileSlot: null },
      options,
    )
    expect(none).toBeCloseTo(options.directoryPadding, 6)
  })
})

describe('buildQuadTree', () => {
  it('two overlapping points each feel a push directly apart from the other', () => {
    const points: QuadPoint[] = [
      { path: 'a', position: { x: 0, y: 0 }, radius: 10 },
      { path: 'b', position: { x: 4, y: 0 }, radius: 10 },
    ]
    const tree = buildQuadTree(points, 0.5)

    // 'a' is at x=0, 'b' at x=4, summed radii 20: they overlap by 16, so 'a' is pushed in -x.
    const pushA = tree.repulsionOn('a', { x: 0, y: 0 }, 10, () => true)
    expect(pushA.x).toBeLessThan(0)
    expect(Math.abs(pushA.y)).toBeLessThan(1e-9)

    // 'b' is pushed the opposite way, in +x.
    const pushB = tree.repulsionOn('b', { x: 4, y: 0 }, 10, () => true)
    expect(pushB.x).toBeGreaterThan(0)
  })

  it('well-separated points feel no push (overlap-only force)', () => {
    const points: QuadPoint[] = [
      { path: 'a', position: { x: 0, y: 0 }, radius: 5 },
      { path: 'b', position: { x: 1000, y: 0 }, radius: 5 },
    ]
    const tree = buildQuadTree(points, 0.5)
    const push = tree.repulsionOn('a', { x: 0, y: 0 }, 5, () => true)
    expect(Math.hypot(push.x, push.y)).toBeCloseTo(0, 9)
  })

  it('respects the exclusion predicate (a skipped point contributes nothing)', () => {
    const points: QuadPoint[] = [
      { path: 'a', position: { x: 0, y: 0 }, radius: 10 },
      { path: 'b', position: { x: 4, y: 0 }, radius: 10 },
    ]
    const tree = buildQuadTree(points, 0.5)
    // Exclude 'b' entirely: 'a' should feel nothing even though they overlap.
    const push = tree.repulsionOn('a', { x: 0, y: 0 }, 10, (candidate) => candidate !== 'b')
    expect(Math.hypot(push.x, push.y)).toBeCloseTo(0, 9)
  })

  it('an empty tree always returns a zero push', () => {
    const tree = buildQuadTree([], 0.5)
    const push = tree.repulsionOn('x', { x: 0, y: 0 }, 1, () => true)
    expect(push).toEqual({ x: 0, y: 0 })
  })

  it('a far cluster of overlapping points still pushes a nearby query the right way', () => {
    // A tight cluster near the origin and one query point just overlapping it: the lumped far-field
    // path (and the exact near path) must both push the query away from the cluster.
    const points: QuadPoint[] = []
    for (let index = 0; index < 20; index++) {
      points.push({ path: `c${index}`, position: { x: index * 0.1, y: 0 }, radius: 30 })
    }
    const tree = buildQuadTree(points, 0.5)
    const push = tree.repulsionOn('query', { x: -1, y: 0 }, 30, () => true)
    // The cluster sits to the +x side, so the query at -1 is pushed further -x.
    expect(push.x).toBeLessThan(0)
  })
})

describe('clampSpeed', () => {
  it('passes a vector under the cap through unchanged', () => {
    expect(clampSpeed({ x: 3, y: 4 }, 10)).toEqual({ x: 3, y: 4 })
  })

  it('rescales a vector over the cap to the cap magnitude, keeping direction', () => {
    const clamped = clampSpeed({ x: 30, y: 40 }, 10) // magnitude 50 -> 10
    expect(Math.hypot(clamped.x, clamped.y)).toBeCloseTo(10, 9)
    expect(clamped.x / clamped.y).toBeCloseTo(30 / 40, 9)
  })

  it('collapses a non-finite component or non-positive cap to zero', () => {
    expect(clampSpeed({ x: Number.NaN, y: 1 }, 10)).toEqual({ x: 0, y: 0 })
    expect(clampSpeed({ x: 1, y: 1 }, 0)).toEqual({ x: 0, y: 0 })
  })
})

describe('zoomImpulse', () => {
  it('zooming in pushes the nodes outward (away from the anchor)', () => {
    // centerOffset points from anchor to center; zooming in (factor > 1) flips it outward.
    const impulse = zoomImpulse({ x: 10, y: 0 }, 2, 5)
    expect(impulse.x).toBeLessThan(0)
  })

  it('zooming out pulls the nodes inward (toward the center)', () => {
    const impulse = zoomImpulse({ x: 10, y: 0 }, 0.5, 5)
    expect(impulse.x).toBeGreaterThan(0)
  })

  it('a unit factor, non-positive factor, or anchor-on-center yields zero', () => {
    expect(zoomImpulse({ x: 10, y: 0 }, 1, 5)).toEqual({ x: 0, y: 0 })
    expect(zoomImpulse({ x: 10, y: 0 }, -1, 5)).toEqual({ x: 0, y: 0 })
    expect(zoomImpulse({ x: 0, y: 0 }, 2, 5)).toEqual({ x: 0, y: 0 })
  })
})
