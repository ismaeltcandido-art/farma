(function () {
  'use strict';
  var BASE = new URL(document.currentScript.src).pathname.replace(/\/assets\/usuarios\.js$/, '');
  var $ = function (id) { return document.getElementById(id); };
  var H = { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' };
  var meId = 0, msgT;

  function api(method, url, body) {
    return fetch(BASE + url, { method: method, headers: H, credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined })
      .then(function (r) {
        if (r.status === 401) { location.replace(BASE + '/login'); throw new Error('401'); }
        return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; });
      });
  }
  function toast(t, ok) {
    var m = $('msg'); m.textContent = t; m.className = ok ? 'ok' : 'err'; m.style.display = 'block';
    clearTimeout(msgT); msgT = setTimeout(function () { m.style.display = 'none'; }, 4500);
  }
  function el(tag, props, kids) {
    var e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) { if (k === 'text') e.textContent = props[k]; else if (k === 'class') e.className = props[k]; else e[k] = props[k]; });
    (kids || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }

  function load() {
    api('GET', '/api/users').then(function (r) {
      if (r.status === 403 || !r.ok) { location.replace(BASE + '/modulos'); return; }
      meId = r.j.me;
      var tb = $('rows'); tb.innerHTML = '';
      r.j.users.forEach(function (u) {
        var tr = el('tr', { class: u.active ? '' : 'inactive' });
        tr.appendChild(el('td', { text: u.username + (u.id === meId ? ' (você)' : '') }));
        tr.appendChild(el('td', { class: 'c-name', text: u.name || '—' }));
        tr.appendChild(el('td', {}, [el('span', { class: 'tag ' + u.role, text: u.role === 'admin' ? 'Administrador' : 'Funcionário' })]));
        tr.appendChild(el('td', {}, [el('span', { class: u.active ? '' : 'tag off', text: u.active ? 'Ativo' : 'Desativado' })]));
        var act = el('td', { class: 'act' });
        var bRole = el('button', { class: 'sec', type: 'button', text: u.role === 'admin' ? 'Tornar funcionário' : 'Tornar admin' });
        bRole.onclick = function () { patch(u, { role: u.role === 'admin' ? 'funcionario' : 'admin' }, 'Nível alterado.'); };
        var bPw = el('button', { class: 'sec', type: 'button', text: 'Nova senha' });
        bPw.onclick = function () {
          var pw = window.prompt('Nova senha para "' + u.username + '" (mínimo 8 caracteres):');
          if (pw === null) return;
          patch(u, { password: pw }, 'Senha redefinida.');
        };
        var bAct = el('button', { class: u.active ? 'bad' : 'sec', type: 'button', text: u.active ? 'Desativar' : 'Reativar' });
        bAct.onclick = function () { patch(u, { active: !u.active }, u.active ? 'Usuário desativado.' : 'Usuário reativado.'); };
        if (u.id === meId) { bRole.disabled = true; bAct.disabled = true; }
        [bRole, bPw, bAct].forEach(function (b) { act.appendChild(b); });
        tr.appendChild(act); tb.appendChild(tr);
      });
    }).catch(function () {});
  }
  function patch(u, body, okMsg) {
    api('PATCH', '/api/users/' + u.id, body).then(function (r) {
      if (r.ok) { toast(okMsg, true); load(); } else toast(r.j.error || 'Não foi possível salvar.', false);
    }).catch(function () { toast('Sem conexão com o servidor.', false); });
  }

  $('new').addEventListener('submit', function (e) {
    e.preventDefault();
    api('POST', '/api/users', {
      name: $('n-name').value, username: $('n-user').value, password: $('n-pass').value, role: $('n-role').value
    }).then(function (r) {
      if (r.ok) { toast('Usuário cadastrado.', true); $('new').reset(); load(); }
      else toast(r.j.error || 'Não foi possível cadastrar.', false);
    }).catch(function () { toast('Sem conexão com o servidor.', false); });
  });
  load();
})();
