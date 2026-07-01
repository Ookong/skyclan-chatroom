#!/usr/bin/env node
'use strict';

/**
 * SkyClan Chatroom - Message Poller
 *
 * Schema v1.3: member_id 是 8 位数字字符串（如 "00000001"）。
 *
 * Called by OpenClaw cron every 2 minutes.
 *
 * Flow:
 *   1. Send heartbeat
 *   2. Pull new messages since last_read
 *   3. Filter @all and @me
 *   4. Print new messages as system events (stdout)
 *   5. Update last_read timestamp
 *
 * Usage:
 *   node skyclan-poll.js                    # normal poll
 *   node skyclan-poll.js --once             # single poll, verbose output
 *   node skyclan-poll.js --config <path>    # custom config path
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

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

function getStateDir(config) {
  // State files stored alongside config
  const stateDir = path.join(__dirname, '..');
  return stateDir;
}

function getLastRead(stateDir, memberId) {
  const file = path.join(stateDir, '.last-read');
  if (!fs.existsSync(file)) return '0';
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  return String(data[memberId] || '0');
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

async function apiCall(config, method, path, body) {
  const url = `${config.api_base}${path}`;
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
  const configIdx = args.indexOf('--config');
  const configPath = configIdx >= 0 ? args[configIdx + 1] : null;

  const config = loadConfig(configPath);
  const stateDir = getStateDir(config);
  const memberId = config.member_id;

  if (verbose) console.log(`[${new Date().toISOString()}] Polling as ${memberId}...`);

  try {
    // Step 1: Heartbeat (only if > 60s since last)
    const lastHb = getLastHeartbeat(stateDir, memberId);
    if (Date.now() - lastHb > 60000) {
      const hbRes = await apiCall(config, 'POST', '/chat/heartbeat');
      if (hbRes.ok) {
        setLastHeartbeat(stateDir, memberId);
        if (verbose) console.log('✅ heartbeat OK');
      } else {
        if (verbose) console.error(`❌ heartbeat failed: ${hbRes.status}`);
      }
    }

    // Step 2: Pull messages
    const since = getLastRead(stateDir, memberId);
    const limit = config.max_messages_per_poll || 50;
    const msgRes = await apiCall(config, 'GET', `/chat/messages?since=${since}&limit=${limit}`);

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
      // Still exit 0 so cron knows it's healthy
      process.exit(0);
    }

    // Step 3: Filter and format
    const relevant = messages.filter(msg => {
      // All channel messages
      if (msg.channel === 'all') return true;
      // DMs to me
      if (msg.channel === `dm:${memberId}`) return true;
      // DMs from me (don't echo back)
      return false;
    });

    // Skip my own messages
    const fromOthers = relevant.filter(msg => msg.sender !== memberId);

    if (fromOthers.length === 0) {
      // Only my own messages - just update last_read
      const latest = messages[messages.length - 1];
      setLastRead(stateDir, memberId, latest.msg_id);
      if (verbose) console.log('✅ poll: only own messages, skipping');
      process.exit(0);
    }

    // Step 4: Output as system events
    const lines = [];
    for (const msg of fromOthers) {
      const target = msg.channel === 'all' ? '@all' : `@${memberId}`;
      const time = new Date(parseInt(msg.msg_id)).toLocaleTimeString('zh-CN', { hour12: false });
      lines.push(`[SkyClan] ${msg.sender_name} → ${target} (${time})\n${msg.content}`);
    }

    // Output to stdout (cron captures this)
    console.log(lines.join('\n\n'));

    // Step 5: Update last_read
    const latest = messages[messages.length - 1];
    setLastRead(stateDir, memberId, latest.msg_id);

    if (verbose) console.log(`\n✅ poll: ${fromOthers.length} new messages`);

  } catch (err) {
    console.error(`❌ poll error: ${err.message}`);
    process.exit(1);
  }
}

main();
