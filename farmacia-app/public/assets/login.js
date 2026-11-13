(function () {
  'use strict';
  var BASE = new URL(document.currentScript.src).pathname.replace(/\/assets\/login\.js$/, '');
  var form = document.getElementById('f'), err = document.getElementById('err'), btn = document.getElementById('btn');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    err.textContent = ''; btn.disabled = true;
    fetch(BASE + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
      credentials: 'same-origin',
      body: JSON.stringify({ username: form.u.value, password: form.p.value })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (res.ok) location.assign(BASE + '/declaracao');
        else { err.textContent = res.j.error || 'Falha ao entrar'; btn.disabled = false; }
      }).catch(function () { err.textContent = 'Sem conexão com o servidor'; btn.disabled = false; });
  });
})();
