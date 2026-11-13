'use strict';
/**
 * Farmavip Dr Trajano - servidor do sistema de serviços farmacêuticos.
 *
 * - Porta lida de process.env.PORT (nunca fixa no código; 3000 só como padrão local).
 * - Caminho base configurável por BASE_PATH (ex.: /farmacia -> https://projetoisma.com/farmacia).
 * - Banco MySQL (mysql2). Para testes: DB_DRIVER=memory.
 * - Sem framework: apenas módulos nativos do Node + mysql2.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createDb } = require('./db');

// ---------- configuração ----------
function loadDotEnv(file) {
  // Leitura simples de .env para uso LOCAL (na Hostinger as variáveis vêm do painel).
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !m[1].startsWith('#') && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (_) { /* sem .env: ok */ }
}

function normalizeBase(b) {
  b = (b === undefined ? '/farmacia' : String(b)).trim();
  if (b === '' || b === '/') return '';
  if (!b.startsWith('/')) b = '/' + b;
  return b.replace(/\/+$/, '');
}

const SESSION_COOKIE = 'farm_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 horas
const MAX_BODY = 8 * 1024 * 1024;            // logo/assinatura em base64 podem ser grandes
const KEY_RE = /^farm_[a-z0-9_]{1,60}$/;

// ---------- utilitários ----------
function b64u(buf) { return Buffer.from(buf).toString('base64url'); }

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384;
  const hash = crypto.scryptSync(password, salt, 64, { N });
  return `scrypt$${N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
  try {
    const [alg, N, saltHex, hashHex] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, { N: Number(N) });
    return crypto.timingSafeEqual(expected, actual);
  } catch (_) { return false; }
}

function sign(secret, payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function unsign(secret, token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.indexOf('.');
  if (i < 1) return null;
  const body = token.slice(0, i), sig = token.slice(i + 1);
  const exp = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch (_) { return null; }
}

function parseCookies(h) {
  const out = {};
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Corpo muito grande'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { throw Object.assign(new Error('JSON inválido'), { status: 400 }); }
}

// ---------- aplicação ----------
function createApp(env = process.env) {
  const BASE = normalizeBase(env.BASE_PATH);
  const isProd = env.NODE_ENV === 'production';
  let SECRET = env.SESSION_SECRET;
  if (!SECRET) {
    if (isProd) throw new Error('SESSION_SECRET não definido. Cadastre a variável de ambiente antes de iniciar em produção.');
    SECRET = crypto.randomBytes(32).toString('hex'); // dev: sessões não sobrevivem a reinício
  }
  const db = createDb(env);

  const VIEWS = path.join(__dirname, 'views');
  const ASSETS = path.join(__dirname, 'public', 'assets');
  const templateCache = new Map();
  function template(name) {
    if (!templateCache.has(name)) {
      templateCache.set(name, fs.readFileSync(path.join(VIEWS, name), 'utf8').replace(/__BASE__/g, BASE));
    }
    return templateCache.get(name);
  }

  // limitador simples de tentativas de login (memória do processo)
  const attempts = new Map();
  const MAX_ATTEMPTS = 5, WINDOW_MS = 15 * 60 * 1000;
  function throttled(key) {
    const now = Date.now(); const a = attempts.get(key);
    if (!a || now - a.first > WINDOW_MS) return false;
    return a.n >= MAX_ATTEMPTS;
  }
  function failAttempt(key) {
    const now = Date.now(); const a = attempts.get(key);
    if (!a || now - a.first > WINDOW_MS) attempts.set(key, { n: 1, first: now }); else a.n++;
  }
  const gc = setInterval(() => { const now = Date.now(); for (const [k, a] of attempts) if (now - a.first > WINDOW_MS) attempts.delete(k); }, 10 * 60 * 1000);
  gc.unref();

  function clientIp(req) {
    // Atrás do proxy da Hostinger o IP real vem em X-Forwarded-For.
    const xf = req.headers['x-forwarded-for'];
    return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || 'ip';
  }

  function securityHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    if (isProd) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }

  function send(res, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
    res.writeHead(status, { 'Content-Type': type, ...extra });
    res.end(body);
  }
  const json = (res, status, obj, extra) => send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8', extra);
  const redirect = (res, loc) => { res.writeHead(302, { Location: loc }); res.end(); };

  function sessionCookie(token, maxAgeSec) {
    return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=${BASE || '/'}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}` + (isProd ? '; Secure' : '');
  }
  function getSession(req) {
    const t = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return unsign(SECRET, t);
  }
  // Proteção CSRF: escritas exigem cabeçalho customizado (navegadores não o enviam em formulários cross-site).
  function csrfOk(req) { return req.headers['x-requested-with'] === 'fetch'; }

  async function handler(req, res) {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    let p = url.pathname;

    // Raiz do domínio -> caminho base
    if (BASE && (p === '/' || p === '')) return redirect(res, BASE + '/');
    if (BASE) {
      if (p === BASE) return redirect(res, BASE + '/');
      if (!p.startsWith(BASE + '/')) return send(res, 404, 'Não encontrado');
      p = p.slice(BASE.length);
    }
    if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
    if (p === '') p = '/';
    const method = req.method;

    // ----- públicos -----
    if (p === '/health' && method === 'GET') {
      try { await db.ping(); return json(res, 200, { ok: true }); }
      catch (_) { return json(res, 503, { ok: false }); }
    }
    if (p === '/login' && method === 'GET') {
      if (getSession(req)) return redirect(res, BASE + '/declaracao');
      return send(res, 200, template('login.html'), 'text/html; charset=utf-8');
    }
    if (p === '/api/login' && method === 'POST') {
      if (!csrfOk(req)) return json(res, 403, { error: 'Requisição inválida' });
      const body = await readJson(req);
      const username = String(body.username || '').trim().toLowerCase().slice(0, 60);
      const password = String(body.password || '').slice(0, 200);
      const key = clientIp(req) + '|' + username;
      if (throttled(key)) return json(res, 429, { error: 'Muitas tentativas. Aguarde 15 minutos.' });
      const user = username ? await db.getUser(username) : null;
      // verifica sempre (mesmo sem usuário) para não revelar quais usuários existem pelo tempo de resposta
      const ok = verifyPassword(password, user ? user.password_hash : 'scrypt$16384$00$00') && !!user;
      if (!ok) { failAttempt(key); return json(res, 401, { error: 'Usuário ou senha incorretos' }); }
      attempts.delete(key);
      const token = sign(SECRET, { uid: user.id, u: user.username, exp: Date.now() + SESSION_TTL_MS });
      return json(res, 200, { ok: true, user: user.username }, { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
    }
    if (p === '/api/logout' && method === 'POST') {
      return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    }
    if (p.startsWith('/assets/') && method === 'GET') {
      const name = path.basename(p);
      const allowed = { 'sync.js': 'application/javascript; charset=utf-8', 'login.js': 'application/javascript; charset=utf-8' };
      if (!allowed[name] || p !== '/assets/' + name) return send(res, 404, 'Não encontrado');
      return send(res, 200, fs.readFileSync(path.join(ASSETS, name)), allowed[name]);
    }

    // ----- autenticados -----
    const sess = getSession(req);
    if (!sess) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'Sessão expirada' });
      return redirect(res, BASE + '/login');
    }

    if (p === '/') return redirect(res, BASE + '/declaracao');
    if ((p === '/declaracao' || p === '/rotinas') && method === 'GET') {
      return send(res, 200, template(p.slice(1) + '.html'), 'text/html; charset=utf-8');
    }

    if (p === '/api/store' && method === 'GET') {
      return json(res, 200, { user: sess.u, items: await db.getAll() });
    }
    if (p === '/api/backup' && method === 'GET') {
      const all = await db.getAll();
      const out = { exportedAt: new Date().toISOString(), items: Object.fromEntries(Object.entries(all).map(([k, r]) => [k, r.v])) };
      const stamp = new Date().toISOString().slice(0, 10);
      return send(res, 200, JSON.stringify(out), 'application/json; charset=utf-8',
        { 'Content-Disposition': `attachment; filename="farmacia-backup-${stamp}.json"` });
    }
    const m = p.match(/^\/api\/store\/([^/]+)$/);
    if (m && (method === 'PUT' || method === 'DELETE')) {
      if (!csrfOk(req)) return json(res, 403, { error: 'Requisição inválida' });
      const key = m[1];
      if (!KEY_RE.test(key)) return json(res, 400, { error: 'Chave inválida' });
      const body = await readJson(req);
      const base = Number.isInteger(body.base) && body.base >= 0 ? body.base : 0;
      let r;
      if (method === 'PUT') {
        if (typeof body.value !== 'string') return json(res, 400, { error: 'Valor inválido' });
        r = await db.put(key, body.value, base, sess.uid);
      } else {
        r = await db.del(key, base);
      }
      if (!r.ok) return json(res, 409, { error: 'Conflito: os dados foram alterados em outro aparelho', current: r.current });
      return json(res, 200, { ok: true, version: r.version });
    }

    return send(res, 404, 'Não encontrado');
  }

  const server = http.createServer((req, res) => {
    handler(req, res).catch(err => {
      const status = err.status || 500;
      if (status === 500) console.error('[erro]', err);
      if (!res.headersSent) json(res, status, { error: status === 500 ? 'Erro interno' : err.message });
      else res.end();
    });
  });

  async function seedAdmin() {
    const u = String(env.ADMIN_USER || '').trim().toLowerCase();
    const pw = env.ADMIN_PASSWORD;
    if (!u || !pw) return;
    if (await db.countUsers() === 0) {
      if (pw.length < 10) throw new Error('ADMIN_PASSWORD deve ter pelo menos 10 caracteres');
      await db.createUser(u, hashPassword(pw));
      console.log(`[setup] usuário inicial "${u}" criado. Remova ADMIN_PASSWORD das variáveis de ambiente.`);
    }
  }

  async function start() {
    await db.init();
    await seedAdmin();
    const port = Number(env.PORT || 3000);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, resolve); });
    console.log(`[ok] Farmácia no ar: porta ${server.address().port}, caminho base "${BASE || '/'}"`);
    return server;
  }

  async function stop() {
    await new Promise(r => server.close(r));
    await db.close();
  }

  return { server, start, stop, db, BASE };
}

module.exports = { createApp, hashPassword, verifyPassword };

if (require.main === module) {
  loadDotEnv(path.join(__dirname, '.env'));
  let app;
  try { app = createApp(process.env); } catch (e) { console.error('[falha]', e.message); process.exit(1); }
  app.start().catch(e => { console.error('[falha ao iniciar]', e.message); process.exit(1); });
  const shutdown = () => app.stop().finally(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
