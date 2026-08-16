# ☁️ Memory Search 云端 Embedding（智谱 embedding-3）— 全家默认方案

> **状态：✅ 官方首选（2026-08-16 猴哥指令）**
> 新成员 / 新机器 onboarding 时，**直接按本文配置**。

---

## 🧠 一、原理：用内置 `openai-compatible` provider

OpenClaw 内置 provider id `openai-compatible`，走 OpenAI 标准 `/v1/embeddings` 端点，可指向任何兼容服务。

⚠️ **`@openclaw/zai-provider` 插件只注册 GLM 系列 LLM，不注册 embedding。**
`"memorySearch": { "provider": "zai" }` 会报"找不到 embedding 模型"，必须用 `openai-compatible`：

```jsonc
"memorySearch": {
  "provider": "openai-compatible",
  "model": "embedding-3",
  "remote": {
    "baseUrl": "https://open.bigmodel.cn/api/paas/v4",
    "apiKey": "<智谱 API Key>"
  }
}
```

| 项 | 值 |
|---|---|
| Provider id | `openai-compatible`（内置，非 zai 插件） |
| 智谱端点 | `https://open.bigmodel.cn/api/paas/v4`（标准端点；`/api/coding/paas/v4` 是 Coding Plan 专用，**不支持** embeddings） |
| 模型 | `embedding-3`（2048 维） |
| 鉴权 | `Authorization: Bearer <智谱 API Key>` |

⚠️ **Key 注意：** GLM Coding Plan 的 key（`sk-cp-*`）对 embeddings 端点返回 401，**必须用智谱开放平台的标准 API Key**（格式 `xxxxxxxx.yyyyyyyy`）。

---

## 🔧 二、配置步骤

### 1. 准备智谱 API Key
[智谱开放平台](https://open.bigmodel.cn/) 注册 → 生成 API Key。embedding-3 免费额度对个人足够。

### 2. 备份并修改 `openclaw.json`

```bash
cp -p ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak-pre-cloud-embedding-$(date +%s)
```

用 jq 合并（保留原有 cache / query.hybrid 配置）：

```bash
jq --arg key "<你的智谱Key>" '.agents.defaults.memorySearch = (.agents.defaults.memorySearch + {
  "provider": "openai-compatible",
  "model": "embedding-3",
  "remote": { "baseUrl": "https://open.bigmodel.cn/api/paas/v4", "apiKey": $key }
})' ~/.openclaw/openclaw.json > /tmp/openclaw.json.new \
  && jq -e / /tmp/openclaw.json.new > /dev/null \
  && chmod 600 /tmp/openclaw.json.new \
  && mv -f /tmp/openclaw.json.new ~/.openclaw/openclaw.json
```

### 3. 重启网关

```bash
openclaw gateway restart
curl -s http://localhost:18789/health   # 期待 {"ok":true,"status":"live"}
```

### 4. 重建索引 ⚠️ 必做

切 provider 后旧索引维度不兼容（embedding-3 为 2048 维），必须 `--force` 重建，否则 vector search 一直 paused、退化为关键词搜索：

```bash
openclaw memory index --force --agent main
# 4819 chunks 约 7 分钟；途中出现 retryable error 重试属正常
```

### 5. 验证

```bash
openclaw memory status --deep --agent main | grep -E "Provider|Model|Indexed|Dirty|identity|Vector search|dims|Embeddings"
```

期望：

| 指标 | 值 |
|---|---|
| Provider | `openai-compatible (requested: openai-compatible)` |
| Model | `embedding-3` |
| Indexed | 全部文件 · chunks 数 |
| Dirty | `no` |
| Vector dims | `2048` |
| Vector search | 不再 `paused` |
| Embeddings | `ready` |

实测搜索：

```bash
openclaw memory search "任意语义查询" --agent main   # 应返回带评分的语义命中
```

---

## ⚠️ 三、踩坑记录

### 坑 1：zai 插件不支持 embedding
`openclaw-zai-provider` 的 modelCatalog 只有 GLM LLM。直接 `provider: "zai"` 报"找不到 embedding 模型"。
**解决：** 用内置 `openai-compatible` + 智谱标准端点。

### 坑 2：Coding Plan key 调标准端点 401
`sk-cp-*` 格式的 key 只对 coding 端点有效，调 `/api/paas/v4/embeddings` 返回 401"令牌已过期或验证不正确"。
**解决：** 用智谱开放平台生成的标准 API Key（`id.secret` 格式）。

### 坑 3：切 provider 不 reindex → 静默退化
不重建索引时 `Vector search: paused until memory is rebuilt`，搜索退回 FTS-only（关键词），看起来"能用"但语义搜索失效。**必须 `--force`。**

---

## 📊 四、性能与成本

| 场景 | 实测（智谱 embedding-3） |
|---|---|
| 单次 embedding 调用 | 0.27s |
| 全量重建 4819 chunks | ~7 分钟 |
| 日常搜索（embed + 检索） | < 1.5s |
| 成本 | 输入 ~¥0.0005/千token；个人日常用几乎免费 |

---

## 🔄 五、升级历史

| 日期 | 事件 |
|---|---|
| 2026-08-15 | 龙井配置云端方案并沉淀文档（首版） |
| 2026-08-16 01:00 | MK-MacBook（冰爪）按本文切换：验证 key → 改配置 → 重启 → 强制重建 |
| 2026-08-16 01:10 | 猴哥指令：云端为全家默认，写入 onboarding |
| 2026-08-17 | 删除本地 llama-cpp 历史归档文档，本文只保留云端方案 |

---

_本文档位于：`~/projects/skyclan-chatroom/docs/MEMORY_SEARCH_CLOUD.md`_
