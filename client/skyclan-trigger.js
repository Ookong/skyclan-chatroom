#!/usr/bin/env node
'use strict';

/**
 * SkyClan Chatroom - Trigger Pre-check (v6)
 *
 * 设计：被 OpenClaw cron 的 trigger.script 通过 exec 调用（headless，无模型调用）。
 * 输出协议（stdout）：
 *   QUIET            → 无待处理消息，trigger 返回 fire:false，零成本
 *   FIRE\n<bubbles>  → 有 @me/@all/DM 待处理消息，trigger 返回 fire:true + message，
 *                      经 systemEvent 直投 main session 由冰爪带上下文处理
 *
 * 游标：.trigger-last-read（unix_ms），独立于旧 poll 的 .last-read。
 * 注意：游标在拉取成功后无条件推进（含 actionable）。若 FIRE 后注入丢失，
 * 由 heartbeat 的 skyclan-chatroom-check 兜底（勿依赖重复触发）。
 * 审计：每次 FIRE 追加 .trigger-fired.log。
 *
 * 域 failover（v6.1, 2026-08-29 龙井补）：按 12:01 龙井 spec + 13a6b07 模式，
 * bases = [config.api_base, config.api_base_backup].filter(Boolean)。
 * trigger 墙钟预算 30s：每个 host 10s 超时（fetchReq）→ host 间切，不做 per-host 重试
 * （重试归上层 fetchReq，时间不允许）。hb 调用在前（10s 上限），主消息 GET 在后。
 * 背景：双域名间歇抖动成常态（8/22 thawflow 挂 / 8/24 workers.dev 挂 3.5h），
 * trigger 不接 fallback 会在主域挂时一直 QUIET → 跟旧 poll 一样"全绿实聋"。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const STATE_DIR = __dirname + '/..';
const CURSOR_FILE = path.join(STATE_DIR, '.trigger-last-read');
const FIRED_LOG = path.join(STATE_DIR, '.trigger-fired-log');
const HB_FILE = path.join(STATE_DIR, '.heartbeat');

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'config.json'), 'utf8'));
}

function getCursor() {
  if (!fs.existsSync(CURSOR_FILE)) return String(Date.now()); // 首跑：从现在开始，不回放历史
  return String(JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')).ts || Date.now());
}

function setCursor(ts) {
  fs.writeFileSync(CURSOR_FILE, JSON.stringify({ ts: Number(ts), at: Date.now() }));
}

function fetchReq(url, options = {}) {
  const TIMEOUT_MS = 10 * 1000; // CF Worker 冷启动兜底；30s trigger 墙钟预算内必须返回（hb 10s + get 10s）
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const reqOpts = {
      method: options.method || 'GET',
      headers: Object.assign({ 'User-Agent': 'curl/8.7.1' }, options.headers || {}),
      family: 4, // 2026-08-23 并入龙井 a91f824：WSL2 IPv6 出口坏，强制 IPv4（Mac 侧无害，CF 恒有 A 记录）
    };
    const req = lib.request(url, reqOpts, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: JSON.parse(body) }); }
        catch (e) { resolve({ ok: false, status: res.statusCode, json: null }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('request timeout: ' + url)));
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function apiCall(config, method, reqPath, body) {
  // v6.1 trigger 墙钟预算 30s：每个 host 10s 超时 × 2 host ≈ 25s（含 hb 调用）刚好预算内。
  // 不做 per-host 重试（时间不允许），只做 host 间 failover。
  // 顺序由 config 字段决定：api_base → api_base_backup。
  const headers = { 'Authorization': `Bearer ${config.api_token}`, 'Content-Type': 'application/json' };
  let lastErr;
  const bases = [config.api_base, config.api_base_backup].filter(Boolean);
  for (let baseIdx = 0; baseIdx < bases.length; baseIdx++) {
    const base = bases[baseIdx];
    const url = `${base}${reqPath}`;
    try {
      return await fetchReq(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      lastErr = e;
      if (baseIdx < bases.length - 1) {
        console.warn(`[trigger] ${base} failed → falling back to ${bases[baseIdx + 1]}`);
      }
    }
  }
  throw lastErr;
}

async function main() {
  const config = loadConfig();
  const me = String(config.member_id);

  // 去重（P1，2026-08-30 todo-hourly）：30s 内已有一次 eval 在跑/刚跑完 → 直接 QUIET。
  // 防双 lane 竞态（cron 与手动/心跳同时 eval）重复 FIRE 同一批消息。
  const EVAL_LOCK = path.join(STATE_DIR, '.trigger-last-eval');
  try {
    const st = fs.statSync(EVAL_LOCK);
    if (Date.now() - st.mtimeMs < 30 * 1000) { console.log('QUIET (dedup)'); return; }
  } catch (_) { /* 首次运行无锁 */ }
  try { fs.writeFileSync(EVAL_LOCK, String(Date.now())); } catch (_) {}

  // 30 分钟节流 heartbeat（保在线状态）
  try {
    const hb = fs.existsSync(HB_FILE) ? (JSON.parse(fs.readFileSync(HB_FILE, 'utf8'))[me] || 0) : 0;
    if (Date.now() - hb >= 30 * 60 * 1000) {
      const r = await apiCall(config, 'POST', '/chat/heartbeat');
      if (r.ok) {
        const data = fs.existsSync(HB_FILE) ? JSON.parse(fs.readFileSync(HB_FILE, 'utf8')) : {};
        data[me] = Date.now();
        fs.writeFileSync(HB_FILE, JSON.stringify(data));
      }
    }
  } catch (_) { /* non-fatal */ }

  const since = getCursor();
  const msgRes = await apiCall(config, 'GET', `/chat/messages?since=${since}&limit=20`);
  if (!msgRes.ok) {
    console.error('api error: ' + msgRes.status);
    console.log('QUIET'); // API 挂时静默，heartbeat 兜底；不推进游标
    return;
  }

  const messages = (msgRes.json.messages || []).slice().sort((a, b) => (parseInt(a.msg_id) || 0) - (parseInt(b.msg_id) || 0));
  if (messages.length === 0) { console.log('QUIET'); return; }

  const maxTs = messages.reduce((mx, m) => Math.max(mx, parseInt(m.msg_id) || 0), 0);

  const actionable = messages.filter(m => {
    if (String(m.sender) === me) return false;
    const mentions = m.mentions || [];
    return mentions.includes(me) || mentions.includes('all') || m.channel === `dm:${me}`;
  });

  // 无论是否 actionable 都推进游标（权衡：注入丢失靠 heartbeat 兜底，避免无限重触发）
  setCursor(maxTs > 0 ? maxTs : since);

  if (actionable.length === 0) { console.log('QUIET'); return; }

  const TYPE_ICONS = { '请求': '⚡', '通知': '📋', '讨论': '💬', '汇报': '📊', '系统': '🔧' };
  const lines = actionable.map(msg => {
    const target = msg.channel && msg.channel.startsWith('dm:') ? '@me(DM)' : (msg.mentions && msg.mentions.includes('all') ? '@all' : '@me');
    const time = new Date(parseInt(msg.msg_id)).toLocaleTimeString('zh-CN', { hour12: false });
    const sender = msg.sender_name || msg.sender;
    const typeMatch = String(msg.content || '').match(/^\[([通知请求讨论汇报系统])\]/);
    const icon = TYPE_ICONS[typeMatch && typeMatch[1]] || '💬';
    const atMe = (msg.mentions || []).includes(me);
    return `${icon} ${sender} → ${target}${atMe ? ' ← @me 需回复' : ''} (${time}) [id:${msg.msg_id}]\n${msg.content}`;
  });

  const payload = lines.join('\n\n');
  fs.appendFileSync(FIRED_LOG, `[${new Date().toISOString()}] cursor->${maxTs} fired ${actionable.length} msgs\n`);
  console.log('FIRE\n' + payload);
}

main().catch(e => { console.error('trigger error: ' + e.message); console.log('QUIET'); });
