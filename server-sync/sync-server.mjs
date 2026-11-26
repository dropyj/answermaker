// AnswerMaker Sync Service — zero-dependency Node server.
// Stores ONLY encrypted .amsync packages (zero-knowledge: the sync passphrase
// never reaches this server).
//
// Auth (v1.1): personal accounts (email + password, scrypt-hashed) with
// 30-day session tokens. Packages are isolated per account. Registration is
// open only for the very first account; afterwards an invite code is required
// (create one on the server: `node sync-server.mjs --create-invite`).
// Legacy per-device Bearer tokens (data/tokens.json) still work and map to
// the shared 'legacy' namespace.
//
// API (behind Caddy the /amsync prefix is stripped):
//   GET  /health          (no auth)
//   POST /auth/register   {email, password, inviteCode?} -> {token, user, expiresAt}
//   POST /auth/login      {email, password}              -> {token, user, expiresAt}
//   POST /auth/logout     (Bearer session)
//   GET  /auth/me         (Bearer session)
//   PUT  /package         (Bearer)  body = .amsync JSON, X-Device-Id / X-Device-Name headers
//   GET  /package/latest  (Bearer)
//   GET  /packages        (Bearer)  last 10 versions of the caller's namespace
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.AMSYNC_PORT || 7362);
const HOST = process.env.AMSYNC_HOST || '0.0.0.0';
const DATA_DIR = process.env.AMSYNC_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const MAX_BODY = 20 * 1024 * 1024;
const KEEP = 10;
const SESSION_DAYS = 30;

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), { mode: 0o600 });
}
const usersFile = () => path.join(DATA_DIR, 'users.json');
const sessionsFile = () => path.join(DATA_DIR, 'sessions.json');
const invitesFile = () => path.join(DATA_DIR, 'invites.json');
const tokensFile = () => path.join(DATA_DIR, 'tokens.json');
const loadUsers = () => readJson(usersFile(), []);
const loadSessions = () => readJson(sessionsFile(), []);
const loadInvites = () => readJson(invitesFile(), []);
const loadTokens = () => readJson(tokensFile(), []);
function saveTokens(list) { writeJson(tokensFile(), list); }

// Bootstrap legacy device token on first run (back-compat).
if (loadTokens().length === 0 && !fs.existsSync(tokensFile())) {
  const token = 'amsync_' + crypto.randomBytes(24).toString('base64url');
  saveTokens([{ id: 'default', name: 'default', token, createdAt: new Date().toISOString(), revoked: false }]);
  fs.writeFileSync(path.join(DATA_DIR, 'bootstrap-token.txt'), token + '\n', { mode: 0o600 });
  console.log('[sync] bootstrap device token created (see data/bootstrap-token.txt)');
}

// ---------- CLI helpers ----------
if (process.argv.includes('--create-invite')) {
  const code = 'AM-' + crypto.randomBytes(6).toString('hex').toUpperCase();
  const invites = loadInvites();
  invites.push({ codeHash: crypto.createHash('sha256').update(code).digest('hex'), createdAt: new Date().toISOString(), usedBy: null });
  writeJson(invitesFile(), invites);
  console.log(code);
  process.exit(0);
}

// ---------- crypto helpers ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}
function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// ---------- login throttle (in-memory) ----------
const loginFails = new Map(); // key ip|email -> [timestamps]
function throttled(key) {
  const now = Date.now();
  const list = (loginFails.get(key) || []).filter(t => now - t < 10 * 60 * 1000);
  loginFails.set(key, list);
  return list.length >= 5;
}
function recordFail(key) {
  const list = loginFails.get(key) || [];
  list.push(Date.now());
  loginFails.set(key, list);
}

// ---------- auth ----------
function createSession(userId, deviceName) {
  const token = 'amsess_' + crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString();
  const sessions = loadSessions().filter(s => new Date(s.expiresAt) > new Date());
  sessions.push({ tokenHash: sha256(token), userId, deviceName: deviceName || '', createdAt: new Date().toISOString(), expiresAt });
  writeJson(sessionsFile(), sessions);
  return { token, expiresAt };
}
function authClient(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) return null;
  if (token.startsWith('amsess_')) {
    const s = loadSessions().find(x => x.tokenHash === sha256(token));
    if (!s || new Date(s.expiresAt) <= new Date()) return null;
    const user = loadUsers().find(u => u.id === s.userId);
    if (!user) return null;
    return { type: 'session', ns: 'user-' + user.id, user };
  }
  const legacy = loadTokens().find(t => !t.revoked && t.token === token);
  if (legacy) return { type: 'device', ns: 'legacy', name: legacy.name };
  return null;
}
function audit(entry) {
  try { fs.appendFileSync(path.join(DATA_DIR, 'audit.log'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch {}
}

// ---------- packages per namespace ----------
function pkgDir(ns) { return path.join(DATA_DIR, 'stores', ns, 'packages'); }
function loadIndex(ns) { return readJson(path.join(pkgDir(ns), 'index.json'), []); }
function saveIndex(ns, list) { writeJson(path.join(pkgDir(ns), 'index.json'), list); }
// Migrate the pre-account global store into the legacy namespace once.
(function migrateLegacy() {
  const oldDir = path.join(DATA_DIR, 'packages');
  const newDir = pkgDir('legacy');
  if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
    fs.mkdirSync(path.dirname(newDir), { recursive: true });
    fs.renameSync(oldDir, newDir);
    console.log('[sync] migrated global package store to legacy namespace');
  }
})();

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Device-Id, X-Device-Name');
  res.setHeader('Access-Control-Expose-Headers', 'X-Package-Version, X-Package-Updated-At, X-Package-Device');
}
function json(res, code, obj) { cors(res); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise(resolve => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { req.destroy(); resolve(null); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, service: 'answermaker-sync', version: '1.1.0' });
  }

  // ----- account auth -----
  if (req.method === 'POST' && url.pathname === '/auth/register') {
    const body = await readBody(req);
    let data; try { data = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid_json' }); }
    const email = String(data.email || '').trim().toLowerCase();
    const password = String(data.password || '');
    if (!EMAIL_RE.test(email)) return json(res, 400, { error: 'invalid_email' });
    if (password.length < 8) return json(res, 400, { error: 'weak_password' });
    const users = loadUsers();
    if (users.some(u => u.email === email)) return json(res, 409, { error: 'email_exists' });
    if (users.length > 0) {
      const code = String(data.inviteCode || '').trim().toUpperCase();
      if (!code) return json(res, 403, { error: 'invite_required' });
      const invites = loadInvites();
      const inv = invites.find(i => !i.usedBy && i.codeHash === sha256(code));
      if (!inv) return json(res, 403, { error: 'invite_invalid' });
      inv.usedBy = email;
      writeJson(invitesFile(), invites);
    }
    const user = { id: crypto.randomBytes(8).toString('hex'), email, pw: hashPassword(password), role: users.length === 0 ? 'admin' : 'user', createdAt: new Date().toISOString() };
    users.push(user);
    writeJson(usersFile(), users);
    const { token, expiresAt } = createSession(user.id, String(req.headers['x-device-name'] || ''));
    audit({ event: 'register', email });
    return json(res, 200, { token, user: { id: user.id, email: user.email }, expiresAt });
  }

  if (req.method === 'POST' && url.pathname === '/auth/login') {
    const body = await readBody(req);
    let data; try { data = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid_json' }); }
    const email = String(data.email || '').trim().toLowerCase();
    const password = String(data.password || '');
    const key = (req.socket.remoteAddress || '') + '|' + email;
    if (throttled(key)) return json(res, 429, { error: 'too_many_attempts' });
    const user = loadUsers().find(u => u.email === email);
    if (!user || !verifyPassword(password, user.pw)) {
      recordFail(key);
      audit({ event: 'login_fail', email });
      return json(res, 401, { error: 'invalid_credentials' });
    }
    loginFails.delete(key);
    const { token, expiresAt } = createSession(user.id, String(req.headers['x-device-name'] || ''));
    audit({ event: 'login', email });
    return json(res, 200, { token, user: { id: user.id, email: user.email }, expiresAt });
  }

  if (req.method === 'POST' && url.pathname === '/auth/logout') {
    const h = req.headers['authorization'] || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (token.startsWith('amsess_')) {
      writeJson(sessionsFile(), loadSessions().filter(s => s.tokenHash !== sha256(token)));
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/auth/me') {
    const client = authClient(req);
    if (!client || client.type !== 'session') return json(res, 401, { error: 'unauthorized' });
    return json(res, 200, { user: { id: client.user.id, email: client.user.email } });
  }

  // ----- packages (session or legacy device token) -----
  const client = authClient(req);
  if (!client) { audit({ event: 'auth_fail', path: url.pathname }); return json(res, 401, { error: 'unauthorized' }); }
  const ns = client.ns;

  if (req.method === 'PUT' && url.pathname === '/package') {
    const body = await readBody(req);
    if (body === null) return json(res, 413, { error: 'package_too_large' });
    let parsed; try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'invalid_json' }); }
    if (!parsed || typeof parsed !== 'object' || !('ct' in parsed || 'cipher' in parsed || 'data' in parsed || 'payload' in parsed)) {
      return json(res, 400, { error: 'not_an_encrypted_package' });
    }
    fs.mkdirSync(pkgDir(ns), { recursive: true });
    const index = loadIndex(ns);
    const version = (index.length ? index[index.length - 1].version : 0) + 1;
    let deviceName = String(req.headers['x-device-name'] || 'unknown');
    try { deviceName = decodeURIComponent(deviceName); } catch {}
    deviceName = deviceName.slice(0, 64);
    const deviceId = String(req.headers['x-device-id'] || '').slice(0, 64);
    fs.writeFileSync(path.join(pkgDir(ns), `pkg-${version}.amsync`), body, { mode: 0o600 });
    const meta = { version, deviceName, deviceId, size: Buffer.byteLength(body), updatedAt: new Date().toISOString() };
    index.push(meta);
    while (index.length > KEEP) { const old = index.shift(); try { fs.unlinkSync(path.join(pkgDir(ns), `pkg-${old.version}.amsync`)); } catch {} }
    saveIndex(ns, index);
    audit({ event: 'push', ns, device: deviceName, version, size: meta.size });
    return json(res, 200, { ok: true, version, size: meta.size, updatedAt: meta.updatedAt });
  }

  if (req.method === 'GET' && url.pathname === '/package/latest') {
    const index = loadIndex(ns);
    if (!index.length) return json(res, 404, { error: 'no_package' });
    const latest = index[index.length - 1];
    const body = fs.readFileSync(path.join(pkgDir(ns), `pkg-${latest.version}.amsync`), 'utf8');
    cors(res);
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Package-Version': String(latest.version), 'X-Package-Updated-At': latest.updatedAt, 'X-Package-Device': encodeURIComponent(latest.deviceName) });
    audit({ event: 'pull', ns, version: latest.version });
    res.end(body); return;
  }

  if (req.method === 'GET' && url.pathname === '/packages') {
    const index = loadIndex(ns);
    return json(res, 200, { packages: [...index].reverse().map(({ version, deviceName, size, updatedAt }) => ({ version, deviceName, size, updatedAt })) });
  }

  return json(res, 404, { error: 'not_found' });
});

// Only listen when run as the server (not when invoked for CLI helpers).
if (!process.argv.includes('--create-invite')) {
  server.listen(PORT, HOST, () => console.log(`[sync] answermaker-sync v1.1 listening on ${HOST}:${PORT}, data=${DATA_DIR}`));
}
