// Copyright © 2026 Jalapeno Labs

import type { RunewoodEvent, RunewoodAction } from '../src/index'

/**
 * A synthetic event generator that fakes a swarm of agents crawling a multi-repo
 * forest, so the renderer and controls can be exercised end to end without a real
 * data source. It is intentionally a self-contained, host-shaped producer: it
 * owns a timer, builds a growing model of the fake forest, and pushes
 * {@link RunewoodEvent}s into a sink (the controller's `ingest`) on a cadence the
 * UI can speed up or slow down live.
 *
 * The forest starts from a fixed seed of repo roots and directories so the tree
 * has structure to discover, then the actors mutate it: reading (`scan`), editing
 * (`modify`), creating (`create`), deleting (`delete`), hopping across repos, and
 * emitting pathless `pulse`s (shell commands, thoughts). The generator
 * deliberately drives the edge cases the renderer needs to survive: bursts of
 * rapid edits, idle gaps with nothing happening, deleting an entire directory in
 * one tick, several actors working concurrently, and very deep paths.
 *
 * It is pure of any DOM or pixi knowledge: it only emits events, which keeps the
 * playground's wiring (the page) cleanly separated from its data (this file).
 */

/**
 * The fake actors that take turns (or overlap) crawling the forest. Kept to
 * exactly two contributors per direct user feedback: a smaller cast makes the
 * follow camera calmer (it no longer chases a swarm scattered across the whole
 * forest) and reads more like a real, focused work session.
 */
const ACTORS = [ 'fable', 'sonnet' ] as const

/** The repo roots of the fake forest. Mirrors a real Seraphim-style multi-repo workspace. */
const REPO_ROOTS = [ 'api', 'frontend', 'workspace', 'docs', 'infra' ] as const

/** Filename stems the generator pairs with an extension to invent plausible file paths. */
const FILE_STEMS = [
  'main', 'index', 'handler', 'router', 'client', 'model', 'utils', 'config',
  'service', 'store', 'view', 'parser', 'loader', 'worker', 'schema', 'guard',
]

/** Extensions per repo root, so a repo's invented files look like they belong to it. */
const EXTENSIONS_BY_ROOT = {
  api: [ 'rs', 'toml', 'sql' ],
  frontend: [ 'ts', 'tsx', 'svelte', 'css' ],
  workspace: [ 'sh', 'dockerfile', 'ts' ],
  docs: [ 'md', 'mdx' ],
  infra: [ 'yml', 'tf', 'sh' ],
} as const satisfies Record<typeof REPO_ROOTS[number], string[]>

/** Mid-path directory segments used to build realistic, sometimes deep, paths. */
const DIRECTORY_SEGMENTS = [
  'src', 'lib', 'core', 'http', 'db', 'components', 'routes', 'hooks',
  'helpers', 'internal', 'modules', 'services', 'pkg', 'cmd',
]

/**
 * Noise directory segments the path filter is meant to omit. The generator
 * occasionally roots an invented path under one of these so the playground's
 * exclude globs visibly remove them from the forest.
 */
const NOISE_SEGMENTS = [ 'node_modules', '__pycache__', '.git', 'dist' ]

/** Freeform command labels attached to pathless `pulse` events for flavor. */
const PULSE_COMMANDS = [
  'cargo build', 'yarn install', 'git status', 'docker compose up',
  'cargo test', 'eslint .', 'tsc --noEmit', 'gh pr create', 'git push',
]

/**
 * Weighted action mix for the steady-state stream. `scan` dominates (agents read
 * far more than they write), `modify` is common, and the mutating verbs that
 * change the tree shape are rarer. Bursts and dir-deletes are layered on top of
 * this base distribution by the scheduler, not encoded here.
 */
const WEIGHTED_ACTIONS: Array<{ action: RunewoodAction, weight: number }> = [
  { action: 'scan', weight: 50 },
  { action: 'modify', weight: 28 },
  { action: 'create', weight: 10 },
  { action: 'delete', weight: 4 },
  { action: 'pulse', weight: 8 },
]

/** Options controlling the generator's cadence and intensity. */
export type SyntheticOptions = {
  /**
   * Mean events emitted per second. The scheduler converts this into a per-tick
   * count and jitters it, so the real rate fluctuates around this value. Changed
   * live from the control panel.
   */
  eventsPerSecond?: number
  /** The sink every generated event is pushed into (the controller's `ingest`). */
  onEvent: (event: RunewoodEvent) => void
}

/**
 * The generator's mutable view of the fake forest: the set of file paths that
 * currently "exist", grouped by their repo root so a cross-repo hop or a
 * whole-directory delete can be modeled without re-deriving structure from the
 * controller (which the generator deliberately does not read back from).
 */
type Forest = {
  /** Every live file path, the universe `scan` / `modify` / `delete` draw from. */
  files: Set<string>
  /** The repo root each actor is currently focused on, to make hops visible and occasional. */
  focusByActor: Map<string, string>
}

/**
 * Creates a synthetic stream controller. Returns imperative `start` / `stop` /
 * `setRate` handles plus a `burst` trigger the UI can fire to slam the renderer
 * with a rapid cluster of edits on demand.
 */
export function createSyntheticStream(options: SyntheticOptions) {
  let eventsPerSecond = options.eventsPerSecond ?? 12
  let timer: ReturnType<typeof setInterval> | null = null

  // The generator advances its own logical clock rather than reading `Date.now()`
  // each emit, so a burst of events within one tick still carries strictly
  // increasing timestamps a few ms apart. The controller wants non-decreasing
  // time; monotonic synthetic time guarantees it.
  let clock = Date.now()

  const forest = createForest()

  /** How often the scheduler wakes. A fixed cadence; the per-tick count carries the rate. */
  const TICK_INTERVAL_MS = 100

  /**
   * Idle-gap state: every so often the generator goes quiet for a few ticks to
   * exercise the renderer's fade-to-rest path and the "nothing is happening"
   * camera behavior. `idleTicksRemaining` counts down a current gap.
   */
  let idleTicksRemaining = 0

  function tick(): void {
    // Occasionally open an idle gap so the forest visibly goes quiet, then resumes.
    if (idleTicksRemaining > 0) {
      idleTicksRemaining -= 1
      clock += TICK_INTERVAL_MS
      return
    }
    if (Math.random() < IDLE_GAP_CHANCE) {
      idleTicksRemaining = randomInt(IDLE_GAP_MIN_TICKS, IDLE_GAP_MAX_TICKS)
      return
    }

    // Convert the target rate into this tick's event count, jittered so the stream
    // is lumpy rather than metronomic. A rare burst multiplies it for a spike.
    const baseCount = (eventsPerSecond * TICK_INTERVAL_MS) / 1000
    const jittered = baseCount * randomBetween(0.4, 1.6)
    const isBurst = Math.random() < BURST_CHANCE
    const count = Math.max(1, Math.round(jittered * (isBurst ? BURST_MULTIPLIER : 1)))

    for (let index = 0; index < count; index += 1) {
      // Spread events across the tick window so their timestamps differ; this keeps
      // the timeline's ordering meaningful instead of stacking them on one instant.
      clock += Math.max(1, Math.round(TICK_INTERVAL_MS / count))
      emitOne()
    }
  }

  /** Generates and dispatches a single event, mutating the forest model as needed. */
  function emitOne(): void {
    const actor = pickActor()
    const action = pickWeightedAction()

    if (action === 'pulse') {
      const command = PULSE_COMMANDS[randomInt(0, PULSE_COMMANDS.length - 1)]
      options.onEvent({ at: clock, actor, action: 'pulse', label: command })
      return
    }

    if (action === 'delete') {
      emitDelete(actor)
      return
    }

    if (action === 'create') {
      const path = inventPath(actor)
      forest.files.add(path)
      options.onEvent({ at: clock, actor, action: 'create', path })
      return
    }

    // `scan` / `modify` touch an existing file, or invent one if the forest is bare.
    const path = pickExistingFile() ?? inventPath(actor)
    forest.files.add(path)
    options.onEvent({ at: clock, actor, action, path })
  }

  /**
   * Models a delete. Most deletes remove a single file, but a fraction wipe a whole
   * directory at once (every live file under a shared prefix) so the renderer's
   * subtree-removal path is exercised. Emits one `delete` event per removed file.
   */
  function emitDelete(actor: string): void {
    if (forest.files.size === 0) {
      return
    }
    const wipeDirectory = Math.random() < DIRECTORY_DELETE_CHANCE
    if (wipeDirectory) {
      const prefix = pickDirectoryPrefix()
      if (prefix) {
        const doomed = [ ...forest.files ].filter((path) => path.startsWith(prefix + '/'))
        for (const path of doomed) {
          forest.files.delete(path)
          clock += 1
          options.onEvent({ at: clock, actor, action: 'delete', path })
        }
        return
      }
    }
    const target = pickExistingFile()
    if (target) {
      forest.files.delete(target)
      options.onEvent({ at: clock, actor, action: 'delete', path: target })
    }
  }

  /** Picks an actor, occasionally hopping its focus to a different repo root. */
  function pickActor(): string {
    const actor = ACTORS[randomInt(0, ACTORS.length - 1)]
    if (Math.random() < CROSS_REPO_HOP_CHANCE) {
      forest.focusByActor.set(actor, REPO_ROOTS[randomInt(0, REPO_ROOTS.length - 1)])
    }
    else if (!forest.focusByActor.has(actor)) {
      forest.focusByActor.set(actor, REPO_ROOTS[randomInt(0, REPO_ROOTS.length - 1)])
    }
    return actor
  }

  /** Invents a fresh, plausibly-deep path under the actor's focused repo root. */
  function inventPath(actor: string): string {
    const root = forest.focusByActor.get(actor) ?? REPO_ROOTS[randomInt(0, REPO_ROOTS.length - 1)]
    const depth = randomInt(1, MAX_PATH_DEPTH)
    const segments: string[] = [ root ]
    // Occasionally route the path through a noise directory (node_modules, etc.) so
    // the playground's exclude filter has something to visibly strip out.
    if (Math.random() < NOISE_PATH_CHANCE) {
      segments.push(NOISE_SEGMENTS[randomInt(0, NOISE_SEGMENTS.length - 1)])
    }
    for (let level = 0; level < depth; level += 1) {
      segments.push(DIRECTORY_SEGMENTS[randomInt(0, DIRECTORY_SEGMENTS.length - 1)])
    }
    const extensions = EXTENSIONS_BY_ROOT[root as keyof typeof EXTENSIONS_BY_ROOT]
    const stem = FILE_STEMS[randomInt(0, FILE_STEMS.length - 1)]
    const extension = extensions[randomInt(0, extensions.length - 1)]
    segments.push(`${stem}.${extension}`)
    return segments.join('/')
  }

  /** A random live file, or null when the forest is empty. */
  function pickExistingFile(): string | null {
    if (forest.files.size === 0) {
      return null
    }
    const all = [ ...forest.files ]
    return all[randomInt(0, all.length - 1)]
  }

  /**
   * A directory prefix that currently holds at least two files, chosen for a
   * whole-directory wipe. Returns null when no such directory exists yet.
   */
  function pickDirectoryPrefix(): string | null {
    const countByPrefix = new Map<string, number>()
    for (const path of forest.files) {
      const lastSlash = path.lastIndexOf('/')
      if (lastSlash <= 0) {
        continue
      }
      const prefix = path.slice(0, lastSlash)
      countByPrefix.set(prefix, (countByPrefix.get(prefix) ?? 0) + 1)
    }
    const populated = [ ...countByPrefix.entries() ].filter(([ , count ]) => count >= 2)
    if (populated.length === 0) {
      return null
    }
    return populated[randomInt(0, populated.length - 1)][0]
  }

  return {
    /** Begin emitting on the timer. A no-op if already running. */
    start(): void {
      if (timer !== null) {
        return
      }
      clock = Date.now()
      timer = setInterval(tick, TICK_INTERVAL_MS)
    },
    /** Stop emitting. The forest model is retained so a restart continues the same tree. */
    stop(): void {
      if (timer === null) {
        return
      }
      clearInterval(timer)
      timer = null
    },
    /** Whether the stream is currently running. */
    isRunning(): boolean {
      return timer !== null
    },
    /** Change the target events-per-second live; takes effect on the next tick. */
    setRate(nextEventsPerSecond: number): void {
      eventsPerSecond = Math.max(0, nextEventsPerSecond)
    },
    /**
     * Fire a one-off burst immediately, independent of the timer: a tight cluster of
     * rapid edits on a handful of files, to stress the renderer on demand from the UI.
     */
    burst(): void {
      const count = randomInt(BURST_MANUAL_MIN, BURST_MANUAL_MAX)
      for (let index = 0; index < count; index += 1) {
        clock += randomInt(1, 6)
        emitOne()
      }
    },
  } as const
}

export type SyntheticStream = ReturnType<typeof createSyntheticStream>

/** Builds the initial forest: a handful of seed files per repo so there is structure to discover. */
function createForest(): Forest {
  const files = new Set<string>()
  for (const root of REPO_ROOTS) {
    const extensions = EXTENSIONS_BY_ROOT[root]
    files.add(`${root}/src/${FILE_STEMS[0]}.${extensions[0]}`)
    files.add(`${root}/src/${FILE_STEMS[1]}.${extensions[0]}`)
    files.add(`${root}/README.md`)
  }
  return { files, focusByActor: new Map() }
}

/** The seed paths the playground hands to `controller.seed` so the tree shows dim structure up front. */
export function seedPaths(): string[] {
  const forest = createForest()
  return [ ...forest.files ]
}

/** Inclusive-integer random in `[min, max]`. */
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** Uniform float in `[min, max)`. */
function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min
}

/** Draws one action from {@link WEIGHTED_ACTIONS} by its relative weight. */
function pickWeightedAction(): RunewoodAction {
  const totalWeight = WEIGHTED_ACTIONS.reduce((sum, entry) => sum + entry.weight, 0)
  let roll = Math.random() * totalWeight
  for (const entry of WEIGHTED_ACTIONS) {
    roll -= entry.weight
    if (roll <= 0) {
      return entry.action
    }
  }
  return 'scan'
}

/**
 * Chance per tick of opening an idle gap, so the forest visibly goes quiet
 * sometimes. Raised so the gaps are frequent enough to actually watch an actor
 * LINGER parked at its last node (Part C) before it acts again, rather than the
 * stream barely ever pausing.
 */
const IDLE_GAP_CHANCE = 0.12
/** Shortest idle gap, in ticks (at the 100ms tick this is ~0.8s). */
const IDLE_GAP_MIN_TICKS = 8
/** Longest idle gap, in ticks (~3.5s), long enough to clearly see the lingering idle pulse. */
const IDLE_GAP_MAX_TICKS = 35
/** Chance a given tick becomes a burst (a rapid spike of events). */
const BURST_CHANCE = 0.05
/** How much a burst tick multiplies its event count. */
const BURST_MULTIPLIER = 6
/** Chance a `delete` wipes an entire directory rather than one file. */
const DIRECTORY_DELETE_CHANCE = 0.15
/** Chance an emit hops the chosen actor to a different repo root (a cross-repo hop). */
const CROSS_REPO_HOP_CHANCE = 0.08
/** Deepest invented path, in directory levels below the repo root. */
const MAX_PATH_DEPTH = 6
/** Chance an invented path is routed through a noise directory the filter should strip. */
const NOISE_PATH_CHANCE = 0.18
/** Fewest events in a manual (button-triggered) burst. */
const BURST_MANUAL_MIN = 30
/** Most events in a manual burst. */
const BURST_MANUAL_MAX = 60
