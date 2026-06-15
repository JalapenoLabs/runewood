// Copyright © 2026 Jalapeno Labs

import type { LabelCandidate } from './labels'

// Core
import { describe, expect, it } from 'vitest'

import { decideLabels } from './labels'

/** Builds a file candidate, defaulting to one freshly touched at `now = 1000`. */
function fileCandidate(overrides: Partial<LabelCandidate> = {}): LabelCandidate {
  return {
    kind: 'file',
    id: overrides.id ?? 'repo/src/main.ts',
    text: overrides.text ?? 'main.ts',
    position: overrides.position ?? { x: 0, y: 0 },
    lastTouchedAt: overrides.lastTouchedAt ?? 1000,
  }
}

/** Builds a directory-root candidate. */
function rootCandidate(overrides: Partial<LabelCandidate> = {}): LabelCandidate {
  return {
    kind: 'root',
    id: overrides.id ?? 'repo',
    text: overrides.text ?? 'repo',
    position: overrides.position ?? { x: 0, y: 0 },
  }
}

/** Builds an actor candidate, defaulting to fully present. */
function actorCandidate(overrides: Partial<LabelCandidate> = {}): LabelCandidate {
  return {
    kind: 'actor',
    id: overrides.id ?? 'agent-1',
    text: overrides.text ?? 'agent-1',
    position: overrides.position ?? { x: 0, y: 0 },
    actorAlpha: overrides.actorAlpha ?? 1,
  }
}

/** Finds the single decision for an id, asserting it exists. */
function decisionFor(decisions: ReturnType<typeof decideLabels>, id: string) {
  const found = decisions.find((decision) => decision.id === id)
  if (!found) {
    throw new Error(`no decision produced for id '${id}'`)
  }
  return found
}

describe('decideLabels', () => {
  describe('actor labels', () => {
    it('shows an active actor label and carries its presence as alpha', () => {
      const decisions = decideLabels([ actorCandidate({ actorAlpha: 0.8 }) ], 1000)
      const decision = decisionFor(decisions, 'agent-1')

      expect(decision.kind).toBe('actor')
      expect(decision.visible).toBe(true)
      expect(decision.alpha).toBeCloseTo(0.8, 5)
    })

    it('hides an actor that has fully faded out', () => {
      const decisions = decideLabels([ actorCandidate({ actorAlpha: 0 }) ], 1000)
      expect(decisionFor(decisions, 'agent-1').visible).toBe(false)
    })
  })

  describe('directory-root labels', () => {
    it('stays visible at the subtle root alpha', () => {
      const decisions = decideLabels([ rootCandidate() ], 1000, { rootAlpha: 0.45 })

      expect(decisionFor(decisions, 'repo').visible).toBe(true)
      expect(decisionFor(decisions, 'repo').alpha).toBeCloseTo(0.45, 5)
    })

    it('is subtler than a fresh file or active actor label', () => {
      const candidates = [ rootCandidate(), fileCandidate({ lastTouchedAt: 1000 }), actorCandidate() ]
      const decisions = decideLabels(candidates, 1000, { rootAlpha: 0.45 })

      const root = decisionFor(decisions, 'repo')
      const file = decisionFor(decisions, 'repo/src/main.ts')
      const actor = decisionFor(decisions, 'agent-1')

      expect(root.alpha).toBeLessThan(file.alpha)
      expect(root.alpha).toBeLessThan(actor.alpha)
    })

    it('defaults to a clearly legible (but still sub-full) opacity', () => {
      // The user found the old near-invisible root alpha unreadable. The default is
      // now high enough to read easily, while staying a touch below the full-opacity
      // file/actor flashes so roots remain the calm orientation layer.
      const decision = decisionFor(decideLabels([ rootCandidate() ], 1000), 'repo')

      expect(decision.alpha).toBeGreaterThanOrEqual(0.8)
      expect(decision.alpha).toBeLessThan(1)
    })
  })

  describe('file labels fade with the touch flash', () => {
    it('is full opacity at the instant of the touch', () => {
      const decisions = decideLabels([ fileCandidate({ lastTouchedAt: 1000 }) ], 1000, { fileFadeMs: 1200 })
      const decision = decisionFor(decisions, 'repo/src/main.ts')

      expect(decision.visible).toBe(true)
      expect(decision.alpha).toBeCloseTo(1, 5)
    })

    it('fades linearly to nothing over the fade window then hides', () => {
      const lastTouchedAt = 1000
      const fileFadeMs = 1200
      const candidate = fileCandidate({ lastTouchedAt })

      const atTouch = decideLabels([ candidate ], lastTouchedAt, { fileFadeMs })
      const midFade = decideLabels([ candidate ], lastTouchedAt + fileFadeMs / 2, { fileFadeMs })
      const afterFade = decideLabels([ candidate ], lastTouchedAt + fileFadeMs, { fileFadeMs })

      expect(decisionFor(atTouch, candidate.id).alpha).toBeCloseTo(1, 5)
      expect(decisionFor(midFade, candidate.id).alpha).toBeCloseTo(0.5, 5)
      // Past the window the label is no longer shown at all.
      expect(decisionFor(afterFade, candidate.id).visible).toBe(false)
      expect(decisionFor(afterFade, candidate.id).alpha).toBe(0)
    })

    it('does not show a file that has never been touched', () => {
      const candidate: LabelCandidate = {
        kind: 'file',
        id: 'repo/src/cold.ts',
        text: 'cold.ts',
        position: { x: 0, y: 0 },
      }
      expect(decisionFor(decideLabels([ candidate ], 1000), candidate.id).visible).toBe(false)
    })
  })

  describe('level-of-detail gates file labels by density, never by zoom', () => {
    it('culls the whole file tier when lit-label density exceeds the cap, but keeps roots and actors', () => {
      const litFiles: LabelCandidate[] = []
      for (let index = 0; index < 10; index++) {
        litFiles.push(fileCandidate({ id: `repo/src/file-${index}.ts`, text: `file-${index}.ts`, lastTouchedAt: 1000 }))
      }
      const candidates = [ ...litFiles, rootCandidate(), actorCandidate() ]

      // Cap of 5 with 10 lit files: the file tier is over budget and culled.
      const decisions = decideLabels(candidates, 1000, { fileDensityCap: 5 })

      for (const file of litFiles) {
        expect(decisionFor(decisions, file.id).visible).toBe(false)
      }
      expect(decisionFor(decisions, 'repo').visible).toBe(true)
      expect(decisionFor(decisions, 'agent-1').visible).toBe(true)
    })

    it('keeps file labels when lit density is within the cap', () => {
      const litFiles: LabelCandidate[] = []
      for (let index = 0; index < 4; index++) {
        litFiles.push(fileCandidate({ id: `repo/src/file-${index}.ts`, text: `file-${index}.ts`, lastTouchedAt: 1000 }))
      }

      const decisions = decideLabels(litFiles, 1000, { fileDensityCap: 5 })
      for (const file of litFiles) {
        expect(decisionFor(decisions, file.id).visible).toBe(true)
      }
    })

    it('counts only lit (flashing) files toward density, ignoring cold ones', () => {
      // One lit file plus many cold files: the cold files cost nothing, so the
      // single lit label survives even a tiny cap.
      const lit = fileCandidate({ id: 'repo/lit.ts', text: 'lit.ts', lastTouchedAt: 1000 })
      const cold: LabelCandidate[] = []
      for (let index = 0; index < 100; index++) {
        cold.push(fileCandidate({ id: `repo/cold-${index}.ts`, text: `cold-${index}.ts`, lastTouchedAt: -1_000_000 }))
      }

      const decisions = decideLabels([ lit, ...cold ], 1000, { fileDensityCap: 2, fileFadeMs: 1200 })
      expect(decisionFor(decisions, 'repo/lit.ts').visible).toBe(true)
    })
  })

  describe('truncation of long names', () => {
    it('truncates a long name to the max length with an ellipsis', () => {
      const longName = 'a-really-long-file-name-that-overflows.tsx'
      const candidate = fileCandidate({ id: 'repo/long', text: longName, lastTouchedAt: 1000 })

      const decision = decisionFor(decideLabels([ candidate ], 1000, { maxTextLength: 12 }), 'repo/long')

      expect(decision.text.length).toBe(12)
      expect(decision.text.endsWith('…')).toBe(true)
      expect(decision.text).toBe('a-really-lo…')
    })

    it('leaves a name within the limit untouched', () => {
      const candidate = fileCandidate({ id: 'repo/short', text: 'main.ts', lastTouchedAt: 1000 })
      const decision = decisionFor(decideLabels([ candidate ], 1000, { maxTextLength: 24 }), 'repo/short')
      expect(decision.text).toBe('main.ts')
    })

    it('truncates root and actor labels too, not just files', () => {
      const root = rootCandidate({ id: 'repo', text: 'an-extremely-long-repository-name' })
      const actor = actorCandidate({ id: 'agent', text: 'an-extremely-long-actor-identifier' })

      const decisions = decideLabels([ root, actor ], 1000, { maxTextLength: 10 })
      expect(decisionFor(decisions, 'repo').text.length).toBe(10)
      expect(decisionFor(decisions, 'agent').text.length).toBe(10)
    })
  })

  describe('determinism', () => {
    it('is a pure function of its inputs', () => {
      const candidates = [ fileCandidate(), rootCandidate(), actorCandidate() ]
      const first = decideLabels(candidates, 1200)
      const second = decideLabels(candidates, 1200)
      expect(first).toEqual(second)
    })
  })
})
