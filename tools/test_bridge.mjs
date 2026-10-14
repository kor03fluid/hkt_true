#!/usr/bin/env node
// tools/squad_bridge.mjs write path: only POST /squad/api/maintenance, JSON, from the bridge's own page or an allowed
// origin, at most 32 KB; everything else that writes is refused. Runs the bridge against a stub control server.
//   node tools/test_bridge.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let passes = 0, fails = 0;
const ok = (c, msg) => (c ? passes++ : (fails++, console.log('FAIL', msg)));

const got = [];
const stub = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    got.push({ method: req.method, url: req.url, type: req.headers['content-type'], body });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url === '/api/config' ? '{}' : '{"ok":true}');
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const port = 18000 + Math.floor(Math.random() * 1000);
const bridge = spawn(process.execPath, [fileURLToPath(new URL('squad_bridge.mjs', import.meta.url)), `http://127.0.0.1:${stub.address().port}`, '--port', String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => bridge.stdout.once('data', r));
const base = `http://localhost:${port}/squad/api/`;
const post = (path, { origin, type = 'application/json', body = '{"node_id":"halo_01"}', method = 'POST', headers = {} } = {}) =>
  fetch(base + path, { method, headers: { ...(type ? { 'Content-Type': type } : {}), ...(origin ? { Origin: origin } : {}), ...headers }, body: method === 'OPTIONS' ? undefined : body });

try {
  ok((await post('maintenance', { origin: `http://localhost:${port}` })).status === 200, 'own page posts');
  ok((await post('maintenance')).status === 200, 'no Origin (curl) posts');
  const pages = await post('maintenance', { origin: 'https://kor03fluid.github.io' });
  ok(pages.status === 200 && pages.headers.get('access-control-allow-origin') === 'https://kor03fluid.github.io', 'allowed origin posts with CORS');
  ok((await post('maintenance', { origin: 'https://evil.example' })).status === 403, 'foreign origin refused');
  ok((await post('maintenance', { origin: 'null' })).status === 403, "Origin 'null' refused");
  ok((await post('maintenance', { type: 'text/plain' })).status === 415, 'text/plain refused');
  ok((await post('maintenance', { type: 'application/x-www-form-urlencoded', body: 'a=b' })).status === 415, 'form refused');
  ok((await post('maintenance', { body: 'x'.repeat(40000) })).status === 413, 'over 32 KB refused');
  const pre = await post('maintenance', { method: 'OPTIONS', origin: 'https://kor03fluid.github.io', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  ok(pre.status === 204 && /POST/.test(pre.headers.get('access-control-allow-methods')) && /Content-Type/i.test(pre.headers.get('access-control-allow-headers')), 'preflight allows POST + Content-Type');
  ok((await post('maintenance', { method: 'OPTIONS', origin: 'https://evil.example' })).status === 403, 'foreign preflight refused');
  for (const path of ['ingest', 'events', 'state', 'config']) ok((await post(path)).status === 405, `POST ${path} refused`);
  ok((await post('maintenance', { method: 'PUT' })).status === 405, 'PUT refused');
  ok((await fetch(base + 'state')).status === 200, 'GET still relayed');
  const writes = got.filter((g) => g.method === 'POST');
  ok(writes.length === 3 && writes.every((g) => g.url === '/api/maintenance' && g.type === 'application/json' && g.body === '{"node_id":"halo_01"}'), 'only the three accepted reports reached the server, unchanged');
} finally {
  bridge.kill();
  stub.close();
}
console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
