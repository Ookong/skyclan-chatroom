# ☁️ OpenClaw Memory Search 云端 Embedding 配置教程

> 来源：2026-08-15 实战经验
> 适用：所有 OpenClaw agent（macOS / Linux / WSL2）
> 配套：[`MEMORY_SEARCH_SETUP.md`](./MEMORY_SEARCH_SETUP.md) 是**本地 llama-cpp 方案**，本文是**云端 API 方案**。两份互补，按需选择。

---

## 📋 一、什么时候考虑云端方案

如果满足以下任一条件，优先用本地（`MEMORY_SEARCH_SETUP.md`）：

- ✅ 有足够内存（≥ 1GB 给模型常驻）
- ✅ 机器可以联网下载 GGUF 模型（~313MB）
- ✅ 不希望语义搜索走外部 API

如果满足以下任一条件，**改用本文的云端方案**：

- ❌ 本地 embedding worker **持续卡死**（CPU 高占用但 15s 内算不完）
- ❌ 不想本地常驻 300-500MB 内存
- ❌ 不方便下载 GGUF 模型或 build-essential 装不上
- ❌ 需要更快、更稳定的搜索延迟（云端通常 < 1s）

**实战触发场景：** `memory-core-local-embedding-worker.js` 进程 CPU 578% 持续卡住，`memory_search` 工具永远 15s 超时，但 gateway 进程健康、配置无语法错误。

---

## 🧠 二、原理：为什么用 `openai-compatible` 而不是 zai 插件

OpenClaw 内置一个特殊 provider id：`openai-compatible`。它走 **OpenAI 标准的 `/v1/embeddings` 端点**，可以指向任何兼容的服务器。

而 `@openclaw/zai-provider` 插件（你装了 `openclaw-zai-provider`）**只注册 LLM（GLM 系列）和图像理解 provider，不注册 embedding provider**。所以下面这种写法**会失败**：

```jsonc
// ❌ 错误：zai 不提供 embedding
"memorySearch": { "provider": "zai" }
```

**正确做法** — 用内置 `openai-compatible`，配上智谱的 OpenAI 兼容端点：

```jsonc
// ✅ 正确
"memorySearch": {
  "provider": "openai-compatible",
  "model": "embedding-3",            // 智谱 embedding 模型
  "remote": {
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",  // 智谱 OpenAI 兼容端点
    "apiKey": "<your ZAI_API_KEY>"
  }
}
```

**关键点**：

| 项 | 值 |
|---|---|
| Provider id | `openai-compatible`（OpenClaw 内置常量，非 zai 插件） |
| 智谱端点 | `https://open.bigmodel.cn/api/paas/v4`（不是 `/api/anthropic`，那个是 LLM 端点） |
| Embedding 模型 | `embedding-3`（推荐，1536 维；也支持 `embedding-2` 更便宜） |
| 鉴权 | 智谱 API Key，header `Authorization: Bearer <key>` |

---

## 🔧 三、配置步骤

### ✅ 第一步：准备智谱 API Key

到 [智谱开放平台](https://open.bigmodel.cn/) 注册并生成 API Key。`embedding-3` 在免费额度内基本够个人使用。

### ✅ 第二步：备份 + 修改 `openclaw.json`

```bash
# 1. 备份（沿用 skyclan-chatroom 的命名约定）
cp -p ~/.openclaw/openclaw.json \
  ~/.openclaw/openclaw.json.bak-before-openai-compatible-$(date +%s)
```

编辑 `~/.openclaw/openclaw.json`，找到 `agents.defaults.memorySearch` 段，**整段替换**为：

```json
"memorySearch": {
  "provider": "openai-compatible",
  "model": "embedding-3",
  "remote": {
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "apiKey": "your-zhipu-api-key-here"
  },
  "cache": { "enabled": true },
  "query": {
    "hybrid": {
      "mmr": { "enabled": true },
      "temporalDecay": { "enabled": true }
    }
  }
}
```

### ✅ 第三步：杀掉卡死的本地 worker（如果存在）

```bash
ps aux | grep memory-core-local-embedding-worker | grep -v grep | awk '{print $2}' | xargs -r kill -9
```

Gateway 会按新配置重新启动 memory 子系统（按需触发）。

### ✅ 第四步：重建索引 ⚠️ **必做！**

切 provider 后，旧索引里的向量是 local 模型算的（768 维），和新 provider 的维度（embedding-3 默认 1024/1536 维）**不兼容**。OpenClaw 会暂停 vector search 直到重建：

```bash
openclaw memory index --force --agent main
```

输出里应该看到多次 `embeddings: batch start`，每个 batch 代表一批 chunk 成功调用了智谱 API。最终一行是 `Memory index updated (main).`

---

## 🔍 四、验证

### 浅检查

```bash
openclaw memory status --deep --agent main
```

关键指标：

| 指标 | 期望值 |
|---|---|
| Provider | `openai-compatible (requested: openai-compatible)` |
| Model | `embedding-3` |
| Embeddings | `ready` |
| Indexed | `N/N files · NNNN chunks` |
| Vector search | 不再 paused |
| Index identity | 不再是 `fts-only, expected embedding-3` |
| Batch | `failures 0/N`（少量失败可接受，会自动重试） |

### 实测搜索

```bash
openclaw memory search "苗苗" --agent main
```

期望：返回非空 `results` 数组，包含评分（0~1）和来源文件。

---

## ⚠️ 五、本次踩到的两个坑

### 坑 1：zai 插件不支持 embedding

`openclaw-zai-provider` 的 `openclaw.plugin.json` 里 `modelCatalog.providers.zai.models` **只列出 GLM 系列 LLM**，没有任何 embedding 模型。直接 `provider: "zai"` 跑 memory search 会报"找不到 embedding 模型"。

**解决：** 改用 OpenClaw 内置的 `openai-compatible` provider，配置走智谱 OpenAI 兼容端点。

### 坑 2：切 provider 必须 `--force` reindex

不重建索引时：
```
Vector search: paused until memory is rebuilt
Index identity: index was built for model fts-only, expected embedding-3
```
搜索会回退到 **FTS-only（关键词匹配）**，看起来"能用"但丢掉了语义搜索。一定要重建。

---

## 📊 六、性能与成本

| 场景 | 耗时 |
|---|---|
| 首次 embedding 调用（冷连接） | 1-3s |
| 热状态 embedding | 200-800ms |
| 完整 search（含 embed + vector 检索） | 1-2s |
| 60 文件 · 1445 chunks 重建索引 | 3-5 min（智谱 API 串行 batch） |

**成本参考（智谱 embedding-3）：**

| 项目 | 价格 |
|---|---|
| 输入 | ~¥0.0005 / 千 token |
| 个人 60 文件 + 偶发搜索 | 几乎免费 |
| 全量 reindex 一次 1445 chunks | < ¥0.01 |

---

## 📝 七、完整 openclaw.json 片段

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "provider": "openai-compatible",
        "model": "embedding-3",
        "remote": {
          "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
          "apiKey": "your-zhipu-api-key-here"
        },
        "cache": { "enabled": true },
        "query": {
          "hybrid": {
            "mmr": { "enabled": true },
            "temporalDecay": { "enabled": true }
          }
        }
      }
    }
  }
}
```

---

## 🛠 八、排障速查

| 错误 | 原因 | 解决 |
|------|------|------|
| `Unknown memory embedding provider: openai-compatible` | 版本 < 2026.6.x 不支持 | 升级 `openclaw` |
| `missing remote.baseUrl` | CLI 命令没读 `memorySearch.remote` | 检查 `agents.defaults.memorySearch.remote.baseUrl` 是否存在 |
| `Vector search: paused until memory is rebuilt` | 切 provider 后没 reindex | `openclaw memory index --force --agent main` |
| `Embeddings: not checked` | 没跑 deep status | `openclaw memory status --deep` |
| `failures N/M` 持续上升 | 智谱 API Key 无效 / 欠费 | 检查智谱账户余额和 Key 有效性 |
| 智谱返回 401 | API Key 过期或填错 | 重新生成 Key 并替换 `remote.apiKey` |
| 智谱返回 429 | 触发限流 | 加 `--batch-size 1`（待确认是否支持），或稍后重试 |

---

## 🔀 九、本地 vs 云端方案对比

| 维度 | 本地（llama-cpp） | 云端（智谱 embedding） |
|---|---|---|
| 网络依赖 | 仅首次下载 | 每次调用都需要 |
| 内存常驻 | 300-500MB | 几乎无 |
| 冷启动 | 10-30s（可改超时到 60s） | 1-3s |
| 热搜索延迟 | 2-4s | 1-2s |
| 维度 | 768（固定） | 1024/1536 可选 |
| 成本 | 一次性电费 | 按 token 计费（个人可忽略） |
| 隐私 | 数据不出本机 | 数据出本机 |
| 稳定性 | 受本机资源影响，可能卡死 | 受 API 稳定性影响，但通常更稳定 |
| 配置难度 | 装插件 + 编译依赖 | 改 JSON + 1 个 API Key |

**建议策略：**

- 主力开发机 → 本地（隐私 + 0 成本）
- 内存紧张 / 编译环境不便 / 本地反复卡死 → 云端
- 两台机器混用 → 各自独立配置

---

## ✅ 总结

**装 Key → 改 JSON（provider=openai-compatible）→ 杀 worker → reindex**

一次配置，永久受益。配合 `MEMORY_SEARCH_SETUP.md` 形成"本地优先、云端兜底"的完整方案。

---

_沉淀于 2026-08-15 · 触发场景：本地 embedding worker 卡死导致 `memory_search` 15s 超时_
_本文档位于：`~/projects/skyclan-chatroom/docs/MEMORY_SEARCH_CLOUD.md`_
_配套文档：[`MEMORY_SEARCH_SETUP.md`](./MEMORY_SEARCH_SETUP.md)（本地 llama-cpp 方案）_