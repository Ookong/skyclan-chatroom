# MEMORY_SEARCH_MINIMAX_EXPERIENCE — MiniMax Embedding 落地经验

> **作者：** 小马（MK-002 野・行动）
> **日期：** 2026-09-05
> **状态：** ✅ 已落地（基于 2026-09-02 21:00 主代理部署）
> **适用范围：** Vega Punk 全员 MiniMax Embedding 部署者 / 维护者
> **互补文档：** [`docs/MEMORY_SEARCH_CLOUD.md`](../MEMORY_SEARCH_CLOUD.md)（智谱方案，已废 · 仅参考）/ [`punk-records/docs/guides/memory-search-minimax-embedding.md`](../../punk-records/docs/guides/memory-search-minimax-embedding.md)（部署指南 how-to）
> **本文档定位：** **why-we-did-this-way + 踩坑 + 教训**（how-to 见上方部署指南）

---

## 1. 触发 & 决策链

### 1.1 触发：智谱 API 余额耗尽

2026-09-01 heartbeat 自检发现智谱 embedding API HTTP 429（"余额不足或无可用资源包，请充值"），Vega Punk 全员 memory search 降级为 keyword 搜索。详细自检流程见 `punk-records/learnings/errors/LRN-20260901-001-git-report-ground-truth.md`（小马侧复盘）。

### 1.2 为什么不能回滚到智谱

> ⚠️ **关键事实约束（2026-09-05 猴哥明确）：** 智谱 embedding API **不存在充值选项**。
> - 不是账户余额不够，是产品侧不再提供个人 / 小团队付费通道
> - 全员切换到 MiniMax 是 **单向门**

### 1.3 候选评估

| 选项 | 评估 | 选择 |
|---|---|---|
| **MiniMax `embo-01`** | 公司域账号已有 budget / 1536 维 / API 兼容性已知 / 价格低 | ✅ |
| vLLM 本地部署 | 重启 llama-cpp GGUF 冷启动 10-20s 已知坑（见 8/16 历史教训） | ❌ 性能回退 |
| OpenAI text-embedding-3 | 跨境网络不稳定 / 公司账号预算 / 美元结算 | ❌ |
| 智谱等充值 | **不存在**（见 1.2） | ❌ 单向门 |

### 1.4 决策时间表

| 时间 | 事件 |
|---|---|
| 9/1 18:00 | heartbeat 触发智谱 429 告警 |
| 9/1 18:30 | 评估 MiniMax 可行性，确认公司域账号可用 |
| 9/2 21:00 | 小马主代理完成翻译代理 + systemd 部署 |
| 9/2 23:00 | 索引重建成功（977 chunks / 1536 维）|
| 9/3 14:00 | HEARTBEAT.md v6.0 → v6.1 同步迁移状态 |

---

## 2. 架构选择：为什么需要翻译代理

### 2.1 MiniMax 不是 OpenAI 兼容

**最常见的误解**：以为换个 baseUrl + model ID 就能切到 MiniMax。**不能**：

```bash
# ❌ 失败：直接换 baseUrl + model
openclaw memory config set provider openai-compatible
openclaw memory config set baseUrl https://api.minimaxi.com/v1
openclaw memory config set model embo-01
```

**为什么失败**：

| 字段 | OpenAI 标准 | MiniMax |
|---|---|---|
| `input` | `string \| string[]` | — |
| `texts` | — | **`string[]`**（必须数组，单个也要包）|
| `type` | — | **必填** `"db"`（入库） / `"query"`（检索）|
| `model` | `string` | `string` |

两套 schema 不兼容，OpenAI 兼容客户端直接发会被 MiniMax 拒（典型响应：`{"base_resp":{"status_code":1001,"status_msg":"invalid param"}}`）。

### 2.2 为什么不能直接走 zai 插件

OpenClaw 自带的 zai 插件（智谱官方）只支持 zai 协议，**不支持自定义 embedding provider**。试过的坑：

- 把 MiniMax 端点塞进 zai 插件 → 404
- 让 zai 插件支持 OpenAI 兼容 → 需要改 OpenClaw 源码（不现实）

**正确做法：本地起一个翻译代理**

```
[OpenClaw memory search]
    ↓ OpenAI 标准 POST /v1/embeddings {model, input}
[翻译代理 :9999 (Node.js ~80 行)]
    ↓ 重写为 MiniMax 格式 {model, texts, type}
[MiniMax API :443 embo-01]
    ↓ 返回 {embeddings: [[...]]}
[翻译代理 → OpenClaw]
    ↓ 改写为 OpenAI 标准 {data: [{embedding: [...]}]}
```

### 2.3 翻译代理代码骨架

文件：`~/.openclaw/scripts/minimax-embed-proxy.mjs`（~80 行 Node.js，完整代码见部署指南 §步骤 1）

关键字段映射在 §4 详述。

---

## 3. 翻译代理的 3 个坑

### 3.1 systemd user instance 保活（不加会重启挂）

**坑：** 直接 `node minimax-embed-proxy.mjs &` 后台跑，重启或换 session 就挂。memory search 静默降级为 keyword，24h+ 不告警（智谱 9/1 故障就是这个模式）。

**解：** 必须用 `systemd --user` 注册（不是 system service）：

```ini
# ~/.config/systemd/user/minimax-embed-proxy.service
[Unit]
Description=MiniMax Embedding OpenAI-Compatible Translation Proxy

[Service]
Type=simple
Environment=MINIMAX_API_KEY=...
Environment=PROXY_PORT=9999
ExecStart=/usr/bin/node /home/%u/.openclaw/scripts/minimax-embed-proxy.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

启用：

```bash
systemctl --user daemon-reload
systemctl --user enable --now minimax-embed-proxy.service
systemctl --user status minimax-embed-proxy.service
```

**为什么必须 user service（不是 system）：**

- 不污染 system 服务树（避免 sudo 权限）
- 不需要 root 启动（与 OpenClaw gateway 同模式）
- 跟随用户 session 自动启停（macOS launchd 也是类似）

### 3.2 端口 9999 占用排查

**坑：** 第一次跑发现端口占用，但 `lsof -i :9999` 看不到（systemd 进程在另一个 namespace）。

**解：**

```bash
ss -tlnp | grep 9999
# 看 systemd 进程名 + PID

journalctl --user -u minimax-embed-proxy.service -n 50
# 看启动错误
```

**预防：**

- 选个不常见的端口（9999 / 9988 / 9123）
- 启动失败立即看 `journalctl`
- `RestartSec=5` 让 systemd 自动重试

### 3.3 IPv4 强制（WSL2 特有）

**坑：** WSL2 默认 IPv6 优先解析 `api.minimaxi.com`，但 MiniMax API 端点只 IPv4 → DNS 解析到 IPv6 地址后连接超时（典型症状：`getaddrinfo EAI_AGAIN` 或 30s+ 无响应）。

**解：** 在翻译代理里强制 `family: 4`：

```javascript
const req = https.request(url, {
  method: 'POST',
  family: 4,  // ← 强制 IPv4
  headers: {...}
}, (res) => {...});
```

**为什么上游 OpenClaw poll.js 也需要：** 同样原因，OpenClaw 任何 outbound HTTPS 在 WSL2 都可能撞 IPv6 解析慢。OpenClaw 上游已硬化（`a91f824` 加了 `family: 4`），翻译代理要自己做。

**Mac 分身不需要：** macOS 没有这个 WSL2 quirk。launchd 部署时可省略。

---

## 4. MiniMax 适配 OpenAI 标准的边界

### 4.1 字段重写清单

代理需要做这些转换：

```javascript
// 入站：OpenAI 标准
{ model: "embo-01", input: "hello" }

// 改写为：MiniMax
{ model: "embo-01", texts: ["hello"], type: "db" }

// 入站：OpenAI 数组
{ model: "embo-01", input: ["a", "b", "c"] }

// 改写为：MiniMax
{ model: "embo-01", texts: ["a", "b", "c"], type: "db" }
```

### 4.2 响应字段 unwrap

```javascript
// MiniMax 返回
{
  embeddings: [[0.1, 0.2, ...]],
  total_tokens: 5,
  // ... 其他 MiniMax 字段
}

// 改写为：OpenAI 标准
{
  data: [
    { embedding: [0.1, 0.2, ...], index: 0, object: "embedding" }
  ],
  model: "embo-01",
  usage: { prompt_tokens: 5, total_tokens: 5 }
}
```

### 4.3 错误码映射

| MiniMax status_code | 含义 | OpenAI 映射 | 翻译策略 |
|---|---|---|---|
| `1001` | invalid param | `400` | 透传 + 加 `error.message` |
| `1002` | rate limit | `429` | **必须重试 + 退避** |
| `1004` | auth failed | `401` | 透传 + 上报 heartbeat |
| `1008` | insufficient balance | `402` | 透传 + 紧急告警 |
| `5xx` | upstream error | `5xx` | 透传 + 客户端重试 |

**关键：** `1002` 是限流（不是 "1002 次重试"），需要：

- 节流（≥ 250ms / 调用）
- 重试（≤ 4 次，指数退避：500ms / 1s / 2s / 4s）

否则瞬时 QPS 上去立即被 MiniMax 拒。

### 4.4 `type` 参数的语义

| 场景 | `type` 值 | 用途 |
|---|---|---|
| 索引（写入 memory） | `"db"` | 长期存储向量 |
| 检索（query memory） | `"query"` | 临时检索向量 |

**MVP 简化：** 翻译代理默认 `type="db"`（小马机器只服务 memory search 索引）。如果未来需要 query 端点（如外部检索工具），通过 path 或 header 区分：

```javascript
const type = req.url.startsWith('/v1/embeddings/query') ? 'query' : 'db';
```

---

## 5. Reindex Lock 排查（LRN-20260902-001）

### 5.1 锁文件结构

OpenClaw 在 `~/.openclaw/agents/main/agent/` 下用 SQLite 锁文件协调 reindex：

```
openclaw-agent.sqlite.reindex-lock.sqlite          # 活跃锁
openclaw-agent.sqlite.reindex-lock.sqlite-journal  # 锁的 WAL journal
```

正常 reindex 完成会清理这两个文件。

### 5.2 什么时候会留 orphan

- **OOM / SIGKILL**：reindex 进程被强杀，锁文件未清理
- **翻译代理 502**：reindex 写一半代理挂，gateway 进程也退出
- **磁盘满**：reindex 写到一半 ENOSPC，进程崩溃
- **gateway 重启**：reindex 中途 gateway 重启，旧锁未释放

### 5.3 症状

```bash
openclaw memory index --force
# 启动后 10 分钟无进度 → 日志出现：
#   "reindex-lock is held" / "database is locked"
```

### 5.4 fail-open 清理

```bash
# 把 orphan 锁移走（不删，留审计痕迹）
mv ~/.openclaw/agents/main/agent/openclaw-agent.sqlite.reindex-lock.sqlite* \
   ~/.openclaw/agents/main/agent/orphan-$(date +%s).lock

# 重新触发 reindex
openclaw memory index --force
# 约 20 分钟重建 977 chunks
```

### 5.5 为什么 fail-open

OpenClaw 的设计选择：**宁可多一个 reindex（万一锁真的还活着），也别让脏锁永久阻塞。**

所以 `mv` 而不是 `rm` 是安全姿势——错的可以反向还原（`mv orphan-XXX.lock openclaw-agent.sqlite.reindex-lock.sqlite*`）。

### 5.6 预防

- systemd 保活翻译代理（避免 502 中断 reindex）
- 加 swap 防 OOM（WSL2 默认 swap=0）
- reindex 时不要中途 kill gateway
- 加 `Restart=always` 让 gateway 自动恢复

---

## 6. 回滚路径（已关闭）

> ⚠️ **2026-09-05 猴哥明确：** 智谱 embedding API **不存在充值选项** → MiniMax 是单向迁移。

可走的"降级"是 **回退到 keyword 搜索**（不是真正回滚）：

```bash
openclaw memory config set provider zai  # 或回退到本地 FTS
# memory search 暂时不用向量，仅 keyword
# 准确度大幅下降但不会断
```

**不建议长期降级**，只是应急止血。重建 MiniMax 索引后立即切回 `openai-compatible`。

**真正的"回滚"路径已无。** MiniMax 出问题只能：

1. 修复翻译代理
2. 充值 MiniMax 账户（公司域账号）
3. 重建索引
4. 切回 zai 作为最后手段

---

## 7. 与其他分身部署的差异点

### 7.1 Mac 分身（如意 / IcePaw）

| 项 | 小马（Ubuntu WSL）| Mac 分身 |
|---|---|---|
| 进程守护 | systemd --user | **launchd**（`~/Library/LaunchAgents/`）|
| 翻译代理路径 | `~/.openclaw/scripts/minimax-embed-proxy.mjs` | 同 |
| service 文件 | `~/.config/systemd/user/*.service` | `~/Library/LaunchAgents/com.openclaw.minimax-embed-proxy.plist` |
| IPv4 强制 | **需要**（WSL2 quirk）| **不需要**（macOS DNS 正常）|
| `family: 4` | 翻译代理里要加 | 不需要 |

### 7.2 launchd plist 模板（Mac 分身参考）

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.openclaw.minimax-embed-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/USERNAME/.openclaw/scripts/minimax-embed-proxy.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MINIMAX_API_KEY</key><string>YOUR_KEY</string>
    <key>PROXY_PORT</key><string>9999</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.openclaw.minimax-embed-proxy.plist
launchctl list | grep minimax
# 期望看到 com.openclaw.minimax-embed-proxy
```

### 7.3 S 系列（阿飞 / Rocky / 大侦探）

- 同 Mac / Ubuntu 流程
- `MINIMAX_API_KEY` 共享（向猴哥 / 如意要）
- 或申请独立 key（如果用量大需要 rate limit 隔离）

---

## 8. 后续优化方向

| 优化 | 预期收益 | 实施成本 |
|---|---|---|
| **向量维度 1536 → 3072** | 检索准确率 +5-10% | 重建索引（20min）+ 调用成本 ×2 |
| **batch embedding** | 索引速度 ×3 | 翻译代理支持 batch 改写 |
| **缓存命中率**（同一段文字不重复 embedding）| 减少 API 调用 30%+ | 加 LRU 缓存层（sqlite）|
| **本地 fallback**（MiniMax 挂了 → 本地 llama-cpp 30s 冷启动）| 高可用 | 双 provider 配置 + 切换逻辑 |
| **监控指标**（QPS / 限流命中率 / p99 latency）| 限流告警 | Prometheus exporter |
| **dimension 维度自适应** | 不强绑 1536 | 翻译代理读 model 名 → 决定维度 |

### 8.1 建议优先级

1. **缓存命中率** — ROI 最高，省钱（如果重建索引时发现大量重复 chunk，缓存收益显著）
2. **监控指标** — 避免 9/1 智谱那种 "silent failure 24h"
3. **本地 fallback** — 高可用，但实施复杂（30s 冷启动 vs 全断，权衡）
4. **向量维度升级** — 质量提升，但成本翻倍（按需）

---

## 9. 验证清单（部署后跑一遍）

```bash
# 1. 翻译代理在跑
systemctl --user status minimax-embed-proxy.service
# 期望：active (running)

# 2. 代理端点健康
curl http://127.0.0.1:9999/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"embo-01","input":"hello"}'
# 期望：{"data":[{"embedding":[...]}]}（HTTP 200）

# 3. OpenClaw memory search 配置
openclaw memory status --deep --agent main
# 期望：
#   Provider: openai-compatible (requested: openai-compatible)
#   Model: embo-01
#   Vector dims: 1536
#   Embeddings: ready
#   Vector search 不 paused

# 4. 实测检索
openclaw memory search "智谱 API 切换"
# 期望：返回 1-3 条相关 chunk
```

---

## 10. 关联 LRN / 教训

| 教训 | 链接 | 触发场景 |
|---|---|---|
| LRN-20260902-001 | `punk-records/learnings/errors/LRN-20260902-001-reindex-lock.md` | Reindex Lock 排查（本文档 §5） |
| LRN-20260901-002 | `punk-records/learnings/pending/LRN-20260901-002-git-author-forensic.md` | 9/1 智谱告警发现的 git author / 真相核验流程 |
| 智谱 → MiniMax 决策 | `punk-records/diary/2026-09-02-xiaoma.md` | 主代理落地时的实时决策 |

---

## 变更日志

| 版本 | 日期 | 变更 |
|---|---|---|
| v2026-09-05 | 2026-09-05 | 首次落地经验总结（基于 9/2 部署实操 + 9/3 HEARTBEAT v6.1 同步 + 9/5 猴哥"智谱无充值"事实约束）|

## 关联文档

- [`docs/MEMORY_SEARCH_CLOUD.md`](../MEMORY_SEARCH_CLOUD.md) — 智谱方案（已废 · 仅参考）
- [`punk-records/docs/guides/memory-search-minimax-embedding.md`](../../punk-records/docs/guides/memory-search-minimax-embedding.md) — 部署指南（how-to）
- [`punk-records/learnings/errors/LRN-20260902-001-reindex-lock.md`](../../punk-records/learnings/errors/LRN-20260902-001-reindex-lock.md) — Reindex Lock 排查细节
- `~/.openclaw/scripts/minimax-embed-proxy.mjs` — 翻译代理源码
