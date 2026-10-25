# Agent Note: Workspace membership survives Session index gaps

Status: implemented

English | [中文](2026-10-25-workspace-session-membership-survives-index-gaps.zh.md)

## Problem

A Workspace's Sessions drop out of the sidebar while every Session directory and event log stays readable on disk. Two defects combined.

`WorkspaceEntity.mutate()` asked a header index that `WorkspaceRegistry` built from one `listStoredHeaders()` snapshot at startup and deleted every recorded id the index did not answer for. A listing that raced an active Session, an unreadable header, or an unresolvable `cwd` therefore erased members permanently: the durable record stopped naming the Session, later startups had nothing left to re-check, the projection hid the row, and no entry point rebuilt membership from disk.

`session-persistence-jsonl` required the first Zstandard frame to decode to exactly one header line. A log the writer compressed into a single frame is valid but failed that check, and `list()` skipped the whole Session without a diagnostic — removing it from the index that membership read.

## Decision

`WorkspaceEntityHost.candidateState(id, path)` classifies each recorded id on four states:

- `valid` — readable header, canonical `cwd` equal to the workspace path; visible.
- `missing-dir` — fully qualified `cwd` whose `realpath` fails with ENOENT alone; visible, because the directory may have moved temporarily.
- `invalid` — staleness the header itself confirms: no `cwd`, a relative `cwd`, a `realpath` failure for another reason, a canonical `cwd` that is not a directory, or a canonical `cwd` at a different directory; the only state an accepted mutation prunes.
- `unknown` — no index pass covers the id: an unreadable header including an absent one, a permission, timeout, or corruption failure, or a listing that omits the id; durable, absent from the projection, warned once.

`WorkspaceEntity.sessionIds` projects `valid` and `missing-dir`. Pruning happens at startup reconciliation and at every accepted mutation, each removal logged at warn with the id, the workspace path, and its recorded reason. No `sessionPersistence.stat` result prunes anything: inside a rename or migration window an artifact is briefly absent, which is indistinguishable from a deletion, and treating that as evidence is what deleted the members this decision restores.

The only other removal is `detachSession`, which records the id in the same write as a durable tombstone (`WorkspaceRecord.detachedSessionIds`, omitted when empty) instead of relying on the id's absence from the account. The removal survives a restart, and a later `attachSession` clears the tombstone and brings the Session back.

Startup reconciliation also re-admits: `reconcile(workspaceId?)` lists stored headers once, merges back stored Sessions whose canonical `cwd` matches the workspace path, keeps `origin: 'subagent'` Sessions and detached ids out, and reports `{added, pruned}`, writing nothing when both are empty. Members an earlier build pruned automatically come back on the next startup; members a caller detached stay out.

`session-persistence-jsonl` splits the header record out of the first decoded frame and scans the remainder, so a log held in one frame parses; a log it still cannot read is reported instead of dropped.

## Alternatives considered

**Rebuild the index on every membership read.** Every sidebar refresh would re-list stored headers per Workspace; the startup snapshot avoids that cost per render, and reconciliation covers the recovery need.

**Treat `unknown` as invalid and log a warning.** The deletion is the defect; a warning records the loss without preventing it.

**Prune on `sessionPersistence.stat` reporting no artifact.** The check reads as positive evidence and is not: a file briefly absent during migration fails it, which is the failure this decision exists to stop.

**Skip startup reconciliation and require an explicit `reconcile` only.** Leaves the historical loss in place until someone calls it, and needs a detach tombstone anyway to tell a deliberate removal from a pruned member.

**Keep detach as bare absence instead of a tombstone.** Startup reconciliation would re-admit every detached Session whose `cwd` matches, so a removal would quietly undo itself at the next boot.

**Fix only the persistence parser.** Restores the dropped Sessions and leaves the prune-on-absence rule, so the next incomplete listing still deletes members for good.

## Consequences

A recorded id no index pass covers stays in the record, out of the projection, warned at each startup. Residual dead ids are the accepted cost of never deleting a live Session on a failed read, and they clear only when a pass classifies them.

Workspace membership can change at startup without user action: rows an earlier build pruned reappear, and rows whose header confirms staleness disappear, on a single restart.

`detachedSessionIds` grows with every detach and is pruned to non-empty only; each entry costs one Session id in the record until a re-attach clears it.

## Related decisions

The [blank-session reuse decision](../../archived/bug-fix/2026-08-05-workspace-blank-session-reuse-membership.md) owns the sidebar consequences of a stale membership account. The [Workspace file service decision](../../architecture/2026-09-05-workspace-files-service.md) owns header validation at attach time.
