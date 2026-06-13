// Copyright © 2026 Jalapeno Labs

export type { RunewoodAction, RunewoodEvent } from './types'
export type { NodeStatus, TreeNode } from './core/tree'
export type { AdvanceResult } from './core/timeline'
export type {
  Vec2,
  LayoutOptions,
  NodePhysics,
  SpringState,
  SpringParams,
  HeatOptions,
} from './core/layout'
export type { Hsl, RunewoodTheme, RunewoodThemeOverrides, ThemeName } from './core/theme'
export type { PickCandidate } from './core/picking'

export { applyEvent, createTree, seedTree } from './core/tree'
export { Timeline } from './core/timeline'
export { computeTargets, stepSprings, nodeHeat } from './core/layout'
export { colorForPath, colorForActor, themes, defaultTheme, mergeTheme } from './core/theme'
export { Emitter } from './core/emitter'
export { nearestWithinRadius } from './core/picking'

// The public controller: the single entry point a host mounts against a div.
export { createRunewood } from './runewood'
export type {
  RunewoodController,
  RunewoodOptions,
  RunewoodEventMap,
  RunewoodSeekPayload,
  RunewoodNodeClickPayload,
  RunewoodActorClickPayload,
  RunewoodPlaybackState,
} from './runewood'
