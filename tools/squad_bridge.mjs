#!/usr/bin/env node
// SQUAD LINK <-> AI 정비 bridge: serves the single-file viewer and relays the control server's API under the
// same origin, so the viewer can follow it live (the control server sends no CORS headers, and a https page
// such as GitHub Pages may not read a plain-http LAN server).
//
//   node tools/squad_bridge.mjs [control-server-url] [--port 8095] [--host 127.0.0.1] [--file release/HoloHand-STL.html]
//                               [--allow-origin <origin>]... [--allow-host <name>]...
//   control-server-url defaults to $SQUAD_URL, else http://127.0.0.1:8080 (squad-link: node squad-link/server.mjs)
//   then open http://localhost:8095/#maint
//
// Relayed: GET /squad/api/config, /squad/api/state, /squad/api/stream (SSE), and one write, POST
// /squad/api/maintenance (JSON): the maintenance result, i.e. each soldier's equipment state and the impact
// incidents whose inspection is done. Everything else is refused, so the viewer can never acknowledge or close
// an SOS or a link incident, or inject device packets.
// The squad data is not public: other web pages may read it (and send the maintenance report) only from an allowed origin (CORS echo, plus the
// private-network preflight answer). Allowed by default: the hosted viewer https://kor03fluid.github.io; add
// more with --allow-origin (or $SQUAD_ALLOW_ORIGINS, comma separated). A file:// copy sends Origin 'null', which
// sandboxed frames of any site send too, so it is never allowed by default: open the bridge URL instead.
// Requests must name the bridge by localhost, an IP address, or a name given with --allow-host (or
// $SQUAD_ALLOW_HOSTS) in Host: a web page that re-points its own domain at this machine (DNS rebinding) is refused.
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
const list = (env) => String(process.env[env] || '').split(',').map((x) => x.trim()).filter(Boolean);
const many = (name) => {
  const out = [];
  for (let v; (v = opt(name, null)); ) out.push(v);
  return out;
};
// browsers send Origin in canonical form (lowercase scheme and host, no path): compare the same way
const allow = new Set();
for (const o of ['https://kor03fluid.github.io', ...list('SQUAD_ALLOW_ORIGINS'), ...many('allow-origin')]) {
  if (o === 'null') allow.add('null'); // only when asked for explicitly
  else {
    try {
      allow.add(new URL(o).origin);
    } catch {
      console.warn(`  ignored --allow-origin '${o}' (not an origin such as https://example.org)`);
    }
  }
}
const allowHosts = new Set([...list('SQUAD_ALLOW_HOSTS'), ...many('allow-host')].map((h) => h.toLowerCase()));
const USAGE = 'usage: node tools/squad_bridge.mjs [http://<control-server>:8080] [--port 8095] [--host 127.0.0.1] [--file release/HoloHand-STL.html] [--allow-origin <origin>] [--allow-host <name>]';
const unknown = args.filter((a) => a.startsWith('--'));
if (unknown.length) {
  console.error(`unknown option ${unknown.join(' ')}\n${USAGE}`);
  process.exit(2);
}
let target;
try {
  const raw = args.find((a) => !a.startsWith('--')) || process.env.SQUAD_URL || 'http://127.0.0.1:8080';
  target = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`); // '192.168.0.10:8080' means http
} catch {
  console.error(`not a control-server URL: ${args.find((a) => !a.startsWith('--'))}\n${USAGE}`);
  process.exit(2);
}
if (target.protocol !== 'http:') {
  console.error(`the control server (squad-link) speaks plain http; got ${target.protocol}//\n${USAGE}`);
  process.exit(2);
}
if (!Number.isInteger(port) || port <= 0 || port >= 65536) {
  console.error(`bad --port ${port}\n${USAGE}`);
  process.exit(2);
}
const ROUTES = new Set(['config', 'state', 'stream']);
const MAX_REPORT = 32 * 1024; // bytes of one maintenance report
/** Host header names this machine: localhost, an IP address (any port, e.g. through a port forward), or an allowed name. */
function hostOk(h) {
  const m = /^(\[[0-9a-f:.]+\]|[^:]+)(?::\d+)?$/i.exec(String(h || '').trim());
  if (!m) return false;
  const name = m[1].toLowerCase();
  return name === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || /^\[[0-9a-f:.]+\]$/.test(name) || allowHosts.has(name);
}
const refused = new Set();
/** The page this bridge serves (also behind an https tunnel); browsers send Origin on its POSTs too. */
const ownOrigin = (req) => [`http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin);
/** CORS headers for an allowed cross-origin caller, none otherwise (same-origin requests need none). */
function cors(req) {
  const o = req.headers.origin;
  if (!o || ownOrigin(req)) return {};
  if (!allow.has(o)) {
    if (!refused.has(o)) {
      refused.add(o);
      console.log(`  refused cross-origin request from ${o} — to allow it: --allow-origin ${o}`);
    }
    return {};
  }
  return {
    'Access-Control-Allow-Origin': o,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST',
    'Access-Control-Allow-Headers': 'Cache-Control, Last-Event-ID, Content-Type',
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

/** POST /squad/api/maintenance: JSON from this page or an allowed origin, relayed as is. */
function report(req, res) {
  const h = cors(req);
  const o = req.headers.origin;
  // a write needs a known page: this bridge's own origin or an allowed one (curl and other tools send none)
  if (o && !ownOrigin(req) && !h['Access-Control-Allow-Origin']) return send(res, 403, { error: '허용되지 않은 페이지의 정비 보고입니다 (--allow-origin 으로 추가)' });
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: '정비 보고는 application/json 으로 보내야 합니다.' }, undefined, h);
  const chunks = [];
  let size = 0, tooBig = false;
  req.on('data', (c) => {
    if (tooBig) return;
    size += c.length;
    if (size <= MAX_REPORT) return void chunks.push(c);
    tooBig = true;
    res.once('finish', () => req.destroy()); // answer first, then stop reading
    send(res, 413, { error: '정비 보고가 너무 큽니다.' }, undefined, { ...h, Connection: 'close' });
  });
  req.on('error', () => res.destroy());
  req.on('end', () => {
    if (tooBig || res.headersSent) return;
    const body = Buffer.concat(chunks);
    const up = http.request(new URL('/api/maintenance', target), { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, (r) => {
      res.writeHead(r.statusCode || 502, { ...h, 'Cache-Control': 'no-store', 'Content-Type': r.headers['content-type'] || 'application/json; charset=utf-8' });
      r.pipe(res);
      r.on('error', () => res.destroy());
    });
    up.setTimeout(4000, () => up.destroy(new Error('timeout')));
    up.on('error', (e) => {
      if (res.headersSent) res.destroy();
      else send(res, 502, { error: `SQUAD LINK 서버에 연결할 수 없습니다 (${target.origin}): ${e.message}` }, undefined, h);
    });
    up.end(body);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!hostOk(req.headers.host)) return send(res, 421, { error: 'Host 헤더가 이 중계 서버가 아닙니다 (--allow-host 로 추가)' });
    const path = new URL(req.url, 'http://localhost').pathname;
    const m = /^\/squad\/api\/([a-z]+)$/.exec(path);
    if (req.method === 'OPTIONS' && m) {
      const h = cors(req);
      return send(res, h['Access-Control-Allow-Origin'] ? 204 : 403, '', 'text/plain', h);
    }
    if (req.method === 'POST' && m && m[1] === 'maintenance') return report(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: '읽기와 정비 보고만 중계합니다' }, undefined, { Allow: 'GET' });
    if (m && ROUTES.has(m[1])) return relay(req, res, m[1]);
    if (path === '/' || path === '/index.html') return send(res, 200, await viewer(), 'text/html; charset=utf-8');
    send(res, 404, { error: '없는 경로입니다.' });
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `port ${port} is already in use (another bridge running?) — pick one with --port` : `bridge error: ${e.message || e}`);
  process.exit(1);
});
server.listen(port, host, () => {
  const shown = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`SQUAD LINK bridge: http://${shown}:${port}/#maint  (viewer ${file.replace(ROOT + '/', '')} · relays ${target.origin}/api/{config,state,stream} + POST /api/maintenance)`);
  console.log(`  other pages allowed to read it and send maintenance reports: ${[...allow].join(', ') || '(none)'}`);
  if (host === '0.0.0.0') console.log('  note: other devices reach it over plain http, where browsers turn the camera (hand tracking) off');
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.(); // open SSE streams would keep close() waiting
    setTimeout(() => process.exit(0), 500).unref();
  });
}
