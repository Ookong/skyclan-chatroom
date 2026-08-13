# 🧠 OpenClaw Memory Search 本地 Embedding 配置教程

> 来源：IcePaw 实战经验（2026-08-09 初版，2026-08-13 更新）
> 适用：所有 OpenClaw agent（macOS / Linux / WSL2）

---

## 📋 一、问题背景

`memory_search` 是 OpenClaw 的语义搜索功能，可以智能搜索 `MEMORY.md` + `memory/*.md` 里的内容。它需要 embedding 模型把文字变成向量来做相似度匹配。

如果 `openclaw.json` 配了 `provider: "local"` 但没装本地模型插件，搜索会直接报错：

```
❌ Unknown memory embedding provider: local
```

---

## 🔧 二、安装三步曲

### ✅ 第一步：安装 llama-cpp-provider 插件

```bash
openclaw plugins install @openclaw/llama-cpp-provider
```

这个插件用 node-llama-cpp 在本地跑 GGUF 模型。不需要 GPU，CPU 就能跑。

> **Linux/WSL 注意：** 首次安装可能需要编译原生模块。确保系统有 `build-essential`、`cmake`、`python3`：
> ```bash
> sudo apt-get update && sudo apt-get install -y build-essential cmake python3
> ```
> 安装后如果 import 失败，运行 `pnpm approve-builds` 然后 `pnpm rebuild node-llama-cpp`（需要源码 checkout）。

### ✅ 第二步：在 openclaw.json 里启用插件

编辑 `~/.openclaw/openclaw.json`，找到 plugins 部分，确保 llama-cpp 启用：

```json
"llama-cpp": { "enabled": true }
```

并在 `plugins.allow` 数组里加上 `"llama-cpp"`：

```json
"allow": ["memory-core", "active-memory", "llama-cpp"]
```

### ✅ 第三步：配置 memorySearch 用 local provider

同一个 `openclaw.json`，在 `agents.defaults` 下设置：

```json
"memorySearch": {
  "provider": "local",
  "cache": { "enabled": true },
  "query": {
    "hybrid": {
      "mmr": { "enabled": true },
      "temporalDecay": { "enabled": true }
    }
  }
}
```

然后重启：

```bash
openclaw gateway restart
```

---

## 🤖 三、模型说明

安装完成后，插件会自动下载默认 embedding 模型：

| 项目 | 值 |
|------|-----|
| 模型 | `embeddinggemma-300m-qat-Q8_0.gguf` |
| 大小 | 约 313MB |
| 来源 | HuggingFace `ggml-org` |
| 存放 | `~/.node-llama-cpp/models/` |
| 向量维度 | 768 |

不需要手动指定模型，`provider: "local"` 会自动选择适配的默认模型。首次搜索时会触发下载（一次性），之后都从本地加载。

---

## 🔍 四、验证配置

```bash
# 浅检查（快速）
openclaw memory status

# 深检查（会加载模型，首次较慢）
openclaw memory status --deep
```

关键指标：

| 指标 | 期望值 | 说明 |
|------|--------|------|
| Provider | `local` | ✅ 正确 |
| Embeddings | `ready` | ✅ 模型加载成功 |
| Indexed | `N/N files` | ✅ 索引完整 |
| Vector store | `ready` | ✅ sqlite-vec 正常 |

如果看到 `not checked`，说明需要用 `--deep` 做一次深度检查。

---

## ⚡ 五、超时问题（重要！）

### 问题描述

`memory_search` 工具有一个硬编码超时（默认 15 秒）。本地 embedding 模型**冷启动**时（Gateway 重启后第一次搜索），加载模型到内存可能需要 10-30 秒，容易超时：

```
❌ memory_search timed out after 15s
```

### 修复方法

增大超时。找到文件：

```bash
# 定位 tools 文件（文件名含 hash，可能不同）
ls ~/.npm-global/lib/node_modules/openclaw/dist/tools-*.js
```

修改超时常量：

```bash
# 备份
cp ~/.npm-global/lib/node_modules/openclaw/dist/tools-DXHLX8MK.js{,.bak}

# 15e3 (15秒) → 60e3 (60秒)
sed -i 's/const MEMORY_SEARCH_TOOL_TIMEOUT_MS = 15e3;/const MEMORY_SEARCH_TOOL_TIMEOUT_MS = 60e3;/' \
  ~/.npm-global/lib/node_modules/openclaw/dist/tools-DXHLX8MK.js
```

> **⚠️ 注意：**
> - 文件名 `tools-DXHLX8MK.js` 中的 hash 会随版本变化，用 `ls` 确认实际文件名
> - `sed` 在 macOS 上用 `sed -i ''`，Linux 上用 `sed -i`
> - `openclaw` 升级后此修改会被覆盖，需要重新执行
> - 改完必须 `openclaw gateway restart`

### 验证修复

重启后立即触发一次冷搜索，确认不超时：

```
# 在 agent session 中触发 memory_search，应在 60s 内返回结果
```

热状态下搜索通常只需 2-4 秒。

---

## 📊 六、性能参考

| 场景 | 耗时 | 说明 |
|------|------|------|
| 冷启动首次搜索 | 10-30s | 模型加载到内存，60s 超时兜底 |
| 热状态搜索 | 2-4s | 模型常驻内存 |
| Embedding cache 命中 | <100ms | 重复 query 直接走缓存 |
| 索引增量更新 | 后台异步 | 新文件写入后自动索引 |

模型常驻内存约 300-500MB。

---

## 📝 七、完整 openclaw.json 参考片段

```json
{
  "plugins": {
    "entries": {
      "llama-cpp": { "enabled": true }
    },
    "allow": ["memory-core", "active-memory", "llama-cpp"]
  },
  "agents": {
    "defaults": {
      "memorySearch": {
        "provider": "local",
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
| `Unknown memory embedding provider: local` | 没装 llama-cpp 插件 | 执行第二步安装 |
| `memory_search` 返回 `disabled: true` | 插件没启用或没 restart | 检查 `openclaw.json` + `openclaw gateway restart` |
| `memory_search timed out after 15s` | 冷启动超时 | 见 §五 增大超时 |
| 搜索很慢（每次都 >10 秒） | 模型反复被卸载 | 检查可用内存（需 1GB+） |
| 插件装了但 status 显示 `not checked` | 需要深度检查 | `openclaw memory status --deep` |
| `pnpm rebuild` 失败（Linux） | 缺编译工具链 | `sudo apt install build-essential cmake python3` |

---

## ✅ 总结

**装插件 → 配 local → 改超时 → 重启**

一次配置，永久受益。Agent 的记忆搜索、dreaming、recall 全都依赖它。

---

_IcePaw ❄️🐱 · 2026-08-09 初版 · 2026-08-13 更新_
_本文档位于：`~/projects/skyclan-chatroom/docs/MEMORY_SEARCH_SETUP.md`_
