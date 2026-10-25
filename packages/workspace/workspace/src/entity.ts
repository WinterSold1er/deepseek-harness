/**
 * Package-private workspace entity: the single {@link Workspace}
 * implementation. Holds a record snapshot that is swapped in place after each
 * durable mutation; every write funnels through the private `mutate` so
 * `updatedAt` stamping and confirmed-stale pruning happen exactly once.
 * Not re-exported from the package entrypoint — consumers see only the
 * `Workspace` interface.
 * @module @deepseek-ai/dsh-workspace/src/entity
 */

import { stat } from 'node:fs/promises'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { WorkspaceRecord } from './spec.ts'
import type { Workspace, WorkspaceId } from './types.ts'
import { realpathNormalize } from './paths.ts'

/** An insertSessionBefore request named a session or anchor not on the account (storage failures stay plain errors). */
export class WorkspaceMoveInvalidError extends Error {
  /**
   * @param message - Which id was unaccounted and where.
   */
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceMoveInvalidError'
  }
}

/**
 * How the header index classifies one recorded session against a workspace
 * path. `valid` has a readable header whose fully qualified cwd resolves to an
 * existing directory equal to the path. `missing-dir` has a readable header
 * whose fully qualified cwd fails to resolve with `ENOENT` only, so the
 * directory may have been moved temporarily. `invalid` is confirmed staleness
 * carried by the header itself: no cwd, a non-absolute cwd, a resolve failure
 * for any other reason, a canonical cwd that is not a directory, or a canonical
 * cwd at a different directory — the only state an accepted mutation prunes.
 * `unknown` means no index pass covers the id: an unreadable header (including
 * an absent one), a permission, timeout, or corruption failure, or a listing
 * that never included the id. Only `invalid` is prunable; `valid` and
 * `missing-dir` stay visible; `unknown` stays durable and hidden.
 */
export type CandidateState = 'valid' | 'missing-dir' | 'invalid' | 'unknown'

/**
 * The registry-owned machinery an entity mutates through. Entities never see
 * the registry itself — only the open table, the canonical session-path
 * index backing the `sessionIds` projection, and attach-time header reads.
 */
export interface WorkspaceEntityHost {
  /**
   * Resolve the open `workspaces` table.
   * @returns the table; throws while the registry has not started yet.
   */
  table(): KvTable<WorkspaceId, WorkspaceRecord>

  /**
   * Classify an already-accounted session against a workspace path. A missing
   * directory cannot confirm a mismatch, and an id the index does not cover
   * stays `unknown` rather than becoming staleness evidence.
   * @param id - Session already present in this workspace's candidate account.
   * @param path - Workspace's stored canonical directory.
   * @returns the index's classification of the candidate.
   */
  candidateState(id: SessionId, path: string): CandidateState

  /**
   * Read one stored session header for attach validation.
   * @param id - The session whose header to read.
   * @returns the header; rejects when session persistence is absent or holds
   * no session with this id.
   */
  readSessionHeader(id: SessionId): Promise<SessionHeader>

  /**
   * Publish a successfully validated canonical cwd to the projection index.
   * @param id - Validated session id.
   * @param path - Canonical existing directory from the immutable header cwd.
   */
  rememberSessionPath(id: SessionId, path: string): void

  /**
   * Report one durable prune of a confirmed-stale (`invalid`) session id.
   * id. Called exactly once per pruned id, before the membership write lands, so
   * an operator can see every removal the registry makes on its own.
   * @param id - The pruned session id.
   * @param path - The workspace path whose membership no longer holds the id.
   */
  reportPruned(id: SessionId, path: string): void
}

/** Chain-slot abort sentinel thrown by the update fn when the record needs no change; only `mutate` observes it. */
const unchangedSentinel = new Error('workspace record unchanged (internal sentinel)')

/**
 * Copy `record` with its detach tombstone set to `detachedSessionIds`. The
 * field is omitted when that list is empty, so a record that never detached a
 * session keeps the fields it was written with.
 * @param record - Record to copy.
 * @param detachedSessionIds - Tombstone entries to store, in detach order.
 * @returns the copied record.
 */
function withDetachedSessionIds(record: WorkspaceRecord, detachedSessionIds: readonly SessionId[]): WorkspaceRecord {
  const next: WorkspaceRecord = { ...record }
  if (detachedSessionIds.length === 0) delete next.detachedSessionIds
  else next.detachedSessionIds = detachedSessionIds
  return next
}

/** The single {@link Workspace} implementation; constructed only by the registry. */
export class WorkspaceEntity implements Workspace {
  private record: WorkspaceRecord

  /**
   * @param host - Registry-owned table, session-path index, and header reads.
   * @param id - The record's stable id.
   * @param record - The validated record snapshot loaded or just written.
   */
  constructor(
    private readonly host: WorkspaceEntityHost,
    readonly id: WorkspaceId,
    record: WorkspaceRecord,
  ) {
    this.record = record
  }

  get path(): string {
    return this.record.path
  }

  get title(): string {
    return this.record.title
  }

  get createdAt(): string {
    return this.record.createdAt
  }

  get updatedAt(): string {
    return this.record.updatedAt
  }

  get sessionIds(): readonly SessionId[] {
    return this.record.sessionIds.filter((id) => {
      const state = this.host.candidateState(id, this.record.path)
      return state === 'valid' || state === 'missing-dir'
    })
  }

  async setTitle(title: string): Promise<void> {
    await this.mutate(record => ({ ...record, title }))
  }

  async attachSession(sessionId: SessionId): Promise<void> {
    // Validation is skipped when the settled snapshot already accounts the
    // id: the cwd fact was checked when it first attached and both inputs
    // (stored header cwd, workspace path) are immutable. Membership itself is
    // decided on the write chain inside `mutate`, never on this snapshot.
    if (!this.record.sessionIds.includes(sessionId)) {
      const header = await this.host.readSessionHeader(sessionId)
      if (header.cwd === undefined) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + 'its stored header carries no cwd to validate against',
        )
      }
      let cwd: string
      try {
        cwd = await realpathNormalize(header.cwd)
      } catch (error) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd '${header.cwd}' does not resolve, so it cannot be validated`,
          { cause: error },
        )
      }
      if (!(await stat(cwd)).isDirectory()) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd '${header.cwd}' is not a directory`,
        )
      }
      if (cwd !== this.record.path) {
        throw new Error(
          `cannot attach session '${sessionId}' to workspace '${this.record.path}': `
          + `its cwd resolves to '${cwd}'`,
        )
      }
      this.host.rememberSessionPath(sessionId, cwd)
    }
    await this.mutate((record) => {
      if (record.sessionIds.includes(sessionId) && !record.detachedSessionIds?.includes(sessionId)) return record
      return withDetachedSessionIds(
        record.sessionIds.includes(sessionId)
          ? record
          : { ...record, sessionIds: [sessionId, ...record.sessionIds] },
        (record.detachedSessionIds ?? []).filter(id => id !== sessionId),
      )
    })
  }

  /**
   * Admit stored sessions the header index confirms at this workspace's
   * canonical path, prepending them in the given order through one durable
   * mutation, and drop every admitted id from the detach tombstone.
   * @param sessionIds - Stored session ids, newest first, whose canonical cwd is this path.
   * @returns the ids actually added; empty when every id was already accounted.
   */
  async admitSessions(sessionIds: readonly SessionId[]): Promise<readonly SessionId[]> {
    let added: readonly SessionId[] = []
    await this.mutate((record) => {
      const missing = sessionIds.filter(id => !record.sessionIds.includes(id))
      if (missing.length === 0) return record
      added = missing
      return withDetachedSessionIds(
        { ...record, sessionIds: [...missing, ...record.sessionIds] },
        (record.detachedSessionIds ?? []).filter(id => !missing.includes(id)),
      )
    })
    return added
  }

  async insertSessionBefore(sessionId: SessionId, beforeSessionId?: SessionId): Promise<void> {
    await this.mutate((record) => {
      if (!record.sessionIds.includes(sessionId)) {
        throw new WorkspaceMoveInvalidError(
          `cannot move session '${sessionId}' in workspace '${record.path}': the session is not accounted`,
        )
      }
      if (beforeSessionId !== undefined && !record.sessionIds.includes(beforeSessionId)) {
        throw new WorkspaceMoveInvalidError(
          `cannot move session '${sessionId}' before '${beforeSessionId}' in workspace '${record.path}': `
          + 'the anchor session is not accounted',
        )
      }
      if (beforeSessionId === sessionId) return record
      const without = record.sessionIds.filter(id => id !== sessionId)
      const at = beforeSessionId === undefined ? without.length : without.indexOf(beforeSessionId)
      const sessionIds = [...without.slice(0, at), sessionId, ...without.slice(at)]
      return sessionIds.every((id, index) => id === record.sessionIds[index])
        ? record
        : { ...record, sessionIds }
    })
  }

  /**
   * Remove `sessionId` from the account and append it to the detach tombstone
   * in the same mutation, so the removal survives a restart. Detaching an id
   * the account does not hold writes nothing, whether or not the tombstone
   * already holds it.
   */
  async detachSession(sessionId: SessionId): Promise<void> {
    await this.mutate((record) => {
      if (!record.sessionIds.includes(sessionId)) return record
      const tombstone = record.detachedSessionIds ?? []
      return withDetachedSessionIds(
        { ...record, sessionIds: record.sessionIds.filter(id => id !== sessionId) },
        tombstone.includes(sessionId) ? tombstone : [...tombstone, sessionId],
      )
    })
  }

  async status(): Promise<'ok' | 'missing-dir'> {
    try {
      return (await stat(this.record.path)).isDirectory() ? 'ok' : 'missing-dir'
    } catch {
      // Any stat failure (ENOENT, dangling parent, permission loss) means the
      // directory is not usable right now; the record itself never mutates.
      return 'missing-dir'
    }
  }

  /**
   * The single write path: run `fn` on the domain write chain via
   * `table.update`, stamping `updatedAt` and pruning only candidates the
   * header index confirms `invalid`, then swap the snapshot.
   * `unknown` and `missing-dir` candidates are retained verbatim: an id the
   * index does not cover is never treated as stale, and recovery of an
   * unreachable cwd is `WorkspaceRegistry.reconcile`.
   *
   * `fn` sees the value current at its chain slot, so membership decisions
   * (attach/detach idempotence) are race-free against queued writes; a fn
   * signalling no change by returning `current` verbatim aborts the slot
   * through the sentinel when pruning also finds nothing, so a no-op neither
   * rewrites the medium nor emits a change event.
   *
   * Every prune is observable: each confirmed-stale id is reported through
   * {@link WorkspaceEntityHost.reportPruned} before the write lands, so no
   * durable membership removal happens silently.
   */
  private async mutate(fn: (record: WorkspaceRecord) => WorkspaceRecord): Promise<void> {
    let next: WorkspaceRecord
    try {
      next = await this.host.table().update(this.id, (current) => {
        const changed = fn(current)
        const sessionIds = changed.sessionIds.filter((id) => {
          const state = this.host.candidateState(id, changed.path)
          if (state !== 'invalid') return true
          this.host.reportPruned(id, changed.path)
          return false
        })
        if (changed === current && sessionIds.length === current.sessionIds.length) {
          throw unchangedSentinel
        }
        return { ...changed, sessionIds, updatedAt: new Date().toISOString() }
      })
    } catch (error) {
      if (error === unchangedSentinel) return
      throw error
    }
    this.record = next
  }
}
