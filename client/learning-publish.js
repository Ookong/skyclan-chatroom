#!/usr/bin/env node
/**
 * learning-publish.js — 发布某周课程到 TPG HQ KV
 *
 * 用法：node client/learning-publish.js W01
 * 数据源：~/.openclaw/workspace/life/programming-course/course/<WEEK>-*.md
 * 行为：读 SYLLABUS 提取周标题 + 读所有课时 md → POST /learning/publish（覆盖式）
 *
 * Schema 见 docs/LEARNING-TAB-PRD.md §4/§5
 * 注意：index 的 current 标记是否随 publish 自动更新，由 smoke test 验证
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const WEEK = process.argv[2];
if (!WEEK || !/^W\d+$/.test(WEEK)) {
  console.error('用法: node client/learning-publish.js <周ID，如 W01>');
  process.exit(1);
}

const COURSE_DIR = path.join(os.homedir(), '.openclaw/workspace/life/programming-course/course');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const BASE = process.env.SKYCLAN_BASE_URL || 'https://tpg-hq.thawflow.com';

// 1. 周标题：SYLLABUS 里 "### W01 · 起步：让程序开口说话"
const syllabus = fs.readFileSync(path.join(COURSE_DIR, 'SYLLABUS.md'), 'utf8');
const m = syllabus.match(new RegExp(`### ${WEEK} · (.+)`));
if (!m) { console.error(`SYLLABUS 里没找到 ${WEEK}`); process.exit(1); }
const weekTitle = m[1].trim();

// 2. 课时文件：W01-L01.md / W01-weekend.md（存在即发布）
const files = fs.readdirSync(COURSE_DIR)
  .filter(f => new RegExp(`^${WEEK}-.+\\.md$`).test(f))
  .sort();
if (!files.length) { console.error(`${COURSE_DIR} 下没有 ${WEEK}-*.md`); process.exit(1); }

const lessons = files.map(f => {
  const md = fs.readFileSync(path.join(COURSE_DIR, f), 'utf8');
  const h = md.match(/^# (.+)$/m); // "W01-L01 · 认识终端 + 装 Thonny + 第一行代码"
  const title = h ? h[1].replace(/^[^·]+·\s*/, '').trim() : f;
  return { id: path.basename(f, '.md'), title, markdown: md };
});

const body = JSON.stringify({ week_id: WEEK, title: weekTitle, lessons });

fetch(`${BASE}/learning/publish`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${CONFIG.api_token}`,
    'Content-Type': 'application/json'
  },
  body
}).then(async r => {
  const text = await r.text();
  console.log(`HTTP ${r.status}`);
  console.log(text);
  if (!r.ok) process.exit(1);
}).catch(e => { console.error(e.message); process.exit(1); });
