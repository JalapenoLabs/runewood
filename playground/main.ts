// Copyright © 2026 Jalapeno Labs

import type { ThemeName, CameraMode, RunewoodEvent, RunewoodHighlight } from '../src/index'
import type { BloomQuality } from '../src/render/bloom'

// Core
import { createRunewood, colorForPath, themes } from '../src/index'

// User interface
import { hslToRgbInt } from '../src/render/color'

// Misc
import { createSyntheticStream, seedPaths } from './synthetic'

/**
 * The file types shown in the playground color legend, each paired with a sample
 * path the engine's {@link colorForPath} will color. They are drawn straight from
 * the same color logic the forest uses, so the legend can never drift from what
 * the nodes actually render. A folder entry is appended separately from the
 * active theme's hub color.
 */
const LEGEND_FILE_SAMPLES = [
  { label: 'TypeScript', path: 'sample.ts' },
  { label: 'React TSX', path: 'sample.tsx' },
  { label: 'JavaScript', path: 'sample.js' },
  { label: 'Python', path: 'sample.py' },
  { label: 'Rust', path: 'sample.rs' },
  { label: 'Go', path: 'sample.go' },
  { label: 'Ruby', path: 'sample.rb' },
  { label: 'Java', path: 'sample.java' },
  { label: 'C++', path: 'sample.cpp' },
  { label: 'JSON', path: 'sample.json' },
  { label: 'YAML', path: 'sample.yaml' },
  { label: 'Markdown', path: 'sample.md' },
  { label: 'CSS', path: 'sample.css' },
  { label: 'HTML', path: 'sample.html' },
  { label: 'SQL', path: 'sample.sql' },
  { label: 'Shell', path: 'sample.sh' },
] as const

/**
 * The runewood dev playground entry point. It mounts the real engine
 * ({@link createRunewood}, which pulls in pixi and every render scene) against a
 * full-viewport canvas, drives it with the synthetic event stream, and wires a
 * small control panel so the renderer and controls can be developed and demoed
 * with zero Seraphim. This file is the playground's only DOM glue; the data
 * (the fake forest) lives in `synthetic.ts`, and the engine itself is imported
 * straight from source so a `vite build` here doubles as integration proof.
 */

const STATE_READOUT_INTERVAL_MS = 250

/**
 * How long the simulated CI run keeps its PR files glowing amber ("CI running")
 * before it flips them green ("passed"). The operator can also click the button
 * again to clear early.
 */
const SIMULATED_CI_RUNNING_MS = 5_000

/**
 * How long the files stay green ("CI passed") after the run finishes before the
 * highlight auto-clears, so the operator sees the running -> passed transition land
 * before it disappears.
 */
const SIMULATED_CI_PASSED_MS = 2_500

/** How many current files a simulated PR "touches", chosen at random from the live forest. */
const SIMULATED_PR_FILE_COUNT = 6

/** The amber attention color the simulated-CI highlight uses while CI is "running", matching the library's default. */
const CI_HIGHLIGHT_COLOR = { h: 38, s: 0.95, l: 0.58 } as const

/** The green color the simulated-CI highlight flips to when CI "passes", so the demo shows the success transition. */
const CI_PASSED_COLOR = { h: 140, s: 0.85, l: 0.5 } as const

/**
 * Exponential-smoothing weight for the FPS readout: each frame blends this much of
 * the new instantaneous rate into the running average, so the number is steady and
 * readable rather than jittering every frame. ~0.1 settles within a few frames
 * while still reacting to a real, sustained drop.
 */
const FPS_SMOOTHING = 0.1

/**
 * How long to wait after the last keystroke in the exclude field before rebuilding
 * the controller, so typing a multi-pattern list does not rebuild on every key.
 */
const EXCLUDE_REBUILD_DEBOUNCE_MS = 400

function main(): void {
  const canvasHost = requireElement<HTMLDivElement>('canvas-host')
  const stateReadout = requireElement<HTMLPreElement>('state-readout')
  const startStopButton = requireElement<HTMLButtonElement>('start-stop')
  const burstButton = requireElement<HTMLButtonElement>('burst')
  const resetButton = requireElement<HTMLButtonElement>('reset')
  const simulateCiButton = requireElement<HTMLButtonElement>('simulate-ci')
  const rateInput = requireElement<HTMLInputElement>('rate')
  const rateValue = requireElement<HTMLSpanElement>('rate-value')
  const themeSelect = requireElement<HTMLSelectElement>('theme')
  const bloomSelect = requireElement<HTMLSelectElement>('bloom')
  const labelsToggle = requireElement<HTMLInputElement>('labels')
  const controlsToggle = requireElement<HTMLInputElement>('controls')
  const playPauseButton = requireElement<HTMLButtonElement>('play-pause')
  const panel = requireElement<HTMLDivElement>('panel')
  const panelRestore = requireElement<HTMLButtonElement>('panel-restore')
  const legendGrid = requireElement<HTMLDivElement>('legend-grid')
  const excludeInput = requireElement<HTMLTextAreaElement>('exclude')
  const hoverTooltip = requireElement<HTMLDivElement>('hover-tooltip')
  const fpsCounter = requireElement<HTMLDivElement>('fps-counter')
  // The camera-mode segmented control: one button per mode, the active one
  // highlighted from the live `getState().cameraMode`.
  const cameraModeButtons: Record<CameraMode, HTMLButtonElement> = {
    overview: requireElement<HTMLButtonElement>('camera-overview'),
    follow: requireElement<HTMLButtonElement>('camera-follow'),
    manual: requireElement<HTMLButtonElement>('camera-manual'),
  }

  // Drive the FPS readout off the page's own requestAnimationFrame deltas, which
  // tick at the display refresh and reflect the real render rate the user feels.
  // The instantaneous `1000 / deltaMs` is noisy, so it is exponentially smoothed
  // into a steady number an operator can read while changing the events/sec.
  startFpsCounter(fpsCounter)

  // The legend mirrors the engine's own coloring, so it is built from the same
  // theme + colorForPath the forest uses and refreshed whenever the theme changes.
  renderLegend(legendGrid, themeSelect.value as ThemeName)

  // Build the engine. We start following-live so the synthetic stream's newest
  // events drag the view, and pre-seed the known structure as dim nodes. The
  // exclude globs from the panel feed the controller's construction-time path
  // filter, so excluded paths (node_modules, __pycache__, ...) never enter the
  // forest. The camera defaults to `follow` (the Gource-style camera) so that
  // behavior is what an operator sees first.
  //
  // Note: the follow camera looks best with *coherent* activity that travels as a
  // region. The synthetic generator now runs just 2 contributors (see `ACTORS` in
  // synthetic.ts), so the activity stays tighter and the follow camera is calmer.
  let controller = createRunewood(canvasHost, {
    theme: 'dusk',
    bloom: 'off',
    showLabels: true,
    autoplay: true,
    followLive: true,
    cameraMode: 'follow',
    // One shared root node (Part A): the repos (api/docs/frontend/infra/workspace)
    // branch off a single labeled center, so the forest reads as one tree rather
    // than a ring of separate fans.
    rootLabel: 'root',
    exclude: parseExcludePatterns(excludeInput.value),
  })
  controller.seed(seedPaths())
  wireControllerLogging(controller)
  wireHoverTooltip(controller, hoverTooltip)

  // The set of file paths the live forest currently knows about, accumulated from
  // the synthetic stream so the "Simulate CI on a PR" button can pick a handful of
  // *real, on-screen* files to highlight. The library itself does not expose the
  // forest (the host owns its own data), so the playground tracks it here off the
  // very events it ingests. Seeded so the button works before the stream warms up.
  const seenFilePaths = new Set<string>(seedPaths())

  // The active simulated-CI highlight handle + its phase timer, so a second button
  // click (or a rebuild / reset) can clear it early and tear the timer down. The timer
  // first flips the highlight from amber ("running") to green ("passed"), then a second
  // scheduled timer clears it, so the demo plays out the running -> passed -> done arc.
  let ciHighlight: RunewoodHighlight | null = null
  let ciClearTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * The event sink the synthetic stream pushes into: forwards every event to the
   * live controller and records any file path it carries, so the simulated-CI demo
   * has a pool of current files to light up. Re-reads the outer `controller` binding
   * on each call, so a controller rebuild is picked up for free.
   */
  function ingest(event: RunewoodEvent): void {
    controller.ingest(event)
    if (event.path !== undefined) {
      seenFilePaths.add(event.path)
    }
  }

  /** Stops any running simulated-CI highlight and clears its auto-clear timer. */
  function stopSimulatedCi(): void {
    if (ciClearTimer !== null) {
      clearTimeout(ciClearTimer)
      ciClearTimer = null
    }
    ciHighlight?.clear()
    ciHighlight = null
    simulateCiButton.textContent = 'Simulate CI on a PR'
  }

  // The simulated-CI demo (issue #180): on the first click, pick a handful of current
  // files (a fake PR's touched set) and highlight them amber ("CI running"). After a few
  // seconds the run "passes": the same files are re-highlighted GREEN (re-using the
  // `simulated-ci` id replaces the group's color in place), so the operator watches the
  // reticle's running -> passed transition, and then it auto-clears. A second click
  // clears early. This mirrors exactly how a host like Seraphim drives the feature:
  // highlight on CI start, recolor on result, clear when done.
  simulateCiButton.addEventListener('click', () => {
    if (ciHighlight) {
      stopSimulatedCi()
      return
    }
    const prFiles = pickRandomPaths(seenFilePaths, SIMULATED_PR_FILE_COUNT)
    if (prFiles.length === 0) {
      console.debug('[runewood] Simulate CI: no files in the forest yet, nothing to highlight')
      return
    }
    ciHighlight = controller.highlight(prFiles, { color: CI_HIGHLIGHT_COLOR, id: 'simulated-ci' })
    simulateCiButton.textContent = 'CI running... (click to clear)'
    ciClearTimer = setTimeout(() => {
      // CI "passed": flip the same group to green so the reticle turns green in place,
      // then schedule the final clear once the operator has seen the success state.
      controller.highlight(prFiles, { color: CI_PASSED_COLOR, id: 'simulated-ci' })
      simulateCiButton.textContent = 'CI passed! (click to clear)'
      ciClearTimer = setTimeout(() => stopSimulatedCi(), SIMULATED_CI_PASSED_MS)
    }, SIMULATED_CI_RUNNING_MS)
  })

  // The synthetic stream is held in a mutable binding (not a const) so the Reset
  // button can throw the whole generator away and start a brand-new one from an
  // empty forest, rather than resuming the retained one. Its `onEvent` re-reads the
  // outer `controller` on every emit, so a controller rebuild is picked up for free.
  let stream = createSyntheticStream({
    eventsPerSecond: Number(rateInput.value),
    onEvent: ingest,
  })
  stream.start()

  function syncStartStopLabel(): void {
    startStopButton.textContent = stream.isRunning() ? 'Stop stream' : 'Start stream'
  }
  syncStartStopLabel()

  startStopButton.addEventListener('click', () => {
    if (stream.isRunning()) {
      stream.stop()
    }
    else {
      stream.start()
    }
    syncStartStopLabel()
  })

  burstButton.addEventListener('click', () => stream.burst())

  // Reset / Restart: tear the whole visualization down and recreate it fresh, the
  // way the theme-change rebuild does, but also throw the synthetic generator away
  // so the forest starts empty again rather than continuing the retained tree.
  resetButton.addEventListener('click', () => reset())

  rateInput.addEventListener('input', () => {
    const nextRate = Number(rateInput.value)
    rateValue.textContent = `${nextRate}/s`
    stream.setRate(nextRate)
  })
  rateValue.textContent = `${Number(rateInput.value)}/s`

  playPauseButton.addEventListener('click', () => {
    const { playing } = controller.getState()
    if (playing) {
      controller.pause()
    }
    else {
      controller.play()
    }
  })

  // Wire the camera-mode buttons: clicking one re-engages that mode via
  // `setCameraMode`. The highlight is not set here; it is driven from the live
  // `getState().cameraMode` in the readout interval below, so a manual pan / wheel
  // zoom (which flips the engine to `manual` on its own) is reflected too.
  for (const button of Object.values(cameraModeButtons)) {
    button.addEventListener('click', () => {
      const mode = button.dataset.mode as CameraMode
      controller.setCameraMode(mode)
    })
  }

  /** Highlights the button for `mode` and clears the others, reflecting the live camera mode. */
  function syncCameraModeButtons(mode: CameraMode): void {
    for (const [ buttonMode, button ] of Object.entries(cameraModeButtons)) {
      button.classList.toggle('active', buttonMode === mode)
    }
  }

  // Theme, bloom, and labels are construction-time options on the controller, so
  // changing them rebuilds it in place. We hand the fresh controller the same
  // seed and re-log clicks, then keep the stream pointed at it via `currentController`.
  themeSelect.addEventListener('change', () => {
    renderLegend(legendGrid, themeSelect.value as ThemeName)
    rebuild()
  })
  bloomSelect.addEventListener('change', () => rebuild())
  labelsToggle.addEventListener('change', () => rebuild())

  // Rebuilding the controller is the way to apply new exclude globs (filtering is
  // construction-time), so editing the patterns rebuilds in place, debounced so a
  // burst of keystrokes does not thrash the renderer. Mirrors the theme rebuild.
  let excludeDebounce: ReturnType<typeof setTimeout> | null = null
  excludeInput.addEventListener('input', () => {
    if (excludeDebounce !== null) {
      clearTimeout(excludeDebounce)
    }
    excludeDebounce = setTimeout(() => rebuild(), EXCLUDE_REBUILD_DEBOUNCE_MS)
  })

  // The engine exposes `getState()` for a host to render its own transport rather
  // than shipping a built-in overlay (issue #11 is not implemented yet), so this
  // toggle shows or hides the playground's own control panel chrome over the canvas
  // so the renderer can be viewed unobstructed. A small floating button restores it
  // (the toggle itself lives inside the panel, so it cannot bring the panel back).
  controlsToggle.addEventListener('change', () => {
    const visible = controlsToggle.checked
    panel.style.display = visible ? 'flex' : 'none'
    panelRestore.hidden = visible
  })
  panelRestore.addEventListener('click', () => {
    controlsToggle.checked = true
    panel.style.display = 'flex'
    panelRestore.hidden = true
  })

  function rebuild(): void {
    const wasRunning = stream.isRunning()
    // The simulated-CI highlight belongs to the controller we are about to destroy;
    // stop it (and its auto-clear timer) so no stale handle or button label survives.
    stopSimulatedCi()
    controller.destroy()
    // The tooltip belongs to the old controller's hover events; hide it so a stale
    // path does not linger across the rebuild.
    hoverTooltip.style.display = 'none'
    controller = createRunewood(canvasHost, {
      theme: themeSelect.value as ThemeName,
      bloom: bloomSelect.value as BloomQuality,
      showLabels: labelsToggle.checked,
      autoplay: true,
      followLive: true,
      cameraMode: 'follow',
      rootLabel: 'root',
      exclude: parseExcludePatterns(excludeInput.value),
    })
    controller.seed(seedPaths())
    wireControllerLogging(controller)
    wireHoverTooltip(controller, hoverTooltip)
    // Repoint the stream's sink at the new controller by recreating nothing: the
    // closure already captures `controller` by reference through the outer binding,
    // so re-reading it on each emit picks up the rebuild. We just resume if needed.
    if (!wasRunning) {
      stream.stop()
    }
  }

  /**
   * Resets the playground to a clean slate: destroy the controller, throw away the
   * synthetic generator (so its retained forest is gone), and recreate both fresh,
   * exactly like the theme-change rebuild but with an empty forest restarted from
   * zero. The new stream's `onEvent` captures the new `controller`, and the outer
   * `stream` binding is repointed so every later control (start/stop, burst, rate)
   * drives the fresh generator.
   */
  function reset(): void {
    // Stop the simulated-CI highlight first: the controller it lives on is destroyed
    // here, and the forest is wiped, so any tracked PR files no longer exist.
    stopSimulatedCi()
    seenFilePaths.clear()
    controller.destroy()
    stream.stop()
    hoverTooltip.style.display = 'none'

    controller = createRunewood(canvasHost, {
      theme: themeSelect.value as ThemeName,
      bloom: bloomSelect.value as BloomQuality,
      showLabels: labelsToggle.checked,
      autoplay: true,
      followLive: true,
      cameraMode: 'follow',
      rootLabel: 'root',
      exclude: parseExcludePatterns(excludeInput.value),
    })
    controller.seed(seedPaths())
    wireControllerLogging(controller)
    wireHoverTooltip(controller, hoverTooltip)

    // A brand-new generator starts the fake forest over from empty, rather than
    // continuing the previous run's retained tree.
    stream = createSyntheticStream({
      eventsPerSecond: Number(rateInput.value),
      onEvent: ingest,
    })
    stream.start()
    syncStartStopLabel()
  }

  // The live state readout: a tiny JSON dump of `getState()`, refreshed on a timer
  // so an operator can watch the playhead, duration, and follow flag move. The same
  // poll reflects the live camera mode onto the segmented control, so a manual pan /
  // wheel-zoom visibly flips the highlight to Manual.
  setInterval(() => {
    const state = controller.getState()
    stateReadout.textContent = JSON.stringify(state, null, 2)
    syncCameraModeButtons(state.cameraMode)
  }, STATE_READOUT_INTERVAL_MS)
}

/**
 * Runs a self-contained requestAnimationFrame loop that measures the page's frame
 * rate from the RAF timestamp deltas and writes a smoothed reading into `counter`.
 * It is independent of the engine's own loop (it only times how often the browser
 * paints), so it reflects the true on-screen frame rate the user feels, including
 * any jank the engine introduces. The first frame has no delta to measure from, so
 * it only seeds the timestamp; every frame after blends its instantaneous rate in.
 */
function startFpsCounter(counter: HTMLDivElement): void {
  let smoothedFps = 0
  let lastTimestamp: number | null = null

  function tick(timestamp: number): void {
    if (lastTimestamp !== null) {
      const deltaMs = timestamp - lastTimestamp
      if (deltaMs > 0) {
        const instantFps = 1000 / deltaMs
        smoothedFps = smoothedFps === 0
          ? instantFps
          : smoothedFps + (instantFps - smoothedFps) * FPS_SMOOTHING
        counter.textContent = `${Math.round(smoothedFps)} FPS`
      }
    }
    lastTimestamp = timestamp
    requestAnimationFrame(tick)
  }

  requestAnimationFrame(tick)
}

/**
 * Splits the exclude textarea's freeform text into glob patterns. Patterns are
 * separated by commas or newlines, trimmed, and empties dropped, so an operator
 * can type `**\/node_modules/**, **\/dist/**` on one line or one per line.
 */
function parseExcludePatterns(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
}

/**
 * Drives the playground's DOM tooltip from the library's `nodeHover` event. The
 * tooltip itself lives here in the host, not the library, so the core stays
 * framework-agnostic: the library only emits the hovered path + screen point, and
 * the playground decides how to render it. The screen point is canvas-relative,
 * and the canvas fills the viewport, so it doubles as a viewport coordinate for a
 * `position: fixed` tooltip.
 */
function wireHoverTooltip(controller: ReturnType<typeof createRunewood>, tooltip: HTMLDivElement): void {
  controller.on('nodeHover', (payload) => {
    // The shared root node has an empty path, so it would render as a blank
    // tooltip box; treat an empty path like no hover and hide it.
    if (payload === null || !payload.path) {
      tooltip.style.display = 'none'
      return
    }
    tooltip.textContent = payload.path
    tooltip.style.left = `${payload.screen.x}px`
    tooltip.style.top = `${payload.screen.y}px`
    tooltip.style.display = 'block'
  })
}

/**
 * Subscribes console logging to the controller's click events. The issue asks for
 * `nodeClick` / `actorClick` to be logged so picking can be verified by hand in
 * the playground.
 */
function wireControllerLogging(controller: ReturnType<typeof createRunewood>): void {
  controller.on('nodeClick', (payload) => {
    console.log('[runewood] nodeClick', payload.path)
  })
  controller.on('actorClick', (payload) => {
    console.log('[runewood] actorClick', payload.actor)
  })
}

/**
 * Renders the color legend so the operator can read the encoding at a glance:
 * a swatch per common file type (colored by the very same {@link colorForPath}
 * the forest nodes use) plus a folder entry colored from the active theme's
 * neutral hub. Rebuilt on every theme change so the folder swatch always matches
 * what is on screen. Each swatch is a CSS `hsl()` so the playground never has to
 * re-implement the engine's HSL math.
 */
function renderLegend(grid: HTMLDivElement, themeName: ThemeName): void {
  const hub = themes[themeName].hub
  const entries: { label: string, color: number }[] = LEGEND_FILE_SAMPLES.map((sample) => ({
    label: sample.label,
    color: hslToRgbInt(colorForPath(sample.path)),
  }))
  // The folder swatch leads so folder-vs-file is the first thing the legend shows.
  entries.unshift({ label: 'Folder', color: hslToRgbInt(hub) })

  grid.replaceChildren(...entries.map((entry) => {
    const item = document.createElement('div')
    item.className = 'legend-item'

    const swatch = document.createElement('span')
    swatch.className = 'legend-swatch'
    // hslToRgbInt returns 0xRRGGBB; pad to a six-digit hex so CSS reads it right.
    swatch.style.background = `#${entry.color.toString(16).padStart(6, '0')}`

    const text = document.createElement('span')
    text.textContent = entry.label

    item.append(swatch, text)
    return item
  }))
}

/**
 * Picks up to `count` random distinct paths from a set, standing in for the files a
 * pull request touched. A partial Fisher-Yates over a copy: it shuffles only as many
 * entries as it needs, so it stays cheap even on a large forest, and returns fewer
 * than `count` when the set is smaller.
 */
function pickRandomPaths(paths: Set<string>, count: number): string[] {
  const pool = [ ...paths ]
  const take = Math.min(count, pool.length)
  for (let index = 0; index < take; index += 1) {
    const swapWith = index + Math.floor(Math.random() * (pool.length - index))
    const temporary = pool[index]
    pool[index] = pool[swapWith]
    pool[swapWith] = temporary
  }
  return pool.slice(0, take)
}

/** Fetches an element by id, throwing loudly if the page markup is missing it. */
function requireElement<Shape extends HTMLElement>(id: string): Shape {
  const element = document.getElementById(id)
  if (!element) {
    throw new Error(`Playground markup is missing the #${id} element`)
  }
  return element as Shape
}

main()
