// Copyright © 2026 Jalapeno Labs

import type { RunewoodEvent } from '../types'

// Core
import { describe, expect, it } from 'vitest'

import { applyEvent, createTree } from './tree'
import { collapseTree } from './collapse'

/**
 * Builds a folded tree from a list of paths by replaying a `create` event for
 * each, mirroring how the real engine grows a tree. Returns the forest root. The
 * same helper the layout tests use, so both exercise the genuine tree fold.
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

/** The set of visible node paths, for asserting which nodes survived the collapse. */
function visiblePaths(tree: ReturnType<typeof createTree>): Set<string> {
  return new Set(collapseTree(tree).map((visible) => visible.node.path))
}

/** The display-parent recorded for a single visible path, asserting it exists. */
function displayParentOf(tree: ReturnType<typeof createTree>, path: string): string {
  const found = collapseTree(tree).find((visible) => visible.node.path === path)
  if (!found) {
    throw new Error(`expected '${path}' to be visible, but it was collapsed away`)
  }
  return found.displayParentPath
}

/** The visible depth recorded for a single visible path, asserting it exists. */
function depthOf(tree: ReturnType<typeof createTree>, path: string): number {
  const found = collapseTree(tree).find((visible) => visible.node.path === path)
  if (!found) {
    throw new Error(`expected '${path}' to be visible, but it was collapsed away`)
  }
  return found.depth
}

describe('collapseTree', () => {
  it('collapses a single-child directory chain to just the real branch and the leaf', () => {
    // The motivating case: `docs` has other children, but helpers/cmd/routes/http/
    // pkg are each empty single-child pass-through dirs ending in the leaf .mdx.
    const tree = treeFromPaths([
      'docs/helpers/cmd/routes/http/pkg/parser.mdx',
      'docs/guide.mdx',
    ])

    const visible = visiblePaths(tree)

    // The repo root and the two real branches it directly carries stay visible.
    expect(visible.has('docs')).toBe(true)
    expect(visible.has('docs/guide.mdx')).toBe(true)
    // The deep leaf stays visible (it is a file, never collapsed).
    expect(visible.has('docs/helpers/cmd/routes/http/pkg/parser.mdx')).toBe(true)

    // Every lonely single-child intermediate is collapsed away: no node at all.
    for (const collapsed of [
      'docs/helpers',
      'docs/helpers/cmd',
      'docs/helpers/cmd/routes',
      'docs/helpers/cmd/routes/http',
      'docs/helpers/cmd/routes/http/pkg',
    ]) {
      expect(visible.has(collapsed)).toBe(false)
    }
  })

  it('connects a collapsed leaf to its nearest visible ancestor, spanning the gap', () => {
    const tree = treeFromPaths([
      'docs/helpers/cmd/routes/http/pkg/parser.mdx',
      'docs/guide.mdx',
    ])

    // `docs` branches (it has two children), so it is the nearest visible ancestor
    // of the deep leaf; the collapsed chain between them is spanned by one edge.
    expect(displayParentOf(tree, 'docs/helpers/cmd/routes/http/pkg/parser.mdx')).toBe('docs')
  })

  it('counts only visible ancestors for depth, so a deep leaf is not flung out', () => {
    const tree = treeFromPaths([
      'docs/helpers/cmd/routes/http/pkg/parser.mdx',
      'docs/guide.mdx',
    ])

    // `docs` is a repo root at visible depth 1; the deep leaf hangs directly off it
    // (its display-parent), so despite seven real path segments it is visible depth 2.
    expect(depthOf(tree, 'docs')).toBe(1)
    expect(depthOf(tree, 'docs/guide.mdx')).toBe(2)
    expect(depthOf(tree, 'docs/helpers/cmd/routes/http/pkg/parser.mdx')).toBe(2)
  })

  it('keeps a directory with two or more children visible', () => {
    const tree = treeFromPaths([ 'repo/src/a.ts', 'repo/src/b.ts' ])

    const visible = visiblePaths(tree)
    // `repo/src` has two children, so it is a real branch and stays.
    expect(visible.has('repo/src')).toBe(true)
    expect(visible.has('repo/src/a.ts')).toBe(true)
    expect(visible.has('repo/src/b.ts')).toBe(true)
    // Both leaves hang off the visible `repo/src`.
    expect(displayParentOf(tree, 'repo/src/a.ts')).toBe('repo/src')
    expect(displayParentOf(tree, 'repo/src/b.ts')).toBe('repo/src')
  })

  it('keeps a repo root visible even when it has a single child', () => {
    // A repo root with one child is NOT collapsed: the forest trunks stay anchored.
    const tree = treeFromPaths([ 'repo/only/deep/file.ts' ])

    const visible = visiblePaths(tree)
    expect(visible.has('repo')).toBe(true)
    // The root's display-parent is the undrawn forest center (the empty string).
    expect(displayParentOf(tree, 'repo')).toBe('')
    // The single-child intermediates below it collapse away, leaving just the leaf.
    expect(visible.has('repo/only')).toBe(false)
    expect(visible.has('repo/only/deep')).toBe(false)
    expect(visible.has('repo/only/deep/file.ts')).toBe(true)
    // The leaf connects straight back to the repo root, spanning the collapsed chain.
    expect(displayParentOf(tree, 'repo/only/deep/file.ts')).toBe('repo')
  })

  it('keeps the genuine full path on every visible node (picking / beams use real paths)', () => {
    const tree = treeFromPaths([ 'repo/only/deep/file.ts' ])
    const leaf = collapseTree(tree).find((visible) => visible.node.path.endsWith('file.ts'))

    // The collapse is a display transform: the node still carries its real, full
    // path so the controller's picking, beams, and identity keep working unchanged.
    expect(leaf?.node.path).toBe('repo/only/deep/file.ts')
    expect(leaf?.node.name).toBe('file.ts')
  })

  it('never yields the undrawn forest root itself', () => {
    const tree = treeFromPaths([ 'repo/a.ts' ])
    const visible = visiblePaths(tree)
    // The forest root has an empty path and is not drawn, so it is never a visible node.
    expect(visible.has('')).toBe(false)
  })

  it('is a pure function of the tree shape (same structure, same result)', () => {
    const first = collapseTree(treeFromPaths([ 'repo/src/a.ts', 'repo/src/b.ts', 'repo/deep/only/leaf.ts' ]))
    const second = collapseTree(treeFromPaths([ 'repo/src/a.ts', 'repo/src/b.ts', 'repo/deep/only/leaf.ts' ]))

    const firstPaths = first.map((visible) => `${visible.node.path}<-${visible.displayParentPath}@${visible.depth}`)
    const secondPaths = second.map((visible) => `${visible.node.path}<-${visible.displayParentPath}@${visible.depth}`)
    expect(new Set(firstPaths)).toEqual(new Set(secondPaths))
  })

  describe('with the forest root visible (rootLabel / Part A)', () => {
    it('yields the forest root as a depth-0 center node with no display-parent', () => {
      const tree = treeFromPaths([ 'api/main.rs', 'docs/guide.md' ])
      const root = collapseTree(tree, { rootVisible: true }).find((visible) => visible.isForestRoot)

      expect(root).toBeDefined()
      expect(root?.node.path).toBe('')
      expect(root?.depth).toBe(0)
      // The center hangs off nothing; the empty display-parent here is "the center
      // itself", which the scene treats specially via `isForestRoot`.
      expect(root?.displayParentPath).toBe('')
      expect(root?.isForestRoot).toBe(true)
    })

    it('makes every repo a depth-1 child of the root (an edge root -> repo)', () => {
      const tree = treeFromPaths([ 'api/main.rs', 'docs/guide.md', 'frontend/app.ts' ])
      const visible = collapseTree(tree, { rootVisible: true })

      for (const repo of [ 'api', 'docs', 'frontend' ]) {
        const found = visible.find((entry) => entry.node.path === repo)
        if (!found) {
          throw new Error(`expected repo '${repo}' to be visible`)
        }
        expect(found.depth).toBe(1)
        // The repo's display-parent is the empty-string center, which is now the
        // DRAWN root, so the scene draws an edge from the repo to the root.
        expect(found.displayParentPath).toBe('')
        expect(found.isForestRoot).toBe(false)
      }
    })

    it('keeps the root even when the forest has a single repo (it is the shared trunk)', () => {
      const tree = treeFromPaths([ 'only/deep/file.ts' ])
      const visible = collapseTree(tree, { rootVisible: true })

      expect(visible.find((entry) => entry.isForestRoot)?.node.path).toBe('')
      // The single repo root still hangs off the drawn center at depth 1.
      const repo = visible.find((entry) => entry.node.path === 'only')
      expect(repo?.depth).toBe(1)
      expect(repo?.displayParentPath).toBe('')
    })

    it('is identical to the no-root output except for the extra root entry', () => {
      const paths = [ 'api/src/a.rs', 'api/src/b.rs', 'docs/guide.md' ]
      const withoutRoot = collapseTree(treeFromPaths(paths))
      const withRoot = collapseTree(treeFromPaths(paths), { rootVisible: true })

      // Exactly one extra entry: the forest root.
      expect(withRoot.length).toBe(withoutRoot.length + 1)
      const extras = withRoot.filter((entry) => entry.isForestRoot)
      expect(extras).toHaveLength(1)

      // Every non-root visible node is unchanged (same path, display-parent, depth).
      const key = (entry: { node: { path: string }, displayParentPath: string, depth: number }): string =>
        `${entry.node.path}<-${entry.displayParentPath}@${entry.depth}`
      const withoutKeys = new Set(withoutRoot.map(key))
      const withKeysNonRoot = new Set(withRoot.filter((entry) => !entry.isForestRoot).map(key))
      expect(withKeysNonRoot).toEqual(withoutKeys)
    })
  })

  it('never yields the forest root when rootVisible is unset (default unchanged)', () => {
    const tree = treeFromPaths([ 'repo/a.ts' ])
    const visible = collapseTree(tree)
    expect(visible.some((entry) => entry.isForestRoot)).toBe(false)
    expect(visible.some((entry) => entry.node.path === '')).toBe(false)
  })
})
