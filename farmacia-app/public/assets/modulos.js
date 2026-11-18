(function () {
  'use strict';
  var BASE = new URL(document.currentScript.src).pathname.replace(/\/assets\/modulos\.js$/, '');
  var $ = function (id) { return document.getElementById(id); };
  var H = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };
  var username = '';

  function api(method, url, body) {
    return fetch(BASE + url, { method: method, headers: H, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        if (r.status === 401) { location.replace(BASE + '/login'); throw new Error('401'); }
        return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; });
      });
  }

  // Preferência (só neste navegador): ver ou não a prévia da declaração.
  function prefKey() { return 'pref_preview_' + username; }
  function getPref() { try { return localStorage.getItem(prefKey()) !== '0'; } catch (e) { return true; } }
  function setPref(on) { try { localStorage.setItem(prefKey(), on ? '1' : '0'); } catch (e) {} }

  api('GET', '/api/me').then(function (r) {
    var u = r.j; username = u.username;
    $('who').textContent = u.name || u.username;
    var role = $('role'); role.hidden = false; role.textContent = u.role === 'admin' ? 'Administrador' : 'Funcionário';
    if (u.role === 'admin') $('c-usr').hidden = false;
    $('prev').checked = getPref();
  }).catch(function () {});

  $('prev').addEventListener('change', function () { setPref(this.checked); });

  $('btn-out').addEventListener('click', function () {
    api('POST', '/api/logout').then(function () { location.assign(BASE + '/login'); }).catch(function () { location.assign(BASE + '/login'); });
  });

  var pw = $('pw'), msg = $('msg');
  function say(t, cls) { msg.textContent = t; msg.className = cls || ''; }
  $('btn-pw').addEventListener('click', function () { pw.style.display = 'block'; say(''); $('p0').focus(); });
  $('pw-x').addEventListener('click', function () { pw.style.display = 'none'; pw.reset(); say(''); });
  pw.addEventListener('submit', function (e) {
    e.preventDefault();
    if ($('p1').value !== $('p2').value) return say('As senhas novas não são iguais.', 'err');
    api('POST', '/api/me/password', { current: $('p0').value, password: $('p1').value }).then(function (r) {
      if (r.ok) { pw.reset(); say('Senha alterada com sucesso.', 'ok'); }
      else say(r.j.error || 'Não foi possível alterar a senha.', 'err');
    }).catch(function () { say('Sem conexão com o servidor.', 'err'); });
  });
})();
