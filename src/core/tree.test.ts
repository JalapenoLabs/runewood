// Copyright © 2026 Jalapeno Labs

import type { RunewoodEvent } from '../types'

// Core
import { describe, expect, it } from 'vitest'

import { applyEvent, createTree, seedTree } from './tree'

function event(overrides: Partial<RunewoodEvent>): RunewoodEvent {
  return {
    at: 1000,
    actor: 'agent-1',
    action: 'modify',
    path: 'repo/src/main.rs',
    ...overrides,
  }
}

describe('applyEvent', () => {
  it('creates intermediate directories on the way to a file', () => {
    const root = createTree()
    const { node } = applyEvent(root, event({ action: 'create' }))

    expect(node?.path).toBe('repo/src/main.rs')
    expect(node?.isFile).toBe(true)

    const repo = root.children.get('repo')
    const src = repo?.children.get('src')
    expect(repo?.isFile).toBe(false)
    expect(src?.isFile).toBe(false)
    expect(src?.children.get('main.rs')).toBe(node)
  })

  it('bumps touch count and timestamp on every hit', () => {
    const root = createTree()
    applyEvent(root, event({ at: 1000 }))
    const { node } = applyEvent(root, event({ at: 2000 }))

    expect(node?.touchCount).toBe(2)
    expect(node?.lastTouchedAt).toBe(2000)
  })

  it('marks a deleted directory and its whole subtree deleted', () => {
    const root = createTree()
    applyEvent(root, event({ path: 'repo/src/a.ts' }))
    applyEvent(root, event({ path: 'repo/src/b.ts' }))

    const { node: deleted } = applyEvent(root, event({ action: 'delete', path: 'repo/src' }))

    expect(deleted?.status).toBe('deleted')
    expect(deleted?.children.get('a.ts')?.status).toBe('deleted')
    expect(deleted?.children.get('b.ts')?.status).toBe('deleted')
  })

  it('resurrects a deleted file when it is created again', () => {
    const root = createTree()
    applyEvent(root, event({ action: 'create' }))
    applyEvent(root, event({ action: 'delete' }))
    const { node } = applyEvent(root, event({ action: 'create' }))

    expect(node?.status).toBe('discovered')
  })

  it('does not resurrect a deleted file on a mere scan', () => {
    const root = createTree()
    applyEvent(root, event({ action: 'create' }))
    applyEvent(root, event({ action: 'delete' }))
    const { node } = applyEvent(root, event({ action: 'scan' }))

    expect(node?.status).toBe('deleted')
  })

  it('reveals a seeded node when an event touches it', () => {
    const root = createTree()
    seedTree(root, [ 'repo/src/main.rs' ])

    const before = root.children.get('repo')?.children.get('src')?.children.get('main.rs')
    expect(before?.status).toBe('seeded')

    const { node } = applyEvent(root, event({ action: 'scan' }))
    expect(node?.status).toBe('discovered')
    expect(node).toBe(before)
  })

  it('ignores pulse events and pathless events without touching the tree', () => {
    const root = createTree()
    expect(applyEvent(root, event({ action: 'pulse', path: undefined })).node).toBeNull()
    expect(applyEvent(root, event({ path: '   ' })).node).toBeNull()
    expect(root.children.size).toBe(0)
  })

  it('is a deterministic fold: replaying the same log yields the same tree', () => {
    const log: RunewoodEvent[] = [
      event({ at: 1, action: 'create', path: 'repo/a.ts' }),
      event({ at: 2, action: 'modify', path: 'repo/a.ts' }),
      event({ at: 3, action: 'create', path: 'repo/lib/b.ts' }),
      event({ at: 4, action: 'delete', path: 'repo/a.ts' }),
    ]

    const first = createTree()
    const second = createTree()
    for (const entry of log) {
      applyEvent(first, entry)
    }
    for (const entry of log) {
      applyEvent(second, entry)
    }

    expect(first).toEqual(second)
    expect(first.children.get('repo')?.children.get('a.ts')?.status).toBe('deleted')
    expect(first.children.get('repo')?.children.get('lib')?.children.get('b.ts')?.status).toBe('discovered')
  })
})

describe('applyEvent structural-change signal', () => {
  it('reports created when an event reaches a brand-new node', () => {
    const root = createTree()
    const { created } = applyEvent(root, event({ action: 'create', path: 'repo/a.ts' }))
    expect(created).toBe(true)
  })

  it('reports created when only some intermediate directories already exist', () => {
    const root = createTree()
    // First event builds repo/ and repo/src/ and the file.
    applyEvent(root, event({ action: 'create', path: 'repo/src/a.ts' }))
    // A sibling under the existing repo/src still adds a new leaf, so it is created.
    const { created } = applyEvent(root, event({ action: 'create', path: 'repo/src/b.ts' }))
    expect(created).toBe(true)
  })

  it('does not report created when re-touching an existing node', () => {
    const root = createTree()
    applyEvent(root, event({ action: 'create', path: 'repo/a.ts' }))

    const modified = applyEvent(root, event({ action: 'modify', path: 'repo/a.ts' }))
    expect(modified.created).toBe(false)

    const scanned = applyEvent(root, event({ action: 'scan', path: 'repo/a.ts' }))
    expect(scanned.created).toBe(false)
  })

  it('does not report created when deleting an existing node (delete retains the node)', () => {
    const root = createTree()
    applyEvent(root, event({ action: 'create', path: 'repo/a.ts' }))

    const deleted = applyEvent(root, event({ action: 'delete', path: 'repo/a.ts' }))
    // The node is retained for the fade, so a delete never changes the structure
    // the layout depends on: created must be false.
    expect(deleted.created).toBe(false)
  })

  it('never reports created for a pulse or pathless event', () => {
    const root = createTree()
    expect(applyEvent(root, event({ action: 'pulse', path: undefined })).created).toBe(false)
    expect(applyEvent(root, event({ path: '   ' })).created).toBe(false)
  })
})

describe('seedTree', () => {
  it('creates dim structure without touch counts', () => {
    const root = createTree()
    seedTree(root, [ 'repo/src/main.rs', 'repo/README.md' ])

    const main = root.children.get('repo')?.children.get('src')?.children.get('main.rs')
    expect(main?.status).toBe('seeded')
    expect(main?.touchCount).toBe(0)
    expect(main?.lastTouchedAt).toBeNull()
  })
})
