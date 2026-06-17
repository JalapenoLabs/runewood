// Copyright © 2026 Jalapeno Labs

import type { Texture } from 'pixi.js'

// Core
import { Assets } from 'pixi.js'

/**
 * The load state of one avatar URL in the {@link AvatarTextureCache}: it is loading
 * (no texture yet, draw the fallback), it loaded (a usable {@link Texture}), or it
 * failed (do not retry, draw the fallback forever). Keeping the three apart lets the
 * cache answer {@link AvatarTextureCache.get} synchronously every frame without
 * re-kicking a load or re-logging a failure.
 */
type AvatarEntry =
  | { status: 'loading' }
  | { status: 'loaded', texture: Texture }
  | { status: 'failed' }

/**
 * A small lazy, URL-keyed cache of avatar {@link Texture}s for the actor draw. The
 * render layer asks it for a URL's texture every frame via {@link get}; the FIRST
 * ask kicks off an async pixi load (`Assets.load`) and returns `null` (so the draw
 * uses the colored-orb fallback meanwhile), and once the load resolves, the very
 * next frame's {@link get} returns the ready texture, so the avatar swaps in the
 * frame it finishes. A failed load is remembered as failed so it is never retried
 * and the actor keeps its fallback gracefully (no throw, one debug log).
 *
 * Why a dedicated cache and not loading per actor: several actors can share one URL
 * (a default agent icon), and the same actor is drawn every frame, so keying by URL
 * means one network/decode per distinct image for the whole forest's life. The
 * texture is decoded once and the GPU upload is reused by every sprite that samples
 * it.
 *
 * It deliberately holds NO pixi sprite or actor state, only `url -> Texture`, so the
 * lookup logic ({@link has}, the {@link size}) is testable and the sprite +
 * circular-mask drawing stays in the beam scene. Pixi's `Assets` is the one async
 * boundary; the rest is a plain map.
 */
export class AvatarTextureCache {
  /** The load state per distinct avatar URL. Entries are never removed (a URL's image is stable). */
  private readonly entries = new Map<string, AvatarEntry>()

  /**
   * The ready texture for `url`, or `null` while it is still loading, has failed, or
   * has never been asked for. The first call for a URL starts the async load (and
   * returns `null`); later calls return the texture the frame after it resolves. A
   * falsy / empty URL is ignored (returns `null`) rather than loading a blank.
   */
  public get(url: string): Texture | null {
    if (!url) {
      return null
    }

    const entry = this.entries.get(url)
    if (entry) {
      return entry.status === 'loaded' ? entry.texture : null
    }

    // First sighting of this URL: mark it loading so the next frames use the fallback
    // and we never double-load, then kick the async pixi load. The handlers below mutate
    // the same map entry, so the next `get` after the load resolves returns the texture.
    this.entries.set(url, { status: 'loading' })
    Assets
      .load<Texture>(url)
      .then((texture) => {
        this.entries.set(url, { status: 'loaded', texture })
      })
      .catch((error: unknown) => {
        // A bad / unreachable image must never throw out of the render loop: remember it
        // as failed (so it is not retried) and keep the colored-orb fallback. One debug
        // line so a host can see why an avatar never appeared, per the no-silent-failure rule.
        console.debug('runewood: avatar image failed to load, falling back to the colored orb', { url, error })
        this.entries.set(url, { status: 'failed' })
      })
    return null
  }

  /** Whether a URL has been seen by {@link get} (loading, loaded, or failed). For tests / introspection. */
  public has(url: string): boolean {
    return this.entries.has(url)
  }

  /** How many distinct URLs the cache is tracking. For tests / introspection. */
  public get size(): number {
    return this.entries.size
  }
}
