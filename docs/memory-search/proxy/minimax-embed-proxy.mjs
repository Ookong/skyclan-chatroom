#!/usr/bin/env node
// minimax-embed-proxy.mjs
// OpenAI-compatible embedding → MiniMax embo-01 translation proxy
// Listens on 127.0.0.1:9999, translates {model, input} → {model, texts, type}
//
// ENV: MINIMAX_API_KEY (required), PROXY_PORT (default 9999), EMBED_TYPE (default "db")

import http from 'node:http';

const PORT = parseInt(process.env.PROXY_PORT || '9999', 10);
const TARGET = 'https://api.minimaxi.com/v1/embeddings';
const API_KEY = process.env.MINIMAX_API_KEY;
const DEFAULT_TYPE = process.env.EMBED_TYPE || 'db';
const MIN_INTERVAL_MS = parseInt(process.env.MIN_INTERVAL_MS || '200', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '4', 10);

// Serial gate: ensures at most one upstream call at a time, spaced by MIN_INTERVAL_MS
let lastCallAt = 0;
async function acquireSlot() {
  const now = Date.now();
  const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - now);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCallAt = Date.now();
}

if (!API_KEY) {
  console.error('[minimax-embed-proxy] FATAL: MINIMAX_API_KEY not set');
  process.exit(1);
}

console.log(`[minimax-embed-proxy] starting on http://127.0.0.1:${PORT}`);
console.log(`[minimax-embed-proxy] upstream=${TARGET} default_type=${DEFAULT_TYPE} min_interval_ms=${MIN_INTERVAL_MS} max_retries=${MAX_RETRIES}`);

const server = http.createServer(async (req, res) => {
  // CORS for browser probing
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Embed-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  if (req.method !== 'POST' || !req.url.startsWith('/v1/embeddings')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found', message: `POST /v1/embeddings only, got ${req.method} ${req.url}` }));
    return;
  }

  let body = '';
  for await (const chunk of req) body += chunk;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_json', message: String(e) }));
    return;
  }

  const model = parsed.model || 'embo-01';
  const input = parsed.input;
  const texts = Array.isArray(input) ? input : (typeof input === 'string' ? [input] : []);
  if (texts.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_input', message: 'input must be string or string[]' }));
    return;
  }

  // Honor X-Embed-Type header if set (db|query), else default
  const type = (req.headers['x-embed-type'] || DEFAULT_TYPE).toString();

  const start = Date.now();
  let attempt = 0;
  while (true) {
    attempt++;
    await acquireSlot();
    try {
      const upstream = await fetch(TARGET, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, texts, type }),
      });
      const json = await upstream.json();

      // Rate-limit retry (MiniMax status 1002)
      if (json.base_resp?.status_code === 1002 && attempt <= MAX_RETRIES) {
        const backoff = Math.min(15000, 1000 * Math.pow(2, attempt - 1));
        console.warn(`[minimax-embed-proxy] rate limited (attempt ${attempt}/${MAX_RETRIES}), backoff ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }

      if (json.base_resp?.status_code !== 0 || !Array.isArray(json.vectors)) {
        const code = json.base_resp?.status_code ?? 'unknown';
        const msg = json.base_resp?.status_msg ?? 'no vectors in response';
        console.error(`[minimax-embed-proxy] upstream error code=${code} msg=${msg} model=${model} type=${type} attempt=${attempt}`);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream_error', code, message: msg, raw: json, attempt }));
        return;
      }

      // Translate MiniMax {vectors: [[...]]} → OpenAI {data: [{embedding: [...]}]}
      const data = json.vectors.map((embedding, index) => ({
        object: 'embedding',
        embedding,
        index,
      }));
      const resp = {
        object: 'list',
        data,
        model,
        usage: { prompt_tokens: 0, total_tokens: 0 },
      };
      const ms = Date.now() - start;
      console.log(`[minimax-embed-proxy] ok model=${model} type=${type} n=${texts.length} ${ms}ms attempt=${attempt}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(resp));
      return;
    } catch (e) {
      if (attempt <= MAX_RETRIES) {
        const backoff = Math.min(10000, 500 * Math.pow(2, attempt - 1));
        console.warn(`[minimax-embed-proxy] fetch error attempt ${attempt}: ${e.message}, backoff ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      console.error(`[minimax-embed-proxy] fetch error after ${attempt} attempts: ${e.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'fetch_failed', message: String(e), attempt }));
      return;
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[minimax-embed-proxy] ready`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[minimax-embed-proxy] ${sig} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  });
}