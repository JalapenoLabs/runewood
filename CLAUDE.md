# runewood

> Project memory for agents working **on** runewood. Read this first.

## What it is

Runewood is a framework-agnostic, WebGL visualization of activity flowing through
a file tree, inspired by [Gource](https://gource.io/) but rebuilt from scratch
for the browser. It animates a stream of small activity events (an AI agent
editing code, commits, CI runs) as a growing, glowing forest, with live play plus
exact rewind, scrub, and replay.

It is published to npm as `runewood` under the JalapenoLabs org. Its first
consumer is **Seraphim**'s watch page, but it must stay generic: no Seraphim,
React, or Svelte specifics in the core.

## Architectural pillars (do not violate)

1. **The core is framework-agnostic vanilla TypeScript.** The public surface is an
   imperative controller created against a DOM element (the xterm.js/chart.js
   shape). React/Svelte wrappers, when they exist, are thin and live in their own
   entry points; never import a framework into the core.
2. **Tree state is a pure fold over the event log.** The tree at time `t` is a
   deterministic reduction of all events with `at <= t` (see `src/core/tree.ts`).
   This is what makes the DATA `seek`/rewind exact and the core testable. Do not
   introduce forward-only mutable state into the *logical* tree itself: the fold,
   the actor tracking, and the collapse must stay pure functions of the event log.
   **The LAYOUT is the deliberate exception.** As of the force-directed migration,
   node *positions* come from a continuous, Gource-style physics simulation
   (`src/core/physics.ts`, `ForceLayout`) that is always gently settling and is
   forward-only visual state, NOT a pure function of the tree. A backward seek
   re-folds the (exact) tree and then resets + re-syncs the sim, which re-settles
   organically rather than reproducing pixel-exact prior positions. So: the data
   fold stays seek-exact; the layout no longer is, by design. (The old pure radial
   `computeTargets`/`stepSprings` in `src/core/layout.ts` are retained for reference
   but the controller no longer drives the layout from them.)
3. **Rendering is isolated behind an interface.** The first renderer targets
   WebGL2 (likely via a thin layer). Keep the scene/layout decoupled from the
   draw backend so it can be swapped.
4. **Events are the only input.** Hosts map their domain (git, agent telemetry,
   CI) into `RunewoodEvent`s. The library never reaches out to a data source
   itself.

## Repo layout

```
src/
  types.ts          RunewoodEvent + action union (the entire input surface)
  core/
    tree.ts         pure tree fold (createTree / seedTree / applyEvent)
    tree.test.ts    vitest coverage for the fold
  index.ts          public barrel export
eslint.config.ts    extends @jalapenolabs/cli/eslint
tsup.config.ts      build -> dist/ (ESM + .d.ts)
vitest.config.ts
.release-it.json    release config (patch bump, npm publish, GitHub release)
.github/workflows/  ci.yml (lint/typecheck/test/build), release.yml (main -> npm)
```

## Toolchain & conventions

- **Package manager: Yarn Berry**, pinned via `packageManager` (corepack). On
  this Windows host run it as `corepack yarn@<version> <cmd>` (the global `yarn`
  is classic 1.x, and `corepack enable` can hit an EPERM writing shims into
  `C:\Program Files`). On the Linux CI runner, `corepack enable` then `yarn`.
- **ESLint: the shared org config** `@jalapenolabs/cli/eslint` (Google-derived
  style: no semicolons, single quotes, 2-space indent, 120-col, `[ spaced ]`
  array brackets, `type` over `interface`, named exports only, license header).
  Pin **eslint to v9** — the org's plugins are not yet ESLint 10 compatible.
- **TypeScript is 6.x.** `tsconfig.json` sets `"ignoreDeprecations": "6.0"` so
  tsup's bundled dts step does not fail on the deprecated `baseUrl` it injects.
- **Tests: Vitest**, `*.test.ts` next to the source. Follow the org rule: tests
  assert real behavior, never just pass. Escalate bugs you find, don't paper
  over them.
- **Follow the global engineering conventions** (human readability first; read
  the applicable `~/.claude/docs/*.md` before editing).

## Local checks (must pass before pushing)

```bash
yarn lint && yarn typecheck && yarn test && yarn build
```

CI runs the same four on the self-hosted fedora runners for every PR and every
push to `main`/`develop`.

## Branching & releases

- **`develop`**: integration branch for rough/in-progress work; direct pushes are
  fine.
- **`main`**: stable. Every push to `main` triggers `.github/workflows/release.yml`,
  which patch-bumps the version, publishes to npm, and opens a GitHub Release via
  release-it. The release commit is tagged `[skip ci]` to avoid retriggering.
- Promote `develop` -> `main` as the package stabilizes.
- **Required secret:** `NPM_TOKEN` (npm automation token with publish rights) must
  be set on the repo for the release workflow. CI does not need it.

## Naming

"Runewood" is its own identity, not a Gource clone. Keep the magical-forest motif
(Thaumcraft-flavored: vis, aura, glowing wood) in user-facing copy; avoid copying
Gource's exact look or terminology 1:1.

## Git

Commit + push only when asked. **Never** add a co-author trailer. **No em
dashes** in any user-facing text (commits, PRs, UI, docs).
