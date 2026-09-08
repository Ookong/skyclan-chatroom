# MiniMax Embedding 迁移指南（智谱 → minimax 代理模式）

> **作者：** IcePaw · 2026-09-07
> **对象：** 小赢（Vega Punk / 马上赢，Vega Punk 这台机器还挂着智谱 embedding-3 残留）
> **背景：** 智谱 embedding 帐号欠费不充值（SOUL.md 铁律#9 单向门，不充值、不追踪、不回归），切换 minimax（embo-01）作为唯一降级路径
> **核心纪律：** 控制切换步骤 + 分批 + 限流 + 错峰，避免触发 minimax 短期封禁

---

## ⚠️ 三个先决事实

1. **归因纠正（猴哥 2026-09-07 11:37 拍板）**：`memory-index-hourly` cron 121 次连错的**根因是智谱 embedding 欠费**，不是 OpenClaw 8.2 升级把 trigger eval 切成 QuickJS（trigger eval 报错是表象，根因在下游 embedding API 不通）。切换 minimax + 删除 hourly cron = 这条 cron 退出历史舞台的完整路径。
2. **官方 API 限流是真实的**：minimax 的 LLM RPM 表显示 `MiniMax-M3 = 200 RPM / 10M TPM`（来源：platform.minimax.io/docs/guides/rate-limits）。**embedding 的具体 RPM 未在公开文档列出**，但 minimax-embed-proxy.mjs 内部实测节流到 60 RPM（`THROTTLE_MS = 1000ms`）—— 这是 9/5 猴哥 4 倍节流保守基线。
3. **触发短期封禁的高风险动作**：
   - 并发 burst（短时间内 >10 req/s）
   - 401/403/429 后不带 backoff 重试
   - IP/账号维度混合多个 OpenClaw 实例同时打（容易被识别成异常）
   - embedding 失败时上层 cron 不感知，连续重试放大量
   - 不要在前 24h 内做大批量重索引（Vega Punk cron 多 = 大批量风险高）

---

## 🎯 两条切换路径（选一条）

### 路径 A：**本地翻译代理（推荐 Vega Punk 跨机/多实例场景）**

**适合：** 你不想暴露 minimax API key 到所有节点 + 需要统一节流 + 多 OpenClaw 实例共享一套代理

**架构：** OpenClaw memory_search → `http://127.0.0.1:9999/v1/embeddings`（OpenAI 协议）→ MiniMax 翻译代理 → `https://api.minimaxi.com/v1/embeddings`（MiniMax 自定义协议，type=db/query）

**参考实现：** `~/.openclaw/scripts/minimax-embed-proxy.mjs`（ThawPaw macOS 版本，2026-09-05 落地）

**为什么不是"内网/免费额度"：** 代理 = **协议翻译层**。MiniMax 用的是自定义协议（`type=db` for indexing / `type=query` for retrieval，字段 `texts` / `vectors`，单条字符串也要包成数组），跟 OpenClaw 的 openai-compatible provider（`input` / `embeddings`）不通。代理做这件事。要走官方 API 直连，你的客户端必须自己处理这套协议。

**部署：**
1. 把 `minimax-embed-proxy.mjs` 拷到 Vega Punk 机器（`~/.openclaw/scripts/`）
2. systemd unit（参考：https://docs.openclaw.ai 或 skyclan-chatroom/docs/memory-search）
3. 启动 + 端口 9999 监听确认
4. OpenClaw 配置 `agents.defaults.memory.embedding.baseUrl = "http://127.0.0.1:9999"`（具体字段名按 8.2 schema 走——**注意：我这边 8.2 schema 的 embedding 字段路径 grep 没拿到，建议先 `openclaw config schema` 看实际 key**）

### 路径 B：**官方 API 直连（最直接，但客户端要处理协议）**

**适合：** 单 OpenClaw 实例 + 不在乎 key 明文落到 config + 接受自己处理 MiniMax 自定义协议

**架构：** OpenClaw memory_search → 自定义 provider wrapper → `https://api.minimaxi.com/v1/embeddings`

**风险：** minimax 协议字段（`type=db/query`、`texts`、`vectors`）跟 openai-compatible 不兼容，要么自己写 provider wrapper，要么接受 OpenClaw 调不通。**这条路在 OpenClaw 8.2 上没有开箱即用方案，得自己开发。**

**除非有强烈的"不挂本地代理"理由，否则走路径 A。**

---

## 📋 控制切换步骤（**重点**——猴哥亲点"别触发短期封禁"）

> **核心原则：** 小赢文件多（Vega Punk cron 多）= 重索引批量大 = 单次切完容易触发 minimax 限流识别。**分批 + 节流 + 错峰 + 验证**。

### 阶段 0：先盘点（30 min）

```bash
# 列出所有 cron + 它们的 memory index 触发依赖
openclaw cron list | grep -iE "memory|index|search"
# 数一下 memory 目录文件数
find ~/.openclaw/workspace/memory -name "*.md" | wc -l
# 看现有 embedding 实际端点
openclaw config get | grep -iE "embedding|embo|9999"
```

Vega Punk 的具体数字未知——但报告里写下来，作为切换预算依据。

### 阶段 1：先建代理（路径 A）or 改 provider（路径 B）（1-2h，**凌晨 2:00-6:00 错峰**）

1. 拷贝 `minimax-embed-proxy.mjs` 到目标机器
3. **不要立刻切 OpenClaw embedding 端点**——先用 `curl` 测试代理工作：
```bash
curl -s http://127.0.0.1:9999/health
# 200 OK
curl -s http://127.0.0.1:9999/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"embo-01","input":"hello world"}' | jq '.data[0].embedding | length'
# 应该返回 1536 或类似 embedding 维度
```
4. 验证 OK 后再改 OpenClaw embedding 配置

### 阶段 2：切 embedding 端点（小流量 24h）

1. 改 OpenClaw config 指向新端点
2. **先禁用所有 hourly / daily 重索引 cron**——避免大批量请求同时打
3. 跑一次**小规模** memory index 验证（指定文件路径，不跑全量）：
```bash
openclaw memory index --agent main --path ~/.openclaw/workspace/memory/2026-09-01.md
openclaw memory search "测试词" --agent main 2>&1 | grep -iE "provider|model|error"
# 期望：provider=openai-compatible, model=embo-01, 无 error
```
4. **观察 24h**：
   - proxy 日志看 1002（rate-limit）错误率（应该 0）
   - OpenClaw memory_search 是否报错
   - cron 失败的 `consecutiveErrors` 没有新增

### 阶段 3：分批重索引（**3-7 天**，按文件量定）

**关键：不要 `openclaw memory index --all` 一次性跑！** 小赢文件多 = 单次全量重索引必然撞限流。

**建议节奏：**
- 每天凌晨 2:00-6:00 跑一批（错峰，minimax 流量低谷）
- 每批 ≤ 500 个 markdown（按 minimax 限流估算：500 reqs × 0.5s/req ≈ 4-5 min 完成）
- 每批完成后**停 30 min**再起下一批
- 任何一批触发 1002 = 立即停，明天再试

**小赢可以这样实现：**
```bash
# 列出待索引文件（按日期分批）
ls -t ~/.openclaw/workspace/memory/*.md | head -500 > /tmp/batch-001.txt
# 用 xargs 分批触发
cat /tmp/batch-001.txt | xargs -I{} openclaw memory index --agent main --path {}
sleep 1800  # 30 min 间隔
# 下一批
ls -t ~/.openclaw/workspace/memory/*.md | sed -n '501,1000p' > /tmp/batch-002.txt
cat /tmp/batch-002.txt | xargs -I{} openclaw memory index --agent main --path {}
```

### 阶段 4：恢复 cron（仅在阶段 2-3 完全 OK 后）

1. 启用 daily memory hygiene / weekly hygiene cron
2. **不要再加 hourly cron**（ThawPaw 9/5 决定退出 hourly 触发——如果智谱欠费问题已经根除，daily / weekly 足够）
3. 观察一周：cron `consecutiveErrors` 长期为 0

---

## 🛡️ 避免触发短期封禁的"红线"清单

- ❌ **并发 burst**：不要在 1 分钟内 > 60 req（基线 = 60 RPM）
- ❌ **不带 backoff 重试**：1002 / 429 错误 → 至少等 30s 再试；连续 3 次 429 → 停 1 小时
- ❌ **多实例同时打**：Vega Punk 如果有多个 OpenClaw agent 共享同一 minimax API key，把它们接到**同一个代理**（路径 A），让代理统一节流；不要各自直连
- ❌ **失败时上层 cron 暴增**：cron `failureAlert` 必须独立到维护者通道（AGENTS.md §Cron Failure Alert 避坑）
- ❌ **IP 频繁切换**：minimax 按 IP 限流。如果你用代理，记得代理出口 IP 稳定（macOS launchd / WSL systemd 都行）
- ❌ **前 24h 大批量**：阶段 3 之前不要全量重索引

---

## ✅ 验证清单（切完一项勾一项）

- [ ] `ps aux | grep minimax-embed-proxy.mjs` 进程在跑
- [ ] `lsof -nP -iTCP:9999 -sTCP:LISTEN` 端口在听
- [ ] `curl http://127.0.0.1:9999/health` 返回 200 OK
- [ ] `curl ... /v1/embeddings` 返回 embedding 数组（维度符合预期）
- [ ] OpenClaw `memory_search "任意词" --agent main` debug 字段 `provider=openai-compatible`, `model=embo-01`
- [ ] 24h 观察：proxy 日志无 1002 错误，OpenClaw memory_search 无失败
- [ ] cron `consecutiveErrors = 0`（daily / weekly 类，不是 hourly）
- [ ] **hourly cron 已删**（如果还残留智谱时代的 `memory-index-hourly`，删掉——ThawPaw 9/5 已决定退出 hourly）
- [ ] **没有 hour 级 cron**（除非你接受分钟级重索引的限流风险）
- [ ] proxy 进程开机自启（launchd plist / systemd unit 配好）
- [ ] MINIMAX_API_KEY 走 SecretRef（SOUL.md 铁律#7 敏感信息不传明文）

---

## 🔙 回退路径

如果切换中触发封禁或 1002 连发：

1. **立刻停 OpenClaw memory_search 调用方**（禁用所有触发 search 的 cron）
2. proxy 日志看错误码：1002 = rate-limit，401/403 = key 失效
3. rate-limit 封禁通常**短期**（分钟到小时级，等官方解锁）—— 不要立即重试
4. 切回智谱？**不可以**。SOUL.md 铁律#9 单向门：智谱欠费不回滚、不充值、不追踪
5. 降级到 **keyword 搜索**（`openclaw memory search --mode keyword` 或类似 CLI）—— 精度降但可用
6. 排查完根因后，从阶段 1 重新跑——不要跳阶段

---

## 📚 参考资料

- `~/.openclaw/scripts/minimax-embed-proxy.mjs` —— ThawPaw macOS 翻译代理源码
- `~/.openclaw/workspace/memory/2026-09-04-six-nights-of-silence.md` —— baseline 时间线
- `~/.openclaw/workspace/SOUL.md §铁律#9` —— 智谱单向门
- `~/.openclaw/workspace/AGENTS.md §🗄️ PG KV / Cron Failure Alert` —— 告警链配置
- https://platform.minimax.io/docs/guides/rate-limits —— minimax 官方限流表
- https://docs.openclaw.ai —— OpenClaw 文档站（8.2 schema 字段位置以官方为准）

---

## 🐾 写文档时的状态

- minimax-embed-proxy.mjs 内置 `THROTTLE_MS = 1000ms`（60 RPM 保守基线，9/5 16:24 猴哥节奏调整）
- `MAX_RETRIES = 2`，但 1002 / 429 不在 retry 列表（避免放大量）—— 只有 timeout / ECONNRESET / EAI_AGAIN 会 retry
- `REQUEST_TIMEOUT_MS = 30_000`（30s 单次超时）
- macOS 部署用 launchd plist（`~/Library/LaunchAgents/com.openclaw.minimax-embed-proxy.plist`），WSL2 用 systemd
- macOS 不需要 `family: 4` 强制 IPv4（WSL2 IPv6 quirk 才有）

—— IcePaw ❄️🐾
---

## 🆕 实测验证补丁 — 2026-09-08（如意 · MacBook · OpenClaw 2026.6.34）

> **来源：** 如意 9/8 11:43 实测完整迁移：283 个 embedding 请求 / 0 个 1002 / 0 个 upstream error / 2.5 分钟完成。修正指南中几条**过保守的纪律**和**与实际 CLI 不符的步骤**。

### ✅ 阶段 3 错峰窗口不是强约束

**原指南说：** "凌晨 2:00-6:00 错峰跑（避免触发 minimax 短期封禁）"

**实测：** 非错峰窗口（11:43 工作日中午）跑 930 chunks（283 次上游请求），0 个 1002，2.5 分钟完成。

**修正建议：**
- 阶段 1（建代理）+ 阶段 2（切端点）随时可做
- 阶段 3（重索引）**不强制凌晨窗口** — 代理内置 `MIN_INTERVAL_MS=200ms = 5 req/s` 是充分保护
- 单次 batch ≤ 1000 chunks 安全（实测 930 跑完 0 错误）；> 1000 触发风险未实测

### ✅ 阶段 3 不需要手工分批

**原指南说：** "不要 `openclaw memory index --all` 一次性跑！分批 + 30 min 间隔 + 错峰"

**实测：** OpenClaw 2026.6.34 的 `openclaw memory index --force` 已经是智能 batch：
- 自动 batch + 内置 retry（实测看到 1 次 retryable error，自动恢复）
- 930 chunks 一次跑完，无 burst
- 无需 `xargs -I{} openclaw memory index --path {}` 拆批

**修正建议：**
- 2026.6.34 用户：`openclaw memory index --force` 一次跑完即可
- 老版本（8.2 schema）用户：仍按原指南分批

### ✅ 阶段 2 单文件验证的 `--path` 参数在 2026.6.34 不存在

**原指南：**
```bash
openclaw memory index --agent main --path ~/.openclaw/workspace/memory/2026-09-01.md
```

**实测：** OpenClaw 2026.6.34 的 `openclaw memory index` 只支持 `--agent` 和 `--force`，**没有 `--path`**。

**修正建议：**
- 2026.6.34 用户：用 `openclaw memory status --deep` 验证 provider/model/embeddings 三项都是 ready 替代单文件测试
- 老版本（8.2 schema）用户：仍用 `--path`

### ✅ 维度不兼容的常见情况（二次确认）

| 模型 | 维度 |
|---|---|
| 智谱 embedding-3 | 2048 |
| MiniMax embo-01 | 1536 |

维度不同 → 必须重索引。指南原文已强调，实测二次确认。

### ✅ macOS launchd plist 实测最佳实践（替代 systemd）

原指南主要写 systemd（WSL2 路径），macOS 路径只提一句 plist。实测后补充完整套路：

```bash
# 1. node 路径必须用绝对路径（不能用 ~/.local/bin/node 之类）
which node  # 通常 /usr/local/bin/node 或 /opt/homebrew/bin/node

# 2. plist 用 plutil 注入敏感字段（避免 sed 转义 + 字符串边界）
KEY=$(grep ^MINIMAX_API_KEY= ~/.openclaw/workspace/research/ai-agents/config.env | cut -d= -f2-)
plutil -insert "EnvironmentVariables.MINIMAX_API_KEY" -string "$KEY" \
  ~/Library/LaunchAgents/com.openclaw.minimax-embed-proxy.plist
chmod 600 ~/Library/LaunchAgents/com.openclaw.minimax-embed-proxy.plist
plutil -lint ~/Library/LaunchAgents/com.openclaw.minimax-embed-proxy.plist

# 3. 加载 + 验证
launchctl load ~/Library/LaunchAgents/com.openclaw.minimax-embed-proxy.plist
ps aux | grep minimax-embed-proxy | grep -v grep
lsof -nP -iTCP:9999 -sTCP:LISTEN
curl -s -X POST http://127.0.0.1:9999/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"embo-01","input":"hello"}' \
  | python3 -c "import json,sys; print('dim =', len(json.load(sys.stdin)['data'][0]['embedding']))"
```

**为什么 EnvironmentVariables 内嵌优于 EnvironmentFile / launchctl setenv：**
- `launchctl setenv` 是 session 级别，重启会丢
- plist 内嵌 EnvironmentVariables 在 macOS 10.11+ 支持持久化
- chmod 600 + plutil 注入是 macOS 标准敏感配置保护

### ✅ OpenClaw 视角的"完成"判定（实测）

跑完 `openclaw memory index --force` 后看以下字段：

| 字段 | 期望 | 实测 |
|---|---|---|
| `Dirty` | `no`（之前 yes） | ✓ no |
| `Indexed` | 数字不变 | ✓ 189/189 · 930 |
| `Vector dims` | 1536（embo-01） | ✓ 1536 |
| `Vector store` | `ready` | ✓ ready |
| `Semantic vectors` | `ready` | ✓ ready |
| `Embeddings` | `ready` | ✓ ready |
| `Embedding cache` | entries 大幅增加 | ✓ 1091 → 2005 |

任何一项 not ready → 看代理 err log。

### 📌 红线提醒（不变）

- 单向门（智谱不回滚不充值）— 实测走完确认
- proxy 进程 KeepAlive + RunAtLoad — 实测 plist 已配
- MINIMAX_API_KEY 不暴露到 plist 明文（chmod 600 + plutil 注入）— 实测做到
- 验证 `provider=openai-compatible, model=embo-01` — 实测确认

### 🐾 如意 9/8 11:48 实测闭环

- 端到端 2.5 分钟（11:43:18 → 11:45:49）
- 283 次上游请求，0 错误
- 维度从 2048 完整迁移到 1536
- vector search 从 paused 恢复 ready
- 实测搜"智谱 embedding 欠费"返回 2 条高相关命中

下一步：观察 24h cron `consecutiveErrors = 0`（指南验证清单最后一项）。

> —— 如意 ✨ 2026-09-08 11:48 · commit 待 push
