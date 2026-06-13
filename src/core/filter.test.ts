// Copyright © 2026 Jalapeno Labs

// Core
import { describe, expect, it } from 'vitest'

import { compilePathFilter } from './filter'

describe('compilePathFilter', () => {
  describe('the empty / default filter', () => {
    it('keeps every path when neither include nor exclude is given', () => {
      const keep = compilePathFilter()

      expect(keep('api/src/main.rs')).toBe(true)
      expect(keep('frontend/node_modules/react/index.js')).toBe(true)
      expect(keep('')).toBe(true)
    })

    it('keeps every path when both arrays are explicitly empty', () => {
      const keep = compilePathFilter({ include: [], exclude: []})

      expect(keep('anything/at/all.ts')).toBe(true)
    })
  })

  describe('exclude-only (blacklist)', () => {
    it('drops a path matched by an exclude and keeps the rest', () => {
      const keep = compilePathFilter({ exclude: [ '**/node_modules/**' ]})

      expect(keep('api/node_modules/lodash/index.js')).toBe(false)
      expect(keep('api/src/main.ts')).toBe(true)
    })

    it('drops a top-level match because **/ also matches zero directories', () => {
      const keep = compilePathFilter({ exclude: [ '**/node_modules/**' ]})

      // No leading directory before node_modules: the **/ must match zero dirs.
      expect(keep('node_modules/react/index.js')).toBe(false)
    })

    it('honors several exclude patterns at once', () => {
      const keep = compilePathFilter({
        exclude: [ '**/node_modules/**', '**/__pycache__/**', '**/.git/**', '**/dist/**' ],
      })

      expect(keep('api/node_modules/x.js')).toBe(false)
      expect(keep('service/__pycache__/mod.pyc')).toBe(false)
      expect(keep('repo/.git/config')).toBe(false)
      expect(keep('frontend/dist/bundle.js')).toBe(false)
      expect(keep('frontend/src/app.tsx')).toBe(true)
    })
  })

  describe('include-only (whitelist)', () => {
    it('keeps only paths matching an include', () => {
      const keep = compilePathFilter({ include: [ 'api/**' ]})

      expect(keep('api/src/main.rs')).toBe(true)
      expect(keep('frontend/src/app.tsx')).toBe(false)
    })

    it('keeps a path matching any one of several includes', () => {
      const keep = compilePathFilter({ include: [ 'api/**', 'frontend/**' ]})

      expect(keep('api/src/main.rs')).toBe(true)
      expect(keep('frontend/src/app.tsx')).toBe(true)
      expect(keep('docs/readme.md')).toBe(false)
    })
  })

  describe('include and exclude together', () => {
    it('keeps a path in the whitelist that is not blacklisted', () => {
      const keep = compilePathFilter({ include: [ 'api/**' ], exclude: [ '**/node_modules/**' ]})

      expect(keep('api/src/main.rs')).toBe(true)
    })

    it('lets exclude win over include for a path matched by both', () => {
      const keep = compilePathFilter({ include: [ 'api/**' ], exclude: [ '**/node_modules/**' ]})

      // Whitelisted by `api/**` but blacklisted by node_modules: exclude wins.
      expect(keep('api/node_modules/lodash/index.js')).toBe(false)
    })

    it('drops a path outside the whitelist even when no exclude matches', () => {
      const keep = compilePathFilter({ include: [ 'api/**' ], exclude: [ '**/dist/**' ]})

      expect(keep('frontend/src/app.tsx')).toBe(false)
    })
  })

  describe('representative ingest paths', () => {
    it('separates a vendored file from a source file under the same repo', () => {
      const keep = compilePathFilter({ exclude: [ '**/node_modules/**' ]})

      expect(keep('api/node_modules/x.js')).toBe(false)
      expect(keep('api/src/x.ts')).toBe(true)
    })
  })

  describe('glob feature: single star (one segment)', () => {
    it('matches within a single path segment but not across a slash', () => {
      const keep = compilePathFilter({ include: [ 'api/*/main.ts' ]})

      expect(keep('api/src/main.ts')).toBe(true)
      // `*` must not cross a slash, so a two-level middle does not match.
      expect(keep('api/src/deep/main.ts')).toBe(false)
    })

    it('matches a partial segment', () => {
      const keep = compilePathFilter({ include: [ 'src/*.test.ts' ]})

      expect(keep('src/filter.test.ts')).toBe(true)
      expect(keep('src/filter.ts')).toBe(false)
    })
  })

  describe('glob feature: double star (any depth)', () => {
    it('spans any number of directories', () => {
      const keep = compilePathFilter({ include: [ 'api/**/main.rs' ]})

      expect(keep('api/main.rs')).toBe(true)
      expect(keep('api/src/main.rs')).toBe(true)
      expect(keep('api/src/very/deep/main.rs')).toBe(true)
      expect(keep('frontend/src/main.rs')).toBe(false)
    })

    it('matches anything as a trailing **', () => {
      const keep = compilePathFilter({ include: [ 'api/**' ]})

      expect(keep('api/a')).toBe(true)
      expect(keep('api/a/b/c.ts')).toBe(true)
    })
  })

  describe('glob feature: question mark (one character)', () => {
    it('matches exactly one non-slash character', () => {
      const keep = compilePathFilter({ include: [ 'v?/index.ts' ]})

      expect(keep('v1/index.ts')).toBe(true)
      expect(keep('v2/index.ts')).toBe(true)
      // Two characters do not match a single `?`.
      expect(keep('v10/index.ts')).toBe(false)
      // `?` does not cross a slash.
      expect(keep('v/index.ts')).toBe(false)
    })
  })

  describe('glob feature: brace alternation', () => {
    it('matches any one of the alternatives', () => {
      const keep = compilePathFilter({ exclude: [ '**/{dist,build,out}/**' ]})

      expect(keep('api/dist/x.js')).toBe(false)
      expect(keep('api/build/x.js')).toBe(false)
      expect(keep('api/out/x.js')).toBe(false)
      expect(keep('api/src/x.ts')).toBe(true)
    })

    it('combines brace alternation with a star for extensions', () => {
      const keep = compilePathFilter({ include: [ 'src/*.{ts,tsx}' ]})

      expect(keep('src/app.ts')).toBe(true)
      expect(keep('src/app.tsx')).toBe(true)
      expect(keep('src/app.js')).toBe(false)
    })
  })

  describe('literal characters are matched literally', () => {
    it('treats regex-special characters in a glob as literals', () => {
      const keep = compilePathFilter({ include: [ 'api/a.b+c/file.ts' ]})

      expect(keep('api/a.b+c/file.ts')).toBe(true)
      // The `.` is a literal dot, not "any character", so this near-miss fails.
      expect(keep('api/axbxc/file.ts')).toBe(false)
    })

    it('anchors the whole path so a glob is not a loose substring', () => {
      const keep = compilePathFilter({ exclude: [ 'node_modules' ]})

      // Exact match is excluded, but a path merely containing the word is not.
      expect(keep('node_modules')).toBe(false)
      expect(keep('my_node_modules_thing/file.ts')).toBe(true)
    })
  })
})
