// Copyright © 2026 Jalapeno Labs

/**
 * The single color representation used across the engine. Hue is in degrees
 * (`0..360`), saturation and lightness are fractions (`0..1`).
 *
 * HSL (not hex, not RGB) is the deliberate choice: every color decision in
 * Runewood is fundamentally a *hue* pick (a file's language, an actor's
 * identity), and a WebGL renderer wants to push that hue toward white as a node
 * heats up or bloom builds. Keeping the canonical form HSL means the renderer
 * brightens a node by nudging `l` and saturates a glow by nudging `s` without
 * ever round-tripping through hex parsing. Hosts that need a CSS string can
 * format it themselves; the engine never needs one internally.
 */
export type Hsl = {
  /** Hue in degrees, `0..360`. */
  h: number
  /** Saturation as a fraction, `0..1`. */
  s: number
  /** Lightness as a fraction, `0..1`. */
  l: number
}

/**
 * A complete set of visual-style decisions for the forest. A renderer is handed
 * one of these (a built-in, or a built-in merged with caller overrides) and
 * reads every global color/intensity knob from it.
 */
export type RunewoodTheme = {
  /** Human-readable name of the theme, e.g. `dusk`. */
  name: string
  /** The canvas/scene background fill. */
  background: Hsl
  /** Color of the branches (the edges connecting tree nodes). */
  branch: Hsl
  /** Color of node labels / text. */
  label: Hsl
  /**
   * How strongly hot nodes bloom, `0..1`. The renderer scales its bloom pass by
   * this; `0` disables bloom, `1` is the most intense glow.
   */
  bloomIntensity: number
  /**
   * How quickly a node's glow falls off with distance, `> 0`. Larger values
   * make a tighter, more contained halo; smaller values let light spread.
   */
  glowFalloff: number
}

/**
 * The saturation and lightness every *generated* hue (file extensions, actors)
 * is rendered at. The hue is what varies and carries the meaning; pinning S and
 * L keeps the whole forest at one consistent vividness so two different files
 * read as "different color", never "different brightness".
 */
const NODE_SATURATION = 0.62
const NODE_LIGHTNESS = 0.55

/**
 * Curated hues (in degrees) for common file extensions, Gource-style. The key is
 * the lowercased extension *without* the dot. Anything not listed here falls
 * back to a deterministic hash of the extension, so unknown types still get a
 * stable, distinct color; this table just pins the languages a viewer sees most
 * so they land on a recognizable, intentional color instead of a hash lottery.
 *
 * Hues are spread around the wheel and grouped loosely by family (web/script
 * warm, systems cool, data/markup green-teal, config/ops violet) so a typical
 * repo reads as a legible palette rather than noise.
 */
const hueByExtension = {
  // Web + scripting
  ts: 211, // TypeScript blue
  tsx: 199,
  js: 49, // JavaScript yellow
  jsx: 39,
  py: 220, // Python blue
  rb: 2, // Ruby red
  php: 262,
  // Systems
  rs: 18, // Rust orange-rust
  go: 187, // Go cyan
  c: 207,
  cpp: 217,
  h: 232,
  java: 27,
  kt: 281,
  swift: 14,
  cs: 124,
  // Data + markup
  json: 90,
  yaml: 140,
  yml: 140,
  toml: 152,
  xml: 96,
  html: 12,
  css: 318,
  scss: 330,
  md: 168,
  sql: 175,
  graphql: 300,
  // Shell + ops
  sh: 105,
  bash: 105,
  zsh: 110,
  dockerfile: 197,
  lock: 47,
  env: 60,
} as const satisfies Record<string, number>

/** The built-in themes, keyed by name so callers can resolve one by string. */
const builtInThemes = {
  /**
   * `dusk`: the default. A deep blue-violet twilight that lets glowing wood pop
   * without washing out, with a soft, spreading bloom.
   */
  dusk: {
    name: 'dusk',
    background: { h: 240, s: 0.32, l: 0.10 },
    branch: { h: 250, s: 0.22, l: 0.42 },
    label: { h: 240, s: 0.18, l: 0.86 },
    bloomIntensity: 0.65,
    glowFalloff: 1.4,
  },
  /**
   * `void`: near-black, high-contrast, minimal ambient color. The forest is the
   * only light source; bloom is dialed up and kept tight for a stark look.
   */
  void: {
    name: 'void',
    background: { h: 0, s: 0, l: 0.03 },
    branch: { h: 0, s: 0, l: 0.30 },
    label: { h: 0, s: 0, l: 0.92 },
    bloomIntensity: 0.85,
    glowFalloff: 2.1,
  },
  /**
   * `parchment`: a warm, light theme for screenshots and docs. Dark ink on aged
   * paper; bloom is restrained since there is little darkness to glow against.
   */
  parchment: {
    name: 'parchment',
    background: { h: 42, s: 0.38, l: 0.90 },
    branch: { h: 34, s: 0.30, l: 0.48 },
    label: { h: 28, s: 0.45, l: 0.20 },
    bloomIntensity: 0.30,
    glowFalloff: 1.0,
  },
} as const satisfies Record<string, RunewoodTheme>

/** Names of the built-in themes, for callers iterating or building a picker. */
export type ThemeName = keyof typeof builtInThemes

export const themes = builtInThemes

/** The theme used when a caller asks for none: `dusk`. */
export const defaultTheme: RunewoodTheme = builtInThemes.dusk

/**
 * FNV-1a 32-bit hash of a string: stable, fast, dependency-free, and well
 * distributed across the low bits we map to a hue. Mirrors the hash used by the
 * layout jitter so the engine has one hashing story.
 */
function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    // FNV prime multiply expressed as shifts to stay in 32-bit integer math.
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return hash >>> 0
}

/** Maps any string to a stable, well-spread hue in `[0, 360)` via its hash. */
function hueFromHash(value: string): number {
  return hashString(value) % 360
}

/**
 * The color for a file node, chosen from its extension. A curated language gets
 * its intentional hue; everything else falls back to a deterministic hash of the
 * extension (or of the whole path, for extension-less files like `Makefile`) so
 * unknown types are still stable and distinct. Saturation and lightness are
 * fixed so only the hue (the meaning) varies.
 *
 * Pure: identical `path` always yields the identical color, with no time or
 * randomness, so a rewound timeline repaints every node exactly.
 */
export function colorForPath(path: string): Hsl {
  const fileName = path.slice(path.lastIndexOf('/') + 1)
  const lastDot = fileName.lastIndexOf('.')

  // A leading-dot dotfile (`.env`) is treated as the extension being its own
  // name; a genuine extension-less file (`Makefile`, lastDot <= 0 with content
  // before it) hashes the whole path so it still gets a stable color.
  let extension = ''
  if (lastDot === 0) {
    extension = fileName.slice(1).toLowerCase()
  }
  else if (lastDot > 0) {
    extension = fileName.slice(lastDot + 1).toLowerCase()
  }

  if (!extension) {
    return { h: hueFromHash(path), s: NODE_SATURATION, l: NODE_LIGHTNESS }
  }

  const curatedHue = (hueByExtension as Record<string, number | undefined>)[extension]
  const hue = curatedHue ?? hueFromHash(extension)
  return { h: hue, s: NODE_SATURATION, l: NODE_LIGHTNESS }
}

/**
 * The color for an actor (an agent, a committer, a task), chosen by a
 * deterministic hash of its identifier so the same actor is always the same
 * color and different actors spread well around the wheel. Same fixed S/L as
 * file nodes so actors and files share one coherent palette.
 *
 * Pure: identical `actor` always yields the identical color.
 */
export function colorForActor(actor: string): Hsl {
  return { h: hueFromHash(actor), s: NODE_SATURATION, l: NODE_LIGHTNESS }
}

/**
 * A caller-supplied partial theme. Every field is optional, and the three color
 * fields accept a partial {@link Hsl} so a host can override just a hue and keep
 * the base saturation and lightness. This is the shape {@link mergeTheme} takes.
 */
export type RunewoodThemeOverrides = {
  name?: string
  background?: Partial<Hsl>
  branch?: Partial<Hsl>
  label?: Partial<Hsl>
  bloomIntensity?: number
  glowFalloff?: number
}

/**
 * Produces a concrete theme from a base built-in (default `dusk`) plus an
 * optional partial override. Any field the caller supplies wins; everything
 * else is inherited from the base, so a host can recolor just the background or
 * dial back bloom without restating the whole theme.
 *
 * The merge is shallow-with-nested-color awareness: the four scalar fields
 * replace wholesale, while the three `Hsl` fields merge per channel so a caller
 * can override only a hue and keep the base saturation and lightness.
 */
export function mergeTheme(base: RunewoodTheme, overrides: RunewoodThemeOverrides = {}): RunewoodTheme {
  return {
    name: overrides.name ?? base.name,
    background: { ...base.background, ...overrides.background },
    branch: { ...base.branch, ...overrides.branch },
    label: { ...base.label, ...overrides.label },
    bloomIntensity: overrides.bloomIntensity ?? base.bloomIntensity,
    glowFalloff: overrides.glowFalloff ?? base.glowFalloff,
  }
}
