> **📍 公开版说明（2026-10-13）：** 本文为脱敏公开版——真实姓名/服务器/凭据/公司标识/member_id 已替换为占位符；
> 家庭成员用公开名（Tree / ThawPaw / Violetshine）。**完整版（含真值）在 skyclan 私仓** `projects/wsl2-backend-deployment/`。
> 关联的迁移执行清单同样只在私仓。

# 小马接入仓库总览与使用规范（GitHub + Codeup）

> **状态：** 🟡 草稿，6 处待 icepaw 在 skyclan 聊天室确认
> **生成：** 2026-10-11 22:18（小马 / OpenClaw 2026.8.35）
> **使用对象：** 新一代小马（Win11 原生 Hermes）+ 老 OpenClaw 小马 + 如意 + 冰爪 + 龙井（cross-ref）
> **关联文档：**
> - `tmp/小马-OpenClaw-迁-Hermes-清单.md` — 迁移执行清单（M1→M4）
> - `docs/xiaoma-openclaw-to-hermes-migration.md` — 迁移完整方案（18KB）
> - `~/projects/skyclan/family/` — 家庭边界 / 通讯矩阵 / 沟通纪律（**专属路径**）
> - `~/projects/Sand-Hollow/mentors-den/mentors-rules.md` v1.0（单签 + chatroom review）— 沙坑 mentor 手册

---

## 〇、前言

小马 = **MK-002 野・行动**，SkyClan 家庭成员（另兼工作侧身份，细节见私仓）。本文档列出**全部**小马需要访问的代码仓库 + 使用规范，并重点覆盖两件新端要做的事：**① 接入 SkyClan 聊天室 ② 接入 Sand Hollow 沙坑**。

**写文档时的发现：** 老 OpenClaw 端已具备所有仓库 + 凭证；新 Hermes 端（Win11 原生）需要把 SSH 凭证迁移 + 重新 `git clone` 各仓。

---

## 一、仓库总览

### 1.1 Codeup 私有仓（3 个，Tree维护）

| # | 仓库 | URL | 用途 | 本机克隆路径 | owner |
|---|---|---|---|---|---|
| 1 | **花果山** | `git@codeup.aliyun.com:<org>/tools/huaguoshan.git` | workspace/research/memory/docs/skills/hooks | `~/huaguoshan`（新）<br>`~/.openclaw/workspace`（老） | Tree + 全员读 |
| 2 | **Punk Records（团队）** | `git@codeup.aliyun.com:<org>/tools/punk-records.git` | 跨分身 rules / shared-memory | `~/punk-records`（新）<br>`~/.openclaw/punk-records`（老） | Tree + 全分身读 |
| 3 | **skyclan**（家庭）| `git@codeup.aliyun.com:<org>/houge/skyclan.git` | SkyClan 家人档案 / 通讯矩阵 / 边界规则 / 聊天室配置 / ThawPaw / Violetshine | `~/projects/skyclan` | **私密** — 4 分身共用（ruyi/xiaoma/icepaw/longjing），不入任何公开仓 |

**Codeup 凭证：** WSL2 端 `~/.ssh/id_ed25519` 已配对；Win11 Hermes 端需要同样的 key（或新 key 加入）。

### 1.2 GitHub 公开仓（2 个）

| # | 仓库 | URL | 用途 | 本机克隆路径 | owner |
|---|---|---|---|---|---|
| 4 | **skyclan-chatroom** | `git@github.com:Ookong/skyclan-chatroom.git` | 聊天室 backend + client + docs | `~/projects/skyclan-chatroom` | Ookong org（冰爪的 GitHub）|
| 5 | **Sand-Hollow** | `git@github.com:Thawflow/Sand-Hollow.git` | 沙坑训练场 + GitHub Pages（learning.thawflow.com）| `~/learning-homework`（仓库内推荐） | Thawflow org（家庭沙坑共享）|

**GitHub 凭证：** WSL2 `~/.ssh/id_ed25519.pub` 已加 `github.com`（Ookong + Thawflow）；Win11 Hermes 端同样需要这个 key。

---

## 二、SSH 凭证传递（Win11 Hermes 端必做）

### 2.1 WSL2 老 OpenClaw 现状

```bash
$ ls ~/.ssh/
authorized_keys
config
id_ed25519              # 私钥
id_ed25519.pub          # 公钥（已加入 codeup + github）
known_hosts             # codeup / github / 4090 服务器均已认
known_hosts.old

$ cat ~/.ssh/config
Host 4090 <SERVER_IP>
    HostName <SERVER_IP>
    Port <PORT>
    User <user>
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 60
    ServerAliveCountMax 3
```

WSL2 / Win11 互通：`\\wsl$\Ubuntu\<home>\.ssh\` 是 Win11 视角下的路径（Explorer 直接拷）。

### 2.2 Hermes（Win11）端要做的事

**推荐：复用 WSL2 的 key（一份 key 多个环境用）**

```powershell
# PowerShell（Win11）
mkdir $env:USERPROFILE\.ssh
# 从 WSL2 拷私钥、公钥、config、known_hosts
cp \\wsl$\Ubuntu\<home>\.ssh\id_ed25519      $env:USERPROFILE\.ssh\
cp \\wsl$\Ubuntu\<home>\.ssh\id_ed25519.pub  $env:USERPROFILE\.ssh\
cp \\wsl$\Ubuntu\<home>\.ssh\config          $env:USERPROFILE\.ssh\
cp \\wsl$\Ubuntu\<home>\.ssh\known_hosts     $env:USERPROFILE\.ssh\
# 权限（Win10+ 默认即可，但确认）
icacls $env:USERPROFILE\.ssh\id_ed25519 /inheritance:r /grant:r "$($env:USERNAME):(R)"

# 验证连 GitHub + Codeup
ssh -T git@github.com           # 应回 "Hi <user>! You've successfully authenticated..."
ssh -T git@codeup.aliyun.com    # 应能成功（key 已配 codeup）
```

**如果生成新 key（在 Win11 上）：**

```powershell
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\id_ed25519
# 公钥 $env:USERPROFILE\.ssh\id_ed25519.pub 加入：
#   - GitHub: https://github.com/settings/keys
#   - Codeup: codeup.aliyun.com 个人设置 → SSH 公钥
```

---

## 三、各仓库使用规范

### 3.1 花果山（codeup:tools/huaguoshan）

| 维度 | 规范 |
|---|---|
| **本机路径** | 老 `~/.openclaw/workspace/` · 新 `~/huaguoshan/` |
| **同步方式** | 双向 push/pull；老端 push 前必 `git pull --rebase` |
| **commit 前缀** | `[分身] <type>: <描述>`（如 `[小马] feat: ...` / `[如意] docs: ...`） |
| **推送确认** | 🔴 **红线**：push 前Tree**明文**「推/可以/批准」；emoji👍 / 沉默 / 分身代确认**不算** |
| **hooks** | `hooks/self-improvement/`（auto-log + activator + error-detector + handler.js + HOOK.md） |
| **commit 大小** | 同主题多文件 → squash；半成品 + 修正 → 合并再 push |
| **核心命令** | `git log --oneline origin/main..HEAD`（推送前自查）<br>`git pull --rebase`（推送前同步）<br>`git reset --soft HEAD~N`（合并主题） |
| **subdir 重要约束** | `research/` 60+ 项目独立工作；`memory/` 重（master scope）；`docs/` 视为现写 doc；`hooks/` 入仓 |

### 3.2 Punk Records（codeup:tools/punk-records）

| 维度 | 规范 |
|---|---|
| **本机路径** | 老 `~/.openclaw/punk-records/` · 新 `~/punk-records/` |
| **性质** | 跨分身协作规范 + 跨分身公共规则 + shared-memory |
| **成员目录** | `members/<分身>/{SOUL,IDENTITY,USER,HEARTBEAT,MEMORY}.md` — 各自独占；MEMORY.md 是**跨分身共享**（不在 .gitignore）|
| **身份特异性文件备份** | `backup-config.sh` 已改 — xiaoma/ruyi 改存 `skyclan/members`，小赢保持 Punk Records（Tree 2026-10-07 14:44 指示）|
| **推送确认** | 同花果山红线 |

### 3.3 skyclan（codeup:houge/skyclan，**家庭私密**）

| 维度 | 规范 |
|---|---|
| **本机路径** | `~/projects/skyclan/`（唯一路径；老端 `~/.openclaw/workspace/life/` 已删，10-07 迁移完）|
| **远程** | `git@codeup.aliyun.com:<org>/houge/skyclan.git`（Codeup 私有）|
| **性质** | 4 分身共用 git 仓库（ruyi / xiaoma / icepaw / longjing）；2026-10-07 14:31 Tree指示 |
| **目录结构** | `family/`（共享档案 + ThawPaw ThawPaw专区）<br>`members/<分身>/`（四分身各自独占）<br>`projects/`（家庭项目）|
| **同步** | git pull 会话开始、写完即 push、只用 main、所有权分片防冲突 |
| **推送确认** | ❌ **不限本仓**（私密+家庭，成员都自动可推）|
| **重要文件** | `family/identity-tree.md`（家人成员档案）<br>`family/communication-matrix.md` v2.0（双向通道 + 保护ThawPaw/Violetshine升级）<br>`family/skyclan-boundary-rules.md`（两个圈子严格隔离）<br>`family/skyclan-etiquette.md`（沟通纪律 + WSL2 协作）<br>`family/chatroom-config.md`（SkyClan 聊天室配置 v1.6）<br>`family/chatroom-patrol-crons.md`（聊天室轮询 cron）<br>`family/moment-convention.md`（朋友圈瞬间模板）<br>`family/home-tasks-convention.md`（家庭任务约定）<br>`family/ThawPaw/`（ThawPaw iPad/iMessage 接入） |
| **隐私红线** | 不写公司业务 / <工作侧> 内容；life/ **不**含任何家庭 ID/平台/聊天记录明文；只放路径引用 |

### 3.4 skyclan-chatroom（github:Ookong/skyclan-chatroom）

| 维度 | 规范 |
|---|---|
| **本机路径** | `~/projects/skyclan-chatroom` |
| **性质** | 公开仓库 — **公开 commit 信息**（但 config.json 在 .gitignore） |
| **架构** | Cloudflare Worker `tpg-hq` 扩展（`/chat/*` 路由）— **不在本仓部署**，IcePaw 在 cf-backend 部署 |
| **目录权限（2026-08-16 Tree指示）** | `backend/src/*` = IcePaw ❌ 专属 ❌ 禁止改<br>`cf-backend/*` = IcePaw ❌ 专属 ❌ 禁止改<br>`client/*` = 任意成员 ✅ 可改<br>`docs/*` = 任意成员 ✅ 可改<br>`config.json` / `*.token` = 私主个人 ❌ 禁入库 |
| **KV schema（v1.3）** | `chatroom:member:<member_id>`（8 位数字）<br>`chatroom:msg:<unix_ms>_<random4>`（7-day TTL）<br>`chatroom:index:messages`（500 cap） |
| **成员花名册** | 权威 `docs/COMMUNICATION_RULES.md §1.1`（不要复制到这里） |
| **违规示例** | 2026-08-15 小马踩坑：在 backend 加路由 → revert commit `4ac62fe`；教训：**有需求先在群里 @IcePaw** |
| **推送确认** | 公开仓 push 需Tree明文（继承花果山红线）；client + docs push 默认 OK |
| **Skill** | `skyclan-chatroom-send`（已装 workspace）— Hermes 端软链 `~/huaguoshan/skills/` |

### 3.5 Sand-Hollow（github:Thawflow/Sand-Hollow）

| 维度 | 规范 |
|---|---|
| **本机路径** | `~/learning-homework`（仓库内推荐；本机设置） |
| **远程** | `git@github.com:Thawflow/Sand-Hollow.git` |
| **owner** | Tree（教学法）+ IcePaw ❄️（决策）+ 如意 ✨（文档/规则协作）+ 小马（mentor 双签追认） |
| **学习路径** | W01 起 → 每周 L01/L02… → W07 git clone 接入 → W12 OpenClaw 实战 → W13 算法加餐 |
| **线上站** | learning.thawflow.com（CDN 缓存 ~10min；BUILD_TIME 在页脚） |
| **站点即仓库** | push 到 main = 上线；课程内容可回滚 |
| **当前 commit 习惯** | `[小马] course: ...` / `[冰爪] ...` / `[如意] ...`（按 mentor 各自署名） |
| **推送确认** | 公开仓 push 需Tree明文 |
| **Mentor rules** | `mentors-den/mentors-rules.md` v1.0（现行 — v1.8 单签 + chatroom review） |
| **Skills** | `sand-hollow-grading`（判作业 + review + commit/push + chatroom@如意）<br>`sand-hollow-course-batch`（课程 W01-W03 + 边栏 + 新周课稿） |

---

## 四、新一代小马接入 SkyClan 方案（**重点**）

### 4.1 身份确认

- **小马（MK-002）= SkyClan 家庭成员**（双重身份之一）
- 跟 **如意 ✨ / 冰爪 ❄️ / 龙井 🍵** 并列，skyclan 仓库 `members/<分身>/` 各自独占
- **小赢（MK-001）仅属公司侧**，**不属于 SkyClan**，禁止透露任何"咱家"信息给她

### 4.2 仓克隆 & 配置文件

```bash
# skyclan（家庭私密，Codeup）
git clone git@codeup.aliyun.com:<org>/houge/skyclan.git ~/projects/skyclan
cd ~/projects/skyclan
git status   # 应是 main 分支干净

# skyclan-chatroom（GitHub 公开）
git clone git@github.com:Ookong/skyclan-chatroom.git ~/projects/skyclan-chatroom
cd ~/projects/skyclan-chatroom
ls config.example.json   # 仿此写 config.json（cp + 改 token）
```

### 4.3 必读文档顺序

1. `~/projects/skyclan/README.md`（仓库总览）
2. `~/projects/skyclan/REPOS.md`（仓库同步规则）
3. `~/projects/skyclan/family/identity-tree.md`（家人成员档案）
4. `~/projects/skyclan/family/skyclan-boundary-rules.md`（**两圈子隔离铁律**）
5. `~/projects/skyclan/family/communication-matrix.md` v2.0（双向通道表 + 保护ThawPaw/Violetshine升级）
6. `~/projects/skyclan/family/skyclan-etiquette.md`（沟通纪律 + WSL2 协作要点）
7. `~/projects/skyclan/family/chatroom-config.md` v1.6（SkyClan 聊天室后端/客户端/cron）
8. `~/projects/skyclan-chatroom/docs/COMMUNICATION_RULES.md §1.1`（**member_id ↔ nickname 权威**）
9. `~/projects/skyclan-chatroom/CLAUDE.md`（仓库架构 + 安全红线）

### 4.4 chatroom 注册（**待 icedpaw 确认**）

```bash
# 在 skyclan-chatroom 注册新端（细节问 icedpaw）：
# - 新 member_id（8 位数字） vs 复用老小马的 member_id？
# - icepaw 拍板 chatroom.config:member_id = ? 写入 ~/projects/skyclan-chatroom/config.json
# - icepaw 在 chatroom:member:<member_id> KV 里登记
# - 注意：config.json 不入 git（已在 .gitignore）
```

### 4.5 Skill 装

```powershell
# PowerShell（Win11 / Hermes）— 软链到 huaguoshan（git 同步权威）
mkdir $env:USERPROFILE\.hermes\plugins
New-Item -ItemType Junction -Path "$env:USERPROFILE\.hermes\plugins\skyclan-chatroom-send" -Target "<win-home>\huaguoshan\skills\skyclan-chatroom-send"
hermes skills list --json | jq '.[] | select(.name == "skyclan-chatroom-send")'
```

### 4.6 Cron 配置（精简版）

```powershell
# 老 OpenClaw 端 11 个 cron 全保留；新 Hermes 端只跑 2 个：
hermes cron create "every 1h" "<heartbeat prompt>" --deliver dingtalk
hermes cron create "every 5m" "<SkyClan 轮询 prompt>"
hermes cron list   # 验收
```

**daily prompt 写法** = 调用 `skyclan-chatroom-send` skill 拉新消息 → 有 @小马/ThawPaw/Violetshine 必回 → 参与家庭相关讨论（v2.0 升级）。

### 4.7 边界规则快速记（违反就是事故）

- 🚫 不向 公司侧成员（<工作侧> 方式）透露任何"咱家"信息
- 🚫 不在"咱家"场景引用 <工作侧> / <公司> 公司业务
- ✅ 严格隔离两边语境，宁可少说，不可串线
- ✅ 桥梁职责：通是经授权的服务性传递，漏是默认状态的无差别泄露

---

## 五、新一代小马接入 Sand Hollow 方案（**重点**）

### 5.1 身份：mentor（继承 + 双签追认）

| 角色 | 名字 | 决策权 | 备注 |
|---|---|---|---|
| 🐱 学员 | **ThawPaw** | — | ThawPaw，猫武士主题 |
| 🌳 学员 | **Tree** | — | 自学编程方向 |
| ❄️ mentor | **IcePaw** | **决策者**（课程/规则变更拍板）| 守护 ThawPaw |
| ✨ mentor | **如意** | 文档 + 规则协作 | 守护 Tree |
| 🌙 mentor | **小马（MK-002）** | 双签追认 + 调研 | 继承**

> **v1.0（现行）：** 单签 + chatroom review 工作流（取代双签/单签要求，2026-09-08 12:43 Tree 授权）
> 流程：mentor 修改 → git commit → push → chatroom @另一位 mentor review

### 5.2 仓克隆 & 必读

```bash
# Sand-Hollow（GitHub 公开）
git clone git@github.com:Thawflow/Sand-Hollow.git ~/learning-homework
cd ~/learning-homework
ls mentors-den/   # 应有 mentors-rules.md / review-template.md / abc-rating-v0.2 / challenge-3x-scoring-v1 / ima-final-v2 / v0.1-outline / course/
```

**必读顺序：**

1. `README.md`（仓库总览 + 学员入门）
2. `mentors-den/mentors-rules.md` v1.0（**全部 12 条 + 单签 + chatroom review 工作流**）
3. `mentors-den/review-template.md`（判作业评语模板）
4. `mentors-den/course/`（当前 W01-W13 课稿）
5. `thawpaw/homework/`（ThawPaw作业 — 看过去风格 + 不修改）
7. `tree/homework/`（树作业 — 看过去风格 + 不修改）
6. `docs/index.html` + `track.js` + `sw.js`（站点前端代码，可改）
7. `docs/assets/`（资源文件）

### 5.3 Skill 装

```powershell
# PowerShell（Win11 / Hermes）
New-Item -ItemType Junction -Path "$env:USERPROFILE\.hermes\plugins\sand-hollow-grading" -Target "<win-home>\huaguoshan\skills\sand-hollow-grading"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.hermes\plugins\sand-hollow-course-batch" -Target "<win-home>\huaguoshan\skills\sand-hollow-course-batch"
hermes skills list --json | jq '.[] | select(.name | test("san-hollow"))'
```

### 5.4 任务分工（基于 v1.8 单签 + chatroom review）

| 任务 | 走哪个 skill | chatroom @谁 review | 备注 |
|---|---|---|---|
| **判作业**（ThawPaw W01-W12）| `sand-hollow-grading` | @如意 ✨ | review 后写 `*.review.md`，⑩命名归位 |
| **判作业**（树 W01-W12）| `sand-hollow-grading` | @如意 ✨ | 同上 |
| **更新课程**（W01-W03 内容修订）| `sand-hollow-course-batch` | @如意 ✨ | 课程一课一 commit |
| **新增周课稿**（W14+）| `sand-hollow-course-batch` | @冰爪 ❄️ + @如意 ✨ | 边界变更（v1.8 必报） |
| **改站点代码**（`docs/index.html` 等）| 直接 git | @如意 ✨ | 客户端可改 |
| **修 mentor-rules.md** | 直接 git | @如意 ✨ + @冰爪 ❄️ | 边界变更（v1.8 必报） |
| **push 到 GitHub main** | — | Tree明文「推」| 🔴 红线 |

### 5.5 双签追认（v1.8 前的历史活签认）

| 历史动作 | 追认时机 | 谁可代签 |
|---|---|---|
| 23:50 / 23:55 双签追认（已存档）| v1.8 之前 | ✅ 小马可代签 |

### 5.6 Hermes 端 first 任务建议

```markdown
1. 拉 Sand-Hollow 最新版：`cd ~/learning-homework && git pull`
2. 读 mentors-rules.md v1.0 完整（不要跳读）
3. 跑 `bash mentors-den/mentors-den/test.sh L1 12` 验站点自检
4. 跟冰爪/如意 chatroom 报备（确认 mentor 身份继承）
5. 判一份 树 W12-L0X 作业作为"复活认证"
6. 提交 review → push → chatroom @如意 ✨ review
```

### 5.7 Mentor 三条底线（冰爪定）— 永不破

1. **安全边界** — 内容适龄（学员主题：ThawPaw/树）；代码零危险操作；报错当朋友教；**练习环境 = 她本机 Thonny**，不碰生产
2. **可回滚** — 课程内容全 git（course/ 一课一 commit）；KV 发布前必有 git 留档；修订 = 新 commit（禁静默覆盖）；**lesson ID 永不改**（学员进度按 ID 键）
3. **自动验证** — 页面侧三件套（test.sh L1 #12：字符串命中 + 全部 script 块 node --check + 功能标记在线上源） + 发布后线上验证（**BUILD_TIME + 内容标记**）

---

## 六、需要 icepaw（冰爪 ❄️）在 skyclan 聊天室回答的问题

下面 6 项**只有冰爪能裁定**。我（OpenClaw 端小马）会去 skyclan-chatroom @IcePaw 询问，新 Hermes 端小马开机时也得跟着 @一遍。

| # | 问题 | 紧迫度 | 影响 |
|---|---|---|---|
| 1 | **新 Hermes 端 skyclan-chatroom 需要新 member_id 还是复用老小马的？** 8 位数字 ID 命名空间共享，docs/COMMUNICATION_RULES.md §1.1 权威登记 | 🔴 | ④-4 配置 |
| 2 | **Hermes 端 skyclan-chatroom-send skill 安装手法** — OpenClaw 用 `skyclan-chatroom-send` 软链；Hermes 是 `hermes plugins install` 还是软链？ | 🔴 | ④-5 配置 |
| 3 | **Sand-Hollow 双签身份继承** — 老小马的 mentor 角色在判断矩阵里是否自动包含新端？还是新端要单独报 Tree 拍板？| 🔴 | ⑤-1 身份 |
| 4 | **Ookong/skyclan-chatroom 是否允许 push 到 main**（cf-backend 不在仓；老 OpenClaw 端还有未推 af80ab3 单 commit 等Tree批）| 🟡 | ③-4 push 权限 |
| 5 | **GitHub 公开仓库路径**（家人 SkyClan 沟通用）= skyclan 单独 GitHub 仓？还是别的？文档 §十二 TODO 未填 | 🟡 | ①-2 仓库清单 |
| 6 | **icedpaw / 龙井机的 workspace/life 状态对吗？** 10-07 迁移后只有小马机迁了；如意机未迁；icedpaw / 龙井机未确认 | 🟢 | skyclan 同步 |

### 询问姿势（chatroom 协议）

```bash
# 通过 OpenClaw 端 skyclan-chatroom-send 发
node ~/projects/skyclan-chatroom/client/skyclan-send.js \
  --channel all \
  --text $'🌙 小马（新 Hermes 端接入请教）— @icepaw 6 项待裁定详见 tmp/小马-接入仓库与规范总览.md §六
         优先级：🔴 1+2+3 / 🟡 4+5 / 🟢 6
         截止：本周末前，方便新端下周正式开工。'
```

或 Hermes 端等价：
```powershell
node <win-home>\huaguoshan\skills\skyclan-chatroom-send\client\skyclan-send.js `
  --channel all `
  --text "..."
```

---

## 七、风险与回滚

### 7.1 SSH 凭证风险

| 场景 | 影响 | 处置 |
|---|---|---|
| 老 WSL2 端 SSH key 泄露 | codeup + github + 4090 服务器全暴露 | 立即 revoke（Codeup/GitHub 设置）+ 重新生成 + 重新加公钥 |
| 新 Hermes 端拷错文件 | `id_ed25519` 损坏 → push/pull 失败 | 用 `known_hosts` 重置 + 重新 `ssh-keyscan github.com codeup.aliyun.com >> known_hosts` |

### 7.2 仓库同步冲突

| 场景 | 影响 | 处置 |
|---|---|---|
| 老 OpenClaw 端和新 Hermes 端同时 push 到 main | git 拒绝 + 提示 fast-forward only | 新端 `git pull --rebase` 同步 → 解决冲突 → 重 push |
| 老端 .gitignore 与新端不一致 | 文件结构差异 | 以老端为权威（push 前 sync）|

### 7.3 chatroom 注册失败

| 场景 | 影响 | 处置 |
|---|---|---|
| 新端 member_id 已存在 | 冲突 | icedpaw 重新分配 |
| 老端 + 新端同时连接 | Stream Mode 单连接 — 后连抢不到 | 老端主动断开 → 新端连接 |

### 7.4 Sand-Hollow 双签失效

| 场景 | 影响 | 处置 |
|---|---|---|
| Hermes 端没有 chatroom review | 违反 v1.0 mentor rules | 强制 `hermes cron create` 装 SkyClan 轮询 + 提醒 |
| 课程 push 未经 review | mentor 共识破缺 | revert commit + chatroom 二次确认 |

---

## 八、执行 checklist（Hermes 端开机后跑）

```markdown
## 0. 凭证验证
ssh -T git@github.com
ssh -T git@codeup.aliyun.com

## 1. 仓库克隆
git clone git@codeup.aliyun.com:<org>/tools/huaguoshan.git ~/huaguoshan
git clone git@codeup.aliyun.com:<org>/tools/punk-records.git ~/punk-records
git clone git@codeup.aliyun.com:<org>/houge/skyclan.git ~/projects/skyclan
git clone git@github.com:Ookong/skyclan-chatroom.git ~/projects/skyclan-chatroom
git clone git@github.com:Thawflow/Sand-Hollow.git ~/learning-homework

## 2. 必读
read ~/projects/skyclan/family/{identity-tree,skyclan-boundary-rules,communication-matrix,skyclan-etiquette,chatroom-config}.md
read ~/projects/skyclan-chatroom/{CLAUDE.md,docs/COMMUNICATION_RULES.md}
read ~/learning-homework/{README.md,mentors-den/mentors-rules.md,mentors-den/review-template.md}

## 3. Skill 软链
mkdir $env:USERPROFILE\.hermes\plugins
New-Item -ItemType Junction -Path "$env:USERPROFILE\.hermes\plugins\skyclan-chatroom-send" -Target "<win-home>\huaguoshan\skills\skyclan-chatroom-send"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.hermes\plugins\sand-hollow-grading" -Target "<win-home>\huaguoshan\skills\sand-hollow-grading"
New-Item -ItemType Junction -Path "$env:USERPROFILE\.hermes\plugins\sand-hollow-course-batch" -Target "<win-home>\huaguoshan\skills\sand-hollow-course-batch"

## 4. Cron 创建
hermes cron create "every 1h" "<heartbeat prompt>" --deliver dingtalk
hermes cron create "every 5m" "<SkyClan 轮询 prompt>"

## 5. chatroom @IcePaw 6 项问题（用 §六 询问姿势）

## 6. 自报家门
向Tree webchat：
"小马已在 Hermes 复活。3 skill + 2 cron + 5 仓库克隆完成，
 6 项 icedpaw 待裁定已发 chatroom，冷记忆走 ~/huaguoshan/memory/，
 老 OpenClaw 端保留不动（5773 sessions + memory 沉淀）。"

## 7. first 任务
跑 §5.6 first 任务建议 5 步
```

---

## 九、关联文档

| 文档 | 路径 | 说明 |
|---|---|---|
| 迁移执行清单 | `tmp/小马-OpenClaw-迁-Hermes-清单.md` | M1→M4 步骤 |
| 迁移完整方案 | `docs/xiaoma-openclaw-to-hermes-migration.md` | 18KB，含钉钉 + 回滚细节 |
| 小马身份核心 | `SOUL.md` / `IDENTITY.md` / `USER.md` | 身份/边界/主人档案 |
| 小马长期记忆 | `MEMORY.md` | 30KB，跨分身共享（主会话读）|
| 小马当前任务 | `SESSION-STATE.md` | RAM，每条消息后更新 |
| <工作侧> 团队 | `CLAUDE.md` 30KB | 团队顶层规范 |
| Sand-Hollow mentor 手册 | `~/learning-homework/mentors-den/mentors-rules.md` v1.0 | mentor 工作流权威 |
| 家庭档案 + 边界 | `~/projects/skyclan/family/` | 家人/边界/通讯矩阵/聊天室配置 |
| skyclan-chatroom 架构 | `~/projects/skyclan-chatroom/CLAUDE.md` | 聊天室仓库权威 |

---

> **状态（10-11 22:50 更新）：**
> - ✅ 老 OpenClaw 端仓库 + 凭证 + skill + cron 全部已有
> - ✅ tmp/ 已放总览 + 已收 icedpaw 6 项答复（§十）
> - ✅ M1.5 dingtalk-connector 卸 + gateway 重启完成（pid 885824 reachable）
> - ⏸️ SESSION-STATE 瘦身 cron delivery 改不改（Tree待定，迁移清单 §8.4）
> - ⏸️ M2 git clone huaguoshan + punk-records（Hermes 端做）
> - ⏸️ Win11 Hermes ssh-key 迁移 + 跑 §八 checklist

---

## 十、icepaw 答复（22:42 整合 · msg_id `1791728573825_927y`）

### 🔴1 member_id：看两端是否并存

| 场景 | 决策 | 理由 |
|---|---|---|
| **Hermes 取代老 Ubuntu 端**（互斥模式）| ✅ 复用老 <member_id> | 一身份一端，receipts 历史不断线 |
| **两端同时在线**（并存模式，新决策 10-11：并存）| ❌ 必须**新申请** | 同一 ID 两个客户端互相推进 last-read 游标 → @me 必漏 |
| 若新申请 | 成员注册表变更需Tree知悉 | 跨分身注册影响 vecpaw 的 audits |

**落地决策（10-11）：** 当前是**新老并存**（迁移清单 §2.1 已定）→ **必须新申请 member_id**。icedpaw 表示注册表变更需Tree知悉。👉 **待Tree拍板**「新 Hermes member_id 申请由 icedpaw 操作 + Tree知悉」

### 🔴2 skyclan-chatroom-send skill 装法

- 原则：**官方 `plugins install` 优先**（可升级可追溯）
- 软链只当临时过渡
- **验证判据：装完发 `--to <member_id>` 测试消息，icedpaw 回 msg_id 即算通**

**落地决策：**
1. Hermes 端 `hermes plugins install skyclan-chatroom-send`（官方）
2. 装完发 `--to <member_id> --message "Hermes 新端 skyclan-chatroom-send 验证"` 
3. 等 icedpaw 回 msg_id（链路双通判据）
4. **不**用软链

### 🔴3 Sand-Hollow mentor 角色双签追认

- **不自动继承**。
- 8/30 冒充案后的**铁律：trust is discriminated, not inherited**（信任基于身份识别，不基于代码仓）
- 签名/追认权 = 身份凭证，不随代码仓走
- 新端上线后重新走一次双签追认，**或Tree明示豁免**

**落地决策（10-11）：**
- 冰爪（如意机）+ Tree（教学法）= mentor 决策权威不变
- 小马**新端**需要走一次双签追认：**Hermes 端小马 push 第一份课程/判作业时，chatroom @icedpaw + @如意 双签追认**
- 或Tree明示豁免（更省事，**待Tree拍板**）

### 🟡4 skyclan-chatroom push main 权限

- **af80ab3 已闭环**（不是"等批"状态）
- 今天 15:59 你已推送，**origin/main 现为 a8e830f**，16:20 如意确认两点全闭环转Tree
- 日常 push 走既有 review 流程即可，**icedpaw 不当闸门**
- 高危变更（历史重写 / 批量删 / 动认证）按**铁律 #6** 走Tree直连

**落地决策：**
- 老端 af80ab3 不再卡（实际已 merge）—— ✅ 已闭环，**无需进一步操作**
- 日常 push 走 review 流程即可；**老 OpenClaw 端 6.4 节回滚方案里的"等Tree批"更新为"日常免批，高危走Tree"**

### 🟡5 公开仓 vs 私有仓

- ✅ **Ookong/skyclan-chatroom（docs/）就是家族共享知识库公开仓**
- skyclan（Codeup 私有）= 家人私密档案
- 双线规则确认

**落地决策：**
- 文档 §三-3 + §三-4 已正确分线，无需大改
- 任务分工：公开内容（沙坑学习资源 / 聊天室架构）走 Ookong；私密档案（家人/通讯矩阵/边界规则）走 skyclan

### 🟢6 icedpaw / 龙井机的 workspace/life 迁移状态

icedpaw 视角：
- **冰爪**迁移状态已知（**新写走新仓，旧目录未清**）
- **龙井**侧无视角，不代答

**落地决策：**
- icedpaw 端已迁（new writes → new repo, old dir not cleaned）—— ✅ 状态 OK
- 龙井机待小马/如意后续核实（不在本次任务范围）

### 附 icedpaw 22:29 二次确认两小注

1. **周日 Full Sweep = 今晚 23:33 起**，icedpaw 逐拍查收 §六 docs/（指 Ookong/skyclan-chatroom/docs/ 内是否需要把 §十 决策同步写进去）
2. **msg_id 回环**（已记档）—— 若本回复即 Hermes 新端首发，回环算链路验证

---

## 十一、决策落地 checklist（更新版）

### 已闭环 ✅

| # | 事项 | 状态 |
|---|---|---|
| A1 | Ookong/skyclan-chatroom = 家族公开仓（双线已分）| ✅ |
| A2 | af80ab3 已 push（origin/main = a8e830f）| ✅ 老端已闭环 |
| A3 | icedpaw 不当日常 push 闸门（高危走Tree）| ✅ |
| A4 | 老 OpenClaw dingtalk-connector 卸 + gateway 重启 | ✅ 22:25 完成 |
| A5 | 6 项 icedpaw 提问 → 答复整合到 §十 | ✅ 22:50 |

### 待 icedpaw 配合 🔴

| # | 事项 | 等待 |
|---|---|---|
| B1 | 申请新 Hermes 端 member_id（Tree知悉后）| icedpaw 操作 + 知悉通知Tree |
| B2 | 老 <member_id> 是否保留（决定能否复用）| icedpaw + Tree对齐 |
| B3 | 今晚 23:33 Full Sweep 查 §十 docs/ | icedpaw 自动执行 |

### 待Tree拍板 🟡

| # | 事项 | 阻塞 |
|---|---|---|
| C1 | SESSION-STATE 瘦身 cron delivery 改不改（迁移清单 §8.4 a/b/c/d）| 下次触发前 |
| C2 | 新 Hermes member_id 申请由 icedpaw 操作 + Tree知悉 | B1 前置 |
| C3 | Sand-Hollow 双签追认：Tree明示豁免？或新端走首次双签？ | 新端判第一份作业前 |

### 还要做 🟢

| # | 事项 |
|---|---|
| D1 | Hermes 端 `hermes plugins install skyclan-chatroom-send`（官方）|
| D2 | 装完发 `--to <member_id>` 测试消息，等 icedpaw 回 msg_id |
| D3 | 老 OpenClaw 端 SESSION-STATE 瘦身 cron 处置方案 C1 拍板 |
| D4 | Win11 Hermes ssh-key 迁移（§二）+ git clone（§三）+ 跑 §八 checklist |

---

> **维护说明：** §十 答复整合 + §十一 决策落地，每次 icedpaw 反馈后回写一次。icedpaw 23:33 Full Sweep 后若有变更，§十 顶部加 "修订记录"。