// Copyright © 2026 Jalapeno Labs

export type { RunewoodAction, RunewoodEvent } from './types'
export type { NodeStatus, TreeNode } from './core/tree'
export type { VisibleNode } from './core/collapse'
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
export type {
  HighlightGroup,
  HighlightResolution,
  HighlightPulseOptions,
} from './core/highlight'
export type { PickCandidate } from './core/picking'
export type { PathFilter, PathFilterOptions } from './core/filter'
export type {
  CameraMode,
  RecentNodeSample,
  RecentActorSample,
  RecentActivityBoundsOptions,
} from './render/cameraMode'

export { applyEvent, createTree, seedTree } from './core/tree'
export { collapseTree } from './core/collapse'
export { Timeline } from './core/timeline'
export { computeTargets, stepSprings, nodeHeat } from './core/layout'
export { colorForPath, colorForActor, themes, defaultTheme, mergeTheme } from './core/theme'
export { Emitter } from './core/emitter'
export { HighlightRegistry, highlightPulse } from './core/highlight'
export { nearestWithinRadius } from './core/picking'
export { compilePathFilter } from './core/filter'
export { recentActivityBounds, isAutoCameraMode } from './render/cameraMode'

// The public controller: the single entry point a host mounts against a div.
export { createRunewood } from './runewood'
export type {
  RunewoodController,
  RunewoodOptions,
  RunewoodEventMap,
  RunewoodSeekPayload,
  RunewoodNodeClickPayload,
  RunewoodActorClickPayload,
  RunewoodNodeHoverPayload,
  RunewoodPlaybackState,
  HighlightOptions,
  RunewoodHighlight,
} from './runewood'
