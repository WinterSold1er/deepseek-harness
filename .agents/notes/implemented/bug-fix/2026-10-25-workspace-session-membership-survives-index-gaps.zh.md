# Agent Note: 工作区成员关系跨越 Session 索引缺口保留

Status: implemented

[English](2026-10-25-workspace-session-membership-survives-index-gaps.md) | 中文

## 问题

工作区的会话从侧栏消失，而磁盘上每个会话目录与事件日志都完好可读。两个缺陷叠加。

`WorkspaceEntity.mutate()` 依赖 `WorkspaceRegistry` 在启动时用一次 `listStoredHeaders()` 快照建立的 header 索引，并删掉索引没有给出答案的所有已记录 id。因此，与活跃会话竞争的列举、读不出的 header、无法解析的 `cwd`，都会永久抹掉成员：持久记录不再指名该会话，后续启动没有可再校验的对象，投影隐藏该行，且没有任何入口能从磁盘重建成员关系。

`session-persistence-jsonl` 要求第一个 Zstandard 帧恰好解码出一行 header。写入方把整份日志压成单帧是合法日志，却被该检查判失败，`list()` 于是整条会话静默跳过——把它从成员关系所读的索引里移除。

## 决策

`WorkspaceEntityHost.candidateState(id, path)` 把每个已记录 id 分为四种状态：

- `valid`——header 可读、规范化 `cwd` 等于工作区 path；可见。
- `missing-dir`——`cwd` 完全限定且 `realpath` 仅因 ENOENT 失败；可见，因为目录可能只是临时被移动。
- `invalid`——由 header 本身确认的失效：没有 `cwd`、`cwd` 为相对路径、`realpath` 因其他原因失败、规范化 `cwd` 不是目录、或规范化 `cwd` 指向别的目录；这是被接受的写入唯一会自动剪除的状态。
- `unknown`——没有任何索引轮次覆盖该 id：header 读不出（含根本不存在的 header）、权限失败、超时、损坏，或列举中根本没有该 id；保留在持久记录，不进入投影，记录一次日志。

`WorkspaceEntity.sessionIds` 投影 `valid` 与 `missing-dir`。剪枝发生在启动 reconcile 与每次被接受的写入，每次移除以 warn 记录 id、工作区 path 与记录的原因。任何 `sessionPersistence.stat` 结果都不剪枝：在改名或迁移窗口内工件会短暂缺失，这与删除无法区分，而正是把它当作证据删掉了本决策要找回的成员。

唯一另一种移除是 `detachSession`：它在同一次写入中把该 id 记为持久墓碑（`WorkspaceRecord.detachedSessionIds`，为空时省略），而不是依赖 id 在账户中缺席。该移除跨重启保留，之后显式 `attachSession` 会清除墓碑并让会话回归。

启动 reconcile 同时负责并入：`reconcile(workspaceId?)` 列举一次存储的 header，并入规范化 `cwd` 等于工作区 path 的已存储会话，排除 `origin: 'subagent'` 会话与已解绑 id，报告 `{added, pruned}`，两者皆空时不写盘。被旧构建自动剪掉的成员在下次启动时回归；调用方主动解绑的成员保持在外。

`session-persistence-jsonl` 从第一个解码帧中切出 header 记录并继续扫描其余内容，因此单帧日志可以解析；仍无法读取的日志会被上报而不是丢弃。

## 考虑过的替代方案

**在每次成员读取时重建索引。** 每次侧栏刷新都要按工作区重新列举存储的 header；启动快照正是为了避免这项逐次渲染开销，恢复需求由 reconcile 覆盖。

**把 `unknown` 判为失效并记一条告警。** 删除本身就是缺陷；告警只是记录损失，并不能阻止损失。

**以 `sessionPersistence.stat` 找不到工件为据剪枝。** 它看起来是正面证据，实际不是：迁移期间文件短暂缺席就会失败，而这正是本决策要终止的故障。

**跳过启动 reconcile，只保留显式调用。** 历史损失会一直留到有人调用为止，而且仍然需要解绑墓碑来区分「有意移除」与「被剪掉的成员」。

**保留「解绑即唯一缺席」而不写墓碑。** 启动 reconcile 会把所有 `cwd` 匹配的已解绑会话重新并入，解绑会在下次启动悄悄自我撤销。

**只修持久化解析。** 能让被丢弃的会话回来，却保留「查不到即剪」规则，下一次不完整列举仍会永久删除成员。

## 后果

没有任何索引轮次覆盖的已记录 id 会留在记录中、不进入投影，并在每次启动记日志。残留死 id 是「绝不在读取失败时删除活会话」的既定代价，只有被某一轮次分类后才会清除。

工作区成员关系会随一次重启自动改变：旧构建剪掉的行重新出现，header 确认失效的行消失。

`detachedSessionIds` 随每次解绑增长，只保留非空数组；在重新挂载清除之前，每个条目在记录中占一个 Session id 的开销。

## 相关决策

[空白会话复用决策](../../archived/bug-fix/2026-08-05-workspace-blank-session-reuse-membership.md)负责成员账户过期时的侧栏后果。[工作区文件服务决策](../../architecture/2026-09-05-workspace-files-service.md)负责挂载时的 header 校验。
