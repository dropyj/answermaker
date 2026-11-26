// AnswerMaker Sync Service — zero-dependency Node server.
// Stores ONLY encrypted .amsync packages (zero-knowledge: the sync passphrase
// never reaches this server). Auth: per-device Bearer tokens.
// API:
//   GET  /health          (no auth)  -> {ok, service, version}
//   PUT  /package         (auth)     body = .amsync JSON text, headers X-Device-Id / X-Device-Name
//   GET  /package/latest  (auth)     -> latest package body + X-Package-* headers
//   GET  /packages        (auth)     -> {packages:[{version, deviceName, size, updatedAt}]} (max 10 kept)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.AMSYNC_PORT || 7362);
const HOST = process.env.AMSYNC_HOST || '0.0.0.0';
const DATA_DIR = process.env.AMSYNC_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const PKG_DIR = path.join(DATA_DIR, 'packages');
const MAX_BODY = 20 * 1024 * 1024;
const KEEP = 10;

fs.mkdirSync(PKG_DIR, { recursive: true });

function loadTokens() {
  const f = path.join(DATA_DIR, 'tokens.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
}
function saveTokens(list) {
  const f = path.join(DATA_DIR, 'tokens.json');
  fs.writeFileSync(f, JSON.stringify(list, null, 2), { mode: 0o600 });
}
// Bootstrap: create a default device token on first run.
if (loadTokens().length === 0) {
  const token = 'amsync_' + crypto.randomBytes(24).toString('base64url');
  saveTokens([{ id: 'default', name: 'default', token, createdAt: new Date().toISOString(), revoked: false }]);
  fs.writeFileSync(path.join(DATA_DIR, 'bootstrap-token.txt'), token + '\n', { mode: 0o600 });
  console.log('[sync] bootstrap device token created (see data/bootstrap-token.txt)');
}
function authClient(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  return loadTokens().find(t => !t.revoked && t.token === token) || null;
}
function audit(entry) {
  try { fs.appendFileSync(path.join(DATA_DIR, 'audit.log'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch {}
}
function loadIndex() {
  try { return JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'index.json'), 'utf8')); } catch { return []; }
}
function saveIndex(list) { fs.writeFileSync(path.join(PKG_DIR, 'index.json'), JSON.stringify(list, null, 2)); }

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Device-Id, X-Device-Name');
  res.setHeader('Access-Control-Expose-Headers', 'X-Package-Version, X-Package-Updated-At, X-Package-Device');
}
function json(res, code, obj) { cors(res); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'answermaker-sync', version: '1.0.0' });
  }
  const client = authClient(req);
  if (!client) { audit({ event: 'auth_fail', path: url.pathname }); return json(res, 401, { error: 'unauthorized' }); }

  if (req.method === 'PUT' && url.pathname === '/package') {
    const chunks = []; let size = 0; let tooBig = false;
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { tooBig = true; req.destroy(); return; } chunks.push(c); });
    req.on('end', () => {
      if (tooBig) return json(res, 413, { error: 'package_too_large' });
      const body = Buffer.concat(chunks).toString('utf8');
      let parsed; try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid_json' }); }
      if (!parsed || typeof parsed !== 'object' || !('ct' in parsed || 'cipher' in parsed || 'data' in parsed || 'payload' in parsed)) {
        return json(res, 400, { error: 'not_an_encrypted_package' });
      }
      const index = loadIndex();
      const version = (index.length ? index[index.length - 1].version : 0) + 1;
      let deviceName = String(req.headers['x-device-name'] || 'unknown');
      try { deviceName = decodeURIComponent(deviceName); } catch {}
      deviceName = deviceName.slice(0, 64);
      const deviceId = String(req.headers['x-device-id'] || '').slice(0, 64);
      const file = path.join(PKG_DIR, `pkg-${version}.amsync`);
      fs.writeFileSync(file, body, { mode: 0o600 });
      const meta = { version, deviceName, deviceId, size: Buffer.byteLength(body), updatedAt: new Date().toISOString() };
      index.push(meta);
      while (index.length > KEEP) { const old = index.shift(); try { fs.unlinkSync(path.join(PKG_DIR, `pkg-${old.version}.amsync`)); } catch {} }
      saveIndex(index);
      audit({ event: 'push', client: client.name, device: deviceName, version, size: meta.size });
      return json(res, 200, { ok: true, version, size: meta.size, updatedAt: meta.updatedAt });
    });
    req.on('error', () => { try { json(res, 400, { error: 'read_error' }); } catch {} });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/package/latest') {
    const index = loadIndex();
    if (!index.length) return json(res, 404, { error: 'no_package' });
    const latest = index[index.length - 1];
    const body = fs.readFileSync(path.join(PKG_DIR, `pkg-${latest.version}.amsync`), 'utf8');
    cors(res);
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Package-Version': String(latest.version), 'X-Package-Updated-At': latest.updatedAt, 'X-Package-Device': encodeURIComponent(latest.deviceName) });
    audit({ event: 'pull', client: client.name, version: latest.version });
    res.end(body); return;
  }

  if (req.method === 'GET' && url.pathname === '/packages') {
    const index = loadIndex();
    return json(res, 200, { packages: [...index].reverse().map(({ version, deviceName, size, updatedAt }) => ({ version, deviceName, size, updatedAt })) });
  }

  return json(res, 404, { error: 'not_found' });
});
server.listen(PORT, HOST, () => console.log(`[sync] answermaker-sync listening on ${HOST}:${PORT}, data=${DATA_DIR}`));
