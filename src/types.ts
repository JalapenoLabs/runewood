// Copyright © 2026 Jalapeno Labs

/**
 * What an actor did to a path. These map naturally from both git-style logs
 * (A/M/D) and live agent telemetry (file edits, reads, searches, commands):
 *
 * - `create` / `modify` / `delete`: the classic Gource verbs; they change the tree.
 * - `scan`: a non-mutating touch (read, grep, glob). Reveals and warms a node
 *   without implying the file changed.
 * - `pulse`: actor-level activity with no specific path (a shell command, a
 *   thought). Renders on the actor, not the tree.
 */
export type RunewoodAction = 'create' | 'modify' | 'delete' | 'scan' | 'pulse'

/**
 * One unit of activity to visualize. This is the entire input surface of the
 * engine: hosts map their domain (git commits, agent tool calls, CI events)
 * into a stream of these and feed them in via `ingest` or as a replay log.
 */
export type RunewoodEvent = {
  /** Epoch milliseconds. Events must be ingested in non-decreasing time order. */
  at: number
  /** Stable identifier of who acted (an agent, a task, a committer). */
  actor: string
  action: RunewoodAction
  /**
   * Slash-separated path within the forest, e.g. `seraphim/api/src/main.rs`.
   * The first segment is the tree root (one tree per repo makes a forest).
   * Absent for `pulse` events, which have no target.
   */
  path?: string
  /** Optional freeform display text (e.g. the shell command behind a pulse). */
  label?: string
}
