// Copyright © 2026 Jalapeno Labs

import type { RunewoodAction } from '../types'

// Core
import { describe, expect, it } from 'vitest'

import { hslToRgbInt } from './color'
import { beamActionColor } from './beamColor'

/** Splits a packed `0xRRGGBB` integer into its 0..255 channels for assertions. */
function channels(rgb: number) {
  return {
    red: (rgb >> 16) & 0xff,
    green: (rgb >> 8) & 0xff,
    blue: rgb & 0xff,
  }
}

describe('beamActionColor', () => {
  it('colors create, modify, delete, scan, and pulse with distinct hues', () => {
    const actions: RunewoodAction[] = [ 'create', 'modify', 'delete', 'scan', 'pulse' ]
    const hues = actions.map((action) => beamActionColor(action).h)

    // Every action reads as its own intent color; none collide.
    expect(new Set(hues).size).toBe(actions.length)
  })

  it('maps create to Gource green, delete to Gource red, modify to a warm amber', () => {
    // Gource's add beam is green (0,1,0): the dominant channel of the create color is green.
    const create = channels(hslToRgbInt(beamActionColor('create')))
    expect(create.green).toBeGreaterThan(create.red)
    expect(create.green).toBeGreaterThan(create.blue)

    // Gource's remove beam is red (1,0,0): the dominant channel of the delete color is red.
    const del = channels(hslToRgbInt(beamActionColor('delete')))
    expect(del.red).toBeGreaterThan(del.green)
    expect(del.red).toBeGreaterThan(del.blue)

    // Gource's modify beam is warm amber (1,0.7,0.3): red-leaning warm, red over blue.
    const modify = channels(hslToRgbInt(beamActionColor('modify')))
    expect(modify.red).toBeGreaterThan(modify.blue)
    expect(modify.green).toBeGreaterThan(modify.blue)
  })

  it('maps scan to a cool color (more blue than red) so a read reads distinct from a mutate', () => {
    // scan is runewood's cyan addition: cool, clear of the warm create/modify/delete hues.
    const scan = channels(hslToRgbInt(beamActionColor('scan')))
    expect(scan.blue).toBeGreaterThan(scan.red)
  })

  it('renders every action color vivid (high saturation, mid lightness), not washed out', () => {
    const actions: RunewoodAction[] = [ 'create', 'modify', 'delete', 'scan', 'pulse' ]
    for (const action of actions) {
      const color = beamActionColor(action)
      expect(color.s).toBeGreaterThan(0.6)
      expect(color.l).toBeGreaterThan(0.3)
      expect(color.l).toBeLessThan(0.7)
    }
  })

  it('is pure: the same action always yields the identical color', () => {
    expect(beamActionColor('modify')).toEqual(beamActionColor('modify'))
    expect(beamActionColor('create')).toEqual(beamActionColor('create'))
  })
})
