'use strict';
/**
 * Ponto de entrada (entry file) para a Hostinger: `npm start` -> node server.js
 *
 * IMPORTANTE: este arquivo liga o servidor sempre que é carregado. NÃO usar
 * "if (require.main === module)": a Hostinger carrega o arquivo por outro programa
 * e esse teste falharia, deixando o servidor sem chamar listen().
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

// .env só para uso LOCAL (na Hostinger as variáveis vêm do painel).
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) { /* sem .env: ok */ }

const port = Number(process.env.PORT || 3000);
let app;
try {
  const { createApp } = require('./app');
  app = createApp(process.env);
} catch (e) {
  // Configuração inválida (ex.: falta SESSION_SECRET). Liga mesmo assim, mostra aviso
  // simples ao público e escreve o motivo exato nos logs.
  console.error('[falha de configuração]', e.message);
  http.createServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Sistema indisponível: configuração incompleta. Veja os logs do aplicativo.');
  }).listen(port, () => console.error(`[aviso] Servidor de emergência na porta ${port}. Corrija as variáveis de ambiente e reinicie.`));
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
