# Publicar na Hostinger – projetoisma.com/farmacia

Plano: Unlimited Web Hosting (Business/Unlimited aceita Node.js, até 5 apps).
Limites do plano: requisição máxima de 120 s e sem WebSocket (o sistema não usa).

## 1. Banco MySQL
hPanel → Bancos de dados → Bancos de dados MySQL → criar banco + usuário.
Anote: nome do banco, usuário, senha e o host (geralmente `localhost`).
As tabelas (`users`, `kv_store`, `kv_history`, `clientes`) são criadas sozinhas na primeira inicialização.
Se o banco já existia (versão sem níveis), as colunas novas são adicionadas sozinhas e **os usuários que já existiam viram administradores**.

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
2. Abra `https://projetoisma.com/farmacia/` e entre com ADMIN_USER / ADMIN_PASSWORD (o usuário inicial é **Administrador**). Depois do login aparece a escolha entre **Módulo Rotinas** e **Módulo Declarações**.
3. **Remova `ADMIN_PASSWORD` das variáveis** e faça redeploy (o usuário já foi criado).

## 4.1 Usuários e níveis de acesso
- Em **Módulos → Usuários** (só administrador) cadastre os funcionários: nome, login, senha inicial (mín. 8) e nível.
- **Administrador**: tudo (Rotinas, Declarações, Usuários, Backup completo, remover cadastro de cliente).
- **Funcionário**: Rotinas e Declarações; não vê Usuários, não baixa o Backup completo e não remove cadastros de clientes.
- Usuário desativado perde o acesso na hora. Sempre fica pelo menos um administrador ativo.
- Cada pessoa troca a própria senha em **Módulos → Alterar minha senha**.

## 4.2 Declarações: cadastro de clientes, prévia e Google Drive
- **Clientes**: ao digitar o nome (ou CPF/telefone) aparecem os já atendidos e os dados são preenchidos. O cadastro só é gravado com a caixa "cliente autorizou guardar o cadastro" marcada (LGPD: dado de saúde) e é atualizado ao imprimir. Só o administrador remove um cadastro.
- **Prévia**: botão "Ocultar/Mostrar prévia" na barra e opção na tela de módulos (preferência de cada usuário, neste navegador). A impressão funciona com a prévia oculta.
- **Google Drive**: ao imprimir, o PDF sai com nome padrão (`Declaracao_<serviço>_<nº>-<ano>_<Cliente>.pdf`) e aparece o botão para abrir a pasta "05 Declarações de serviços". A pasta pode ser trocada em *Dados do estabelecimento*. O envio é manual (soltar o PDF na pasta); o envio automático exigiria credenciais do Google Cloud.

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
