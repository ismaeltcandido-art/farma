'use strict';
/**
 * Ponto de entrada (entry file) da Hostinger: `npm start` -> node server.js
 *
 * Este arquivo liga o servidor SEMPRE que é carregado, sem nenhuma condição de
 * "arquivo principal". A Hostinger carrega o arquivo por outro programa e espera
 * o listen() em poucos segundos.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

function main() {
  // .env só para uso LOCAL (na Hostinger as variáveis vêm do painel).
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) { /* sem .env: ok */ }

  const port = Number(process.env.PORT || 3000);
  let app = null;
  try {
    const { createApp } = require('./core');
    if (typeof createApp !== 'function') throw new Error('core.js está vazio ou incompleto');
    app = createApp(process.env);
  } catch (e) {
    // Configuração/arquivo inválido: liga mesmo assim, mostra aviso simples ao público
    // e escreve o motivo exato nos logs.
    console.error('[falha de configuração]', e.message);
    http.createServer((req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Sistema indisponível: configuração incompleta. Veja os logs do aplicativo.');
    }).listen(port, () => console.error(`[aviso] Servidor de emergência na porta ${port}. Corrija o problema acima e reinicie.`));
    return;
  }

  app.listen().then(() => {
    let tentativa = 0;
    const iniciar = () => app.initialize().catch(err => {
      tentativa++;
      console.error(`[falha ao iniciar o banco] (tentativa ${tentativa}) ${err.code || ''} ${err.message}`);
      setTimeout(iniciar, Math.min(30000, 3000 * tentativa)); // tenta de novo sem derrubar o servidor
    });
    iniciar();
  }).catch(e => { console.error('[falha ao ligar a porta]', e.message); process.exit(1); });

  const shutdown = () => app.stop().finally(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
