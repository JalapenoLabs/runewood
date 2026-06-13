// Copyright © 2026 Jalapeno Labs

/**
 * A tiny, dependency-free typed event emitter (issue #10). The controller owns
 * one of these to let a host integrate without reaching into internals:
 * `on(event, handler)` subscribes and returns an unsubscribe function,
 * `off(event, handler)` removes a specific handler, and `emit(event, payload)`
 * (controller-only) fans a payload out to every current subscriber.
 *
 * Generic over an event-map type `Events` that maps each event name to its
 * payload type, so subscribing to the wrong event name or handling the wrong
 * payload shape is a compile error rather than a runtime surprise. We keep our
 * own rather than pull in `eventemitter3`: the surface is six events, and a
 * map-of-Sets is both smaller and exactly as much as we need.
 *
 * @typeParam Events a record mapping each event name to that event's payload type.
 */
export class Emitter<Events extends Record<string, unknown>> {
  /**
   * Subscribers keyed by event name. A `Set` (not an array) so the same handler
   * registered twice still fires once and `off` is an O(1) delete. Created lazily
   * per event name the first time something subscribes to it.
   */
  private readonly handlersByEvent = new Map<keyof Events, Set<(payload: never) => void>>()

  /**
   * Subscribe `handler` to `event` and return an unsubscribe function. Calling
   * the returned function is equivalent to `off(event, handler)`; it is
   * idempotent, so a host can call it any number of times safely.
   */
  public on<Name extends keyof Events>(event: Name, handler: (payload: Events[Name]) => void): () => void {
    let handlers = this.handlersByEvent.get(event)
    if (!handlers) {
      handlers = new Set()
      this.handlersByEvent.set(event, handlers)
    }
    handlers.add(handler as (payload: never) => void)

    return () => {
      this.off(event, handler)
    }
  }

  /**
   * Remove a previously-subscribed `handler` from `event`. A handler that was
   * never subscribed (or already removed) is silently ignored, since "make sure
   * this is not subscribed" is a valid intent.
   */
  public off<Name extends keyof Events>(event: Name, handler: (payload: Events[Name]) => void): void {
    const handlers = this.handlersByEvent.get(event)
    if (!handlers) {
      return
    }
    handlers.delete(handler as (payload: never) => void)
    if (handlers.size === 0) {
      this.handlersByEvent.delete(event)
    }
  }

  /**
   * Fan `payload` out to every current subscriber of `event`, in subscription
   * order. Iterating a copy of the set means a handler that unsubscribes itself
   * (or another) mid-dispatch cannot corrupt the in-progress iteration.
   */
  public emit<Name extends keyof Events>(event: Name, payload: Events[Name]): void {
    const handlers = this.handlersByEvent.get(event)
    if (!handlers) {
      return
    }
    for (const handler of [ ...handlers ]) {
      handler(payload as never)
    }
  }

  /** Drop every subscriber across every event. Used on controller teardown. */
  public clear(): void {
    this.handlersByEvent.clear()
  }
}
