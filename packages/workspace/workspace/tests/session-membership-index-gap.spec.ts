import type { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceCorruptionError, SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceRegistry, { WorkspaceId, type workspaceDomainState } from '../src/index.ts'
import type { WorkspaceDomainState, WorkspaceRecord } from '../src/index.ts'

const DOMAIN_VERSION = 2

function record(path: string, sessionIds: string[], createdAt = '2026-07-24T00:00:00.000Z'): WorkspaceRecord {
  return {
    path,
    title: basename(path),
    sessionIds: sessionIds.map(SessionId),
    createdAt,
    updatedAt: createdAt,
  }
}

function header(id: string, cwd?: string, createdAt = 0, origin?: 'subagent'): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt,
    isSeeded: false,
    ...(cwd === undefined ? {} : { cwd }),
    ...(origin === undefined ? {} : { origin }),
  }
}

function snapshot(head: SessionHeader): SessionPersistenceSnapshot {
  return { header: head, revision: SessionPersistenceRevision(`rev-${head.id}`) }
}

function storedPool(
  entries: Array<[string, WorkspaceRecord]>,
  state: z.input<typeof workspaceDomainState>,
): MemoryMediaPool {
  const pool = new MemoryMediaPool()
  pool.versions.set('workspace', DOMAIN_VERSION)
  pool.media.set('workspace', {
    tables: new Map([['workspaces', new Map<string, unknown>(entries)]]),
    global: state,
  })
  return pool
}

function storedRecord(pool: MemoryMediaPool, id: string): WorkspaceRecord {
  return pool.media.get('workspace')!.tables.get('workspaces')!.get(id) as WorkspaceRecord
}

function storedState(pool: MemoryMediaPool): WorkspaceDomainState {
  return pool.media.get('workspace')!.global as WorkspaceDomainState
}

const initializedState = (id: WorkspaceId): z.input<typeof workspaceDomainState> => ({
  initialized: true,
  workspaceIds: [id],
  archivedSessionIds: [],
  pinnedSessionIds: [],
})

interface HarnessOptions {
  /** Artifact check the fake exposes. Membership never consults it; omitted means it fails, as an unavailable peer would. */
  stat?: (id: SessionId) => Promise<SessionPersistenceSnapshot | undefined>
}

/**
 * The `workspace.spec.ts` harness, narrowed to this scenario: a persisted
 * record, a controllable header listing, and a controllable per-session
 * artifact check. Every warning the registry logs, including the startup pass,
 * is captured.
 */
async function harness(
  pool: MemoryMediaPool,
  stored: readonly SessionHeader[] = [],
  options: HarnessOptions = {},
) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)

  let listed = [...stored]
  const list = vi.fn(async (): Promise<SessionPersistenceSnapshot[]> => listed.map(snapshot))
  const stat = vi.fn(options.stat
    ?? (() => { throw new Error('per-session artifact check failed') }))
  ctx.provide('sessionPersistence', {
    list,
    open: vi.fn(() => { throw new Error('event bodies must not be opened') }),
    stat,
  } as never)

  const warnings: string[] = []
  vi.spyOn(ctx.logger, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  })
  const fiber = await ctx.plugin(WorkspaceRegistry)
  return {
    ctx,
    fiber,
    pool,
    registry: ctx.workspaceRegistry,
    list,
    stat,
    warnings,
    setStored: (headers: readonly SessionHeader[]) => { listed = [...headers] },
  }
}

let base: string
const tempDirs: string[] = []

async function makeDir(name: string): Promise<string> {
  base ??= await realpath(await mkdtemp(join(tmpdir(), 'dsh-workspace-')))
  if (tempDirs.length === 0) tempDirs.push(base)
  const dir = join(base, name)
  await mkdir(dir, { recursive: true })
  return dir
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  base = undefined as never
})

describe('workspace session membership across an index gap', () => {
  it('keeps a persisted session the header index never saw when an unrelated write runs', async () => {
    const dir = await makeDir('index-gap')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000001')
    const gapSession = SessionId('persisted-after-index')
    const pool = storedPool([[id, record(dir, [gapSession])]], initializedState(id))

    const { registry, stat, warnings } = await harness(pool)
    expect(registry.list().map(workspace => workspace.id)).toEqual([id])
    expect(storedRecord(pool, id).sessionIds).toEqual([gapSession])
    // No header covers the id, so it is `unknown`: retained, hidden, warned
    // once. The registry never asks the session store whether the artifact
    // exists, because no answer there could justify a prune.
    expect(stat).not.toHaveBeenCalled()
    expect(warnings.filter(warning => warning.includes('outside the header index'))).toHaveLength(1)
    expect(warnings[0]).toContain(String(gapSession))

    await registry.get(id)!.setTitle('renamed')
    expect(storedRecord(pool, id).title).toBe('renamed')
    expect(storedRecord(pool, id).sessionIds).toEqual([gapSession])
    // The projection stays conservative: an id the index does not cover is
    // neither valid nor visible until a later pass confirms its canonical cwd.
    expect(registry.get(id)!.sessionIds).toEqual([])
    // Absence from the persistence listing is not staleness: no prune is reported.
    expect(warnings.some(warning => warning.includes('pruned session'))).toBe(false)
    expect(storedState(pool).workspaceIds).toEqual([id])
  })

  it('prunes a confirmed non-directory cwd and warns with the recorded reason', async () => {
    const dir = await makeDir('non-directory-cwd')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000002')
    const filePath = join(dir, 'not-a-directory')
    await writeFile(filePath, 'x')
    const stale = header('regular-file-cwd', filePath, 100)
    const pool = storedPool([[id, record(dir, [stale.id])]], initializedState(id))

    const { registry, warnings } = await harness(pool, [stale])
    expect(storedRecord(pool, id).sessionIds).toEqual([])
    expect(registry.get(id)!.sessionIds).toEqual([])
    const prunes = warnings.filter(warning => warning.includes('pruned session'))
    expect(prunes).toHaveLength(1)
    expect(prunes[0]).toBe(
      `workspace pruned session '${stale.id}' from membership at '${dir}': `
      + `cwd '${filePath}' is not a directory`,
    )

    const writesOnly = warnings.length
    await registry.get(id)!.setTitle('renamed')
    // Nothing is left to prune: the startup pass already removed the id.
    expect(warnings.slice(writesOnly)).toEqual([])
  })

  it('prunes a candidate whose cwd fails with ENOTDIR, because that is confirmed staleness', async () => {
    const dir = await makeDir('unresolvable-cwd')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000003')
    const filePath = join(dir, 'regular-file')
    await writeFile(filePath, 'x')
    const unresolved = header('enotdir-cwd', join(filePath, 'child'), 100)
    const pool = storedPool([[id, record(dir, [unresolved.id])]], initializedState(id))

    const { registry, warnings } = await harness(pool, [unresolved])
    const prunes = warnings.filter(warning => warning.includes('pruned session'))
    expect(prunes).toHaveLength(1)
    expect(prunes[0]).toContain(`workspace pruned session '${unresolved.id}' from membership at '${dir}'`)
    expect(prunes[0]).toContain('does not resolve')
    expect(storedRecord(pool, id).sessionIds).toEqual([])
    expect(registry.get(id)!.sessionIds).toEqual([])
  })

  it('prunes a no-cwd and a relative-cwd id on a write, each with its own warn', async () => {
    const dir = await makeDir('no-cwd-relative-cwd')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000004')
    const noCwd = SessionId('no-cwd')
    const relative = SessionId('relative-cwd')
    const pool = storedPool([[id, record(dir, [noCwd, relative])]], initializedState(id))

    const { registry, warnings, setStored } = await harness(pool)
    // No pass covers either id yet, so both stay retained and hidden.
    expect(storedRecord(pool, id).sessionIds).toEqual([noCwd, relative])
    expect(registry.get(id)!.sessionIds).toEqual([])
    expect(warnings.filter(warning => warning.includes('outside the header index'))).toHaveLength(2)

    // An index refresh through the session store confirms both as invalid, but
    // the refresh alone writes nothing.
    setStored([header('no-cwd'), header('relative-cwd', 'relative-missing'), header('trigger', dir)])
    await registry.pinSession(SessionId('trigger'))
    expect(storedRecord(pool, id).sessionIds).toEqual([noCwd, relative])

    const beforeWrite = warnings.length
    await registry.get(id)!.setTitle('invalid-prune')

    expect(storedRecord(pool, id).sessionIds).toEqual([])
    expect(registry.get(id)!.sessionIds).toEqual([])
    expect(warnings.slice(beforeWrite)).toEqual([
      `workspace pruned session '${noCwd}' from membership at '${dir}': header has no cwd`,
      `workspace pruned session '${relative}' from membership at '${dir}': `
      + 'cwd \'relative-missing\' is not a fully qualified path',
    ])
  })

  it('retains a recorded id the listing omits when its artifact check resolves no snapshot', async () => {
    const dir = await makeDir('artifact-no-snapshot')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000015')
    const ghost = SessionId('no-snapshot')
    const pool = storedPool([[id, record(dir, [ghost])]], initializedState(id))

    const { registry, stat, warnings } = await harness(pool, [], { stat: async () => undefined })
    expect(await registry.reconcile(id)).toEqual({ added: [], pruned: [] })
    expect(stat).not.toHaveBeenCalled()
    expect(storedRecord(pool, id).sessionIds).toEqual([ghost])
    expect(registry.get(id)!.sessionIds).toEqual([])
    // A resolved absence is not staleness either: the id stays durable, hidden,
    // and reported once.
    expect(warnings.filter(warning => warning.includes('outside the header index'))).toEqual([
      `workspace '${id}' at '${dir}' holds session '${ghost}' outside the header index: `
      + 'session persistence lists no header for it, so it stays hidden until a later pass covers it',
    ])
    expect(warnings.some(warning => warning.includes('pruned session'))).toBe(false)
  })

  it('retains a recorded id whose artifact check rejects with the ENOENT code', async () => {
    const dir = await makeDir('artifact-enoent-rejection')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000016')
    const ghost = SessionId('enoent-rejection')
    const pool = storedPool([[id, record(dir, [ghost])]], initializedState(id))
    const missing = Object.assign(new Error('session log is missing'), { code: 'ENOENT' })

    const { registry, stat, warnings } = await harness(pool, [], {
      stat: async () => { throw missing },
    })
    expect(await registry.reconcile(id)).toEqual({ added: [], pruned: [] })
    expect(stat).not.toHaveBeenCalled()
    expect(storedRecord(pool, id).sessionIds).toEqual([ghost])
    expect(registry.get(id)!.sessionIds).toEqual([])
    expect(warnings.filter(warning => warning.includes('outside the header index'))).toHaveLength(1)
    expect(warnings.some(warning => warning.includes('pruned session'))).toBe(false)
  })

  it('retains an id whose artifact check rejects with a corruption error, hidden and warned once', async () => {
    const dir = await makeDir('artifact-corruption')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000017')
    const ghost = SessionId('corrupt-artifact')
    const pool = storedPool([[id, record(dir, [ghost])]], initializedState(id))
    const corrupt = new SessionPersistenceCorruptionError('stored session record fails validation', {
      cause: new Error('header record is not a valid session header'),
    })

    const { registry, stat, warnings } = await harness(pool, [], {
      stat: async () => { throw corrupt },
    })
    expect(stat).not.toHaveBeenCalled()
    expect(storedRecord(pool, id).sessionIds).toEqual([ghost])
    expect(registry.get(id)!.sessionIds).toEqual([])
    expect(warnings.filter(warning => warning.includes('outside the header index'))).toEqual([
      `workspace '${id}' at '${dir}' holds session '${ghost}' outside the header index: `
      + 'session persistence lists no header for it, so it stays hidden until a later pass covers it',
    ])
    expect(warnings.some(warning => warning.includes('pruned session'))).toBe(false)
  })

  it('re-admits at startup a stored session whose canonical cwd matches the record path', async () => {
    const dir = await makeDir('startup-reconcile')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000007')
    const late = header('late-session', dir, 200)
    const pool = storedPool([[id, record(dir, [])]], initializedState(id))

    const { registry, stat } = await harness(pool, [late])
    expect(storedRecord(pool, id).sessionIds).toEqual([late.id])
    expect(registry.get(id)!.sessionIds).toEqual([late.id])
    expect(stat).not.toHaveBeenCalled()
  })

  it('keeps a session detached in an earlier run out of membership after a restart', async () => {
    // `detachSession` tombstones the id in the record, so the startup reconcile
    // that re-admits a stored session whose canonical cwd is this workspace's
    // path skips it. A detach is the only removal a restart cannot undo.
    const dir = await makeDir('detach-restart')
    const stored = [header('kept', dir, 100)]
    const first = await harness(new MemoryMediaPool(), stored)
    const workspace = await first.registry.create(dir)
    await workspace.attachSession(SessionId('kept'))
    await workspace.detachSession(SessionId('kept'))
    expect(storedRecord(first.pool, workspace.id).sessionIds).toEqual([])
    expect(storedRecord(first.pool, workspace.id).detachedSessionIds).toEqual([SessionId('kept')])
    await first.fiber.dispose()

    const restarted = await harness(first.pool, stored)
    expect(storedRecord(first.pool, workspace.id).sessionIds).toEqual([])
    expect(storedRecord(first.pool, workspace.id).detachedSessionIds).toEqual([SessionId('kept')])
    expect(restarted.registry.get(workspace.id)!.sessionIds).toEqual([])
    expect(restarted.warnings.filter(warning => warning.includes('pruned session'))).toEqual([])
  })

  it('re-admits a stored session the init-time index never saw', async () => {
    const dir = await makeDir('reconcile-gap')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000011')
    const late = header('late-session', dir, 200)
    const pool = storedPool([[id, record(dir, [])]], initializedState(id))
    const { registry, list } = await harness(pool)
    expect(registry.get(id)!.sessionIds).toEqual([])

    list.mockImplementation(async () => [snapshot(late)])
    expect(await registry.reconcile(id)).toEqual({ added: [late.id], pruned: [] })

    expect(storedRecord(pool, id).sessionIds).toEqual([late.id])
    expect(registry.get(id)!.sessionIds).toEqual([late.id])
  })

  it('reports a confirmed-invalid id in pruned when a re-index moves its canonical cwd elsewhere', async () => {
    const dir = await makeDir('reconcile-prune')
    const elsewhere = await makeDir('reconcile-prune-elsewhere')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000018')
    const moved = header('moved-cwd', dir, 200)
    const pool = storedPool([[id, record(dir, [moved.id])]], initializedState(id))

    const { registry, list, warnings } = await harness(pool, [moved])
    expect(registry.get(id)!.sessionIds).toEqual([moved.id])

    list.mockImplementation(async () => [snapshot({ ...moved, cwd: elsewhere })])
    expect(await registry.reconcile(id)).toEqual({ added: [], pruned: [moved.id] })

    expect(storedRecord(pool, id).sessionIds).toEqual([])
    expect(registry.get(id)!.sessionIds).toEqual([])
    expect(warnings.filter(warning => warning.includes('pruned session'))).toEqual([
      `workspace pruned session '${moved.id}' from membership at '${dir}': `
      + `canonical cwd resolves to '${elsewhere}'`,
    ])
  })

  it('is idempotent: a second reconcile adds nothing, prunes nothing, and emits no change', async () => {
    const dir = await makeDir('reconcile-idempotent')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000012')
    const late = header('late-session', dir, 200)
    const pool = storedPool([[id, record(dir, [])]], initializedState(id))
    const { ctx, registry, list } = await harness(pool)
    list.mockImplementation(async () => [snapshot(late)])
    expect(await registry.reconcile()).toEqual({ added: [late.id], pruned: [] })

    const changes: string[] = []
    ctx.on('domain/changed', (change) => { changes.push(change.table) })
    expect(await registry.reconcile()).toEqual({ added: [], pruned: [] })

    expect(changes).toEqual([])
    expect(storedRecord(pool, id).sessionIds).toEqual([late.id])
  })

  it('never admits a subagent session whose cwd matches', async () => {
    const dir = await makeDir('reconcile-subagent')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000013')
    const subagent = header('subagent-session', dir, 300, 'subagent')
    const pool = storedPool([[id, record(dir, [])]], initializedState(id))
    const { registry, list } = await harness(pool)
    list.mockImplementation(async () => [snapshot(subagent)])

    expect(await registry.reconcile(id)).toEqual({ added: [], pruned: [] })
    expect(storedRecord(pool, id).sessionIds).toEqual([])
    expect(registry.get(id)!.sessionIds).toEqual([])
  })

  it('keeps an already accounted session once and prepends new admissions', async () => {
    const dir = await makeDir('reconcile-dedup')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000014')
    const already = header('already-accounted', dir, 100)
    const late = header('late-session', dir, 200)
    const pool = storedPool([[id, record(dir, [already.id])]], initializedState(id))
    const { registry, list } = await harness(pool)
    list.mockImplementation(async () => [snapshot(already), snapshot(late)])

    expect(await registry.reconcile(id)).toEqual({ added: [late.id], pruned: [] })
    expect(storedRecord(pool, id).sessionIds).toEqual([late.id, already.id])
    expect(registry.get(id)!.sessionIds).toEqual([late.id, already.id])
  })

  it('brings a tombstoned session back through a manual attachSession after the restart', async () => {
    const dir = await makeDir('tombstone-reattach')
    const stored = [header('kept', dir, 100)]
    const first = await harness(new MemoryMediaPool(), stored)
    const workspace = await first.registry.create(dir)
    await workspace.attachSession(SessionId('kept'))
    await workspace.detachSession(SessionId('kept'))
    await first.fiber.dispose()

    const restarted = await harness(first.pool, stored)
    const again = restarted.registry.get(workspace.id)!
    expect(again.sessionIds).toEqual([])

    await again.attachSession(SessionId('kept'))

    expect(again.sessionIds).toEqual([SessionId('kept')])
    expect(storedRecord(first.pool, workspace.id).sessionIds).toEqual([SessionId('kept')])
    expect(storedRecord(first.pool, workspace.id)).not.toHaveProperty('detachedSessionIds')
    expect(await restarted.registry.reconcile(workspace.id)).toEqual({ added: [], pruned: [] })
  })

  it('holds one tombstone entry when the same session is detached twice', async () => {
    const dir = await makeDir('detach-twice')
    const pool = new MemoryMediaPool()
    const { ctx, registry } = await harness(pool, [header('kept', dir, 100)])
    const workspace = await registry.create(dir)
    await workspace.attachSession(SessionId('kept'))
    await workspace.detachSession(SessionId('kept'))

    const changes: string[] = []
    ctx.on('domain/changed', (change) => { changes.push(change.table) })
    await workspace.detachSession(SessionId('kept'))

    expect(changes).toEqual([])
    expect(storedRecord(pool, workspace.id).sessionIds).toEqual([])
    expect(storedRecord(pool, workspace.id).detachedSessionIds).toEqual([SessionId('kept')])
  })

  it('writes nothing when a tombstoned id is detached again after a restart', async () => {
    const dir = await makeDir('detach-after-restart')
    const stored = [header('kept', dir, 100)]
    const first = await harness(new MemoryMediaPool(), stored)
    const workspace = await first.registry.create(dir)
    await workspace.attachSession(SessionId('kept'))
    await workspace.detachSession(SessionId('kept'))
    await first.fiber.dispose()

    const restarted = await harness(first.pool, stored)
    const changes: string[] = []
    restarted.ctx.on('domain/changed', (change) => { changes.push(change.table) })
    await restarted.registry.get(workspace.id)!.detachSession(SessionId('kept'))

    expect(changes).toEqual([])
    expect(storedRecord(first.pool, workspace.id).sessionIds).toEqual([])
    expect(storedRecord(first.pool, workspace.id).detachedSessionIds).toEqual([SessionId('kept')])
  })

  it('never tombstones a session reconcile admitted or a confirmed-stale id it pruned', async () => {
    const dir = await makeDir('reconcile-no-tombstone')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000015')
    const filePath = join(dir, 'not-a-directory')
    await writeFile(filePath, 'x')
    const admitted = header('late-session', dir, 200)
    const stale = header('regular-file-cwd', filePath, 100)
    const pool = storedPool([[id, record(dir, [stale.id])]], initializedState(id))

    const { registry } = await harness(pool, [stale, admitted])
    expect(storedRecord(pool, id).sessionIds).toEqual([admitted.id])
    expect(storedRecord(pool, id)).not.toHaveProperty('detachedSessionIds')

    expect(await registry.reconcile(id)).toEqual({ added: [], pruned: [] })
    expect(storedRecord(pool, id).sessionIds).toEqual([admitted.id])
    expect(storedRecord(pool, id)).not.toHaveProperty('detachedSessionIds')
  })

  it('keeps a tombstoned session out when its cwd moves away and back to the workspace path', async () => {
    const dir = await makeDir('tombstone-cwd-moves')
    const stored = [header('kept', dir, 100)]
    const first = await harness(new MemoryMediaPool(), stored)
    const workspace = await first.registry.create(dir)
    await workspace.attachSession(SessionId('kept'))
    await workspace.detachSession(SessionId('kept'))
    await first.fiber.dispose()

    const restarted = await harness(first.pool, stored)
    const moved = `${dir}-moved`
    await rename(dir, moved)
    expect(await restarted.registry.reconcile(workspace.id)).toEqual({ added: [], pruned: [] })
    await rename(moved, dir)

    expect(await restarted.registry.reconcile(workspace.id)).toEqual({ added: [], pruned: [] })
    expect(storedRecord(first.pool, workspace.id).sessionIds).toEqual([])
    expect(storedRecord(first.pool, workspace.id).detachedSessionIds).toEqual([SessionId('kept')])
    expect(restarted.registry.get(workspace.id)!.sessionIds).toEqual([])

    // The moved-back directory matches the stored cwd, so attach validation
    // accepts the session: the tombstone is the only thing reconcile skips here.
    await restarted.registry.get(workspace.id)!.attachSession(SessionId('kept'))
    expect(storedRecord(first.pool, workspace.id).sessionIds).toEqual([SessionId('kept')])
    expect(storedRecord(first.pool, workspace.id)).not.toHaveProperty('detachedSessionIds')
  })

  it('re-admits a pruned confirmed-stale id once a later pass covers it, because a prune is not a detach', async () => {
    const dir = await makeDir('prune-then-readmit')
    const id = WorkspaceId('00000000-0000-4000-8000-000000000020')
    const filePath = join(dir, 'not-a-directory')
    await writeFile(filePath, 'x')
    const pool = storedPool([[id, record(dir, [SessionId('ghost')])]], initializedState(id))

    const { registry, setStored } = await harness(pool, [header('ghost', filePath, 100)])
    expect(storedRecord(pool, id).sessionIds).toEqual([])
    expect(storedRecord(pool, id)).not.toHaveProperty('detachedSessionIds')

    setStored([header('ghost', dir, 200)])
    expect(await registry.reconcile(id)).toEqual({ added: [SessionId('ghost')], pruned: [] })
    expect(storedRecord(pool, id).sessionIds).toEqual([SessionId('ghost')])
    expect(storedRecord(pool, id)).not.toHaveProperty('detachedSessionIds')
  })
})
