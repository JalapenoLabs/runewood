// Copyright © 2026 Jalapeno Labs

import type {
  RunewoodEvent,
  RunewoodAction,
  RunewoodOptions,
  RunewoodTheme,
  RunewoodController,
  RunewoodEventMap,
  RunewoodSeekPayload,
  RunewoodNodeClickPayload,
  RunewoodActorClickPayload,
  RunewoodPlaybackState,
  PickCandidate,
  CameraMode,
} from './index'

// Core
import { describe, expectTypeOf, it } from 'vitest'

import { createRunewood, Emitter, nearestWithinRadius, isAutoCameraMode } from './index'

/**
 * The issue's "public type exports verified" acceptance criterion: a type-level
 * test that imports the documented public surface from the package entry and
 * asserts the shapes the README and #11 / #15 will rely on. It never runs a
 * canvas; it only proves the barrel exposes the right names and shapes, which is
 * exactly the contract a host compiles against.
 */
describe('public type exports', () => {
  it('exposes the controller factory and its option / controller types', () => {
    expectTypeOf(createRunewood).parameter(0).toEqualTypeOf<HTMLElement>()
    expectTypeOf(createRunewood).returns.toEqualTypeOf<RunewoodController>()
    expectTypeOf<RunewoodOptions>().toHaveProperty('theme')
    expectTypeOf<RunewoodOptions>().toHaveProperty('reducedMotion')
    expectTypeOf<RunewoodOptions>().toHaveProperty('followLive')
    expectTypeOf<RunewoodOptions>().toHaveProperty('maxEvents')
    expectTypeOf<RunewoodOptions>().toHaveProperty('showLabels')
  })

  it('exposes the event input types', () => {
    expectTypeOf<RunewoodEvent>().toHaveProperty('at').toEqualTypeOf<number>()
    expectTypeOf<RunewoodEvent>().toHaveProperty('actor').toEqualTypeOf<string>()
    expectTypeOf<RunewoodAction>().toEqualTypeOf<'create' | 'modify' | 'delete' | 'scan' | 'pulse'>()
  })

  it('exposes the emitter event map with correctly typed payloads', () => {
    expectTypeOf<RunewoodEventMap['play']>().toEqualTypeOf<void>()
    expectTypeOf<RunewoodEventMap['pause']>().toEqualTypeOf<void>()
    expectTypeOf<RunewoodEventMap['reachedLiveEdge']>().toEqualTypeOf<void>()
    expectTypeOf<RunewoodEventMap['seek']>().toEqualTypeOf<RunewoodSeekPayload>()
    expectTypeOf<RunewoodEventMap['nodeClick']>().toEqualTypeOf<RunewoodNodeClickPayload>()
    expectTypeOf<RunewoodEventMap['actorClick']>().toEqualTypeOf<RunewoodActorClickPayload>()

    expectTypeOf<RunewoodSeekPayload>().toEqualTypeOf<{ time: number, progress: number }>()
    expectTypeOf<RunewoodNodeClickPayload>().toEqualTypeOf<{ path: string }>()
    expectTypeOf<RunewoodActorClickPayload>().toEqualTypeOf<{ actor: string }>()
  })

  it('types getState as the documented playback snapshot', () => {
    expectTypeOf<RunewoodPlaybackState>().toEqualTypeOf<{
      playing: boolean
      time: number
      duration: number
      progress: number
      speed: number
      following: boolean
      cameraMode: CameraMode
      followedActor: string | null
    }>()
    expectTypeOf<RunewoodController['getState']>().returns.toEqualTypeOf<RunewoodPlaybackState>()
  })

  it('exposes the click-to-follow surface (followActor accepts an actor id or null)', () => {
    expectTypeOf<RunewoodController['followActor']>().parameter(0).toEqualTypeOf<string | null>()
    expectTypeOf<RunewoodController['followActor']>().returns.toEqualTypeOf<void>()
    expectTypeOf<RunewoodPlaybackState>().toHaveProperty('followedActor').toEqualTypeOf<string | null>()
  })

  it('exposes the camera-mode surface (option, setter, state, and the mode union)', () => {
    expectTypeOf<CameraMode>().toEqualTypeOf<'overview' | 'follow' | 'manual'>()
    expectTypeOf<RunewoodOptions>().toHaveProperty('cameraMode')
    expectTypeOf<RunewoodController['setCameraMode']>().parameter(0).toEqualTypeOf<CameraMode>()
    expectTypeOf(isAutoCameraMode).parameter(0).toEqualTypeOf<CameraMode>()
    expectTypeOf(isAutoCameraMode).returns.toEqualTypeOf<boolean>()
  })

  it('types on() to return an unsubscribe function and infer the payload', () => {
    expectTypeOf<RunewoodController['on']>().returns.toEqualTypeOf<() => void>()
  })

  it('exposes the reusable emitter and pure picking helpers', () => {
    expectTypeOf(Emitter).toBeConstructibleWith()
    expectTypeOf(nearestWithinRadius).returns.toEqualTypeOf<string | null>()
    expectTypeOf<PickCandidate>().toHaveProperty('id').toEqualTypeOf<string>()
  })

  it('exposes the theme type', () => {
    expectTypeOf<RunewoodTheme>().toHaveProperty('bloomIntensity').toEqualTypeOf<number>()
  })
})
