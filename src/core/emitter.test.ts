// Copyright © 2026 Jalapeno Labs

// Core
import { describe, expect, it, vi } from 'vitest'

import { Emitter } from './emitter'

type TestEvents = {
  ping: { value: number }
  pong: void
}

describe('Emitter', () => {
  it('calls a subscribed handler with the emitted payload', () => {
    const emitter = new Emitter<TestEvents>()
    const handler = vi.fn()

    emitter.on('ping', handler)
    emitter.emit('ping', { value: 42 })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ value: 42 })
  })

  it('fans an event out to every subscriber of that event only', () => {
    const emitter = new Emitter<TestEvents>()
    const pingHandler = vi.fn()
    const otherPingHandler = vi.fn()
    const pongHandler = vi.fn()

    emitter.on('ping', pingHandler)
    emitter.on('ping', otherPingHandler)
    emitter.on('pong', pongHandler)

    emitter.emit('ping', { value: 1 })

    expect(pingHandler).toHaveBeenCalledTimes(1)
    expect(otherPingHandler).toHaveBeenCalledTimes(1)
    expect(pongHandler).not.toHaveBeenCalled()
  })

  it('stops calling a handler once its returned unsubscribe fn runs', () => {
    const emitter = new Emitter<TestEvents>()
    const handler = vi.fn()

    const unsubscribe = emitter.on('ping', handler)
    emitter.emit('ping', { value: 1 })
    unsubscribe()
    emitter.emit('ping', { value: 2 })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ value: 1 })
  })

  it('stops calling a handler removed via off', () => {
    const emitter = new Emitter<TestEvents>()
    const handler = vi.fn()

    emitter.on('ping', handler)
    emitter.off('ping', handler)
    emitter.emit('ping', { value: 1 })

    expect(handler).not.toHaveBeenCalled()
  })

  it('only removes the named handler, leaving the others subscribed', () => {
    const emitter = new Emitter<TestEvents>()
    const kept = vi.fn()
    const removed = vi.fn()

    emitter.on('ping', kept)
    emitter.on('ping', removed)
    emitter.off('ping', removed)
    emitter.emit('ping', { value: 1 })

    expect(kept).toHaveBeenCalledTimes(1)
    expect(removed).not.toHaveBeenCalled()
  })

  it('fires the same handler once even if subscribed twice', () => {
    const emitter = new Emitter<TestEvents>()
    const handler = vi.fn()

    emitter.on('ping', handler)
    emitter.on('ping', handler)
    emitter.emit('ping', { value: 1 })

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('ignores an unsubscribe for a handler that was never subscribed', () => {
    const emitter = new Emitter<TestEvents>()

    expect(() => emitter.off('ping', vi.fn())).not.toThrow()
  })

  it('drops every subscriber on clear', () => {
    const emitter = new Emitter<TestEvents>()
    const handler = vi.fn()

    emitter.on('ping', handler)
    emitter.clear()
    emitter.emit('ping', { value: 1 })

    expect(handler).not.toHaveBeenCalled()
  })

  it('lets a handler unsubscribe itself mid-dispatch without skipping others', () => {
    const emitter = new Emitter<TestEvents>()
    const order: string[] = []

    const unsubscribeFirst = emitter.on('ping', () => {
      order.push('first')
      unsubscribeFirst()
    })
    emitter.on('ping', () => {
      order.push('second')
    })

    emitter.emit('ping', { value: 1 })

    expect(order).toEqual([ 'first', 'second' ])
  })
})
