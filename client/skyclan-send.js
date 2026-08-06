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

function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(url, { method: 'POST', headers }, (res) => {
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
    req.write(body);
    req.end();
  });
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
    // Match @ followed by non-whitespace, non-punctuation chars
    // Supports CJK nicknames: @如意, @冰爪, @小马, @龙井
    // Supports ASCII: @icepaw, @IcePaw, @all, @10000002
    const regex = /@([^\s@,，。.!！?？]+)/g;
    let match;
    while ((match = regex.exec(message)) !== null) {
      mentions.push(match[1]);
    }
    mentions = [...new Set(mentions)];
    // Send raw tokens — server resolves nicknames to member_id
    // For numeric IDs and 'all', they pass through as-is
  }

  const body = JSON.stringify({ channel, content: message, mentions });

  const headers = {
    'Authorization': `Bearer ${config.api_token}`,
    'Content-Type': 'application/json',
  };

  try {
    const res = await post(`${config.api_base}/chat/messages`, body, headers);

    if (res.ok) {
      console.log(`✅ Sent → ${opts.to === 'all' ? '@all' : '@' + opts.to}`);
      console.log(`   msg_id: ${res.json.msg_id}`);

      // Piggyback heartbeat on send — updates last_seen without extra KV cost
      // (send already wrote to KV; this just updates the member object)
      try {
        await post(`${config.api_base}/chat/heartbeat`, '{}', headers);
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
