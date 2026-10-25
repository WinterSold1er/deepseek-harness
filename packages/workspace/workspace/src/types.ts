/**
 * Public type vocabulary of the workspace entity: the `WorkspaceId` brand and
 * the `Workspace` consumer interface. Types only — the `WorkspaceId` factory
 * lives in `index.ts` (this file carries no runtime code).
 * @module @deepseek-ai/dsh-workspace/src/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TypertResource } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Identifies one workspace record. A generated uuid, never the path: path
 * normalization rewrites paths, and a reference anchor must stay stable.
 */
export type WorkspaceId = Branded<'WorkspaceId'>

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertResourceMap {
    /** One Workspace; the Workspace Controller registers its default `workspaceId` wire field. */
    workspace: TypertResource<WorkspaceId>
  }

  interface RemoteErrorDetailsMap {
    /** No registration carries that Workspace identity. */
    'workspace/not-found': { readonly workspaceId: WorkspaceId }
  }
}

/**
 * Activity families a `workspace/session-activity` listener may report. This
 * package declares none: each provider merges its own key from a module both
 * its Host and Client faces import, so a consumer that renders the families
 * sees exactly the keys its program compiled and falls through to a generic
 * description for any other. The shipped providers merge `turn` (the Agent
 * registry), `job` (the job registry seam), `subagent` (the Subagent
 * runtime), and `schedule` (the Schedule plugin).
 */
export interface SessionActivityKindMap {}

/** One activity family key. */
export type SessionActivityKind = keyof SessionActivityKindMap

/** One active item of a family that has per-item identity. */
export interface SessionActivityItem {
  /** Family-specific identity: a session id, a job id, or a schedule id. */
  readonly id: string
  /** Display label when the family carries one (a job label, a subagent label). */
  readonly label?: string
}

/**
 * One reason a session counts as active for archive admission. Families with
 * per-item identity list their items so a caller can name what must stop.
 */
export interface SessionActivity {
  readonly kind: SessionActivityKind
  /** Active items of the family; absent for a family without per-item identity (`turn`). */
  readonly items?: readonly SessionActivityItem[]
}

/**
 * One workspace: a stable id over an existing directory, a display title, and
 * an ordered candidate account of sessions. Membership validates header cwd
 * against the workspace path, but preserves an existing account when its
 * fully qualified cwd is missing. Consumers only see this interface; the
 * implementation stays private.
 */
export interface Workspace {
  /** Stable record id (generated uuid). */
  readonly id: WorkspaceId

  /**
   * Canonical directory path: the `fs.realpath` of the path given at create
   * time (trailing slashes, `..`, and symlinks all resolved). Never rewritten
   * afterwards, even when the directory disappears (see {@link status}).
   */
  readonly path: string

  /** Display title. Defaults to the final path segment, or a filesystem root's own spelling; duplicates are allowed. */
  readonly title: string

  /** ISO-8601 creation instant, stamped at create and never rewritten. */
  readonly createdAt: string

  /** ISO-8601 instant of the last durable mutation (create counts as one). */
  readonly updatedAt: string

  /**
   * Header-validated sessions in manually owned order: a new session is
   * prepended at attach, explicit reordering goes through
   * `insertSessionBefore`, and activity never reorders. The durable candidate
   * account is filtered synchronously: a candidate is visible only when it is
   * valid (a readable header whose fully qualified cwd resolves to an existing
   * directory equal to this path) or missing-directory (that resolve fails with
   * ENOENT only, so the directory may just have moved, including a dangling
   * symlink). Invalid candidates (no cwd, a non-absolute cwd, a resolve failure
   * for any other reason, a canonical cwd that is not a directory, or a
   * canonical cwd at a different directory) are the only candidates an accepted
   * mutation prunes, and every prune warns. Unknown candidates — an unreadable
   * or absent header, a failed resolve or check, or a listing that never
   * covered the id — stay durable, hidden from this projection, and warned
   * once. Startup reconciliation and every later mutation prune invalid
   * candidates, never missing-directory or unknown ones. Other than an invalid
   * prune, the only removal from this account is {@link detachSession}. This
   * does not admit new sessions or recreate directories.
   */
  readonly sessionIds: readonly SessionId[]

  /**
   * Replace the display title durably.
   * @param title - New title; any string, duplicates across workspaces allowed.
   * @returns resolution after durability.
   */
  setTitle(title: string): Promise<void>

  /**
   * Prepend a session to this workspace's candidate account. An already
   * accounted id resolves without writing, aside from the durable
   * invalid-candidate prune every accepted mutation performs. A new id's
   * live or persisted
   * header cwd must resolve to an existing directory equal to {@link path};
   * unknown ids, missing or invalid cwd values, and mismatches reject without
   * writing. An id this workspace detached earlier is admitted and its detach
   * tombstone is cleared, so a manual attach brings a detached session back.
   * @param sessionId - The session to record.
   * @returns resolution after durability.
   */
  attachSession(sessionId: SessionId): Promise<void>

  /**
   * Move an accounted session within the manual order, DOM-insertBefore-like:
   * with an anchor the session lands before it, without one it appends to the
   * end. Only the moved id changes position. A session or anchor absent from
   * the account rejects without writing; a move to the current position
   * resolves without writing, aside from the durable invalid-candidate
   * prune every accepted mutation performs; decided on the domain write
   * chain.
   * @param sessionId - The accounted session to move.
   * @param beforeSessionId - Accounted anchor to insert before; omitted appends.
   * @returns resolution after durability.
   */
  insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void>

  /**
   * Remove a session from this workspace's account. This is the only removal
   * from membership that a restart cannot undo: the id is recorded as detached
   * in the same mutation, so startup reconciliation and every later reconcile
   * pass skip it, and a later {@link attachSession} clears
   * that record. Idempotent: an id not on the account resolves without
   * writing, whether or not it is already recorded as detached, aside from the
   * durable invalid-candidate prune every accepted mutation performs; decided
   * on the domain write chain like attach. Never touches the session's own
   * stored log, and an invalid prune is not a detach: a pruned id a later
   * pass covers is admitted again.
   * @param sessionId - The session to remove.
   * @returns resolution after durability.
   */
  detachSession(sessionId: SessionId): Promise<void>

  /**
   * Live directory check, uncached: whether {@link path} currently exists and
   * is a directory. A missing directory never mutates the record — the
   * directory may only be temporarily moved.
   * @returns `'ok'` when the directory exists, `'missing-dir'` otherwise.
   */
  status(): Promise<'ok' | 'missing-dir'>
}
