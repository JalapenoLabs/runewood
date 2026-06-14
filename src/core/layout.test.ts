// Copyright © 2026 Jalapeno Labs

import type { RunewoodEvent } from '../types'
import type { SpringState, Vec2 } from './layout'

// Core
import { describe, expect, it } from 'vitest'

import { applyEvent, createTree } from './tree'
import { computeTargets, nodeHeat, stepSprings } from './layout'

/**
 * Builds a folded tree from a list of paths by replaying a `create` event for
 * each, mirroring how the real engine grows a tree. Returns the forest root.
 */
function treeFromPaths(paths: string[]): ReturnType<typeof createTree> {
  const root = createTree()
  for (const [ index, path ] of paths.entries()) {
    const event: RunewoodEvent = {
      at: 1000 + index,
      actor: 'agent-1',
      action: 'create',
      path,
    }
    applyEvent(root, event)
  }
  return root
}

function distance(left: Vec2, right: Vec2): number {
  return Math.hypot(left.x - right.x, left.y - right.y)
}

/** Angle of a point about the forest center (the origin in these tests). */
function angleOf(point: Vec2): number {
  return Math.atan2(point.y, point.x)
}

/** Smallest absolute difference between two angles, accounting for wraparound. */
function angularDistance(first: number, second: number): number {
  let delta = Math.abs(first - second) % (Math.PI * 2)
  if (delta > Math.PI) {
    delta = Math.PI * 2 - delta
  }
  return delta
}

describe('computeTargets', () => {
  it('is deterministic: the same tree yields identical targets', () => {
    const paths = [ 'repo/src/main.rs', 'repo/src/lib.rs', 'repo/README.md', 'other/index.ts' ]
    const first = computeTargets(treeFromPaths(paths))
    const second = computeTargets(treeFromPaths(paths))

    expect(first.size).toBe(second.size)
    for (const [ path, position ] of first) {
      expect(second.get(path)).toEqual(position)
    }
  })

  it('is independent of the order paths were ingested', () => {
    const forward = computeTargets(treeFromPaths([ 'repo/a.ts', 'repo/b.ts', 'repo/c.ts' ]))
    const shuffled = computeTargets(treeFromPaths([ 'repo/c.ts', 'repo/a.ts', 'repo/b.ts' ]))

    for (const [ path, position ] of forward) {
      expect(shuffled.get(path)).toEqual(position)
    }
  })

  it('places every visible node (plus the forest root), collapsing single-child dirs', () => {
    const targets = computeTargets(treeFromPaths([ 'repo/src/main.rs' ]))

    // forest root '', 'repo' (root), 'repo/src/main.rs' (leaf). `repo/src` is a
    // single-child pass-through directory: it is collapsed away and gets no target.
    expect(targets.has('')).toBe(true)
    expect(targets.has('repo')).toBe(true)
    expect(targets.has('repo/src/main.rs')).toBe(true)
    expect(targets.has('repo/src')).toBe(false)
  })

  it('keeps a multi-child intermediate directory placed (it is not collapsed)', () => {
    // With two children, `repo/src` is a real branch and must get a target.
    const targets = computeTargets(treeFromPaths([ 'repo/src/a.rs', 'repo/src/b.rs' ]))
    expect(targets.has('repo/src')).toBe(true)
    expect(targets.has('repo/src/a.rs')).toBe(true)
    expect(targets.has('repo/src/b.rs')).toBe(true)
  })

  it('pushes each visible depth one ring further from the center', () => {
    // `repo/src` has two children so it stays visible; depth grows ring by ring.
    const targets = computeTargets(treeFromPaths([ 'repo/src/a.rs', 'repo/src/b.rs' ]), { jitter: 0 })
    const center = targets.get('')!

    const repoRadius = distance(targets.get('repo')!, center)
    const srcRadius = distance(targets.get('repo/src')!, center)
    const fileRadius = distance(targets.get('repo/src/a.rs')!, center)

    expect(srcRadius).toBeGreaterThan(repoRadius)
    expect(fileRadius).toBeGreaterThan(srcRadius)
  })

  it('does not fling a leaf below a collapsed chain out past a real sibling depth', () => {
    // `docs` has two children; the deep leaf hangs directly off `docs` (its nearest
    // visible ancestor), so it lands one ring out from `docs`, exactly like the
    // shallow sibling, rather than seven rings out for its seven real segments.
    const targets = computeTargets(
      treeFromPaths([
        'docs/helpers/cmd/routes/http/pkg/parser.mdx',
        'docs/guide.mdx',
      ]),
      { jitter: 0 },
    )
    const center = targets.get('')!

    // The collapsed intermediates have no target at all.
    expect(targets.has('docs/helpers')).toBe(false)
    expect(targets.has('docs/helpers/cmd/routes/http/pkg')).toBe(false)

    const shallowRadius = distance(targets.get('docs/guide.mdx')!, center)
    const deepRadius = distance(targets.get('docs/helpers/cmd/routes/http/pkg/parser.mdx')!, center)
    // Both leaves sit on the same ring (one out from `docs`), so their radii match.
    expect(deepRadius).toBeCloseTo(shallowRadius, 6)
  })

  it('keeps each file within its own repo wedge, not a sibling repo wedge', () => {
    // The defining property of the tidy-tree: a node lives inside its parent's
    // angular slice. With several repo roots each owning a distinct wedge, every
    // file must sit angularly closer to its own repo root than to any other root.
    const targets = computeTargets(
      treeFromPaths([
        'alpha/a.ts', 'alpha/b.ts', 'alpha/c.ts',
        'beta/d.ts', 'beta/e.ts',
        'gamma/f.ts', 'gamma/g.ts',
      ]),
      { jitter: 0 },
    )

    const rootAngles = {
      alpha: angleOf(targets.get('alpha')!),
      beta: angleOf(targets.get('beta')!),
      gamma: angleOf(targets.get('gamma')!),
    }

    const filesByRoot = {
      alpha: [ 'alpha/a.ts', 'alpha/b.ts', 'alpha/c.ts' ],
      beta: [ 'beta/d.ts', 'beta/e.ts' ],
      gamma: [ 'gamma/f.ts', 'gamma/g.ts' ],
    }

    for (const [ ownRoot, files ] of Object.entries(filesByRoot)) {
      for (const file of files) {
        const fileAngle = angleOf(targets.get(file)!)
        const distanceToOwnRoot = angularDistance(fileAngle, rootAngles[ownRoot as keyof typeof rootAngles])

        for (const [ otherRoot, otherAngle ] of Object.entries(rootAngles)) {
          if (otherRoot === ownRoot) {
            continue
          }
          expect(distanceToOwnRoot).toBeLessThan(angularDistance(fileAngle, otherAngle))
        }
      }
    }
  })

  it('grows a lone-directory chain straight outward (the leaf inherits the root angle)', () => {
    // The whole single-child chain `deep/nested` collapses away; only the repo root
    // and the leaf remain, and the lone-child leaf inherits the parent's angle so it
    // grows straight outward rather than drifting.
    const targets = computeTargets(treeFromPaths([ 'repo/deep/nested/file.ts' ]), { jitter: 0 })

    expect(targets.has('repo/deep')).toBe(false)
    expect(targets.has('repo/deep/nested')).toBe(false)

    const repoAngle = angleOf(targets.get('repo')!)
    expect(angleOf(targets.get('repo/deep/nested/file.ts')!)).toBeCloseTo(repoAngle, 9)
  })

  it('derives jitter from the path hash, not randomness (stable but nonzero)', () => {
    const withJitter = computeTargets(treeFromPaths([ 'repo/a.ts', 'repo/b.ts' ]), { jitter: 10 })
    const withoutJitter = computeTargets(treeFromPaths([ 'repo/a.ts', 'repo/b.ts' ]), { jitter: 0 })

    // Jitter actually moved at least one node off its perfect-ring position.
    const moved = distance(withJitter.get('repo/a.ts')!, withoutJitter.get('repo/a.ts')!)
    expect(moved).toBeGreaterThan(0)

    // And it is reproducible: the same jittered layout twice is identical.
    const again = computeTargets(treeFromPaths([ 'repo/a.ts', 'repo/b.ts' ]), { jitter: 10 })
    expect(again.get('repo/a.ts')).toEqual(withJitter.get('repo/a.ts'))
  })

  it('spreads multiple repo roots around the forest center', () => {
    const targets = computeTargets(
      treeFromPaths([ 'alpha/file.ts', 'beta/file.ts', 'gamma/file.ts' ]),
      { jitter: 0 },
    )

    const alpha = angleOf(targets.get('alpha')!)
    const beta = angleOf(targets.get('beta')!)
    const gamma = angleOf(targets.get('gamma')!)

    // No two repo roots share an angle.
    expect(angularDistance(alpha, beta)).toBeGreaterThan(0.1)
    expect(angularDistance(beta, gamma)).toBeGreaterThan(0.1)
    expect(angularDistance(alpha, gamma)).toBeGreaterThan(0.1)
  })

  describe('with the forest root visible (rootLabel / Part A)', () => {
    it('places the root at the center and the repos one ring out from it', () => {
      const targets = computeTargets(
        treeFromPaths([ 'api/main.rs', 'docs/guide.md' ]),
        { jitter: 0, rootVisible: true },
      )

      // The root sits at the center (the default origin).
      expect(targets.get('')).toEqual({ x: 0, y: 0 })

      const center = targets.get('')!
      const apiRadius = distance(targets.get('api')!, center)
      const docsRadius = distance(targets.get('docs')!, center)
      // Both repos are on the first ring out from the shared root (depth 1).
      expect(apiRadius).toBeGreaterThan(0)
      expect(apiRadius).toBeCloseTo(docsRadius, 6)
    })

    it('does not change where any node is placed compared to the no-root layout', () => {
      // The root is drawn vs not, but the radial placement of every repo and file is
      // identical: the option only governs whether the center is yielded for drawing,
      // since the layout already positions the root at the center either way.
      const paths = [ 'api/src/a.rs', 'api/src/b.rs', 'docs/guide.md', 'frontend/app.ts' ]
      const withoutRoot = computeTargets(treeFromPaths(paths), { jitter: 0 })
      const withRoot = computeTargets(treeFromPaths(paths), { jitter: 0, rootVisible: true })

      for (const [ path, position ] of withoutRoot) {
        expect(withRoot.get(path)).toEqual(position)
      }
      // And the root center is present in both (the layout always seeds it).
      expect(withRoot.get('')).toEqual(withoutRoot.get(''))
    })
  })
})

describe('stepSprings', () => {
  it('monotonically reduces distance to a static target over steps', () => {
    const targets = new Map<string, Vec2>([[ 'repo/a.ts', { x: 100, y: 50 }]])
    const state: SpringState = new Map([
      [ 'repo/a.ts', { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }}],
    ])

    let previousDistance = distance(state.get('repo/a.ts')!.position, targets.get('repo/a.ts')!)
    for (let step = 0; step < 200; step++) {
      stepSprings(state, targets, 16, { stiffness: 80, damping: 18 })
      const currentDistance = distance(state.get('repo/a.ts')!.position, targets.get('repo/a.ts')!)
      // Critically damped: never overshoots, so distance is non-increasing.
      expect(currentDistance).toBeLessThanOrEqual(previousDistance + 1e-9)
      previousDistance = currentDistance
    }

    // And it actually arrives, not merely stops moving short of the target.
    expect(previousDistance).toBeLessThan(0.5)
  })

  it('spawns a new node at its parent current position', () => {
    const state: SpringState = new Map([
      [ 'repo', { position: { x: 40, y: 60 }, velocity: { x: 0, y: 0 }}],
    ])
    const targets = new Map<string, Vec2>([
      [ 'repo', { x: 40, y: 60 }],
      [ 'repo/new.ts', { x: 200, y: 200 }],
    ])

    stepSprings(state, targets, 16)

    // The child must have appeared exactly where its parent currently is, not at
    // its own faraway target and not at the origin.
    const child = state.get('repo/new.ts')!
    expect(child.position).toEqual({ x: 40, y: 60 })
    expect(child.velocity).toEqual({ x: 0, y: 0 })
  })

  it('falls back to the target when a new node has no tracked parent', () => {
    const state: SpringState = new Map()
    const targets = new Map<string, Vec2>([[ 'repo', { x: 10, y: 20 }]])

    stepSprings(state, targets, 16)

    // A top-level repo root has no drawn parent, so it spawns at its own target.
    expect(state.get('repo')!.position).toEqual({ x: 10, y: 20 })
  })

  it('retains a deleted node (target gone) so the renderer can fade it', () => {
    const state: SpringState = new Map([
      [ 'repo/gone.ts', { position: { x: 70, y: 30 }, velocity: { x: 0, y: 0 }}],
    ])
    const emptyTargets = new Map<string, Vec2>()

    stepSprings(state, emptyTargets, 16)

    expect(state.has('repo/gone.ts')).toBe(true)
    expect(state.get('repo/gone.ts')!.position).toEqual({ x: 70, y: 30 })
  })

  it('leaves state untouched on an invalid delta', () => {
    const state: SpringState = new Map([
      [ 'repo/a.ts', { position: { x: 5, y: 5 }, velocity: { x: 1, y: 1 }}],
    ])
    const targets = new Map<string, Vec2>([[ 'repo/a.ts', { x: 100, y: 100 }]])

    stepSprings(state, targets, -16)

    expect(state.get('repo/a.ts')!.position).toEqual({ x: 5, y: 5 })
    expect(state.get('repo/a.ts')!.velocity).toEqual({ x: 1, y: 1 })
  })
})

describe('nodeHeat', () => {
  it('grows heat (for glow/brightness) with touch count', () => {
    const root = createTree()
    applyEvent(root, { at: 1000, actor: 'a', action: 'modify', path: 'repo/cold.ts' })
    for (let touch = 0; touch < 20; touch++) {
      applyEvent(root, { at: 1000 + touch, actor: 'a', action: 'modify', path: 'repo/hot.ts' })
    }

    const cold = root.children.get('repo')!.children.get('cold.ts')!
    const hot = root.children.get('repo')!.children.get('hot.ts')!

    const coldHeat = nodeHeat(cold, 1100)
    const hotHeat = nodeHeat(hot, 1100)

    // Heat (which drives the glow + brightness) still rises with activity.
    expect(hotHeat.heat).toBeGreaterThan(coldHeat.heat)
  })

  it('does NOT keep growing the baseline radius with cumulative touch count', () => {
    // The fix for "each modification permanently grows the node": the baseline size
    // is bounded by a *saturating* importance bump, never a runaway cumulative swell.
    // Two heavily-touched nodes, one edited 5x as much as the other, rest at nearly
    // the same size because the bump has plateaued.
    const root = createTree()
    for (let touch = 0; touch < 20; touch++) {
      applyEvent(root, { at: 1000 + touch, actor: 'a', action: 'modify', path: 'repo/busy.ts' })
    }
    for (let touch = 0; touch < 100; touch++) {
      applyEvent(root, { at: 1000 + touch, actor: 'a', action: 'modify', path: 'repo/frantic.ts' })
    }

    const busy = root.children.get('repo')!.children.get('busy.ts')!
    const frantic = root.children.get('repo')!.children.get('frantic.ts')!

    const busyRadius = nodeHeat(busy, 1200).radius
    const franticRadius = nodeHeat(frantic, 1200).radius

    // 5x the edits past the knee changes the resting size by a hair: the bump has
    // saturated, so the radius is not a cumulative function of touch count. And the
    // total bump over a never-touched node is hard-capped at the importance bump.
    expect(Math.abs(franticRadius - busyRadius)).toBeLessThan(0.5)
    const baseline = nodeHeat(createTree(), 1200).radius
    expect(franticRadius - baseline).toBeLessThanOrEqual(5)
  })

  it('cools off as time passes since the last touch', () => {
    const root = createTree()
    applyEvent(root, { at: 1000, actor: 'a', action: 'modify', path: 'repo/file.ts' })
    const node = root.children.get('repo')!.children.get('file.ts')!

    const justTouched = nodeHeat(node, 1000, { coolingMs: 10_000 })
    const longCold = nodeHeat(node, 1000 + 60_000, { coolingMs: 10_000 })

    expect(longCold.heat).toBeLessThan(justTouched.heat)
  })

  it('keeps the baseline radius steady as a node cools (only the pulse animates size)', () => {
    // The resting size must not breathe with recency; only the touch pulse (in the
    // visual model) animates it. So heat can fall while the baseline radius holds.
    const root = createTree()
    applyEvent(root, { at: 1000, actor: 'a', action: 'modify', path: 'repo/file.ts' })
    const node = root.children.get('repo')!.children.get('file.ts')!

    const justTouched = nodeHeat(node, 1000, { coolingMs: 10_000 })
    const longCold = nodeHeat(node, 1000 + 60_000, { coolingMs: 10_000 })

    expect(longCold.radius).toBeCloseTo(justTouched.radius, 9)
  })

  it('gives a never-touched node the base radius and zero heat', () => {
    const node = createTree()
    const result = nodeHeat(node, 1000, { baseRadius: 3 })

    expect(result.heat).toBe(0)
    expect(result.radius).toBe(3)
  })
})
