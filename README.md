# runewood

> A glowing, organic visualization of activity flowing through a file tree.
> Framework-agnostic, WebGL-rendered, built for live streams and instant replay.

Runewood is a [Gource](https://gource.io/)-inspired visualization, rebuilt from
scratch for the browser. Where Gource animates git history, runewood animates
**any** stream of activity over a file forest: an AI agent editing code, commits
landing, CI touching files. You feed it a stream of small events and it grows a
luminous tree you can watch live, then rewind, scrub, and replay.

It ships as a vanilla TypeScript core with an imperative API, so it drops into
React, Svelte, or plain DOM with no framework lock-in. The host owns a `<div>`;
runewood owns everything inside it.

## Status

Early foundation. The pure event-and-tree core and its tests are in place; the
WebGL renderer, timeline/playback, and framework wrappers are tracked as issues.
See the [issue tracker](https://github.com/JalapenoLabs/runewood/issues).

## Install

```bash
yarn add runewood
```

## The idea in one minute

Everything runewood draws is a fold over a stream of [`RunewoodEvent`](src/types.ts)s:

```ts
type RunewoodEvent = {
  at: number                 // epoch ms, fed in time order
  actor: string              // who acted (an agent, a committer)
  action: 'create' | 'modify' | 'delete' | 'scan' | 'pulse'
  path?: string              // 'repo/src/main.rs' — first segment is the tree root
  label?: string             // optional display text
}
```

Because the tree at any moment is a **pure reduction** of the events up to that
moment, seeking is exact: jump to any timestamp and re-fold. That is the design
choice that makes rewind and scrubbing work, and it keeps the core trivially
unit-testable. (Contrast Gource's stateful physics, which can only run forward.)

A forest, not a single tree: the first path segment is the root, so cloning many
repos flat (`repo-a/...`, `repo-b/...`) renders as several trees and you watch an
actor travel between them.

## Intended API (target shape)

```ts
import { createRunewood } from 'runewood'

const viz = createRunewood(container, { theme: 'dusk' })

viz.seed(await listFiles())        // optional: dim, undiscovered structure
viz.ingest({ at: Date.now(), actor: 'agent', action: 'modify', path: 'repo/src/main.rs' })

viz.play()
viz.pause()
viz.seek(timestamp)                // frame-accurate scrub, forward or back
viz.setSpeed(4)
viz.follow('live')                 // pin the playhead to now
```

The renderer and this controller surface are still being built; the event and
tree primitives below are stable today.

## Develop

```bash
yarn install
yarn test         # vitest
yarn typecheck    # tsc --noEmit
yarn lint         # eslint (shared @jalapenolabs/cli config)
yarn build        # tsup -> dist/ (ESM + .d.ts)
```

Branches: `develop` is the integration branch for in-progress work; `main` is
stable and every push to it cuts a patch release to npm. Promote `develop` into
`main` as it stabilizes.

## Playground

A local dev playground (a Vite app under `playground/`) drives the real engine
live with a synthetic event stream, so the renderer and controls can be developed
and demoed without any host. It imports the library straight from `src`, so it
also serves as an end-to-end integration check.

```bash
yarn playground         # dev server with hot reload
yarn playground:build   # production bundle of the playground (integration proof)
```

The page fills the viewport with the runewood canvas and shows a small control
panel: start/stop the synthetic stream, fire a burst, change the emission rate,
toggle play/pause, and switch theme (dusk/void/parchment), bloom (off/low/high),
and labels. A live `getState()` readout sits in the panel, and `nodeClick` /
`actorClick` log to the console. The synthetic generator fakes a swarm of agents
crawling a multi-repo forest (reads, edits, creates, deletes, cross-repo hops,
pathless pulses) and deliberately exercises bursts, idle gaps, whole-directory
deletes, many concurrent actors, and deep paths.

The playground is dev-only: it is excluded from the published package (`files` is
just `dist`), so it never ships to npm.

## License

MIT © Jalapeno Labs
