/* Sincroniza o localStorage das páginas (chaves "farm_*") com o servidor.
 * As páginas continuam usando localStorage como antes; este script carrega os dados
 * do servidor ao abrir e envia cada alteração de volta. Não precisa alterar o código das páginas. */
(function () {
  'use strict';
  var script = document.currentScript;
  var BASE = new URL(script.src).pathname.replace(/\/assets\/sync\.js$/, '');
  var PREFIX = 'farm_';
  var isFarm = function (k) { return typeof k === 'string' && k.indexOf(PREFIX) === 0; };

  var realSet = Storage.prototype.setItem;
  var realRemove = Storage.prototype.removeItem;
  var realGet = Storage.prototype.getItem;
  var versions = {};   // versão conhecida de cada chave no servidor
  var pending = {};    // k -> {del:bool, v:string}
  var timers = {}, sending = {};
  var blocked = false, user = '', role = '';

  // ---------- carga inicial (síncrona, para as páginas já lerem os dados do servidor) ----------
  var xhr = new XMLHttpRequest();
  xhr.open('GET', BASE + '/api/store', false);
  try { xhr.send(); } catch (e) { return fatal('Sem conexão com o servidor. Verifique a internet e recarregue a página.'); }
  if (xhr.status === 401) { location.replace(BASE + '/login'); return; }
  if (xhr.status !== 200) return fatal('Não foi possível carregar os dados (erro ' + xhr.status + '). Recarregue a página.');
  var data;
  try { data = JSON.parse(xhr.responseText); } catch (e) { return fatal('Resposta inválida do servidor.'); }
  user = data.user || '';
  role = data.role || '';
  // O servidor é a fonte da verdade: descarta qualquer resto local antigo.
  for (var i = localStorage.length - 1; i >= 0; i--) {
    var lk = localStorage.key(i);
    if (isFarm(lk)) realRemove.call(localStorage, lk);
  }
  Object.keys(data.items || {}).forEach(function (k) {
    realSet.call(localStorage, k, data.items[k].v);
    versions[k] = data.items[k].version;
  });

  window.FARM = { user: user, role: role, name: data.name || '', base: BASE };

  // ---------- intercepta gravações ----------
  Storage.prototype.setItem = function (k, v) {
    if (this === window.localStorage && isFarm(k)) {
      realSet.call(this, k, v);
      queue(k, { del: false, v: String(v) });
      return;
    }
    return realSet.apply(this, arguments);
  };
  Storage.prototype.removeItem = function (k) {
    if (this === window.localStorage && isFarm(k)) {
      realRemove.call(this, k);
      queue(k, { del: true, v: '' });
      return;
    }
    return realRemove.apply(this, arguments);
  };

  function queue(k, item) {
    pending[k] = item;
    setStatus('saving');
    clearTimeout(timers[k]);
    timers[k] = setTimeout(function () { flush(k); }, 500);
  }

  function flush(k, unloading) {
    if (blocked || sending[k] || !pending[k]) return;
    var item = pending[k];
    sending[k] = true;
    var body = JSON.stringify({ value: item.v, base: versions[k] || 0 });
    fetch(BASE + '/api/store/' + encodeURIComponent(k), {
      method: item.del ? 'DELETE' : 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      credentials: 'same-origin',
      keepalive: !!unloading && body.length < 60000,
      body: body
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j }; });
    }).then(function (res) {
      sending[k] = false;
      if (res.status === 200) {
        versions[k] = res.j.version;
        if (pending[k] === item) delete pending[k];
        else flush(k); // mudou enquanto enviava
        if (!Object.keys(pending).length) setStatus('saved');
      } else if (res.status === 409) {
        blocked = true;
        banner('conflict', 'Estes dados foram alterados em outro aparelho. Suas últimas alterações NÃO foram salvas. Baixe uma cópia e recarregue a página.');
      } else if (res.status === 401) {
        blocked = true;
        banner('auth', 'Sua sessão expirou. Entre novamente para salvar. Baixe uma cópia das alterações antes de sair.');
      } else {
        retry(k);
      }
    }).catch(function () { sending[k] = false; retry(k); });
  }

  function retry(k) {
    setStatus('offline');
    clearTimeout(timers[k]);
    timers[k] = setTimeout(function () { flush(k); }, 5000);
  }

  window.addEventListener('beforeunload', function (e) {
    var k = Object.keys(pending);
    if (!k.length) return;
    k.forEach(function (key) { clearTimeout(timers[key]); flush(key, true); });
    e.preventDefault();
    e.returnValue = '';
  });

  // ---------- interface: pílula de status e navegação ----------
  var pill, label, bannerEl;
  function setStatus(s) {
    if (!label) return;
    var t = { saving: 'Salvando…', saved: 'Salvo no servidor', offline: 'Sem conexão — tentando de novo…' }[s];
    label.textContent = t || '';
    pill.setAttribute('data-s', s);
  }
  function banner(kind, msg) {
    if (!bannerEl) return;
    bannerEl.style.display = 'block';
    bannerEl.innerHTML = '';
    var span = document.createElement('span'); span.textContent = msg; bannerEl.appendChild(span);
    var dl = document.createElement('button'); dl.textContent = 'Baixar cópia';
    dl.onclick = function () {
      var out = {}; Object.keys(pending).forEach(function (k) { out[k] = pending[k].v; });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
      a.download = 'alteracoes-nao-salvas.json'; a.click();
    };
    bannerEl.appendChild(dl);
    var go = document.createElement('button');
    go.textContent = kind === 'auth' ? 'Entrar' : 'Recarregar';
    go.onclick = function () { pending = {}; kind === 'auth' ? location.assign(BASE + '/login') : location.reload(); };
    bannerEl.appendChild(go);
    setStatus('offline'); label.textContent = 'Não salvo';
  }

  function ui() {
    var css = document.createElement('style');
    css.textContent =
      '#fsync{position:fixed;left:10px;bottom:10px;z-index:99999;display:flex;gap:10px;align-items:center;' +
      'background:#0f4c5c;color:#fff;border-radius:999px;padding:6px 14px;font:12px system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.25)}' +
      '#fsync a,#fsync button{color:#fff;text-decoration:none;opacity:.9;background:none;border:0;font:inherit;cursor:pointer;padding:0}' +
      '#fsync a:hover,#fsync button:hover{text-decoration:underline;opacity:1}' +
      '#fsync [data-l]{padding-left:10px;border-left:1px solid rgba(255,255,255,.35)}' +
      '#fsync[data-s=saving] [data-l]{color:#ffe08a}#fsync[data-s=offline] [data-l]{color:#ffb4b4}' +
      '#fbanner{display:none;position:fixed;left:0;right:0;top:0;z-index:100000;background:#d64545;color:#fff;padding:10px 14px;font:14px system-ui,sans-serif;text-align:center}' +
      '#fbanner button{margin-left:10px;border:0;border-radius:6px;padding:4px 10px;cursor:pointer}' +
      '@media print{#fsync,#fbanner{display:none!important}}';
    document.head.appendChild(css);

    pill = document.createElement('div'); pill.id = 'fsync'; pill.setAttribute('data-s', 'saved');
    var here = location.pathname.replace(/\/+$/, '');
    function link(text, href) { var a = document.createElement('a'); a.textContent = text; a.href = href; if (here === href) a.style.fontWeight = '700'; return a; }
    pill.appendChild(link('Módulos', BASE + '/modulos'));
    pill.appendChild(link('Declarações', BASE + '/declaracao'));
    pill.appendChild(link('Rotinas', BASE + '/rotinas'));
    if (role === 'admin') {
      pill.appendChild(link('Usuários', BASE + '/usuarios'));
      var bk = link('Backup', BASE + '/api/backup'); bk.setAttribute('download', ''); pill.appendChild(bk);
    }
    var out = document.createElement('button'); out.textContent = 'Sair' + (user ? ' (' + user + ')' : '');
    out.onclick = function () {
      if (Object.keys(pending).length && !confirm('Há alterações ainda sendo salvas. Sair mesmo assim?')) return;
      fetch(BASE + '/api/logout', { method: 'POST', headers: { 'X-Requested-With': 'fetch' }, credentials: 'same-origin' })
        .finally(function () { pending = {}; location.assign(BASE + '/login'); });
    };
    pill.appendChild(out);
    label = document.createElement('span'); label.setAttribute('data-l', ''); label.textContent = 'Salvo no servidor';
    pill.appendChild(label);
    document.body.appendChild(pill);
    bannerEl = document.createElement('div'); bannerEl.id = 'fbanner'; document.body.appendChild(bannerEl);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ui); else ui();

  function fatal(msg) {
    document.addEventListener('DOMContentLoaded', function () {
      document.body.innerHTML = '<div style="font:16px system-ui;max-width:480px;margin:15vh auto;padding:20px;text-align:center"><h2>Não foi possível abrir</h2><p>' + msg + '</p><button onclick="location.reload()">Tentar de novo</button></div>';
    });
    // impede que a página use dados locais antigos
    Storage.prototype.getItem = function (k) { return isFarm(k) ? null : realGet.apply(this, arguments); };
  }
})();
