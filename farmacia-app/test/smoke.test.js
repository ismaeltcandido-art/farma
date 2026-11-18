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
  assert.ok(!r.body.includes('claude.ai/artifact') && r.body.includes("'declaracao'")); t('rotinas aponta para a declaração do próprio sistema');
  r = await req(port, 'GET', '/farmacia/', { cookie }); assert.strictEqual(r.headers.location, '/farmacia/modulos'); t('/farmacia/ logado -> escolha de módulo');

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


  // ===== níveis de acesso, escolha de módulo, usuários, clientes =====
  r = await req(port, 'GET', '/farmacia/modulos', { cookie }); assert.strictEqual(r.status, 200); assert.ok(r.body.includes('Módulo Rotinas') && r.body.includes('Módulo Declarações') && r.body.includes('/farmacia/assets/modulos.js') && !r.body.includes('__BASE__')); t('tela de escolha de módulo');
  r = await req(port, 'GET', '/farmacia/modulos'); assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.location, '/farmacia/login'); t('módulos exige login');
  r = await req(port, 'GET', '/farmacia/login', { cookie }); assert.strictEqual(r.headers.location, '/farmacia/modulos'); t('login com sessão -> módulos');
  r = await req(port, 'POST', '/farmacia/api/login', { body: { username: 'farma', password: 'senha-de-teste-123' }, headers: XR }); assert.strictEqual(JSON.parse(r.body).role, 'admin'); t('usuário inicial é admin');
  r = await req(port, 'GET', '/farmacia/api/me', { cookie }); assert.strictEqual(JSON.parse(r.body).role, 'admin'); t('/api/me');
  r = await req(port, 'GET', '/farmacia/usuarios', { cookie }); assert.strictEqual(r.status, 200); t('admin abre /usuarios');
  r = await req(port, 'GET', '/farmacia/assets/usuarios.js', { cookie }); assert.strictEqual(r.status, 200); t('asset usuarios.js');

  r = await req(port, 'POST', '/farmacia/api/users', { body: { username: 'maria', password: 'curta', role: 'funcionario' }, cookie, headers: XR }); assert.strictEqual(r.status, 400); t('senha curta recusada');
  r = await req(port, 'POST', '/farmacia/api/users', { body: { username: 'Ma ria', password: 'senha-maria-1' }, cookie, headers: XR }); assert.strictEqual(r.status, 400); t('login inválido recusado');
  r = await req(port, 'POST', '/farmacia/api/users', { body: { username: 'maria', password: 'senha-maria-1', role: 'chefe' }, cookie, headers: XR }); assert.strictEqual(r.status, 400); t('nível inválido recusado');
  r = await req(port, 'POST', '/farmacia/api/users', { body: { username: 'maria', password: 'senha-maria-1', name: 'Maria Silva' }, cookie }); assert.strictEqual(r.status, 403); t('criar usuário sem CSRF = 403');
  r = await req(port, 'POST', '/farmacia/api/users', { body: { username: 'Maria', password: 'senha-maria-1', name: 'Maria Silva' }, cookie, headers: XR }); assert.strictEqual(r.status, 201); t('admin cadastra funcionário (padrão)');
  r = await req(port, 'POST', '/farmacia/api/users', { body: { username: 'maria', password: 'senha-maria-1' }, cookie, headers: XR }); assert.strictEqual(r.status, 409); t('usuário duplicado = 409');

  r = await req(port, 'POST', '/farmacia/api/login', { body: { username: 'maria', password: 'senha-maria-1' }, headers: XR }); assert.strictEqual(r.status, 200); assert.strictEqual(JSON.parse(r.body).role, 'funcionario');
  const fc = r.headers['set-cookie'][0].split(';')[0]; t('funcionário faz login');
  r = await req(port, 'GET', '/farmacia/modulos', { cookie: fc }); assert.strictEqual(r.status, 200); t('funcionário vê escolha de módulo');
  r = await req(port, 'GET', '/farmacia/rotinas', { cookie: fc }); assert.strictEqual(r.status, 200); r = await req(port, 'GET', '/farmacia/declaracao', { cookie: fc }); assert.strictEqual(r.status, 200); t('funcionário acessa Rotinas e Declarações');
  r = await req(port, 'GET', '/farmacia/usuarios', { cookie: fc }); assert.strictEqual(r.status, 302); assert.strictEqual(r.headers.location, '/farmacia/modulos'); t('funcionário NÃO abre /usuarios');
  r = await req(port, 'GET', '/farmacia/api/users', { cookie: fc }); assert.strictEqual(r.status, 403); t('funcionário NÃO lista usuários');
  r = await req(port, 'POST', '/farmacia/api/users', { body: { username: 'x1x', password: 'senha-x-12345', role: 'admin' }, cookie: fc, headers: XR }); assert.strictEqual(r.status, 403); t('funcionário NÃO cria usuário');
  r = await req(port, 'PATCH', '/farmacia/api/users/1', { body: { role: 'funcionario' }, cookie: fc, headers: XR }); assert.strictEqual(r.status, 403); t('funcionário NÃO altera níveis');
  r = await req(port, 'GET', '/farmacia/api/backup', { cookie: fc }); assert.strictEqual(r.status, 403); t('funcionário NÃO baixa backup completo');
  r = await req(port, 'GET', '/farmacia/api/store', { cookie: fc }); const ds = JSON.parse(r.body); assert.strictEqual(ds.role, 'funcionario'); assert.strictEqual(ds.name, 'Maria Silva'); t('funcionário usa os dados normalmente');
  r = await req(port, 'PUT', '/farmacia/api/store/farm_rot', { body: { value: '{"b":1}', base: 2 }, cookie: fc, headers: XR }); assert.strictEqual(r.status, 200); t('funcionário grava registros');

  // troca da própria senha
  r = await req(port, 'POST', '/farmacia/api/me/password', { body: { current: 'errada', password: 'nova-senha-maria' }, cookie: fc, headers: XR }); assert.strictEqual(r.status, 400); t('trocar senha exige a senha atual');
  r = await req(port, 'POST', '/farmacia/api/me/password', { body: { current: 'senha-maria-1', password: 'curta' }, cookie: fc, headers: XR }); assert.strictEqual(r.status, 400); t('nova senha curta recusada');
  r = await req(port, 'POST', '/farmacia/api/me/password', { body: { current: 'senha-maria-1', password: 'nova-senha-maria' }, cookie: fc, headers: XR }); assert.strictEqual(r.status, 200); t('funcionário troca a própria senha');
  r = await req(port, 'POST', '/farmacia/api/login', { body: { username: 'maria', password: 'senha-maria-1' }, headers: XR }); assert.strictEqual(r.status, 401);
  r = await req(port, 'POST', '/farmacia/api/login', { body: { username: 'maria', password: 'nova-senha-maria' }, headers: XR }); assert.strictEqual(r.status, 200); t('senha antiga deixa de valer, a nova vale');

  // admin gerencia
  r = await req(port, 'GET', '/farmacia/api/users', { cookie }); const lu = JSON.parse(r.body); const maria = lu.users.find(u => u.username === 'maria'); const farma = lu.users.find(u => u.username === 'farma');
  assert.ok(maria && farma && !JSON.stringify(lu).includes('hash')); t('lista de usuários sem hashes');
  r = await req(port, 'PATCH', '/farmacia/api/users/' + farma.id, { body: { role: 'funcionario' }, cookie, headers: XR }); assert.strictEqual(r.status, 400); t('admin não rebaixa a si mesmo');
  r = await req(port, 'PATCH', '/farmacia/api/users/' + farma.id, { body: { active: false }, cookie, headers: XR }); assert.strictEqual(r.status, 400); t('admin não desativa a si mesmo');
  r = await req(port, 'PATCH', '/farmacia/api/users/' + maria.id, { body: { password: 'redefinida-123' }, cookie, headers: XR }); assert.strictEqual(r.status, 200); t('admin redefine senha');
  r = await req(port, 'POST', '/farmacia/api/login', { body: { username: 'maria', password: 'redefinida-123' }, headers: XR }); assert.strictEqual(r.status, 200); const fc2 = r.headers['set-cookie'][0].split(';')[0]; t('login com senha redefinida');
  r = await req(port, 'PATCH', '/farmacia/api/users/' + maria.id, { body: { role: 'admin' }, cookie, headers: XR }); assert.strictEqual(r.status, 200);
  r = await req(port, 'GET', '/farmacia/usuarios', { cookie: fc2 }); assert.strictEqual(r.status, 200); t('promover a admin vale na hora');
  r = await req(port, 'PATCH', '/farmacia/api/users/' + maria.id, { body: { role: 'funcionario' }, cookie, headers: XR }); assert.strictEqual(r.status, 200);
  r = await req(port, 'PATCH', '/farmacia/api/users/' + maria.id, { body: { active: false }, cookie, headers: XR }); assert.strictEqual(r.status, 200);
  r = await req(port, 'GET', '/farmacia/api/store', { cookie: fc2 }); assert.strictEqual(r.status, 401); t('usuário desativado perde o acesso na hora (sessão aberta)');
  r = await req(port, 'GET', '/farmacia/login', { cookie: fc2 }); assert.strictEqual(r.status, 200); t('sessão de desativado não entra em loop de redirecionamento');
  r = await req(port, 'POST', '/farmacia/api/login', { body: { username: 'maria', password: 'redefinida-123' }, headers: XR }); assert.strictEqual(r.status, 401); t('usuário desativado não consegue logar');
  r = await req(port, 'PATCH', '/farmacia/api/users/' + maria.id, { body: { active: true }, cookie, headers: XR }); assert.strictEqual(r.status, 200); t('reativar usuário');
  r = await req(port, 'PATCH', '/farmacia/api/users/9999', { body: { active: true }, cookie, headers: XR }); assert.strictEqual(r.status, 404); t('usuário inexistente = 404');

  // último admin protegido por outro admin ativo
  r = await req(port, 'POST', '/farmacia/api/users', { body: { username: 'chefe', password: 'senha-chefe-123', role: 'admin' }, cookie, headers: XR }); assert.strictEqual(r.status, 201);
  r = await req(port, 'POST', '/farmacia/api/login', { body: { username: 'chefe', password: 'senha-chefe-123' }, headers: XR }); const ac = r.headers['set-cookie'][0].split(';')[0];
  r = await req(port, 'PATCH', '/farmacia/api/users/' + farma.id, { body: { active: false }, cookie: ac, headers: XR }); assert.strictEqual(r.status, 200); t('outro admin pode desativar um admin (há mais de um)');
  r = await req(port, 'GET', '/farmacia/api/store', { cookie }); assert.strictEqual(r.status, 401);
  const chefe = JSON.parse((await req(port, 'GET', '/farmacia/api/users', { cookie: ac })).body).users.find(u => u.username === 'chefe');
  r = await req(port, 'PATCH', '/farmacia/api/users/' + farma.id, { body: { active: true, role: 'funcionario' }, cookie: ac, headers: XR }); assert.strictEqual(r.status, 200);
  r = await req(port, 'PATCH', '/farmacia/api/users/' + farma.id, { body: { role: 'admin' }, cookie: ac, headers: XR }); assert.strictEqual(r.status, 200);

  // cadastro de clientes
  r = await req(port, 'GET', '/farmacia/api/clientes?q=jo', { cookie: fc }); assert.strictEqual(JSON.parse(r.body).clientes.length, 0); t('banco de clientes começa vazio');
  r = await req(port, 'POST', '/farmacia/api/clientes', { body: { nome: 'João da Silva', nasc: '1950-03-02', doc: '123.456.789-09', tel: '(19) 99999-1111', endereco: 'Rua A, 10' }, cookie: fc }); assert.strictEqual(r.status, 403); t('cliente: gravar sem CSRF = 403');
  r = await req(port, 'POST', '/farmacia/api/clientes', { body: { nome: 'J' }, cookie: fc, headers: XR }); assert.strictEqual(r.status, 400); t('cliente: nome obrigatório');
  r = await req(port, 'POST', '/farmacia/api/clientes', { body: { nome: 'João da Silva', nasc: '02/03/1950' }, cookie: fc, headers: XR }); assert.strictEqual(r.status, 400); t('cliente: nascimento inválido');
  r = await req(port, 'POST', '/farmacia/api/clientes', { body: { nome: 'João da Silva', nasc: '1950-03-02', doc: '123.456.789-09', tel: '(19) 99999-1111', endereco: 'Rua A, 10' }, cookie: fc, headers: XR }); assert.strictEqual(r.status, 200); const cid = JSON.parse(r.body).id; t('funcionário guarda cliente');
  r = await req(port, 'GET', '/farmacia/api/clientes?q=' + encodeURIComponent('joao'), { cookie: fc }); let cl = JSON.parse(r.body).clientes; assert.strictEqual(cl.length, 1); assert.strictEqual(cl[0].nome, 'João da Silva'); assert.strictEqual(cl[0].endereco, 'Rua A, 10'); t('busca por nome ignora acento e maiúsculas');
  r = await req(port, 'GET', '/farmacia/api/clientes?q=' + encodeURIComponent('12345678909'), { cookie: fc }); assert.strictEqual(JSON.parse(r.body).clientes.length, 1); t('busca por CPF (só números)');
  r = await req(port, 'GET', '/farmacia/api/clientes?q=99999', { cookie: fc }); assert.strictEqual(JSON.parse(r.body).clientes.length, 1); t('busca por telefone');
  r = await req(port, 'POST', '/farmacia/api/clientes', { body: { nome: 'João da Silva Neto', nasc: '1950-03-02', doc: '12345678909', tel: '(19) 98888-0000', endereco: 'Rua B, 20' }, cookie: ac, headers: XR }); assert.strictEqual(JSON.parse(r.body).id, cid);
  r = await req(port, 'GET', '/farmacia/api/clientes?q=joao', { cookie: fc }); cl = JSON.parse(r.body).clientes; assert.strictEqual(cl.length, 1); assert.strictEqual(cl[0].tel, '(19) 98888-0000'); t('mesmo CPF atualiza o cadastro (sem duplicar)');
  r = await req(port, 'POST', '/farmacia/api/clientes', { body: { nome: 'Ana Lima', nasc: '2015-01-10', resp: 'Paula Lima' }, cookie: fc, headers: XR }); const aid = JSON.parse(r.body).id;
  r = await req(port, 'POST', '/farmacia/api/clientes', { body: { nome: 'ANA  lima', nasc: '2015-01-10', resp: 'Paula Lima' }, cookie: fc, headers: XR }); assert.strictEqual(JSON.parse(r.body).id, aid); t('sem CPF: mesmo nome+nascimento não duplica');
  r = await req(port, 'GET', '/farmacia/api/clientes?q=a', { cookie: fc }); assert.strictEqual(JSON.parse(r.body).clientes.length, 0); t('busca exige ao menos 2 letras');
  r = await req(port, 'GET', '/farmacia/api/clientes?q=ana', { cookie }); assert.strictEqual(JSON.parse(r.body).clientes[0].resp, 'Paula Lima'); t('responsável do menor é guardado');
  r = await req(port, 'GET', '/farmacia/api/clientes?q=joao'); assert.strictEqual(r.status, 401); t('clientes exige login');
  r = await req(port, 'DELETE', '/farmacia/api/clientes/' + cid, { cookie: fc, headers: XR }); assert.strictEqual(r.status, 403); t('funcionário NÃO remove cliente');
  r = await req(port, 'DELETE', '/farmacia/api/clientes/' + cid, { cookie: ac, headers: XR }); assert.strictEqual(r.status, 200);
  r = await req(port, 'GET', '/farmacia/api/clientes?q=joao', { cookie: fc }); assert.strictEqual(JSON.parse(r.body).clientes.length, 0); t('admin remove cliente (LGPD)');

  // páginas de declaração trazem as novas opções
  r = await req(port, 'GET', '/farmacia/declaracao', { cookie: fc }); assert.ok(r.body.includes('id="prevBtn"') && r.body.includes('id="cliAut"') && r.body.includes('id="driveOn"') && r.body.includes('1qURKtaIodrd_x1oVE0Brbe6mnq2CjuFu')); t('declaração: prévia opcional, cadastro de clientes e Drive presentes');

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
