// Copyright © 2026 Jalapeno Labs

/**
 * A realistic multi-commit sample of the output of:
 *
 * ```sh
 * git log --reverse --name-status --pretty=format:'C|%H|%an|%aI'
 * ```
 *
 * It exercises several authors, the A/M/D statuses, a rename (`R096`), and a copy
 * (`C078`). Used by the adapter's tests and available for the playground to replay
 * a real-ish history without needing a checked-out repo. Kept as a `.ts` export
 * (rather than a raw asset) so it imports cleanly under both `tsc` and Vite with
 * no extra asset-loader or ambient module declarations.
 */
export const sampleGitLog = `C|9f1c0a7e2b4d6f8a0c1e3d5b7a9c2e4f6081a3c5|Ada Lovelace|2026-01-04T09:12:30+00:00

A\tsrc/index.ts
A\tsrc/core/tree.ts
A\tREADME.md
C|1a2b3c4d5e6f7081928374655647382910abcdef|Ada Lovelace|2026-01-05T14:03:11+00:00

M\tsrc/core/tree.ts
A\tsrc/core/timeline.ts
C|abcdef0192837465564738291011223344556677|Grace Hopper|2026-01-06T11:45:00-05:00

A\tsrc/core/layout.ts
M\tsrc/index.ts
D\tREADME.md
C|0011223344556677889900aabbccddeeff001122|Grace Hopper|2026-01-07T08:30:59-05:00

R096\tsrc/core/layout.ts\tsrc/core/physics.ts
M\tsrc/index.ts
C|feedface0000111122223333444455556666aaaa|Linus Torvalds|2026-01-08T22:15:42+02:00

C078\tsrc/core/tree.ts\tsrc/core/forest.ts
A\tsrc/core/picking.ts
`
