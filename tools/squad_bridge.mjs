#!/usr/bin/env node
// SQUAD LINK -> AI 정비 bridge: serves the single-file viewer and relays the control server's read-only API
// under the same origin, so the viewer can follow it live (the control server sends no CORS headers, and a
// https page such as GitHub Pages may not read a plain-http LAN server).
//
//   node tools/squad_bridge.mjs [control-server-url] [--port 8095] [--host 127.0.0.1] [--file release/HoloHand-STL.html]
//   control-server-url defaults to $SQUAD_URL, else http://127.0.0.1:8080 (squad-link: node squad-link/server.mjs)
//   then open http://localhost:8095/#maint
//
// Read-only and one-way: only GET /squad/api/config, /squad/api/state and /squad/api/stream (SSE) are relayed;
// every other method is refused, so nothing in the viewer can acknowledge, resolve or inject anything.
// The relayed GETs also carry Access-Control-Allow-Origin: * (plus the private-network preflight answer), so
// the hosted viewer (GitHub Pages) or a file:// copy can connect to http://localhost:8095 when asked.
// No dependencies (Node 18+).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, d) => {
  const k = args.indexOf(`--${name}`);
  return k >= 0 && args[k + 1] ? args.splice(k, 2)[1] : d;
};
const port = Number(opt('port', process.env.PORT || 8095));
const host = opt('host', '127.0.0.1');
const file = resolve(ROOT, opt('file', 'release/HoloHand-STL.html'));
const target = new URL(args.find((a) => !a.startsWith('--')) || process.env.SQUAD_URL || 'http://127.0.0.1:8080');
const ROUTES = new Set(['config', 'state', 'stream']);
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Private-Network': 'true',
};

let page = null; // { mtimeMs, body }
async function viewer() {
  const s = await stat(file);
  if (!page || page.mtimeMs !== s.mtimeMs) page = { mtimeMs: s.mtimeMs, body: await readFile(file) };
  return page.body;
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function relay(req, res, route) {
  const url = new URL(`/api/${route}`, target);
  const up = http.get(url, { headers: { Accept: route === 'stream' ? 'text/event-stream' : 'application/json' } }, (r) => {
    const headers = { ...CORS, 'Cache-Control': 'no-cache', 'Content-Type': r.headers['content-type'] || 'application/json; charset=utf-8' };
    if (route === 'stream') {
      headers.Connection = 'keep-alive';
      headers['X-Accel-Buffering'] = 'no';
    }
    res.writeHead(r.statusCode || 502, headers);
    if (route === 'stream') res.flushHeaders?.();
    r.pipe(res);
    r.on('error', () => res.destroy());
  });
  up.setTimeout(route === 'stream' ? 0 : 4000, () => up.destroy(new Error('timeout')));
  up.on('error', (e) => {
    if (res.headersSent) res.destroy();
    else send(res, 502, { error: `SQUAD LINK 서버에 연결할 수 없습니다 (${target.origin}): ${e.message}` }, undefined, CORS);
  });
  res.on('close', () => up.destroy()); // the viewer left: drop the upstream stream too
}

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const m = /^\/squad\/api\/([a-z]+)$/.exec(path);
    if (req.method === 'OPTIONS' && m) return send(res, 204, '', 'text/plain', CORS);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: '읽기 전용 중계입니다 (GET만 허용)' }, undefined, { Allow: 'GET' });
    if (m && ROUTES.has(m[1])) return relay(req, res, m[1]);
    if (path === '/' || path === '/index.html') return send(res, 200, await viewer(), 'text/html; charset=utf-8');
    send(res, 404, { error: '없는 경로입니다.' });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});
server.listen(port, host, () => {
  const shown = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`SQUAD LINK bridge: http://${shown}:${port}/#maint  (viewer ${file.replace(ROOT + '/', '')} · relays ${target.origin}/api/{config,state,stream}, read-only)`);
  if (host === '0.0.0.0') console.log('  note: other devices reach it over plain http, where browsers turn the camera (hand tracking) off');
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.(); // open SSE streams would keep close() waiting
    setTimeout(() => process.exit(0), 500).unref();
  });
}
