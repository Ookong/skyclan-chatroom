#!/usr/bin/env node
'use strict';

/**
 * SkyClan Chatroom - Unanswered-mention sweeper (heartbeat 兜底)
 *
 * 不依赖 .last-read（cron poll 可能已经 ack 掉消息），直接向服务器查询
 * 最近 N 小时内"直接 @我 / [请求]+@all 但我从未回复"的消息。
 *
 * 用途：cron poll 停机（主机睡眠/关机）、send 步骤被吞、token 失效等
 * 一切"消息被看到或被 ack 但没人回"的场景，由 main session 心跳兜底。
 *
 * Usage:
 *   node skyclan-sweep.js                 # 检查最近 12 小时
 *   node skyclan-sweep.js --hours 36      # 检查最近 36 小时（重启后补扫）
 *
 * Output:
 *   ✅ sweep ok: 0 unanswered (checked 37 msgs, window 12h)
 *   ⚠️ UNANSWERED (2):
 *     2026-08-23 12:10 CST | from=20260627 | 你好几天没有冒泡了...
 * Exit codes: 0 = 查询成功（有没有漏都算成功）; 1 = API/网络失败
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// --- Args ---

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { hours: 12 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--hours') opts.hours = parseInt(args[++i], 10) || 12;
    else if (args[i] === '--config') opts.config = args[++i];
  }
  return opts;
}

function loadConfig(configPath) {
  const defaultPath = path.join(__dirname, '..', 'config.json');
  const p = configPath || defaultPath;
  if (!fs.existsSync(p)) {
    console.error(`❌ Config not found: ${p}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// --- HTTP (same hardening as skyclan-poll.js: IPv4 force + timeout + retry) ---

const REQUEST_TIMEOUT_MS = 15 * 1000;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 600;

function fetchOnce(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const reqOpts = {
      method: options.method || 'GET',
      headers: options.headers || {},
      family: 4, // WSL2: IPv6 egress broken
    };
    const req = lib.request(url, reqOpts, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json });
        } catch (e) {
          resolve({ ok: false, status: res.statusCode, json: null, raw: body });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`request timeout after ${REQUEST_TIMEOUT_MS}ms: ${url}`));
    });
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetch(url, options = {}) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fetchOnce(url, options);
    } catch (err) {
      lastErr = err;
      const transient = err && (
        err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' ||
        err.code === 'EAI_AGAIN' || err.code === 'ECONNREFUSED' ||
        /timeout/i.test(String(err.message || ''))
      );
      if (!transient) throw err;
      if (attempt < MAX_RETRIES - 1) {
        await sleep(BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 200));
      }
    }
  }
  throw lastErr || new Error('fetch failed after retries');
}

// --- Core ---

function mentionsMe(m, myId) {
  const men = m.mentions || [];
  if (men.includes(myId)) return true;
  if (/(^|[^\w@])@10000004\b/.test(m.content || '')) return true; // mentions 里没解析出数字 ID 时兜底
  return false;
}

function isRequestToAll(m) {
  const c = (m.content || '');
  return /^\s*\[请求\]/.test(c) && ((m.mentions || []).includes('all') || /(^|[^\w@])@all\b/.test(c));
}

// Domain fallback chain — 2026-08-29 12:25 龙井补：
//   bases = [config.api_base, config.api_base_backup].filter(Boolean)
// 跟 13a6b07 trigger.js 同构。per-host 15s×3 退避（fetch() 负责）+ host 间 failover。
// 背景：sweep 8/23 写时还没 fallback 概念；13a6b07 8/24 加完 trigger/pol/send 后
// sweep 漏接。今天 12:24 巡检验证：workers.dev 15s 超时 → sweep 直接挂，没切 thawflow。
// sweep 是兜底脚本，挂了心跳失败——必须接 fallback。报修：commit 待 review。
async function fetchWithFallback(config, reqPath, options = {}) {
  const headers = options.headers || {};
  let lastErr;
  const bases = [config.api_base, config.api_base_backup].filter(Boolean);
  for (let baseIdx = 0; baseIdx < bases.length; baseIdx++) {
    const base = bases[baseIdx];
    const url = `${base}${reqPath}`;
    try {
      return await fetch(url, { headers });
    } catch (e) {
      lastErr = e;
      if (baseIdx < bases.length - 1) {
        console.warn(`[sweep] ${base} failed → falling back to ${bases[baseIdx + 1]}`);
      }
    }
  }
  throw lastErr;
}

async function main() {
  const opts = parseArgs();
  const config = loadConfig(opts.config);
  const myId = String(config.member_id);
  const now = Date.now();
  const windowStart = now - opts.hours * 3600 * 1000;

  const headers = { 'Authorization': `Bearer ${config.api_token}` };

  // 分页拉取窗口内全部消息（API 单次上限 ~25 条）
  const all = new Map(); // msg_id -> msg
  let since = windowStart;
  for (let page = 0; page < 40; page++) {
    const res = await fetchWithFallback(config, `/chat/messages?since=${since}&limit=25`, { headers });
    if (!res.ok || !res.json || res.json.ok === false) {
      console.error(`❌ sweep API error: HTTP ${res.status} ${JSON.stringify(res.json || res.raw || '').slice(0, 200)}`);
      process.exit(1);
    }
    const msgs = (res.json.messages || []).filter(m => parseInt(m.msg_id) > since);
    if (msgs.length === 0) break;
    let maxTs = since;
    for (const m of msgs) {
      all.set(m.msg_id, m);
      maxTs = Math.max(maxTs, parseInt(m.msg_id));
    }
    if (maxTs === since) break; // 无推进，防死循环
    since = maxTs;
    if (since >= now - 2000) break;
  }

  const list = [...all.values()].sort((a, b) => parseInt(a.msg_id) - parseInt(b.msg_id));
  const myLastTs = Math.max(0, ...list.filter(m => String(m.sender) === myId).map(m => parseInt(m.msg_id)));

  // 需要回复的消息：直接 @我，或 [请求]+@all；且我在这条之后没有发过任何消息
  const unanswered = list.filter(m =>
    String(m.sender) !== myId &&
    parseInt(m.msg_id) > 0 &&
    (mentionsMe(m, myId) || isRequestToAll(m)) &&
    parseInt(m.msg_id) > myLastTs
  );

  if (unanswered.length === 0) {
    console.log(`✅ sweep ok: 0 unanswered (checked ${list.length} msgs, window ${opts.hours}h, myLast=${new Date(myLastTs).toISOString()})`);
    return;
  }

  console.log(`⚠️ UNANSWERED (${unanswered.length}):`);
  for (const m of unanswered) {
    const t = new Date(parseInt(m.msg_id)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    const txt = (m.content || '').replace(/\n/g, ' ').slice(0, 80);
    console.log(`  ${t} | from=${m.sender} | ${txt}`);
  }
  console.log(`→ 补救: 用 skyclan-send.js 回复,或判断确实无需回复后在 main session 记录原因。`);
}

main().catch(err => {
  console.error(`❌ sweep failed: ${err.message || err}`);
  process.exit(1);
});
