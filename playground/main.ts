// Copyright © 2026 Jalapeno Labs

import type { ThemeName } from '../src/index'
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

function main(): void {
  const canvasHost = requireElement<HTMLDivElement>('canvas-host')
  const stateReadout = requireElement<HTMLPreElement>('state-readout')
  const startStopButton = requireElement<HTMLButtonElement>('start-stop')
  const burstButton = requireElement<HTMLButtonElement>('burst')
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

  // The legend mirrors the engine's own coloring, so it is built from the same
  // theme + colorForPath the forest uses and refreshed whenever the theme changes.
  renderLegend(legendGrid, themeSelect.value as ThemeName)

  // Build the engine. We start paused-following-live so the synthetic stream's
  // newest events drag the view, and pre-seed the known structure as dim nodes.
  let controller = createRunewood(canvasHost, {
    theme: 'dusk',
    bloom: 'high',
    showLabels: true,
    autoplay: true,
    followLive: true,
  })
  controller.seed(seedPaths())
  wireControllerLogging(controller)

  const stream = createSyntheticStream({
    eventsPerSecond: Number(rateInput.value),
    onEvent: (event) => controller.ingest(event),
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

  // Theme, bloom, and labels are construction-time options on the controller, so
  // changing them rebuilds it in place. We hand the fresh controller the same
  // seed and re-log clicks, then keep the stream pointed at it via `currentController`.
  themeSelect.addEventListener('change', () => {
    renderLegend(legendGrid, themeSelect.value as ThemeName)
    rebuild()
  })
  bloomSelect.addEventListener('change', () => rebuild())
  labelsToggle.addEventListener('change', () => rebuild())

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
    controller.destroy()
    controller = createRunewood(canvasHost, {
      theme: themeSelect.value as ThemeName,
      bloom: bloomSelect.value as BloomQuality,
      showLabels: labelsToggle.checked,
      autoplay: true,
      followLive: true,
    })
    controller.seed(seedPaths())
    wireControllerLogging(controller)
    // Repoint the stream's sink at the new controller by recreating nothing: the
    // closure already captures `controller` by reference through the outer binding,
    // so re-reading it on each emit picks up the rebuild. We just resume if needed.
    if (!wasRunning) {
      stream.stop()
    }
  }

  // The live state readout: a tiny JSON dump of `getState()`, refreshed on a timer
  // so an operator can watch the playhead, duration, and follow flag move.
  setInterval(() => {
    stateReadout.textContent = JSON.stringify(controller.getState(), null, 2)
  }, STATE_READOUT_INTERVAL_MS)
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

/** Fetches an element by id, throwing loudly if the page markup is missing it. */
function requireElement<Shape extends HTMLElement>(id: string): Shape {
  const element = document.getElementById(id)
  if (!element) {
    throw new Error(`Playground markup is missing the #${id} element`)
  }
  return element as Shape
}

main()
