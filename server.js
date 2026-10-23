/* CampusFlow — ملف واحد: الواجهة + الخادم الحقيقي (حسابات + بحث + رسائل + مكالمات). بدون أي مكتبات.
   التشغيل:  npm start   ثم افتح  http://localhost:3000            */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const DB_FILE = path.join(DATA_DIR, 'data.json');
const MAX = 25 * 1024 * 1024;

const HTML_FILE = path.join(__dirname, 'public', 'index.html');

/* ---------- التخزين (ملف JSON يبقى بعد إعادة التشغيل) ---------- */
let db = { users: {}, state: {}, tokens: {}, inbox: {}, channel: { bio: 'القناة الرسمية للتطبيق', link: 'deeplico', avatar: '', posts: [], subs: [] } };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) {}
db.state = db.state || {};
let timer = null;
function save() { clearTimeout(timer); timer = setTimeout(() => fs.writeFile(DB_FILE + '.tmp', JSON.stringify(db), err => { if (!err) fs.rename(DB_FILE + '.tmp', DB_FILE, () => {}); }), 150); }

/* ---------- أدوات ---------- */
/* الأدمن الموثّق: أي حساب اسمه في هذي القائمة يصير أدمن + علامة توثيق. غيّرها من هنا أو بالمتغير ADMIN_USERS=karrar,ali */
const ADMINS = (process.env.ADMIN_USERS || 'karrar').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
ADMINS.forEach(k => { if (db.users[k]) { db.users[k].admin = true; db.users[k].verified = true; } }); save();
const hash = (p, salt) => crypto.scryptSync(p, salt, 32).toString('hex');
const sockets = {}; /* key -> Set(socket) */
const online = k => !!(sockets[k] && sockets[k].size);
const pub = (u, k) => ({ username: u.username, name: u.name || u.username, verified: u.verified ? 1 : 0, seen: online(k) ? Date.now() : (u.seen || 0), online: online(k) });
const priv = (u, k) => Object.assign(pub(u, k), { email: u.email, admin: u.admin ? 1 : 0 });
const userOf = req => { const h = req.headers.authorization || '', t = h.replace(/^Bearer\s+/i, ''); const k = db.tokens[t]; return k && db.users[k] ? { k, u: db.users[k] } : null; };
const newToken = k => { const t = crypto.randomBytes(24).toString('hex'); db.tokens[t] = k; save(); return t; };
function json(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(b); }
function body(req) { return new Promise((ok, no) => { let n = 0, c = []; req.on('data', d => { n += d.length; if (n > MAX) { req.destroy(); no(new Error('big')); } else c.push(d); }); req.on('end', () => { try { ok(c.length ? JSON.parse(Buffer.concat(c)) : {}); } catch (e) { ok({}); } }); }); }
const validName = n => /^[A-Za-z0-9_.]{3,24}$/.test(n || '');
const validMail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');

/* ---------- إرسال عبر WebSocket ---------- */
function frame(str) {
  const p = Buffer.from(str), n = p.length; let h;
  if (n < 126) h = Buffer.from([0x81, n]); else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(n, 2); } else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([h, p]);
}
function push(k, obj) { const s = sockets[k]; if (!s || !s.size) return false; const f = frame(JSON.stringify(obj)); s.forEach(x => { try { x.write(f); } catch (e) {} }); return true; }
function broadcast(obj) { Object.keys(sockets).forEach(k => push(k, obj)); }

/* ---------- API ---------- */
async function api(req, res, url) {
  const p = url.pathname, q = url.searchParams, m = req.method;
  if (p === '/api/available') { const n = (q.get('u') || '').toLowerCase(); return json(res, 200, { available: validName(q.get('u')) && !db.users[n] }); }
  if (p === '/api/register' && m === 'POST') {
    const b = await body(req), name = String(b.username || '').trim(), em = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
    if (!validName(name) || !validMail(em) || pw.length < 6) return json(res, 400, { error: 'invalid' });
    const k = name.toLowerCase(); if (db.users[k]) return json(res, 409, { error: 'taken' });
    if (Object.values(db.users).some(u => u.email === em)) return json(res, 409, { error: 'email' });
    const first = ADMINS.length ? ADMINS.includes(k) : !Object.keys(db.users).length, salt = crypto.randomBytes(12).toString('hex');
    db.users[k] = { username: name, email: em, salt, pass: hash(pw, salt), verified: first, admin: first, seen: Date.now(), created: Date.now() };
    save(); return json(res, 200, { token: newToken(k), user: priv(db.users[k], k) });
  }
  if (p === '/api/login' && m === 'POST') {
    const b = await body(req), id = String(b.id || '').trim().toLowerCase();
    const k = db.users[id] ? id : Object.keys(db.users).find(x => db.users[x].email === id);
    if (!k) return json(res, 404, { error: 'none' });
    const u = db.users[k]; if (hash(String(b.password || ''), u.salt) !== u.pass) return json(res, 401, { error: 'pass' });
    return json(res, 200, { token: newToken(k), user: priv(u, k) });
  }
  const me = userOf(req); if (!me) return json(res, 401, { error: 'auth' });
  if (p === '/api/search') {
    const s = (q.get('q') || '').toLowerCase().replace(/^@/, '').trim(); if (!s) return json(res, 200, { users: [] });
    const out = Object.keys(db.users).filter(k => k !== me.k && (k.includes(s) || String(db.users[k].name || '').toLowerCase().includes(s)))
      .sort((a, b) => (a.startsWith(s) ? 0 : 1) - (b.startsWith(s) ? 0 : 1) || a.localeCompare(b)).slice(0, 25).map(k => pub(db.users[k], k));
    return json(res, 200, { users: out });
  }
  if (p === '/api/state') {
    if (m === 'PUT') { const b = await body(req); if (b && b.d && typeof b.d === 'object') { db.state[me.k] = { ts: Number(b.ts) || Date.now(), d: b.d }; me.u.name = String((b.d.name || '') + (b.d.last ? ' ' + b.d.last : '')).trim().slice(0, 60) || me.u.username; save(); } return json(res, 200, { ok: 1 }); }
    return json(res, 200, db.state[me.k] || { ts: 0, d: null });
  }
  if (p === '/api/user') { const k = (q.get('u') || '').toLowerCase(); return db.users[k] ? json(res, 200, pub(db.users[k], k)) : json(res, 404, { error: 'none' }); }
  if (p === '/api/me' && m === 'PUT') { const b = await body(req); if (typeof b.name === 'string') me.u.name = b.name.slice(0, 60); save(); return json(res, 200, priv(me.u, me.k)); }
  if (p === '/api/channel') {
    const c = db.channel;
    if (m === 'PUT') { if (!me.u.admin) return json(res, 403, { error: 'admin' }); const b = await body(req); ['bio', 'link', 'avatar'].forEach(f => { if (typeof b[f] === 'string') c[f] = b[f]; }); save(); broadcast({ t: 'chan' }); }
    return json(res, 200, { bio: c.bio, link: c.link, avatar: c.avatar, posts: c.posts, subs: c.subs.length, joined: c.subs.includes(me.k) });
  }
  if (p === '/api/channel/post' && m === 'POST') {
    if (!me.u.admin) return json(res, 403, { error: 'admin' }); const b = await body(req);
    db.channel.posts.push({ t: String(b.t || ''), k: b.k, img: b.img, tm: new Date().toLocaleTimeString('ar', { hour: 'numeric', minute: '2-digit' }) }); save(); broadcast({ t: 'chan' }); return json(res, 200, { ok: 1 });
  }
  if (p === '/api/channel/join' && m === 'POST') { if (!db.channel.subs.includes(me.k)) db.channel.subs.push(me.k); save(); return json(res, 200, { ok: 1 }); }
  if (p === '/api/admin/users') { if (!me.u.admin) return json(res, 403, { error: 'admin' }); return json(res, 200, { users: Object.keys(db.users).map(k => priv(db.users[k], k)) }); }
  if (p === '/api/admin/verify' && m === 'POST') { if (!me.u.admin) return json(res, 403, { error: 'admin' }); const b = await body(req), k = String(b.username || '').toLowerCase(); if (db.users[k]) { db.users[k].verified = !!b.verified; save(); } return json(res, 200, { ok: 1 }); }
  json(res, 404, { error: 'nf' });
}

/* ---------- HTTP ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/health') return json(res, 200, { ok: 1 });
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(fs.readFileSync(HTML_FILE));
  } catch (e) { json(res, 500, { error: 'server' }); }
});

/* ---------- WebSocket (مكتوب يدوياً) ---------- */
server.on('upgrade', (req, sock) => {
  const url = new URL(req.url, 'http://x'), t = url.searchParams.get('token'), k = db.tokens[t];
  if (url.pathname !== '/ws' || !k || !db.users[k] || !req.headers['sec-websocket-key']) return sock.destroy();
  const acc = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  sock.setNoDelay(true); (sockets[k] = sockets[k] || new Set()).add(sock);
  const me = db.users[k]; let buf = Buffer.alloc(0), frag = [];
  /* تسليم الرسائل التي وصلت وهو غير متصل */
  const q = db.inbox[k]; if (q && q.length) { q.forEach(m => sock.write(frame(JSON.stringify(m)))); delete db.inbox[k]; save(); }
  const close = () => { if (sockets[k]) { sockets[k].delete(sock); } me.seen = Date.now(); save(); try { sock.destroy(); } catch (e) {} };
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const fin = buf[0] & 128, op = buf[0] & 15, masked = buf[1] & 128; let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > MAX) return close();
      if (buf.length < off + (masked ? 4 : 0) + len) return;
      let payload = buf.slice(off + (masked ? 4 : 0), off + (masked ? 4 : 0) + len);
      if (masked) { const mk = buf.slice(off, off + 4); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mk[i & 3]; }
      buf = buf.slice(off + (masked ? 4 : 0) + len);
      if (op === 8) return close();
      if (op === 9) { sock.write(Buffer.concat([Buffer.from([0x8A, payload.length]), payload])); continue; }
      if (op === 1 || op === 2 || op === 0) { frag.push(payload); if (fin) { const txt = Buffer.concat(frag).toString(); frag = []; onMsg(k, me, txt); } }
    }
  });
  sock.on('close', close); sock.on('error', close);
});

function onMsg(k, me, txt) {
  let m; try { m = JSON.parse(txt); } catch (e) { return; }
  const to = String(m.to || '').toLowerCase(); if (!to || to === k || !db.users[to]) return;
  if (m.t === 'msg') {
    const out = { t: 'msg', f: k, fn: me.username, text: String(m.text || '').slice(0, 8000), k: m.k, img: m.img, tm: m.tm };
    if (!push(to, out)) { (db.inbox[to] = db.inbox[to] || []).push(out); save(); } /* غير متصل: يُحفظ حتى يدخل */
    return;
  }
  /* إشارات المكالمات: تُمرَّر كما هي للمستقبل إن كان متصلاً */
  if (['inv', 'ack', 'acc', 'dec', 'end', 'sdp', 'ice'].includes(m.t)) { m.f = k; m.fn = me.username; push(to, m); }
}

server.listen(PORT, '0.0.0.0', () => console.log('CampusFlow يعمل على http://localhost:' + PORT));
