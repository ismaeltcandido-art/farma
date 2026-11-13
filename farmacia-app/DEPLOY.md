# Publicar na Hostinger – projetoisma.com/farmacia

Plano: Unlimited Web Hosting (Business/Unlimited aceita Node.js, até 5 apps).
Limites do plano: requisição máxima de 120 s e sem WebSocket (o sistema não usa).

## 1. Banco MySQL
hPanel → Bancos de dados → Bancos de dados MySQL → criar banco + usuário.
Anote: nome do banco, usuário, senha e o host (geralmente `localhost`).
As tabelas (`users`, `kv_store`, `kv_history`) são criadas sozinhas na primeira inicialização.

## 2. Código (recomendado: GitHub PRIVADO)
1. Crie um repositório **privado** e envie o conteúdo desta pasta (o `.gitignore` já exclui `.env` e `node_modules`).
2. hPanel → Websites → Add Website → Node.js web app → Import Git Repository.
Alternativa para o primeiro teste: enviar o `farmacia-app.zip` pelo painel.

## 3. Configurações do app no hPanel
- Entry file: `server.js`  | Comando de start: `npm start`  | Node 22
- Variáveis de ambiente (copie de `.env.example`):
  `NODE_ENV=production`, `BASE_PATH=/farmacia`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`,
  `SESSION_SECRET` (gere: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`),
  `ADMIN_USER`, `ADMIN_PASSWORD` (mín. 10 caracteres).
- **Não defina `PORT`** se o painel já a fornece: o servidor lê `process.env.PORT`.

## 4. Primeiro acesso
1. Abra `https://projetoisma.com/farmacia/health` → deve responder `{"ok":true}`.
2. Abra `https://projetoisma.com/farmacia/` e entre com ADMIN_USER / ADMIN_PASSWORD.
3. **Remova `ADMIN_PASSWORD` das variáveis** e faça redeploy (o usuário já foi criado).

## 5. Levar os dados atuais (teste local) para o servidor
Nas versões antigas (arquivos .html no Chrome do PC) use a exportação/backup de cada tela,
depois entre no sistema novo e use a importação. Faça isso antes de abandonar o Chrome antigo.

## 6. Rotina
- Botão **Backup** (barra inferior) baixa um JSON completo; salvar toda sexta em *06 Registros mensais* no Drive.
- Ative também os backups do banco no hPanel.
- Cada gravação mantém as 50 últimas versões na tabela `kv_history` (recuperação de erros).

## Notas
- Dois aparelhos editando a mesma tela ao mesmo tempo: o segundo recebe aviso de conflito
  (nada é sobrescrito sem aviso) e pode baixar uma cópia das suas alterações.
- Mantenha o repositório privado: as páginas trazem links do Drive e números de licença.
- Se `projetoisma.com` já tiver outro site, use um subdomínio (ex.: `farmacia.projetoisma.com`) com `BASE_PATH=` vazio.
