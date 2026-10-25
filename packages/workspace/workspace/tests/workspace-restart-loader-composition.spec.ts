import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, LoggerLevel } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { brandString } from '@deepseek-ai/dsh-brand'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Workspace from '@deepseek-ai/dsh-workspace'
import { SESSION_FORMAT_VERSION, type SessionId } from '@deepseek-ai/dsh-session'
import { generationLogFilename, logPath } from '../../../session/session-persistence-jsonl/src/format.ts'

// Session logs are written through the production logPath helper, so the on-disk layout cannot drift from the reader.
const WORKSPACE_ID = '8f1d3c46-6a5f-4c2e-9a1b-2d3e4f5a6b7c'
const TOP_LEVEL = ['sess-top-1', 'sess-top-2', 'sess-top-3', 'sess-top-4', 'sess-top-5'] as const
const GAPPED = TOP_LEVEL[4]
const SUBAGENTS = ['sess-sub-a', 'sess-sub-b'] as const
const GAPPED_CREATED_AT = 1_700_000_000_000 + TOP_LEVEL.indexOf(GAPPED)
/** A format generation past this build's ceiling: the log is on disk and readable, no codec can open it. */
const FUTURE_FORMAT_VERSION = SESSION_FORMAT_VERSION + 1

let home: string | undefined
let context: Context | undefined
/** Structured records the root LoggerService handed its exporters during the most recent boot. */
let emitted: Array<{ type: string; name: string; text: string }> = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (home !== undefined) await rm(home, { recursive: true, force: true })
  home = undefined
  vi.unstubAllEnvs()
})

/** One session log: the header line alone, in the uncompressed v4 encoding. */
async function writeSession(sessionsRoot: string, header: Record<string, unknown>): Promise<void> {
  const path = logPath(sessionsRoot, String(header['cwd']), brandString<SessionId>(String(header['id'])), 'none')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(header)}\n`)
}

/** Header of the seeded `sess-top-5`, for restoring the log after a scenario's damage. */
function gappedHeader(project: string): Record<string, unknown> {
  return {
    type: 'session', version: SESSION_FORMAT_VERSION, id: GAPPED, createdAt: GAPPED_CREATED_AT,
    cwd: project, isSeeded: false, delegationDepth: 0,
  }
}

/**
 * A DSH_HOME holding a project directory, five top-level session logs, two
 * subagent logs, and a durable workspace that already accounts for the five.
 * @returns the home directory and the workspace root path used in every header.
 */
async function seedHome(): Promise<{ root: string; project: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-workspace-restart-'))
  const project = join(root, 'project')
  await mkdir(project, { recursive: true })
  const sessionsRoot = join(root, 'sessions')
  let createdAt = 1_700_000_000_000
  for (const id of TOP_LEVEL) {
    await writeSession(sessionsRoot, {
      type: 'session', version: 4, id, createdAt: createdAt++, cwd: project, isSeeded: false, delegationDepth: 0,
    })
  }
  for (const id of SUBAGENTS) {
    await writeSession(sessionsRoot, {
      type: 'session',
      version: 4,
      id,
      createdAt: createdAt++,
      cwd: project,
      isSeeded: false,
      delegationDepth: 2,
      origin: 'subagent',
      parentSession: TOP_LEVEL[0],
    })
  }
  const timestamp = new Date(createdAt).toISOString()
  const storages = join(root, 'storages')
  await mkdir(storages, { recursive: true })
  await writeFile(join(storages, 'workspace.json'), `${JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [WORKSPACE_ID], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: {
      workspaces: {
        [WORKSPACE_ID]: {
          path: project,
          title: 'e2e',
          sessionIds: [...TOP_LEVEL],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    },
  }, null, 2)}\n`)
  return { root, project }
}

/** Boot the real loader composition over an existing DSH_HOME. */
async function boot(root: string): Promise<Context> {
  vi.stubEnv('DSH_HOME', root)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: '${join(root, 'storages')}'`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: '${join(root, 'sessions')}'`,
    '    compression: none',
    "- name: '@deepseek-ai/dsh-workspace'",
    '',
  ].join('\n'))

  const ctx = new Context()
  emitted = []
  // The built-in buffer exporter's default level (INFO) drops WARN records, so the
  // boot registers a WARN-level exporter on the same LoggerService the plugins log
  // through (`ctx.logger.warn` in packages/workspace/workspace/src/index.ts).
  ctx.logger.exporter({
    levels: { default: LoggerLevel.WARN },
    export: message => emitted.push({
      type: message.type,
      name: message.name,
      text: message.args.map((arg: unknown) => String(arg)).join(' '),
    }),
  })
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', JsonStorage],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-session-persistence-jsonl', JsonlSessionPersistence],
    ['@deepseek-ai/dsh-workspace', Workspace],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/** The UI/BFF projection: the single workspace's ordered session account. */
function projection(ctx: Context): readonly SessionId[] {
  const workspaces = ctx.workspaceRegistry.list()
  expect(workspaces.length).toBe(1)
  return workspaces[0]!.sessionIds
}

/** The durable account as stored on disk, independent of any booted registry. */
async function durableSessionIds(root: string): Promise<string[]> {
  const document = JSON.parse(await readFile(join(root, 'storages', 'workspace.json'), 'utf8')) as {
    tables: { workspaces: Record<string, { sessionIds: string[] }> }
  }
  return document.tables.workspaces[WORKSPACE_ID]!.sessionIds
}

/**
 * Warns the workspace registry itself emitted about one session id during the
 * last boot. The registry logs every membership decision it makes about an id
 * the header index does not confirm as a member, so a silent registry means the
 * class was applied without reporting it.
 * @param id - Session id the warning must name.
 * @returns the registry's warn records for that id; empty when it stayed silent.
 */
function registryWarningsAbout(id: string): string[] {
  return emitted
    .filter(entry => entry.type === 'warn' && entry.name === 'workspace-registry' && entry.text.includes(id))
    .map(entry => entry.text)
}

describe('workspace membership across restarts and persistence index gaps', () => {
  // Membership classes the registry commits to, per recorded session:
  // valid — header readable, absolute cwd whose realpath is an existing directory
  //   equal to the workspace path: visible in the projection, kept.
  // invalid — header readable but cwd missing, non-absolute, unresolvable, not a
  //   directory, or mismatched: pruned from the durable record and the projection, warned.
  // unknown — the header cannot be read for any reason, including ENOENT from a
  //   missing generation file or a missing session directory, or the boot listing
  //   did not cover the id: the durable record keeps the id, the projection hides
  //   it, one warning is logged, and it reappears once a readable header covers it
  //   again. A missing generation file is not deletion evidence — inside
  //   persistence it is indistinguishable from a deleted log, and a migration or
  //   rename window produces exactly this state.
  // Deletion exists on exactly one path: the explicit `detachSession` call, which
  // changes the durable account and never touches the session's files.

  it('projects exactly the accounted top-level sessions, never subagents', async () => {
    // valid: every seeded header resolves to the workspace path.
    const seeded = await seedHome()
    home = seeded.root
    context = await boot(home)

    const ids = projection(context)
    expect(ids).toEqual([...TOP_LEVEL])
    expect(ids.filter(id => (SUBAGENTS as readonly string[]).includes(id))).toEqual([])
  })

  it('keeps a session whose generation file disappeared', async () => {
    const seeded = await seedHome()
    home = seeded.root
    const sessionsRoot = join(home, 'sessions')

    // unknown via ENOENT: `sess-top-5` keeps its directory and loses its generation
    // log. A read that fails with ENOENT says only "this pass found no header";
    // persistence cannot tell a deleted log from one mid-migration or mid-rename, so
    // filesystem absence is not deletion evidence and cannot prune. Only
    // `detachSession` removes.
    await rm(logPath(sessionsRoot, seeded.project, brandString<SessionId>(GAPPED), 'none'))
    const kept = TOP_LEVEL.filter(id => id !== GAPPED)
    context = await boot(home)
    expect(projection(context)).toEqual([...kept])
    expect(await durableSessionIds(home)).toEqual([...TOP_LEVEL])
    expect(registryWarningsAbout(GAPPED).length).toBeGreaterThan(0)

    // An unrelated user mutation must not turn `unknown` into staleness evidence.
    await context.workspaceRegistry.list()[0]!.setTitle('renamed')
    expect(await durableSessionIds(home)).toEqual([...TOP_LEVEL])
    expect(projection(context)).toEqual([...kept])
    await context.fiber.dispose()
    context = undefined

    // A readable header covers the id again. It was never removed, so the account
    // keeps its seeded order and the rename survives the gap.
    await writeSession(sessionsRoot, gappedHeader(seeded.project))
    context = await boot(home)
    expect(projection(context)).toEqual([...TOP_LEVEL])
    expect(await durableSessionIds(home)).toEqual([...TOP_LEVEL])
    expect(context.workspaceRegistry.list()[0]!.title).toBe('renamed')
  })

  it('keeps an unreadable-but-present session', async () => {
    const seeded = await seedHome()
    home = seeded.root
    const sessionsRoot = join(home, 'sessions')
    const gappedDir = dirname(logPath(sessionsRoot, seeded.project, brandString<SessionId>(GAPPED), 'none'))

    // unknown without ENOENT: the log stays on disk, unreadable. The route is a
    // generation file for a format version past this build's ceiling — the listing
    // selects the newest generation in the directory, `readGenerationHeader` throws
    // SessionFormatUnsupportedError, the backend reports it and drops the artifact,
    // so `list()` returns four headers instead of failing init. Plain garbage bytes,
    // an empty file, and a malformed header were probed and all fail init or read as
    // a header, so none of them encode this class.
    await writeFile(join(gappedDir, generationLogFilename(FUTURE_FORMAT_VERSION, 'none')), `${JSON.stringify({
      type: 'session', version: FUTURE_FORMAT_VERSION, id: GAPPED, createdAt: GAPPED_CREATED_AT,
      cwd: seeded.project, isSeeded: false, delegationDepth: 0,
    })}\n`)
    const kept = TOP_LEVEL.filter(id => id !== GAPPED)
    context = await boot(home)
    expect(await durableSessionIds(home)).toEqual([...TOP_LEVEL])
    expect(projection(context)).toEqual([...kept])
    expect(registryWarningsAbout(GAPPED).length).toBeGreaterThan(0)

    await context.workspaceRegistry.list()[0]!.setTitle('renamed')
    expect(await durableSessionIds(home)).toEqual([...TOP_LEVEL])
    expect(projection(context)).toEqual([...kept])
    await context.fiber.dispose()
    context = undefined

    // A later index pass covers the id through the seeded readable v4 header, which
    // was on disk the whole time; the account keeps its seeded order.
    await rm(join(gappedDir, generationLogFilename(FUTURE_FORMAT_VERSION, 'none')))
    context = await boot(home)
    expect(projection(context)).toEqual([...TOP_LEVEL])
    expect(await durableSessionIds(home)).toEqual([...TOP_LEVEL])
    expect(context.workspaceRegistry.list()[0]!.title).toBe('renamed')
  })
})
