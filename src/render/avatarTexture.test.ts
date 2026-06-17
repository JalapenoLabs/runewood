// Copyright © 2026 Jalapeno Labs

import type { Texture } from 'pixi.js'

// Core
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock pixi's async asset loader so the cache's lazy load + URL keying can be tested
// without a GPU. `Assets.load` is the one async boundary the cache touches; everything
// else is a plain map. Each test controls how the load resolves/rejects via `loadMock`.
const loadMock = vi.fn()
vi.mock('pixi.js', () => ({
  Assets: {
    load: (url: string) => loadMock(url),
  },
}))

/** A throwaway stand-in for a pixi Texture; the cache only ever stores and returns it. */
function fakeTexture(): Texture {
  return { width: 64, height: 64 } as unknown as Texture
}

describe('AvatarTextureCache', () => {
  beforeEach(() => {
    loadMock.mockReset()
  })

  describe('get', () => {
    it('returns null and kicks one load on the first sighting of a URL', async () => {
      const texture = fakeTexture()
      loadMock.mockResolvedValue(texture)
      const { AvatarTextureCache } = await import('./avatarTexture')
      const cache = new AvatarTextureCache()

      // First ask: still loading, so the colored-orb fallback is used (null).
      expect(cache.get('https://cdn.test/a.png')).toBeNull()
      expect(loadMock).toHaveBeenCalledTimes(1)
      expect(loadMock).toHaveBeenCalledWith('https://cdn.test/a.png')
      expect(cache.has('https://cdn.test/a.png')).toBe(true)
    })

    it('returns the texture once the load resolves and never re-loads the same URL', async () => {
      const texture = fakeTexture()
      loadMock.mockResolvedValue(texture)
      const { AvatarTextureCache } = await import('./avatarTexture')
      const cache = new AvatarTextureCache()

      cache.get('https://cdn.test/a.png')
      // Let the mocked load's promise resolve.
      await Promise.resolve()
      await Promise.resolve()

      // The next frame's ask now returns the ready texture, and asking again is free.
      expect(cache.get('https://cdn.test/a.png')).toBe(texture)
      expect(cache.get('https://cdn.test/a.png')).toBe(texture)
      expect(loadMock).toHaveBeenCalledTimes(1)
    })

    it('keeps returning null after a failed load and does not retry', async () => {
      loadMock.mockRejectedValue(new Error('404'))
      // The cache logs one debug on failure; silence it so the test output stays clean.
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
      const { AvatarTextureCache } = await import('./avatarTexture')
      const cache = new AvatarTextureCache()

      cache.get('https://cdn.test/missing.png')
      await Promise.resolve()
      await Promise.resolve()

      // A failed URL falls back to the orb forever and is never re-loaded.
      expect(cache.get('https://cdn.test/missing.png')).toBeNull()
      expect(cache.get('https://cdn.test/missing.png')).toBeNull()
      expect(loadMock).toHaveBeenCalledTimes(1)
      expect(debugSpy).toHaveBeenCalledTimes(1)
      debugSpy.mockRestore()
    })

    it('ignores an empty URL without touching the loader', async () => {
      const { AvatarTextureCache } = await import('./avatarTexture')
      const cache = new AvatarTextureCache()
      expect(cache.get('')).toBeNull()
      expect(loadMock).not.toHaveBeenCalled()
      expect(cache.size).toBe(0)
    })

    it('caches each distinct URL separately, one load per URL', async () => {
      loadMock.mockResolvedValue(fakeTexture())
      const { AvatarTextureCache } = await import('./avatarTexture')
      const cache = new AvatarTextureCache()

      cache.get('https://cdn.test/a.png')
      cache.get('https://cdn.test/b.png')
      cache.get('https://cdn.test/a.png')

      expect(cache.size).toBe(2)
      expect(loadMock).toHaveBeenCalledTimes(2)
    })
  })
})
