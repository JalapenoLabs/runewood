// Copyright © 2026 Jalapeno Labs

import { defineConfig } from 'tsup'

export default defineConfig({
  // Object form pins each output basename. `git` -> dist/git.js (not
  // dist/adapters/git.js), so the `runewood/git` subpath export resolves and the
  // adapter stays a standalone, tree-shakeable bundle separate from the core.
  entry: {
    index: 'src/index.ts',
    git: 'src/adapters/git.ts',
  },
  format: [ 'esm' ],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
})
