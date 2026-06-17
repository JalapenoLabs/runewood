// Copyright © 2026 Jalapeno Labs

/**
 * The host-supplied resolver that maps an actor id to an avatar image URL, or to
 * `null` / `undefined` for "this actor has no avatar, draw the colored orb". A data
 * URI is a valid URL, so a host with no CDN can hand back an inline image and the
 * feature still works fully offline. This is the primary, framework-agnostic way a
 * host (e.g. Seraphim's watch page) supplies agent icons; see
 * {@link import('../runewood').RunewoodOptions.resolveAvatar}.
 */
export type AvatarResolver = (actor: string) => string | null | undefined

/**
 * The pure resolution policy for an actor's avatar URL, with no pixi or DOM in
 * sight, so it is unit-testable and the render layer holds none of the precedence
 * logic. It tracks two sources and resolves them in a fixed order:
 *
 * 1. A runtime {@link setAvatar} override (the {@link import('../runewood').RunewoodController.setAvatar}
 *    method): a host that fetches an agent icon after construction sets it here, and
 *    it wins over everything. Setting it to `null` clears the actor back to the
 *    resolver / fallback (it does NOT force the colored orb; it just removes the
 *    override).
 * 2. The construction-time {@link AvatarResolver} option, consulted when there is no
 *    override.
 *
 * When neither yields a non-empty URL, {@link resolve} returns `null`, which the
 * render layer reads as "draw the colored-orb fallback". The registry holds only
 * URLs; the actual pixi texture loading + caching lives in the render layer keyed by
 * the URL this resolves to.
 */
export class AvatarRegistry {
  /**
   * Per-actor runtime overrides set via {@link setAvatar}. A present entry (even if
   * its value is `null`... see below) takes precedence over the resolver. We only
   * STORE non-null overrides: {@link setAvatar} with `null` deletes the entry so the
   * actor falls back through to the resolver rather than being pinned to "no avatar".
   */
  private readonly overrides = new Map<string, string>()

  /** The construction-time resolver option, or `undefined` when the host supplied none. */
  private readonly resolver: AvatarResolver | undefined

  constructor(resolver?: AvatarResolver) {
    this.resolver = resolver
  }

  /**
   * Sets or clears one actor's runtime avatar override (the
   * {@link import('../runewood').RunewoodController.setAvatar} method). A non-empty
   * URL pins the actor to that image, beating the {@link AvatarResolver} option;
   * `null` (or an empty string) clears the override so the actor falls back to the
   * resolver, and then to the colored orb if that yields nothing.
   */
  public setAvatar(actor: string, url: string | null): void {
    if (url) {
      this.overrides.set(actor, url)
      return
    }
    this.overrides.delete(actor)
  }

  /**
   * The resolved avatar URL for an actor, or `null` for the colored-orb fallback.
   * Precedence: a {@link setAvatar} override beats the {@link AvatarResolver} option
   * beats none. An empty string from either source is treated as "no avatar" (it is
   * not a usable image URL), so it falls through rather than loading a blank texture.
   */
  public resolve(actor: string): string | null {
    const override = this.overrides.get(actor)
    if (override) {
      return override
    }
    const resolved = this.resolver?.(actor)
    if (resolved) {
      return resolved
    }
    return null
  }
}
