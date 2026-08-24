# PRD · TPG HQ 编程学习标签页

> 版本：v0.1（需求稿）
> 提出人：如意（2026-08-24，猴哥指示）
> 状态：待冰爪评估排期
> 优先级建议：P1（不阻塞线上功能，family learning 场景）

---

## 1. 背景

家庭两位学员开始 12 周系统编程学习（同轨自学）。需要 TPG HQ 提供一个**自助学习入口**：每周学习资料在线阅读，无需人授课。

内容方：如意（每周日写好下周资料并发布）。

## 2. 目标

admin.html 新增「📚 编程学习」标签页：
- 按周列出已发布的课程（W01-W12）
- 点击某周 → 展示该周课文（markdown 渲染成可读网页）
- 勾选进度（每课一个 checkbox），刷新后保留

## 3. 非目标（MVP 不做）

- ❌ 账号/权限体系（沿用 HQ 现有访问方式）
- ❌ 代码在线运行沙盒
- ❌ 视频/图片上传（纯文字 markdown）
- ❌ 进度云端同步（localStorage 够用）

## 4. 存储设计（TPG_KV，沿用现有 namespace）

新增 prefix `learning:`：

```
learning:index
  → {"weeks":[{"id":"W01","title":"起步","published_at":"2026-08-24","current":true}, ...]}

learning:week:W01
  → {
      "week_id": "W01",
      "title": "起步：让程序开口说话",
      "lessons": [
        {"id": "W01-L01", "title": "认识终端 + Thonny + 第一行代码", "markdown": "..."},
        {"id": "W01-L02", "title": "变量", "markdown": "..."},
        {"id": "W01-L03", "title": "input + 计算器", "markdown": "..."},
        {"id": "W01-weekend", "title": "周末项目：自我介绍机器人", "markdown": "..."}
      ]
    }
```

单课 markdown 2-4KB，单周 ≤ 20KB，KV 完全无压力。

## 5. API 设计

| 接口 | 方法 | 鉴权 | 说明 |
|---|---|---|---|
| `/learning/weeks` | GET | 待定① | 返回 index（周列表） |
| `/learning/week/:id` | GET | 待定① | 返回某周完整内容 |
| `/learning/publish` | POST | 现有 Bearer token（与 chatroom 同源鉴权） | 发布/覆盖某周内容。Body 即 §4 的 week 对象 |

发布方：如意每周 `curl POST`（或写成小脚本），内容源文件在自己机器上维护、git 管理，KV 只作分发缓存。

## 6. 前端设计

- admin.html 顶部导航新增 tab「📚 编程学习」
- 布局：左侧周列表（当前周高亮 + 已完成周打勾）+ 右侧课文
- markdown 渲染：marked.js（CDN 引入，与现有前端依赖风格一致即可）
- 每课前一个 checkbox，勾选状态存 localStorage（key: `learning-progress`）
- 移动端：能看就行，不专门适配

## 7. 待定问题（请冰爪按 HQ 现状定）

① **学员访问方式**：admin.html 现有鉴权是 admin 专属吗？若苗苗设备无 admin 权限，选项：
   - a. `/learning/*` GET 接口走弱鉴权或无鉴权（内容非敏感，且 URL 不外传）
   - b. 给 HQ 加「访客只读学习区」入口
   - c. 学员页面独立路径（如 `hq/learning.html`）不经 admin 面板
   你最了解 HQ 的权限模型，请拍板。

② **当前周高亮**：index 里 `current: true` 标记（发布时如意指定）还是前端按日期算？倾向前者，简单。

③ **聊天区联动**：暂不做。学员卡住直接 iMessage / 聊天室问。

## 8. 验收标准

1. 如意 POST 发布 W01（含 3 课 + 周末项目全文）
2. 打开 admin.html → 编程学习 tab → 能看到 W01 → 点开任一课 markdown 正常渲染（标题/表格/代码块/emoji）
3. 勾选某课 → 刷新页面 → 勾选仍在
4. POST 覆盖同一周 → 内容更新生效

## 9. 分工（按项目归属惯例）

- **冰爪**：Worker 路由 + KV 读写 + admin.html tab（backend owner）
- **如意**：内容制作 + 每周发布 + 验收 + scp backup
- **学员**：只用不建 📖
