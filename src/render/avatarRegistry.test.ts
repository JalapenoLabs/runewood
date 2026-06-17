// Copyright © 2026 Jalapeno Labs

// Core
import { describe, expect, it, vi } from 'vitest'

import { AvatarRegistry } from './avatarRegistry'

/**
 * The avatar resolution precedence (issue #20): a runtime `setAvatar` override beats
 * the construction-time `resolveAvatar` resolver beats none (the colored-orb
 * fallback). This is the pure policy the render layer reads each frame, so it is the
 * piece worth unit-testing; the pixi image load + circular draw is visual and proven
 * in the playground, consistent with the rest of the render layer.
 */
describe('AvatarRegistry', () => {
  describe('resolve precedence', () => {
    it('returns null when no resolver and no override exist (the colored-orb fallback)', () => {
      const registry = new AvatarRegistry()
      expect(registry.resolve('fable')).toBeNull()
    })

    it('uses the resolver option when there is no override', () => {
      const registry = new AvatarRegistry((actor) => `https://cdn.test/${actor}.png`)
      expect(registry.resolve('fable')).toBe('https://cdn.test/fable.png')
      expect(registry.resolve('sonnet')).toBe('https://cdn.test/sonnet.png')
    })

    it('falls back to the orb when the resolver returns null or undefined for an actor', () => {
      const registry = new AvatarRegistry((actor) => (actor === 'fable' ? 'data:image/png;base64,AAAA' : null))
      expect(registry.resolve('fable')).toBe('data:image/png;base64,AAAA')
      expect(registry.resolve('sonnet')).toBeNull()
    })

    it('treats an empty-string resolver result as no avatar, not a blank image', () => {
      const registry = new AvatarRegistry(() => '')
      expect(registry.resolve('fable')).toBeNull()
    })

    it('lets a setAvatar override beat the resolver option for that actor', () => {
      const registry = new AvatarRegistry((actor) => `https://cdn.test/${actor}.png`)
      registry.setAvatar('fable', 'https://override.test/fable.png')
      // The overridden actor uses the override; an un-overridden actor still uses the resolver.
      expect(registry.resolve('fable')).toBe('https://override.test/fable.png')
      expect(registry.resolve('sonnet')).toBe('https://cdn.test/sonnet.png')
    })

    it('lets a setAvatar override supply an avatar when there is no resolver at all', () => {
      const registry = new AvatarRegistry()
      registry.setAvatar('fable', 'https://override.test/fable.png')
      expect(registry.resolve('fable')).toBe('https://override.test/fable.png')
      expect(registry.resolve('sonnet')).toBeNull()
    })
  })

  describe('setAvatar clearing', () => {
    it('clears an override back to the resolver when set to null', () => {
      const registry = new AvatarRegistry((actor) => `https://cdn.test/${actor}.png`)
      registry.setAvatar('fable', 'https://override.test/fable.png')
      expect(registry.resolve('fable')).toBe('https://override.test/fable.png')

      // Clearing the override falls back through to the resolver, NOT to "no avatar".
      registry.setAvatar('fable', null)
      expect(registry.resolve('fable')).toBe('https://cdn.test/fable.png')
    })

    it('clears an override back to the colored orb when there is no resolver', () => {
      const registry = new AvatarRegistry()
      registry.setAvatar('fable', 'https://override.test/fable.png')
      registry.setAvatar('fable', null)
      expect(registry.resolve('fable')).toBeNull()
    })

    it('treats an empty-string override the same as clearing it', () => {
      const registry = new AvatarRegistry((actor) => `https://cdn.test/${actor}.png`)
      registry.setAvatar('fable', '')
      // An empty string is not a usable URL, so it clears rather than pins; the resolver wins.
      expect(registry.resolve('fable')).toBe('https://cdn.test/fable.png')
    })

    it('lets a later override replace an earlier one', () => {
      const registry = new AvatarRegistry()
      registry.setAvatar('fable', 'https://override.test/one.png')
      registry.setAvatar('fable', 'https://override.test/two.png')
      expect(registry.resolve('fable')).toBe('https://override.test/two.png')
    })
  })

  describe('resolver invocation', () => {
    it('does not call the resolver for an actor that has an override', () => {
      const resolver = vi.fn(() => 'https://cdn.test/fable.png')
      const registry = new AvatarRegistry(resolver)
      registry.setAvatar('fable', 'https://override.test/fable.png')

      registry.resolve('fable')
      expect(resolver).not.toHaveBeenCalled()

      // It IS consulted for an un-overridden actor.
      registry.resolve('sonnet')
      expect(resolver).toHaveBeenCalledWith('sonnet')
    })
  })
})
