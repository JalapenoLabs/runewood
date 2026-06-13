// Copyright © 2026 Jalapeno Labs

import type { RunewoodEvent } from '../types'

/**
 * How a node came to exist, which drives how it renders:
 *
 * - `seeded`: known from an upfront tree seed (e.g. `git ls-files`) but never
 *   touched by an event. Renders dim, as undiscovered structure.
 * - `discovered`: touched by at least one event. Fully lit.
 * - `deleted`: removed by a `delete` event. Kept in the tree so the renderer
 *   can fade it out instead of popping it off screen.
 */
export type NodeStatus = 'seeded' | 'discovered' | 'deleted'

export type TreeNode = {
  /** The path segment, e.g. `main.rs`. Empty string for the forest root. */
  name: string
  /** The full slash-joined path from the root, e.g. `seraphim/api/src/main.rs`. */
  path: string
  /** Files are leaves by construction; directories may gain children any time. */
  isFile: boolean
  children: Map<string, TreeNode>
  status: NodeStatus
  /** How many events have hit this exact node. Drives visual heat. */
  touchCount: number
  /** Epoch ms of the most recent event on this node, for cooldown effects. */
  lastTouchedAt: number | null
}

/**
 * The tree is rebuilt by folding the event log, so the state at any time `t`
 * is a pure function of the events with `at <= t`. That determinism is what
 * makes seeking and rewinding exact: jump to any point by re-folding.
 */
export function createTree(): TreeNode {
  return {
    name: '',
    path: '',
    isFile: false,
    children: new Map(),
    status: 'discovered',
    touchCount: 0,
    lastTouchedAt: null,
  }
}

/**
 * Pre-populates the forest with known structure (e.g. `git ls-files` output)
 * as dim, undiscovered nodes. Optional: without a seed the forest simply
 * grows fog-of-war style as events reveal it.
 */
export function seedTree(root: TreeNode, paths: string[]): void {
  for (const path of paths) {
    ensurePath(root, path, 'seeded')
  }
}

/**
 * The result of folding one event: the node it landed on (or `null` for an event
 * that does not target the tree), plus whether reaching that node *created* any
 * new node in the tree. `created` is the structural-change signal the controller
 * memoizes the radial layout on: targets depend only on which paths exist and how
 * they nest, so they need recomputing only when a fold added a node, never on a
 * mere modify/scan/delete of an existing one.
 */
export type ApplyEventResult = {
  /** The node the event landed on, or `null` for a pulse / pathless event. */
  node: TreeNode | null
  /** Whether folding this event added at least one new node to the tree. */
  created: boolean
}

/**
 * Folds one event into the tree, mutating it in place, and reports the node the
 * event landed on (so callers can aim effects at it) along with whether it added
 * any new node to the tree (so the controller can memoize the layout, recomputing
 * targets only when the structure actually changed). Returns a `null` node for
 * events that do not target the tree (`pulse`, or a missing/blank path); those
 * never create structure, so `created` is `false`.
 */
export function applyEvent(root: TreeNode, event: RunewoodEvent): ApplyEventResult {
  if (event.action === 'pulse') {
    return { node: null, created: false }
  }
  const path = event.path?.trim()
  if (!path) {
    // A tree-targeting action with no path is malformed input; flag it rather
    // than silently dropping it so host-side mapping bugs surface early.
    console.debug('runewood: dropping pathless tree event', event)
    return { node: null, created: false }
  }

  const { node, created } = ensurePath(root, path, 'discovered')
  node.touchCount += 1
  node.lastTouchedAt = event.at

  if (event.action === 'delete') {
    markDeleted(node)
  }
  else if (node.status !== 'deleted' || event.action === 'create') {
    // Re-creating a deleted file resurrects it; a scan or modify on a live
    // node keeps (or upgrades) it to discovered.
    node.status = 'discovered'
  }
  return { node, created }
}

/**
 * Walks `path` from the root, creating missing intermediate nodes, and reports
 * whether any node along the way had to be created. `created` is the structural
 * signal the layout memoization keys off: it is `true` if the target node or any
 * of its ancestors did not already exist.
 */
function ensurePath(root: TreeNode, path: string, statusForNew: NodeStatus): { node: TreeNode, created: boolean } {
  const segments = path.split('/').filter((segment) => segment.length > 0)
  let current = root
  let created = false
  for (const [ index, segment ] of segments.entries()) {
    let child = current.children.get(segment)
    if (!child) {
      child = {
        name: segment,
        path: segments.slice(0, index + 1).join('/'),
        // Only the final segment is a file; everything above it is a directory.
        isFile: index === segments.length - 1,
        children: new Map(),
        status: statusForNew,
        touchCount: 0,
        lastTouchedAt: null,
      }
      current.children.set(segment, child)
      created = true
    }
    current = child
  }
  return { node: current, created }
}

/** Deleting a directory deletes everything under it. */
function markDeleted(node: TreeNode): void {
  node.status = 'deleted'
  for (const child of node.children.values()) {
    markDeleted(child)
  }
}
