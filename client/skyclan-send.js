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

// Domain fallback chain — primary first (workers.dev, default), fallback to api_base (thawflow.com).
// Background: 2026-08-22 复测确认 workers.dev 稳定、thawflow.com 自定义域间歇超时（HTTP:000 / curl28 timeout）。
// config.json 里现有的 api_base 字段继续作 fallback URL 来源，不需要新增字段。
// 高级用户可在 config 里覆盖 primary_api_base（默认 https://tpg-hq.icepaw.workers.dev）。
const DEFAULT_PRIMARY_API_BASE = 'https://tpg-hq.icepaw.workers.dev';

function getApiBases(config) {
  const primary = config.primary_api_base || DEFAULT_PRIMARY_API_BASE;
  const fallback = config.api_base;
  const chain = [primary];
  if (fallback && fallback !== primary) chain.push(fallback);
  return chain;
}

// Try each base in order; succeed on first 2xx, fall through on network error.
// 4xx/5xx are surfaced (not retried against fallback) — they're server-side / auth issues
// that won't recover by switching the host.
async function postWithFallback(config, reqPath, body, headers) {
  const bases = getApiBases(config);
  let lastErr;
  for (let baseIdx = 0; baseIdx < bases.length; baseIdx++) {
    const url = `${bases[baseIdx]}${reqPath}`;
    try {
      return await post(url, body, headers);
    } catch (e) {
      lastErr = e;
      if (baseIdx < bases.length - 1) {
        console.warn(`[send] ${bases[baseIdx]} failed (${e.message}) → falling back to ${bases[baseIdx + 1]}`);
      }
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
