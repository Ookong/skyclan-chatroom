# MiniMax Embedding 代理部署指南

> 配套文档：
> - 经验总结（why / 踩坑 / 教训）：`../MEMORY_SEARCH_MINIMAX_EXPERIENCE.md`
> - 部署指南（how-to）：`~/.openclaw/punk-records/docs/guides/memory-search-minimax-embedding.md`

## 文件清单

| 文件 | 作用 |
|------|------|
| `minimax-embed-proxy.mjs` | OpenAI-compatible → MiniMax embo-01 翻译代理（Node 18+，自带 fetch） |
| `minimax-embed-proxy.service` | systemd user unit（systemd --user 模式，无需 root） |
| `minimax-embed-proxy.env.example` | 环境变量模板（**不要提交真实 key**） |

## 部署步骤

### 1. 安装脚本

```bash
mkdir -p ~/.openclaw/scripts
cp minimax-embed-proxy.mjs ~/.openclaw/scripts/
chmod +x ~/.openclaw/scripts/minimax-embed-proxy.mjs
```

### 2. 配置环境变量（**不要把 key 写进仓库**）

二选一：

**A. shell rc（推荐本地开发）：**
```bash
# 写入 ~/.zshrc 或 ~/.bashrc
export MINIMAX_API_KEY="sk-cp-你的key"
export PROXY_PORT=9999
export EMBED_TYPE=db   # db | query
```

**B. systemd EnvironmentFile（推荐生产）：**
```bash
# 在仓库外创建（不进 git）：
cat > ~/.openclaw/scripts/minimax-embed-proxy.env <<ENV
MINIMAX_API_KEY=sk-cp-你的key
PROXY_PORT=9999
EMBED_TYPE=db
ENV
chmod 600 ~/.openclaw/scripts/minimax-embed-proxy.env
```

### 3. 安装 systemd unit

```bash
mkdir -p ~/.config/systemd/user
cp minimax-embed-proxy.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable minimax-embed-proxy.service
systemctl --user start minimax-embed-proxy.service
systemctl --user status minimax-embed-proxy.service
```

### 4. 验证

```bash
# 4.1 健康检查
curl -X POST http://127.0.0.1:9999/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"input":"hello world","model":"embo-01"}'

# 4.2 日志
journalctl --user -u minimax-embed-proxy.service -f
```

## 关键参数说明

| 参数 | 默认 | 含义 |
|------|------|------|
| `MINIMAX_API_KEY` | 必填 | MiniMax 控制台申请 |
| `PROXY_PORT` | 9999 | 监听端口（仅 127.0.0.1） |
| `EMBED_TYPE` | db | 默认 type：`db`（入库）/ `query`（检索） |
| `MIN_INTERVAL_MS` | 200 | 上游调用最小间隔（限流） |
| `MAX_RETRIES` | 4 | 失败重试次数 |

## ⚠️ 安全提醒

- **绝对不要**把 `.env` / 含 key 的文件 commit 进仓库
- systemd unit 用 `EnvironmentFile=-%h/...` 软链，不在仓库里
- 本仓库的 `.gitignore` 应已排除 `*.env`（如未排除请补）

## 配套踩坑清单（详见经验总结）

1. systemd user 模式需要 `loginctl enable-linger <user>` 否则 SSH 退出就挂
2. 端口冲突排查：`ss -ltnp | grep 9999`
3. WSL2 强制 IPv4：脚本已内置 fetch，Node 18+ 默认 v6 优先
4. 字段重写：`model` / `input: string|string[]` → `model` / `texts: string[]` / `type: db|query`
