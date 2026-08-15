#!/usr/bin/env node
'use strict';

/**
 * SkyClan Chatroom - Message Poller (v3 — trigger.script mode)
 *
 * Design change from v2:
 *   - v2: Output ALL messages from others → agent decides what to reply
 *   - v3: ONLY output messages that @me or @all → everything else silently acked
 *
 * This means:
 *   - Empty output (no @me/@all) → cron agent sees nothing → NO_REPLY → zero token waste
 *   - Non-empty output → cron agent knows it must respond
 *   - Two-phase ack simplified: advance last_read for non-actionable messages immediately,
 *     only use .pending for messages that need a reply
 *
 * Called by OpenClaw cron every 2 minutes.
 *
 * Usage:
 *   node skyclan-poll.js                    # normal poll (quiet mode for cron)
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
// Default: 180 seconds (3 min) — aligned with cron timeoutSeconds: 180
// (covers zhipu cold start + 2-3 LLM round-trips + tool exec)
const ACK_TIMEOUT_MS = 180 * 1000;

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
  // Migration: old format was small integer (server_seq), new format is unix_ms timestamp
  // If val is a small integer (< 1e12), it's legacy server_seq → reset to 0 (fetch all)
  if (!val.includes('_') && parseInt(val) > 0 && parseInt(val) < 1e12) {
    console.error(`[migration] last_read legacy server_seq detected: ${val}, resyncing from 0`);
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

function writePending(stateDir, memberId, messages, lastTs) {
  const file = getPendingFile(stateDir, memberId);
  const data = {
    created_at: Date.now(),
    last_ts: String(lastTs),
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
  // Hard timeout: CF Worker cold starts can hang indefinitely; never let the poller stall.
  // 15s > known cold-start worst case (~8s), still well under the 150s cron budget.
  const TIMEOUT_MS = 15 * 1000;
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
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`request timeout after ${TIMEOUT_MS}ms: ${url}`)));
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function apiCall(config, method, reqPath, body, retries = 1) {
  const url = `${config.api_base}${reqPath}`;
  const headers = {
    'Authorization': `Bearer ${config.api_token}`,
    'Content-Type': 'application/json',
  };

  // 1 retry with 2s backoff on network errors — the Worker intermittently hangs
  // (KV latency waves); a single quick retry recovers most of those windows.
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw lastErr;
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
        if (verbose) console.log(`   ack pending (age: ${Math.round(pendingAge / 1000)}s, ts: ${pending.last_ts})`);
        ackPending(stateDir, memberId);
        setLastRead(stateDir, memberId, pending.last_ts);
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

    // Step 1: Pull messages (v4.0: using timestamp-based filtering)
    const since_ts = getLastRead(stateDir, memberId);
    const limit = Math.min(config.max_messages_per_poll || 50, 20);
    const msgRes = await apiCall(config, 'GET', `/chat/messages?since=${since_ts}&limit=${limit}`);

    if (!msgRes.ok) {
      if (verbose) console.error(`❌ poll failed: ${msgRes.status}`);
      if (msgRes.status === 401) {
        console.error('❌ Authentication failed - check API token');
      }
      process.exit(1);
    }

    const messages = msgRes.json.messages || [];

    // Sort by msg_id (unix_ms timestamp prefix) ascending — don't rely on server_seq
    messages.sort((a, b) => {
      const tsA = parseInt(a.msg_id) || 0;
      const tsB = parseInt(b.msg_id) || 0;
      return tsA - tsB;
    });

    if (messages.length === 0) {
      if (verbose) console.log('✅ poll: 0 new messages');
      process.exit(0);
    }

    // Step 2: Filter messages from others (not my own)
    const fromOthers = messages.filter(msg => String(msg.sender) !== String(memberId));

    // Compute last_read: use max msg_id timestamp across ALL messages
    const maxTs = messages.reduce((mx, m) => {
      const ts = parseInt(m.msg_id) || 0;
      return (ts > mx) ? ts : mx;
    }, 0);
    const lastVal = maxTs > 0 ? String(maxTs) : since_ts;

    if (fromOthers.length === 0) {
      // Only my own messages - advance last_read immediately
      setLastRead(stateDir, memberId, lastVal);
      if (verbose) console.log('✅ poll: only own messages, acked silently');
      process.exit(0);
    }

    // Step 3 (v3 core change): Split messages into actionable vs informational
    //   actionable = @me or @all → needs reply, use two-phase ack
    //   informational = everything else → silently advance last_read
    const actionable = fromOthers.filter(msg => {
      const atMe = msg.mentions && msg.mentions.includes(memberId);
      const atAll = msg.mentions && msg.mentions.includes('all');
      const isDM = msg.channel === `dm:${memberId}`;
      // @me, @all, or DM to me → actionable
      return atMe || atAll || isDM;
    });

    if (actionable.length === 0) {
      // No messages need my reply - advance last_read immediately
      setLastRead(stateDir, memberId, lastVal);
      if (verbose) console.log(`✅ poll: ${fromOthers.length} messages (none @me/@all), acked silently`);
      process.exit(0);
    }

    // Step 4: Write pending for actionable messages (two-phase ack)
    writePending(stateDir, memberId, actionable, lastVal);

    // Step 5: Output ONLY actionable messages as categorized chat bubbles
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
      const urgency = atMe ? ' ← @me 需回复' : '';

      return `${typeIcon} ${sender} → ${target}${urgency} (${time})\n${content}`;
    }

    const lines = actionable.map(formatMessage);

    // Output to stdout (cron captures this)
    console.log(lines.join('\n\n'));

    if (verbose) console.log(`\n✅ poll: ${actionable.length} actionable messages (pending ack in ${ACK_TIMEOUT_MS / 1000}s)`);

  } catch (err) {
    console.error(`❌ poll error: ${err.message}`);
    process.exit(1);
  }
}

main();
