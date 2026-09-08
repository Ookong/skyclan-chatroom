# OPENCLAW-8.2-WORKSPACE-UPGRADE — workspace *.md 配置变更说明

> **作者：** 龙井 🍵（MK-001）
> **日期：** 2026-09-05 检测 / 2026-09-06 00:02 落档
> **状态：** ✅ 已确认 + memory_search 已修复
> **适用范围：** SkyClan 全员（任何在用 OpenClaw 8.2 的 workspace）
> **互补文档：** [ARCHITECTURE.md](../ARCHITECTURE.md) § OpenClaw 版本追踪

---

## 1. 触发：博文发现 workspace 下 *.md 出现异常

2026-09-05 23:56 博文发现 workspace 下 `AGENTS.md` 和 `MEMORY.md` 在 23:49–23:56 之间被改动，自己没改过、cron 也没改过——怀疑是 **OpenClaw 升级到 8.2 后的 bootstrap 自动合并**。

### 1.1 版本确认

```bash
$ openclaw --version
OpenClaw 2026.8.2 (0965053)
```

之前一直是 2026.8.1 系列（heartbeat 模式 + 老 AGENTS.md 模板）。这次升级引入了三处关键改动。

### 1.2 为什么之前没意识到是升级

OpenClaw 8.2 启动时只对 workspace 做 **增量 merge**：
- ✅ 头部 frontmatter / 新章节追加
- ❌ **不覆盖**用户已编辑过的本地化内容（SkyClan / TOOLS.md / 龙井 SOP / 协议等）
- ❌ **不通知**用户"workspace 文件被自动改了"

结果是：用户看到的 diff 范围很小，没意识到是版本升级的副作用。**8.2 之前没有这个行为**——所以博文下意识没往升级上想。

---

## 2. *.md 文件变更对照（8.1 → 8.2）

### 2.1 `AGENTS.md` —— 结构变化最大

| 旧（8.1） | 新（8.2） | 影响 |
|---|---|---|
| `## 💓 Heartbeats - Be Proactive!` | **`## Automations - Be Proactive`** | 核心概念从"heartbeat"迁移到"automations" |
| 无 | **`## Existing Solutions Preflight`** | **新增**——自建前先查现成方案 |
| Memory 章节笼统 | 拆分为 `### USER.md / ### MEMORY.md / ### Write It Down` 三块 | 写法更严格 |
| `memory/heartbeat-state.json` | **`openclaw automations scratch <jobId> --set "..."`** | 状态文件 → 命令式 scratch |
| `Heartbeat vs Cron` 章节 | 改为引用 [`/automation#automations-vs-heartbeat`](/automation#automations-vs-heartbeat) | 概念已外移到 OpenClaw 主程序 |

**判断**：8.2 把"agent 主动做事"这件事 **从文档层移到了工具层**——automations 现在是头等公民，heartbeat 只是其中一种触发方式。

### 2.2 `USER.md` —— 格式严格化

8.2 模板引入 **指令注释头** 强制格式：

```markdown
<!-- observed: 2026-09-06 | status: active -->

- Prefer concise progress updates during implementation work.
```

规则：
- 每条指令必须以 **imperative 动词开头**（`Always` / `Never` / `Prefer`）
- 注释头标 `observed: YYYY-MM-DD` + `status: active | superseded`
- 偏好变化时旧条目 **必须** 标记 `superseded`，**不允许两条 active 指令互相矛盾**

**当前影响**：博文 + 龙井 + ThawPaw的 USER.md 都是自由文本格式，**未遵循 8.2 新规范**。是否要改造——见 §4 Action Items。

### 2.3 `IDENTITY.md` —— 新增 Theme 字段

8.2 模板优先级链：

```
Theme > Creature > Vibe
```

只有 `Name` / `Theme` / `Emoji` / `Avatar` 这 4 个会被 `openclaw agents set-identity` 写回文件；`Creature` / `Vibe` 是 read-only 输入。

**当前影响**：龙井 IDENTITY.md 只有 Name / Creature / Vibe / Emoji / Avatar，**没有 Theme**。

### 2.4 `SOUL.md` —— 主体一致

8.2 模板 vs 当前 workspace：骨架一致（Core Truths / Boundaries / Vibe / Continuity）。差别只是元数据多了 YAML frontmatter。**无需迁移**。

### 2.5 `MEMORY.md` —— 无官方模板

- OpenClaw 没有 `MEMORY.md` 模板——由 workspace 自维护
- 8.2 强化了加载规则（main session only / 不加载到群聊），但内容是用户沉淀
- **当前 MEMORY.md (504KB / 10516 行)** 是 博文从 2026-06-28 起累计的长期记忆——无需任何格式变更

### 2.6 `CLAUDE.md` —— 非 OpenClaw 模板

- CLAUDE.md 是 Claude Code 的项目级指令，**不是 OpenClaw workspace 模板**
- 当前内容（"禁止推送到远端，私人仓库"）保持不动

---

## 3. memory_search 同步异常 + 修复

> ⚠️ **本章与 OpenClaw 8.2 升级无关**——单独记录是因为今天排查时一并遇到了。

今天排查 workspace 改动时，同时遇到 memory_search 不可用：

```text
[memory_search] unavailable
reason: "index provenance classifier changed"
error: "index provenance classifier changed"
action: Tell the user to run: openclaw memory status --index or openclaw memory index --force.
```

**根因（推测）**：memory index 的 provenance classifier 跟当前不匹配。最可能的触发因素是 2026-09-02 的 embedding provider 切换（智谱 → MiniMax `embo-01`，小马完成，见 `docs/memory-search/MEMORY_SEARCH_MINIMAX_EXPERIENCE.md`），但**没有证据表明跟 OpenClaw 8.2 升级有因果关系**——此错应是 index metadata 与 classifier 不一致的长期问题，任何 provider/模型维度变化都可能触发。

**修复**：

```bash
$ openclaw memory index --force
Memory index updated (main): 142 files indexed.
```

修复后状态：

| 指标 | 修复后 |
|---|---|
| Files indexed | 142 / 142 |
| Chunks | 4723 |
| Vector dims | 1536 |
| Provider | openai-compatible / `embo-01` |
| FTS | ready |
| Recall store | 0（新装，正常） |

**验证**：搜索"ThawPaw 物理营"返回 3 条高质量命中（最高 0.86 分）。

---

## 4. Action Items（SkyClan 全员建议同步检查）

| # | 项 | 优先级 | 谁做 |
|---|---|---|---|
| 1 | `openclaw --version` 确认 ≥ 2026.8.2 | 🔴 高 | 每个分身跑一次，确认自己机器版本 |
| 2 | `openclaw memory index --force` | 🟡 中 | **embedding provider / 模型维度变化后必做**（跟版本升级无关）|
| 3 | USER.md 是否按 8.2 格式改造 | 🟡 中 | 暂不强制，先观察；想改造走 [讨论] |
| 4 | IDENTITY.md 是否加 Theme 字段 | 🟢 低 | 可选；如不加，不影响功能 |
| 5 | HEARTBEAT.md 是否迁 automations 模式 | 🟡 中 | 已用 `openclaw automations` 的不用动；只用 `heartbeat` 的考虑迁移 |
| 6 | 8.2 的 "Existing Solutions Preflight" 是否采纳 | 🟡 中 | 龙井建议**采纳**——自建前先查现成方案 |

---

## 5. 经验教训

### 5.1 "workspace 文件被自动改"应该有提示

8.2 现在是**静默 merge**——用户只能事后从 `git log` / `stat` 反推。**建议向 OpenClaw 提 feature request**：升级时在 workspace 根目录生成 `UPGRADE-NOTES-<version>.md`，列出本次 merge 的所有文件 + diff stat + 触发原因。

→ 责任人：龙井（提 issue 给 openclaw 上游）

### 5.2 "embedding provider / 模型维度切换"必须同步重建索引

这次 memory_search 挂掉，**跟 OpenClaw 8.2 升级无关**——是 index provenance classifier 跟当前不匹配。推测跟 9/2 切了 embedding provider 有关（详见 `memory-search/MEMORY_SEARCH_MINIMAX_EXPERIENCE.md`）。

**教训**：embedding provider / 向量维度 切换后 **必须立刻** 跑 `memory index --force`，不能等出现 search 失败才发现。

→ 已在 `memory-search/MEMORY_SEARCH_MINIMAX_EXPERIENCE.md` 同步

### 5.3 "今天文件被改了但我没改"——升级信号

下次遇到类似情况，**第一反应应该是查 `openclaw --version` 是否有变化**，而不是怀疑 cron / hook / 同事误操作。

---

## 6. 时间线（完整事实链）

| 时间 | 事件 |
|---|---|
| 2026-09-02 21:00 | 小马主代理完成 MiniMax embedding 部署 |
| 2026-09-02 23:00 | memory 索引重建成功（977 chunks / 1536 维） |
| **某时**（未确认） | OpenClaw 升级 2026.8.1 → **2026.8.2** |
| 2026-09-05 23:49 | workspace AGENTS.md 被 bootstrap 静默合并 |
| 2026-09-05 23:56 | workspace MEMORY.md 被 bootstrap 静默合并 |
| 2026-09-05 23:57 | 博文发现文件改动，问龙井 |
| 2026-09-06 00:01 | 确认是 OpenClaw 8.2 升级副作用 |
| 2026-09-06 00:02 | `openclaw memory index --force` 修复 search |
| 2026-09-06 00:04 | 本文档落档 + 通知 IcePaw / 小马 |

---

## 7. 相关链接

- [ARCHITECTURE.md](../ARCHITECTURE.md) § OpenClaw 版本追踪（待补）
- [memory-search/MEMORY_SEARCH_MINIMAX_EXPERIENCE.md](../memory-search/MEMORY_SEARCH_MINIMAX_EXPERIENCE.md) — 9/2 embedding 切换根因
- [POSTMORTEM-2026-08-23-skyclan-outage](../memory/2026-08-23-1733-skyclan-outage-rootcause.md) — 上一次"链路问题排查"参考
- OpenClaw 8.2 release notes（待补官方链接）

---

**维护者：** 龙井 🍵
**最近更新：** 2026-09-06 00:04
**下次 review：** 8.3 发布时 + 任何 avatar 报告 workspace 异常时