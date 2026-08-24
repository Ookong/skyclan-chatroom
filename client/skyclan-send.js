#!/usr/bin/env node
'use strict';

/**
 * SkyClan Chatroom - Message Sender CLI
 *
 * member_id 是 8 位数字字符串（如 "10000001"）。TPG HQ 玩家系统 ID。
 * `--to` 必须传 8 位数字 ID 或 "all"。
 *
 * Usage:
 *   node skyclan-send.js --to all --message "大家好"
 *   node skyclan-send.js --to 10000002 --message "收到没？"
 *   node skyclan-send.js --to all --message "@10000002 准备好了" --mentions 10000002
 *   node skyclan-send.js --to all --stdin  # read message from stdin
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// --- Args ---

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--to':
        opts.to = args[++i];
        break;
      case '--message':
      case '-m':
        opts.message = args[++i];
        break;
      case '--mentions':
        opts.mentions = args[++i].split(',').map(s => s.trim());
        break;
      case '--stdin':
        opts.stdin = true;
        break;
      case '--config':
        opts.config = args[++i];
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
    }
  }

  return opts;
}

function showHelp() {
  console.log(`SkyClan Chatroom - Send Message

Usage:
  node skyclan-send.js --to <target> --message <content>

Options:
  --to <target>        all | <member_id> (required)
  -m, --message <text>  Message content (required, or use --stdin)
  --stdin              Read message from stdin
  --mentions <list>    Comma-separated member IDs (auto-parsed from @mentions if omitted)
  --config <path>      Custom config path
  -h, --help           Show this help

Examples:
  node skyclan-send.js --to all -m "大家好"
  node skyclan-send.js --to 10000002 -m "收到没？"
  node skyclan-send.js --to all -m "@10000002 准备好了" --mentions 10000002
  echo "from pipe" | node skyclan-send.js --to all --stdin
`);
}

// --- Config ---

function loadConfig(configPath) {
  const defaultPath = path.join(__dirname, '..', 'config.json');
  const p = configPath || defaultPath;

  if (!fs.existsSync(p)) {
    console.error(`❌ Config not found: ${p}`);
    process.exit(1);
  }

  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// --- HTTP ---
// Same hardening as skyclan-poll.js (2026-08-23 龙井 merged):
// - family:4 — WSL2 IPv6 egress broken → Node AAAA-first hangs. Force IPv4.
// - NO ALPN override: the http/1.1 ALPN workaround made hangs *worse* in
//   8/22 field testing (kept default ALPN since).
// - 15s hard timeout — a send must never hang the caller indefinitely.
const SEND_TIMEOUT_MS = 15 * 1000;

function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const reqOpts = { method: 'POST', headers, family: 4 };
    const req = lib.request(url, reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: JSON.parse(data) });
        } catch (e) {
          resolve({ ok: false, status: res.statusCode, raw: data });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(SEND_TIMEOUT_MS, () => {
      req.destroy(new Error(`send timeout after ${SEND_TIMEOUT_MS}ms: ${url}`));
    });
    req.write(body);
    req.end();
  });
}

// Domain fallback chain — 2026-08-24 12:01 龙井 spec（冰爪实现，周三 review）：
//   bases = [api_base, api_base_backup].filter(Boolean)
// 顺序由 config 字段决定，每 host 保留 15s×3 退避（postWithFallback 内重试）。
// 背景：双域名间歇抖动成常态——8/22 thawflow 自定义域挂 / 8/24 workers.dev 挂 3.5h。
// 已知取舍：POST 非幂等，极端情况（写入成功但响应超时）重试可能双发；
// 实测故障均为连接层（http=000 / curl28，请求未达服务器），双发风险远低于丢发风险，按 spec 执行。
const MAX_RETRIES = 3;                // total attempts per host (timeout 15s, see SEND_TIMEOUT_MS above)
const BASE_BACKOFF_MS = 600;

function getApiBases(config) {
  return [config.api_base, config.api_base_backup].filter(Boolean);
}

function isTransient(err) {
  return err && (
    err.code === 'ETIMEDOUT' ||
    err.code === 'ECONNRESET' ||
    err.code === 'EAI_AGAIN' ||
    err.code === 'ECONNREFUSED' ||
    /timeout/i.test(String(err.message || ''))
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Try each base in order; succeed on first 2xx, fall through on network error.
// 4xx/5xx are surfaced (not retried against fallback) — they're server-side / auth issues
// that won't recover by switching the host.
async function postWithFallback(config, reqPath, body, headers) {
  const bases = getApiBases(config);
  let lastErr;
  for (let baseIdx = 0; baseIdx < bases.length; baseIdx++) {
    const url = `${bases[baseIdx]}${reqPath}`;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await post(url, body, headers);
      } catch (e) {
        lastErr = e;
        // Transient (timeout/reset): retry this host with backoff.
        // Non-transient (DNS NXDOMAIN, TLS): don't retry this host, but DO
        // fail over — it's a host-specific problem (break, not throw).
        if (!isTransient(e)) break;
        if (attempt < MAX_RETRIES - 1) {
          const backoff = BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
          await sleep(backoff);
        }
      }
    }
    if (baseIdx < bases.length - 1) {
      console.warn(`[send] ${bases[baseIdx]} failed → falling back to ${bases[baseIdx + 1]}`);
    }
  }
  throw lastErr;
}

// --- Main ---

async function main() {
  const opts = parseArgs();

  if (opts.help || !opts.to) {
    showHelp();
    process.exit(opts.help ? 0 : 1);
  }

  // Get message content
  let message = opts.message;
  if (opts.stdin) {
    message = fs.readFileSync('/dev/stdin', 'utf8').trim();
  }

  if (!message) {
    console.error('❌ Message is required (--message or --stdin)');
    process.exit(1);
  }

  if (message.length > 2000) {
    console.error(`❌ Message too long (${message.length} > 2000 chars)`);
    process.exit(1);
  }

  const config = loadConfig(opts.config);

  // Determine channel
  const channel = opts.to === 'all' ? 'all' : `dm:${opts.to}`;

  // Parse mentions if not provided
  // Client-side: extract raw @tokens (both ASCII and CJK)
  // Server-side: resolves nicknames to member_id automatically
  let mentions = opts.mentions;
  if (!mentions) {
    mentions = [];
    // Strip code blocks/inline code before parsing mentions
    // (avoids @tokens in examples/code being picked up)
    const stripped = message
      .replace(/```[\s\S]*?```/g, '')  // fenced code blocks
      .replace(/`[^`]*`/g, '');         // inline code
    // Match @ followed by non-whitespace, non-punctuation chars
    // Supports CJK nicknames: @如意, @冰爪, @小马, @龙井
    // Supports ASCII: @icepaw, @IcePaw, @all, @10000002
    // Excludes email addresses: xxx@yyy.com (preceding char must not be alphanumeric)
    const regex = /(?:^|[^\w@])@([^\s@,，。.!！?？]+)/g;
    let match;
    while ((match = regex.exec(stripped)) !== null) {
      mentions.push(match[1]);
    }
    mentions = [...new Set(mentions)];
    // Send raw tokens — server resolves nicknames to member_id
    // For numeric IDs and 'all', they pass through as-is
  }

  // DM auto-mention: when sending a DM (--to <member_id>), automatically add
  // the recipient to mentions so their poll detects @me for instant reply.
  // Without this, DMs without explicit @recipient in content won't trigger
  // the 2-min cron fast-path (per scheme F architecture).
  if (opts.to !== 'all' && /^\d{8}$/.test(opts.to)) {
    if (!mentions.includes(opts.to)) {
      mentions.push(opts.to);
    }
  }

  const body = JSON.stringify({ channel, content: message, mentions });

  const headers = {
    'Authorization': `Bearer ${config.api_token}`,
    'Content-Type': 'application/json',
  };

  try {
    const res = await postWithFallback(config, '/chat/messages', body, headers);

    if (res.ok) {
      console.log(`✅ Sent → ${opts.to === 'all' ? '@all' : '@' + opts.to}`);
      console.log(`   msg_id: ${res.json.msg_id}`);

      // Piggyback heartbeat on send — updates last_seen without extra KV cost
      // (send already wrote to KV; this just updates the member object)
      try {
        await postWithFallback(config, '/chat/heartbeat', '{}', headers);
      } catch (_) { /* heartbeat failure should not affect send */ }
    } else {
      console.error(`❌ Send failed (${res.status}): ${res.json?.error || res.raw || 'unknown error'}`);
      if (res.status === 401) {
        console.error('   Check API token in config.json');
      }
      process.exit(1);
    }
  } catch (err) {
    console.error(`❌ Network error: ${err.message}`);
    process.exit(1);
  }
}

main();
