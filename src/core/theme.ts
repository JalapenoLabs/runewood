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
  /**
   * Color of a *directory* node disc: a neutral, desaturated "hub" the vividly
   * colored file nodes hang off of. Kept deliberately low-saturation and distinct
   * from every file hue so folder vs file reads at a glance: directories look like
   * structural wood, files look like their language.
   */
  hub: Hsl
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
const NODE_SATURATION = 0.85
const NODE_LIGHTNESS = 0.58

/**
 * Curated hues (in degrees) for common file extensions, Gource-style. The key is
 * the lowercased extension *without* the dot. Anything not listed here falls
 * back to a deterministic hash of the extension, so unknown types still get a
 * stable, distinct color; this table just pins the languages a viewer sees most
 * so they land on a recognizable, intentional color instead of a hash lottery.
 *
 * The hues are deliberately spread far apart for the languages a viewer sees most
 * (ts/py/rs/go/js and friends) so adjacent families never collide into the same
 * color. Related variants share a recognizable hue but are nudged a few degrees
 * apart (ts vs tsx, css vs scss, yaml vs toml) so a glance still tells them apart
 * without losing the family resemblance. Everything is rendered at the high fixed
 * {@link NODE_SATURATION}, so these hues read as vivid, saturated colors.
 */
const hueByExtension = {
  // TypeScript / JavaScript: the blue and yellow poles, far apart on the wheel.
  ts: 210, // TypeScript blue
  tsx: 195, // TS + JSX, nudged toward cyan
  js: 50, // JavaScript yellow
  jsx: 38, // JS + JSX, nudged toward amber
  // Python: a clearly green-leaning yellow, well clear of the TS blues.
  py: 84, // Python yellow-green
  // Ruby: vivid red.
  rb: 354,
  php: 264, // PHP indigo
  // Systems languages, each on its own well-separated hue.
  rs: 22, // Rust burnt orange
  go: 184, // Go cyan
  c: 228, // C deep blue
  cpp: 246, // C++ blue-violet, a step off C
  h: 213, // headers: a lighter blue sibling of C
  java: 32, // Java orange
  kt: 288, // Kotlin purple
  swift: 12, // Swift orange-red
  cs: 132, // C# green
  // Data + markup.
  json: 70, // JSON: gold, clear of both JS yellow and Python yellow-green
  yaml: 156, // YAML green-teal
  yml: 156,
  toml: 174, // TOML teal, a step off YAML
  xml: 108, // XML lime
  html: 18, // HTML orange-red
  css: 318, // CSS magenta
  scss: 332, // SCSS pink, a step off CSS
  md: 168, // Markdown teal-green
  sql: 200, // SQL sky blue
  graphql: 300, // GraphQL magenta-purple
  // Shell + ops.
  sh: 96, // shell green
  bash: 96,
  zsh: 102,
  dockerfile: 198, // Docker blue
  lock: 44, // lockfiles amber
  env: 58, // dotenv amber-yellow
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
    // A pale, almost-grey lilac: clearly lighter and far less saturated than any
    // file hue, so directories read as neutral hubs against the vivid files.
    hub: { h: 245, s: 0.12, l: 0.70 },
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
    // Pure neutral grey: in the colorless void theme a directory is simply a
    // bright grey hub, leaving all the color to the file nodes.
    hub: { h: 0, s: 0, l: 0.62 },
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
    // A muted aged-ink brown, darker than the paper so a directory reads on the
    // light background, but desaturated so it stays neutral against the files.
    hub: { h: 34, s: 0.22, l: 0.42 },
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
  hub?: Partial<Hsl>
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
    hub: { ...base.hub, ...overrides.hub },
    label: { ...base.label, ...overrides.label },
    bloomIntensity: overrides.bloomIntensity ?? base.bloomIntensity,
    glowFalloff: overrides.glowFalloff ?? base.glowFalloff,
  }
}
