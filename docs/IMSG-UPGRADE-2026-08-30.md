# imsg 升级指南与经验沉淀（0.7.2 → 0.14.2，2026-08-30）

> 背景：家庭 iMessage 通道长期跑在 Intel MacBook Pro 的 `imsg` CLI 上。
> 2026-05 曾因 brew 版 PhoneNumberKit bundle symlink 权限问题崩溃（SIGILL），
> 当时用本地编译 0.7.2 顶替。2026-08-30 升级到官方 0.14.2 预编译版，本文沉淀全过程。

## 一、版本现状

| 项 | 值 |
|----|-----|
| 现役版本 | 0.14.2（官方 universal 预编译：x86_64 + arm64，带签名 + hardened runtime） |
| 旧版 | 0.7.2（本地编译，2026-05-06 Intel 修复版） |
| 仓库 | **已迁移**：steipete/imsg → **OpenClaw/imsg**（下载地址认准新 org） |
| 安装方式 | 官方 release 直装；**不走 brew**（tap untrusted 拒载 + Intel bottle 有 bundle crash 前科） |

## 二、⚠️ 不兼容变更（迁移必读）

1. **`imsg send` 的 `--message` 参数已废，改用 `--text`**
   ```bash
   # 旧（0.7.x，报错 Unknown option --message）
   imsg send --to <addr> --message "hi"
   # 新（0.14.x）
   imsg send --to <addr> --text "hi"
   ```
2. **`tapback` / `edit` / `unsend` 的 `--message` 没变** —— 它是消息 GUID 选择器，不是发送文本，别和上面混淆。
3. `imsg rpc` stdout 严格 JSONL：启动失败/权限失败返回 JSON-RPC 错误对象，不再打印人类可读横幅——解析 stdout 的脚本更稳，但裸读文本的旧脚本行为会变。
4. `watch` fail-closed：不再吐 `chat_id=0` 的未解析消息（旧行为的"多消息"消失了，这是修正不是丢消息）。
5. URL 预览行合并为一条逻辑消息（history/search/watch 一致）——按行数统计消息数的脚本数字会变小。

## 三、0.7.2 → 0.14.2 功能变化概览

**JSON-RPC 大升级（0.14.0）**
- 长驻运行时：有界、可恢复；协议 v1 能力上报（`initialize` / `status`）；权威投递结果
- 新方法：`messages.search`、ROWID 分页、`send.multipart`、`send.tracked`（消息级回执对账）、`bridge.events.subscribe`
- `imsg status --json` 带 CLI 版本，可按版本 gate 新 RPC 面

**私有 API 桥（IMCore bridge）**
- macOS 26 兼容修复（发送/回复/tapback/typing/群生命周期）
- AppleScript 自动回退；附件 staging 与回复线程保真

**读侧能力**
- 富文本（attributedBody）消息可搜索（0.14.1，以前完全搜不到）
- 未读计数、`imsg stats`、`imsg scheduled list`、`imsg chat-background status`
- watch 在 SQLite WAL 轮转后自动重挂（0.10.0，修繁忙库漏消息）

**健壮性（0.14.2，推荐升级的主因）**
- 发送时目标会话不在 Messages.app 活跃列表 → 自动恢复，不再失败
- 无头 `watch` / `search` 不再卡在未答复的联系人权限弹窗

**其他**
- 原生投票（发送/投票/读回，0.9–0.13 系列）
- Linux 只读版（0.8.0，`imsg-linux-x86_64.tar.gz`）
- PhoneNumberKit 5.0.7（就是当年 Intel 崩溃的那个库，已多次升级）

## 四、升级流程（可照抄）

```bash
# 1. 下载 + 校验
cd /tmp && mkdir imsg-upgrade && cd imsg-upgrade
curl -sL -o imsg-macos.zip  https://github.com/OpenClaw/imsg/releases/download/v0.14.2/imsg-macos.zip
curl -sL -o SHA256SUMS      https://github.com/OpenClaw/imsg/releases/download/v0.14.2/SHA256SUMS
grep imsg-macos SHA256SUMS && shasum -a 256 imsg-macos.zip   # 两者必须一致
unzip -o imsg-macos.zip

# 2. 架构确认（Intel 机器必须有 x86_64）
lipo -info imsg

# 3. 备份 + 替换
mv /usr/local/bin/imsg /usr/local/bin/imsg.<旧版本>.bak
cp imsg /usr/local/bin/imsg && chmod 755 /usr/local/bin/imsg

# 4. 冒烟三连
imsg --version
imsg chats --limit 3
imsg send --to <维护者地址> --text "🧪 0.14.2 升级发送链路测试"
```

**回滚（30 秒）：**
```bash
cp /usr/local/bin/imsg.<旧版本>.bak /usr/local/bin/imsg && chmod 755 /usr/local/bin/imsg
```

## 五、迁移兼容性审计方法

升级前 grep 全部调用方，确认没有用废弃参数：

```bash
# 发送路径必须全是 --text；--message 只允许出现在 tapback/edit/unsend 上下文
grep -rn "imsg send" ~/.openclaw/ ~/projects/ 2>/dev/null
grep -c '"--message"' <宿主程序分发目录>/*.js   # 逐个确认是 GUID 选择器
```

实测结论（2026-08-30）：OpenClaw gateway 发送路径用 `--text` / `send-rich --text`，tapback/edit/unsend 的 `--message` 语义在 0.14.2 未变，兼容 ✅。

## 六、经验教训

1. **TCC 权限会继承**：同路径替换 + 二进制签名标识一致（com.steipete.imsg），Full Disk Access 不丢——实测 `chats` 换装后立即可用。
2. **时间窗巧合 ≠ 因果**（对应因果链铁律）：本次升级后当晚 OpenClaw gateway 停机 16 分钟，表象像 imsg 升级引发。拉日志实证：死因是 OpenClaw 自升级流程发出的 SIGTERM（外部停止信号），期间 imessage provider 用新 imsg 启动过且零报错，stability 目录当日零新增崩溃转储——**与 imsg 无关**。任何「A 之后 B 坏了」先拉日志/diff 再定责。
3. **宿主与 CLI 同晚双升级时，排障要分开归因**：一次只动一个变量，出问题才知道是谁的锅。

## 七、后续升级约定

- 认准 `OpenClaw/imsg` Releases，下载 `imsg-macos.zip` + `SHA256SUMS`，校验后再装
- 新版发布先看 release notes 里有无新的 breaking flags，再跑第五节审计
- 升级后 24h 内留意 gateway 日志 `[imessage]` 行有无 error
