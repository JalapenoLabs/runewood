// Copyright © 2026 Jalapeno Labs

/**
 * Pure path filtering for the forest (issue #180-adjacent). A host almost always
 * wants to omit noise like `node_modules`, `__pycache__`, `.git`, and build
 * output from the visualization; this module compiles an `include` (whitelist)
 * and `exclude` (blacklist) set of globs into a single predicate the controller
 * applies at ingest and seed time.
 *
 * Keeping it here, glob-compilation and all, means the whole filtering decision
 * is unit-testable without a canvas or a controller: the controller only calls
 * {@link compilePathFilter} once at construction and runs the returned predicate
 * over each event's path.
 *
 * Semantics (the contract the controller relies on):
 *
 *   keep(path) === (include is empty OR path matches some include)
 *                  AND path matches no exclude
 *
 * So an empty `include` means "everything is a candidate" and `exclude` only ever
 * subtracts. A path matched by both an include and an exclude is dropped: exclude
 * wins, which is what an operator expects when they whitelist `api/**` but still
 * blacklist `api/**\/node_modules/**`.
 *
 * Glob dialect (a compact, dependency-free subset of the usual shell globbing,
 * matched against slash-separated paths):
 *
 * - `*`  matches any run of characters except `/` (one path segment's worth).
 * - `**` matches any run of characters including `/` (spans path depth). The
 *   common `**\/` form also matches zero directories, so `**\/node_modules/**`
 *   catches a top-level `node_modules/...` as well as a nested one.
 * - `?`  matches exactly one character except `/`.
 * - `{a,b,c}` matches any one of the comma-separated alternatives (brace
 *   alternation). Nested braces are not supported (none of our patterns need it).
 *
 * We deliberately hand-roll the glob-to-RegExp compiler rather than pull in
 * `picomatch`: the dialect above is small, the package is meant to stay lean
 * (`sideEffects: false`, tree-shaken), and the edge cases we care about (the four
 * features above over `/`-joined paths) are easy to get right and to test
 * exhaustively. If a host ever needs full POSIX glob semantics (extglobs,
 * character classes, negation) reaching for `picomatch` would be justified, but
 * nothing in the forest's path space asks for that today.
 */

/** A compiled predicate: `true` keeps the path in the forest, `false` drops it. */
export type PathFilter = (path: string) => boolean

/** The include / exclude glob arrays a host configures filtering with. */
export type PathFilterOptions = {
  /**
   * Whitelist globs. When non-empty, a path is only kept if it matches at least
   * one of these. Empty (the default) means every path is a candidate.
   */
  include?: string[]
  /**
   * Blacklist globs. A path matching any of these is always dropped, even if it
   * also matched an include. This is where `**\/node_modules/**` and friends go.
   */
  exclude?: string[]
}

/**
 * Compiles `include` / `exclude` globs into a single {@link PathFilter}. The
 * globs are compiled to anchored regular expressions once, here, so the returned
 * predicate is a tight per-path test with no recompilation. An empty / omitted
 * `include` and `exclude` yields a predicate that keeps everything.
 */
export function compilePathFilter(options: PathFilterOptions = {}): PathFilter {
  const includeMatchers = (options.include ?? []).map(globToRegExp)
  const excludeMatchers = (options.exclude ?? []).map(globToRegExp)

  return (path: string): boolean => {
    // Exclude wins over include: a blacklisted path is dropped no matter what.
    for (const matcher of excludeMatchers) {
      if (matcher.test(path)) {
        return false
      }
    }
    // An empty whitelist means "no positive constraint": everything not excluded
    // is kept. A non-empty whitelist requires at least one match.
    if (includeMatchers.length === 0) {
      return true
    }
    for (const matcher of includeMatchers) {
      if (matcher.test(path)) {
        return true
      }
    }
    return false
  }
}

/**
 * Compiles one glob string into an anchored {@link RegExp} matching whole paths.
 * Walks the pattern character by character so each glob feature is translated in
 * context (notably `**` vs `*`, and `**\/` collapsing the following slash so it
 * can match zero directories). Every literal character is escaped for RegExp, so
 * a path with regex-special characters (`.`, `+`, parentheses) is matched
 * literally rather than as a pattern.
 */
function globToRegExp(glob: string): RegExp {
  let pattern = ''
  let index = 0

  while (index < glob.length) {
    const character = glob[index]

    if (character === '*') {
      const isDoubleStar = glob[index + 1] === '*'
      if (isDoubleStar) {
        // `**/` matches any depth INCLUDING zero directories, so a single pattern
        // like `**/node_modules/**` catches both top-level and nested hits. We
        // consume the trailing slash and emit a group that optionally includes it.
        if (glob[index + 2] === '/') {
          pattern += '(?:.*/)?'
          index += 3
          continue
        }
        // A bare `**` (no following slash) matches anything across segments.
        pattern += '.*'
        index += 2
        continue
      }
      // A single `*` matches within one segment: anything but a slash.
      pattern += '[^/]*'
      index += 1
      continue
    }

    if (character === '?') {
      // `?` matches exactly one non-slash character.
      pattern += '[^/]'
      index += 1
      continue
    }

    if (character === '{') {
      const closingIndex = glob.indexOf('}', index)
      if (closingIndex !== -1) {
        const alternatives = glob.slice(index + 1, closingIndex).split(',')
        const escapedAlternatives = alternatives.map((alternative) => escapeRegExp(alternative))
        pattern += `(?:${escapedAlternatives.join('|')})`
        index = closingIndex + 1
        continue
      }
      // An unbalanced `{` is a literal brace, not an alternation.
      pattern += escapeRegExp(character)
      index += 1
      continue
    }

    pattern += escapeRegExp(character)
    index += 1
  }

  // Anchor to the whole path so a glob describes the entire path, not a substring
  // (otherwise `node_modules` would match `my_node_modules_thing`).
  return new RegExp(`^${pattern}$`)
}

/** Escapes a single character (or short alternative) for safe literal use in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
