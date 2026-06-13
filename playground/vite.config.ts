// Copyright © 2026 Jalapeno Labs

import { defineConfig } from 'vite'

/**
 * Vite config for the dev playground. The root is this `playground/` directory, so
 * `index.html` and `main.ts` resolve relative to it while still importing the
 * library straight from `../src` (the real engine, pixi and all). Build output
 * goes to `playground/dist`, kept out of the published package by `files` and by
 * the library's own `dist/` gitignore not covering this subtree (it is dev-only).
 */
export default defineConfig({
  root: __dirname,
  // Relative base so the built bundle works when opened from any path, not just a
  // server root; it is a throwaway dev artifact, never deployed under a fixed host.
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
