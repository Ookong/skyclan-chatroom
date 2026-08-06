#!/usr/bin/env node
'use strict';

/**
 * SkyClan Chatroom - Message Poller (v2 — two-phase ack)
 *
 * member_id 是 8 位数字字符串（如 "10000001"）。TPG HQ 玩家系统 ID。
 *
 * Called by OpenClaw cron every 2 minutes.
 *
 * Two-phase ack flow (prevents message loss on agent timeout):
 *   1. Pull new messages since last_read
 *   2. Write messages to .pending file (NOT advancing last_read yet)
 *   3. Output messages to stdout (cron injects into session)
 *   4. On next poll: check if .pending exists
 *      a. If .pending age < ACK_TIMEOUT → last poll might still be processing, skip
 *      b. If .pending age ≥ ACK_TIMEOUT → assume success, ack pending → advance last_read
 *      c. Then continue with normal poll
 *
 * This ensures: if agent model call times out, messages are NOT lost.
 * They stay in .pending until acked, and last_read is only advanced after
 * a successful processing window.
 *
 * Usage:
 *   node skyclan-poll.js                    # normal poll
 *   node skyclan-poll.js --once             # single poll, verbose output
 *   node skyclan-poll.js --ack              # manually ack pending (for testing)
 *   node skyclan-poll.js --config <path>    # custom config path
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// --- Config ---

// Ack timeout: how long to wait before assuming the previous poll was processed.
// If .pending file is older than this, we ack it (advance last_read).
// Should be > typical agent response time but < cron interval * safety margin.
// Default: 90 seconds (enough for most LLM responses, well within 2min cron gap)
const ACK_TIMEOUT_MS = 90 * 1000;

function loadConfig(configPath) {
  const defaultPath = path.join(__dirname, '..', 'config.json');
  const p = configPath || defaultPath;

  if (!fs.existsSync(p)) {
    console.error(`❌ Config not found: ${p}`);
    process.exit(1);
  }

  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function getStateDir(config) {
  // State files stored alongside config
  const stateDir = path.join(__dirname, '..');
  return stateDir;
}

function getLastRead(stateDir, memberId) {
  const file = path.join(stateDir, '.last-read');
  if (!fs.existsSync(file)) return '0';
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const val = String(data[memberId] || '0');
  // Legacy detection: old format was msg_id ("<ts>_<rand>") or pure timestamp (len > 10)
  // New format is a small integer string (e.g. "42")
  if (val.includes('_') || (val.length > 10 && !val.startsWith('0'))) {
    console.error(`[migration] last_read legacy format detected: ${val}, resyncing from 0`);
    return '0';
  }
  return val;
}

function setLastRead(stateDir, memberId, ts) {
  const file = path.join(stateDir, '.last-read');
  let data = {};
  if (fs.existsSync(file)) {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  data[memberId] = String(ts);
  fs.writeFileSync(file, JSON.stringify(data));
}

function getLastHeartbeat(stateDir, memberId) {
  const file = path.join(stateDir, '.heartbeat');
  if (!fs.existsSync(file)) return 0;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return data[memberId] || 0;
}

function setLastHeartbeat(stateDir, memberId) {
  const file = path.join(stateDir, '.heartbeat');
  let data = {};
  if (fs.existsSync(file)) {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  data[memberId] = Date.now();
  fs.writeFileSync(file, JSON.stringify(data));
}

// --- Two-phase ack state ---

function getPendingFile(stateDir, memberId) {
  return path.join(stateDir, `.pending-${memberId}`);
}

function writePending(stateDir, memberId, messages, lastSeq) {
  const file = getPendingFile(stateDir, memberId);
  const data = {
    created_at: Date.now(),
    last_seq: String(lastSeq),
    msg_count: messages.length,
  };
  fs.writeFileSync(file, JSON.stringify(data));
}

function readPending(stateDir, memberId) {
  const file = getPendingFile(stateDir, memberId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function ackPending(stateDir, memberId) {
  const file = getPendingFile(stateDir, memberId);
  if (fs.existsSync(file)) {
    const pending = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.unlinkSync(file);
    return pending;
  }
  return null;
}

// --- HTTP ---

function fetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
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
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function apiCall(config, method, reqPath, body) {
  const url = `${config.api_base}${reqPath}`;
  const headers = {
    'Authorization': `Bearer ${config.api_token}`,
    'Content-Type': 'application/json',
  };

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  return res;
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--once') || args.includes('--verbose');
  const ackOnly = args.includes('--ack');
  const configIdx = args.indexOf('--config');
  const configPath = configIdx >= 0 ? args[configIdx + 1] : null;

  const config = loadConfig(configPath);
  const stateDir = getStateDir(config);
  const memberId = config.member_id;

  if (verbose) console.log(`[${new Date().toISOString()}] Polling as ${memberId}...`);

  try {
    // --- Two-phase ack: check previous pending ---
    const pending = readPending(stateDir, memberId);
    if (pending) {
      const pendingAge = Date.now() - pending.created_at;
      if (pendingAge >= ACK_TIMEOUT_MS) {
        // Previous poll was processed (enough time elapsed) → ack it
        if (verbose) console.log(`   ack pending (age: ${Math.round(pendingAge / 1000)}s, seq: ${pending.last_seq})`);
        ackPending(stateDir, memberId);
        setLastRead(stateDir, memberId, pending.last_seq);
      } else {
        // Previous poll might still be processing → skip this round
        if (verbose) console.log(`   ⏳ pending not yet acked (age: ${Math.round(pendingAge / 1000)}s < ${ACK_TIMEOUT_MS / 1000}s), skipping poll`);
        process.exit(0);
      }
    }

    // Manual ack mode (for testing)
    if (ackOnly) {
      console.log('✅ ack completed');
      process.exit(0);
    }

    // Step 0: Throttled heartbeat — update last_seen every 30 min max
    const HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
    const lastHb = getLastHeartbeat(stateDir, memberId);
    if (Date.now() - lastHb >= HEARTBEAT_INTERVAL_MS) {
      try {
        const hbRes = await apiCall(config, 'POST', '/chat/heartbeat');
        if (hbRes.ok) {
          setLastHeartbeat(stateDir, memberId);
          if (verbose) console.log('   heartbeat sent ✅');
        }
      } catch (_) { /* non-fatal */ }
    }

    // Step 1: Pull messages (using server_seq for filtering)
    const since_seq = getLastRead(stateDir, memberId);
    const limit = Math.min(config.max_messages_per_poll || 50, 20);
    const msgRes = await apiCall(config, 'GET', `/chat/messages?since_seq=${since_seq}&limit=${limit}`);

    if (!msgRes.ok) {
      if (verbose) console.error(`❌ poll failed: ${msgRes.status}`);
      if (msgRes.status === 401) {
        console.error('❌ Authentication failed - check API token');
      }
      process.exit(1);
    }

    const messages = msgRes.json.messages || [];

    if (messages.length === 0) {
      if (verbose) console.log('✅ poll: 0 new messages');
      process.exit(0);
    }

    // Step 2: Filter — inject ALL messages from others
    const relevant = messages.filter(msg => {
      if (msg.channel === 'all') return true;
      if (msg.channel === `dm:${memberId}`) return true;
      return false;
    });

    // Skip my own messages (normalize types — API returns number, config is string)
    const fromOthers = relevant.filter(msg => String(msg.sender) !== String(memberId));

    // Compute last_seq from ALL messages (including own), not just fromOthers
    const latest = messages[messages.length - 1];
    const lastVal = latest.server_seq ? String(latest.server_seq) : latest.msg_id;

    if (fromOthers.length === 0) {
      // Only my own messages - write pending (will be acked next round quickly)
      writePending(stateDir, memberId, [], lastVal);
      if (verbose) console.log('✅ poll: only own messages, pending written');
      process.exit(0);
    }

    // Step 3: Write pending BEFORE outputting (two-phase ack)
    writePending(stateDir, memberId, fromOthers, lastVal);

    // Step 4: Output as categorized chat bubbles
    const TYPE_ICONS = {
      '请求': '⚡',
      '通知': '📋',
      '讨论': '💬',
      '汇报': '📊',
      '系统': '🔧',
    };

    function formatMessage(msg) {
      const target = msg.channel === 'all' ? '@all' : `@me`;
      const time = new Date(parseInt(msg.msg_id)).toLocaleTimeString('zh-CN', { hour12: false });
      const sender = msg.sender_name || msg.sender;

      let typeIcon = '💬';
      let content = msg.content;
      const typeMatch = msg.content.match(/^\[([通知请求讨论汇报系统])\]/);
      if (typeMatch) {
        typeIcon = TYPE_ICONS[typeMatch[1]] || '💬';
      }

      const atMe = msg.mentions && msg.mentions.includes(memberId);
      const atAll = msg.mentions && msg.mentions.includes('all');
      const urgency = atMe ? ' ← @me 需回复' : (atAll ? '' : '');

      return `${typeIcon} ${sender} → ${target}${urgency} (${time})\n${content}`;
    }

    const lines = fromOthers.map(formatMessage);

    // Output to stdout (cron captures this)
    console.log(lines.join('\n\n'));

    if (verbose) console.log(`\n✅ poll: ${fromOthers.length} new messages (pending ack in ${ACK_TIMEOUT_MS / 1000}s)`);

  } catch (err) {
    console.error(`❌ poll error: ${err.message}`);
    process.exit(1);
  }
}

main();
