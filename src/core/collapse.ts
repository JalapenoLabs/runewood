// Copyright © 2026 Jalapeno Labs

import type { TreeNode } from './tree'

/**
 * Path-compression of the forest for display, in the spirit of Gource: a long
 * line of lonely "pass-through" directories (each a directory with exactly one
 * child, e.g. `docs/helpers/cmd/routes/http/pkg/parser.mdx` where only `docs` and
 * the leaf carry meaning) is collapsed so only the *visible* nodes are drawn. The
 * collapsed intermediates get no node, no spring position, and no label; one edge
 * spans the gap from each visible node to its nearest visible ancestor.
 *
 * This is purely a display transform: the underlying {@link TreeNode} tree is left
 * intact (full paths preserved for picking, beams, and identity). Both the layout
 * and the scene/labels consume {@link collapseTree} so they agree on exactly which
 * nodes are visible and how the visible ones connect.
 */

/**
 * One node that survives the display collapse, paired with the path of the
 * visible node it should hang off of (its display-parent). The `node` is the real
 * {@link TreeNode}, so its `path` is the genuine, full slash-joined path used for
 * picking and beams; `displayParentPath` is the path of the *nearest visible
 * ancestor*, which may skip several collapsed intermediates.
 *
 * A repo root's display-parent is the empty string (the undrawn forest center),
 * exactly as before, so the collapse never changes how roots connect.
 */
export type VisibleNode = {
  /** The real tree node. Its `path` is the full, genuine path (never a collapsed one). */
  node: TreeNode
  /** Path of the nearest visible ancestor; `''` for a repo root hanging off the forest center. */
  displayParentPath: string
  /**
   * The node's *visible* depth: how many visible ancestors sit above it, so a repo
   * root is depth 1 regardless of how many collapsed intermediates were skipped to
   * reach a deep leaf. The radial layout rings off this, and the scene styles each
   * branch by it, so a collapsed chain never flings a leaf many rings out.
   */
  depth: number
}

/**
 * Whether a directory is a collapsed pass-through: a non-root directory with
 * exactly one child. Such a node carries no information a viewer needs (it neither
 * branches nor terminates), so it is skipped in the display and its child connects
 * straight to its own nearest visible ancestor.
 *
 * Files are never collapsed (they are the leaves the viewer is looking for), and a
 * repo root (a depth-1 directory, no slash in its path) is always kept so the
 * forest's trunks stay anchored even when a repo happens to hold a single child.
 */
function isCollapsedPassThrough(node: TreeNode): boolean {
  if (node.isFile) {
    return false
  }
  const isRepoRoot = !node.path.includes('/')
  if (isRepoRoot) {
    return false
  }
  return node.children.size === 1
}

/**
 * Walks the tree and yields every *visible* node (skipping collapsed pass-through
 * directories) paired with its nearest visible ancestor. The forest root itself is
 * not drawn, so it is never yielded; it only seeds the walk and serves as the
 * empty-string display-parent its repo-root children connect to.
 *
 * The result is a pure function of the tree's shape alone: identical structure
 * yields the same visible set and display-parents, with no reads of time or
 * randomness, so it stays compatible with the engine's seek-exact contract.
 */
export function collapseTree(tree: TreeNode): VisibleNode[] {
  const visible: VisibleNode[] = []
  // The forest root is the depth-0 nearest visible ancestor of the repo roots, so
  // they come out at the intended visible depth 1.
  visit(tree, '', 0, visible)
  return visible
}

/**
 * Recurses into `node`'s children. `nearestVisibleAncestorPath` is the path of the
 * closest already-visible ancestor (the empty string at the forest root) and
 * `visibleDepth` is how many visible ancestors sit above the children being
 * visited. A child that is a collapsed pass-through is not emitted and does not
 * become an ancestor: its descendants keep pointing at the same nearest visible
 * ancestor at the same depth, so the chain is skipped over in one hop. A visible
 * child is emitted hanging off the current nearest visible ancestor and then
 * becomes the ancestor (one depth deeper) for its own subtree.
 */
function visit(
  node: TreeNode,
  nearestVisibleAncestorPath: string,
  visibleDepth: number,
  visible: VisibleNode[],
): void {
  for (const child of node.children.values()) {
    if (isCollapsedPassThrough(child)) {
      // Skip the lonely directory: its single child (and everything below) connects
      // to the same nearest visible ancestor at the same depth, so the collapsed run
      // is spanned by one edge rather than rendered as a line of single-child nodes.
      visit(child, nearestVisibleAncestorPath, visibleDepth, visible)
      continue
    }
    const childDepth = visibleDepth + 1
    visible.push({ node: child, displayParentPath: nearestVisibleAncestorPath, depth: childDepth })
    // The child is itself visible, so it is the nearest visible ancestor (one ring
    // deeper) for its subtree.
    visit(child, child.path, childDepth, visible)
  }
}
