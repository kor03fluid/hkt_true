#!/usr/bin/env node
// SQUAD LINK -> AI 정비 bridge: serves the single-file viewer and relays the control server's read-only API
// under the same origin, so the viewer can follow it live (the control server sends no CORS headers, and a
// https page such as GitHub Pages may not read a plain-http LAN server).
//
//   node tools/squad_bridge.mjs [control-server-url] [--port 8095] [--host 127.0.0.1] [--file release/HoloHand-STL.html]
//                               [--allow-origin <origin>]...
//   control-server-url defaults to $SQUAD_URL, else http://127.0.0.1:8080 (squad-link: node squad-link/server.mjs)
//   then open http://localhost:8095/#maint
//
// Read-only and one-way: only GET /squad/api/config, /squad/api/state and /squad/api/stream (SSE) are relayed;
// every other method is refused, so nothing in the viewer can acknowledge, resolve or inject anything.
// The squad data is not public: other web pages may read it only from an allowed origin (CORS echo, plus the
// private-network preflight answer). Allowed by default: the hosted viewer https://kor03fluid.github.io; add
// more with --allow-origin (or $SQUAD_ALLOW_ORIGINS, comma separated). A file:// copy sends Origin 'null', which
// sandboxed frames of any site send too, so it is never allowed by default: open the bridge URL instead.
// Bound to loopback (the default), requests must name localhost / 127.0.0.1 / [::1] in Host (DNS rebinding).
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
const allow = new Set(['https://kor03fluid.github.io', ...String(process.env.SQUAD_ALLOW_ORIGINS || '').split(',').map((x) => x.trim()).filter(Boolean)]);
for (let o; (o = opt('allow-origin', null)); ) allow.add(o.replace(/\/+$/, ''));
const target = new URL(args.find((a) => !a.startsWith('--')) || process.env.SQUAD_URL || 'http://127.0.0.1:8080');
const ROUTES = new Set(['config', 'state', 'stream']);
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(host);
const HOSTS = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
/** CORS headers for an allowed cross-origin caller, none otherwise (same-origin requests need none). */
function cors(req) {
  const o = req.headers.origin;
  if (!o || !allow.has(o)) return {};
  return {
    'Access-Control-Allow-Origin': o,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET',
    'Access-Control-Allow-Headers': 'Cache-Control, Last-Event-ID',
    'Access-Control-Allow-Private-Network': 'true',
  };
}

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
    const headers = { ...cors(req), 'Cache-Control': 'no-cache', 'Content-Type': r.headers['content-type'] || 'application/json; charset=utf-8' };
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
    else send(res, 502, { error: `SQUAD LINK 서버에 연결할 수 없습니다 (${target.origin}): ${e.message}` }, undefined, cors(req));
  });
  res.on('close', () => up.destroy()); // the viewer left: drop the upstream stream too
}

const server = http.createServer(async (req, res) => {
  try {
    if (LOOPBACK && !HOSTS.has(String(req.headers.host || '').toLowerCase())) return send(res, 421, { error: 'Host 헤더가 이 중계 서버가 아닙니다' });
    const path = new URL(req.url, 'http://localhost').pathname;
    const m = /^\/squad\/api\/([a-z]+)$/.exec(path);
    if (req.method === 'OPTIONS' && m) {
      const h = cors(req);
      return send(res, h['Access-Control-Allow-Origin'] ? 204 : 403, '', 'text/plain', h);
    }
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
  console.log(`  other pages allowed to read it: ${[...allow].join(', ') || '(none)'}`);
  if (host === '0.0.0.0') console.log('  note: other devices reach it over plain http, where browsers turn the camera (hand tracking) off');
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.(); // open SSE streams would keep close() waiting
    setTimeout(() => process.exit(0), 500).unref();
  });
}
