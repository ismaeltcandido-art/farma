'use strict';
// Teste de fumaça com banco em memória (DB_DRIVER=memory). Rode: npm test
const assert = require('assert');
const http = require('http');
const { createApp } = require('../core');

function req(port, method, path, { body, cookie, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path,
      headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const XR = { 'X-Requested-With': 'fetch' };

(async () => {
  // porta vinda do ambiente: 0 = sorteia uma livre; prova que o servidor lê env.PORT
  const env = { PORT: '0', BASE_PATH: '/farmacia', NODE_ENV: 'production', SESSION_SECRET: 'x'.repeat(48),
    DB_DRIVER: 'memory', ADMIN_USER: 'Farma', ADMIN_PASSWORD: 'senha-de-teste-123' };
  const app = createApp(env); const srv = await app.start(); const port = srv.address().port;
  const t = (n) => console.log('ok -', n);

  // produção sem SESSION_SECRET deve falhar
  assert.throws(() => createApp({ ...env, SESSION_SECRET: '' }), /SESSION_SECRET/); t('exige SESSION_SECRET em produção');

  let r = await req(port, 'GET', '/'); assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.location, '/farmacia/'); t('raiz redireciona para /farmacia/');
  r = await req(port, 'GET', '/outra'); assert.strictEqual(r.status, 404); t('fora do base path = 404');
  r = await req(port, 'GET', '/farmacia/health'); assert.strictEqual(r.status, 200); t('health');
  r = await req(port, 'GET', '/farmacia/declaracao'); assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.location, '/farmacia/login'); t('página protegida redireciona para login');
  r = await req(port, 'GET', '/farmacia/api/store'); assert.strictEqual(r.status, 401); t('API protegida 401');
  r = await req(port, 'GET', '/farmacia/login'); assert.strictEqual(r.status, 200); assert.ok(r.body.includes('/farmacia/assets/login.js')); t('login serve página com base path');
  r = await req(port, 'GET', '/farmacia/assets/sync.js'); assert.strictEqual(r.status, 200); t('asset sync.js');
  r = await req(port, 'GET', '/farmacia/assets/../server.js'); assert.notStrictEqual(r.status, 200); assert.ok(!r.body.includes('createApp')); t('sem path traversal');

  // login
  r = await req(port, 'POST', '/farmacia/api/login', { body: { username: 'farma', password: 'errada' }, headers: XR }); assert.strictEqual(r.status, 401); t('senha errada 401');
  r = await req(port, 'POST', '/farmacia/api/login', { body: { username: 'farma', password: 'senha-de-teste-123' } }); assert.strictEqual(r.status, 403); t('login sem cabeçalho CSRF bloqueado');
  r = await req(port, 'POST', '/farmacia/api/login', { body: { username: 'FARMA', password: 'senha-de-teste-123' }, headers: XR });
  assert.strictEqual(r.status, 200); const sc = r.headers['set-cookie'][0];
  assert.ok(/HttpOnly/.test(sc) && /Secure/.test(sc) && /SameSite=Lax/.test(sc)); t('login ok, cookie HttpOnly+Secure+SameSite');
  const cookie = sc.split(';')[0];

  r = await req(port, 'GET', '/farmacia/declaracao', { cookie }); assert.strictEqual(r.status, 200); assert.ok(r.body.includes('/farmacia/assets/sync.js') && !r.body.includes('__BASE__')); t('declaracao com sync.js e base path');
  r = await req(port, 'GET', '/farmacia/rotinas', { cookie }); assert.strictEqual(r.status, 200); assert.ok(r.body.includes('/farmacia/assets/sync.js')); t('rotinas');
  assert.ok(!r.body.includes('claude.ai/artifact')); assert.ok(r.body.includes('href="/farmacia/declaracao"')); t('rotinas aponta para a declaração do próprio sistema');
  r = await req(port, 'GET', '/farmacia/', { cookie }); assert.strictEqual(r.headers.location, '/farmacia/declaracao'); t('/farmacia/ logado -> declaracao');

  // API de dados
  r = await req(port, 'PUT', '/farmacia/api/store/farm_rot', { body: { value: '{"a":1}', base: 0 }, cookie }); assert.strictEqual(r.status, 403); t('PUT sem CSRF = 403');
  r = await req(port, 'PUT', '/farmacia/api/store/farm_rot', { body: { value: '{"a":1}', base: 0 }, cookie, headers: XR }); assert.strictEqual(r.status, 200); assert.strictEqual(JSON.parse(r.body).version, 1); t('PUT cria v1');
  r = await req(port, 'PUT', '/farmacia/api/store/farm_rot', { body: { value: '{"a":2}', base: 1 }, cookie, headers: XR }); assert.strictEqual(JSON.parse(r.body).version, 2); t('PUT atualiza v2');
  r = await req(port, 'PUT', '/farmacia/api/store/farm_rot', { body: { value: '{"a":3}', base: 1 }, cookie, headers: XR }); assert.strictEqual(r.status, 409); t('versão antiga = 409 (conflito)');
  r = await req(port, 'PUT', '/farmacia/api/store/outra_chave', { body: { value: 'x', base: 0 }, cookie, headers: XR }); assert.strictEqual(r.status, 400); t('chave fora do padrão farm_* = 400');
  const big = 'A'.repeat(3 * 1024 * 1024);
  r = await req(port, 'PUT', '/farmacia/api/store/farm_logo', { body: { value: big, base: 0 }, cookie, headers: XR }); assert.strictEqual(r.status, 200); t('aceita valor de 3MB (logo/assinatura)');
  r = await req(port, 'GET', '/farmacia/api/store', { cookie }); const d = JSON.parse(r.body);
  assert.strictEqual(d.items.farm_rot.v, '{"a":2}'); assert.strictEqual(d.items.farm_rot.version, 2); assert.strictEqual(d.user, 'farma'); t('GET devolve os dados');
  r = await req(port, 'GET', '/farmacia/api/backup', { cookie }); assert.ok(/attachment/.test(r.headers['content-disposition'])); assert.strictEqual(JSON.parse(r.body).items.farm_rot, '{"a":2}'); t('backup JSON');
  r = await req(port, 'DELETE', '/farmacia/api/store/farm_logo', { body: { base: 1 }, cookie, headers: XR }); assert.strictEqual(r.status, 200); t('DELETE');

  // cookie adulterado
  r = await req(port, 'GET', '/farmacia/api/store', { cookie: cookie.slice(0, -3) + 'abc' }); assert.strictEqual(r.status, 401); t('cookie adulterado rejeitado');

  // limitador de tentativas
  for (let i = 0; i < 5; i++) await req(port, 'POST', '/farmacia/api/login', { body: { username: 'ze', password: 'x' }, headers: XR });
  r = await req(port, 'POST', '/farmacia/api/login', { body: { username: 'ze', password: 'x' }, headers: XR }); assert.strictEqual(r.status, 429); t('limite de tentativas = 429');

  r = await req(port, 'POST', '/farmacia/api/logout', { cookie, headers: XR }); assert.ok(/Max-Age=0/.test(r.headers['set-cookie'][0])); t('logout');

  await app.stop();

  // BASE_PATH vazio (subdomínio)
  const app2 = createApp({ ...env, BASE_PATH: '', ADMIN_USER: '' }); const s2 = await app2.start(); const p2 = s2.address().port;
  r = await req(p2, 'GET', '/login'); assert.strictEqual(r.status, 200); t('BASE_PATH vazio funciona (subdomínio)');
  await app2.stop();
  console.log('\nTODOS OS TESTES PASSARAM');
})().catch(e => { console.error('FALHOU:', e); process.exit(1); });
