'use strict';
// Camada de banco. Produção: MySQL (mysql2). Testes: DB_DRIVER=memory.
const crypto = require('crypto');

// Normaliza nome para busca/duplicidade: minúsculas, sem acentos e sem espaços repetidos.
function norm(t) { return String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
const digits = t => String(t || '').replace(/\D/g, '');
const CLI_FIELDS = ['nome', 'nasc', 'doc', 'tel', 'endereco', 'resp'];

function createMemoryDb() {
  const clientes = new Map(); // id -> cliente
  let nextCli = 1;
  const users = new Map(); // username -> {id, username, name, role, active, password_hash}
  const kv = new Map();    // k -> {v, version, updated_at, updated_by}
  let nextId = 1;
  return {
    async init() {},
    async ping() { return true; },
    async countUsers() { return users.size; },
    async countActiveAdmins() { let n = 0; for (const u of users.values()) if (u.role === 'admin' && u.active) n++; return n; },
    async getUser(username) { return users.get(username) || null; },
    async getUserById(id) { for (const u of users.values()) if (u.id === id) return u; return null; },
    async listUsers() { return [...users.values()].map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role, active: u.active })); },
    async createUser(username, password_hash, role = 'funcionario', name = '') {
      if (users.has(username)) throw Object.assign(new Error('Usuário já existe'), { code: 'ER_DUP_ENTRY' });
      const u = { id: nextId++, username, name, role, active: true, password_hash };
      users.set(username, u); return u.id;
    },
    async updateUser(id, f) {
      const u = await this.getUserById(id); if (!u) throw new Error('Usuário não encontrado');
      for (const k of ['name', 'role', 'active', 'password_hash']) if (f[k] !== undefined) u[k] = f[k];
    },
    async updatePassword(username, password_hash) {
      const u = users.get(username); if (!u) throw new Error('Usuário não encontrado'); u.password_hash = password_hash;
    },
    async getAll() {
      const o = {};
      for (const [k, r] of kv) o[k] = { v: r.v, version: r.version };
      return o;
    },
    // Retorna {ok:true, version} ou {ok:false, current}
    async put(k, v, baseVersion, userId) {
      const cur = kv.get(k);
      const curVer = cur ? cur.version : 0;
      if (baseVersion !== curVer) return { ok: false, current: curVer };
      kv.set(k, { v, version: curVer + 1, updated_at: Date.now(), updated_by: userId });
      return { ok: true, version: curVer + 1 };
    },
    async del(k, baseVersion) {
      const cur = kv.get(k); const curVer = cur ? cur.version : 0;
      if (baseVersion !== curVer) return { ok: false, current: curVer };
      kv.delete(k); return { ok: true, version: 0 };
    },
    // ----- clientes -----
    async findCliente(c) {
      const d = digits(c.doc), n = norm(c.nome);
      for (const r of clientes.values()) {
        if (d && digits(r.doc) === d) return r;
        if (!d && n && norm(r.nome) === n && r.nasc === (c.nasc || '')) return r;
      }
      return null;
    },
    async searchClientes(q) {
      const n = norm(q), d = digits(q); const out = [];
      for (const r of clientes.values()) {
        if (norm(r.nome).includes(n) || (d.length >= 3 && (digits(r.doc).includes(d) || digits(r.tel).includes(d)))) out.push(r);
      }
      return out.sort((a, b) => norm(a.nome).localeCompare(norm(b.nome))).slice(0, 8).map(r => ({ ...r }));
    },
    async saveCliente(c, userId) {
      const ex = await this.findCliente(c);
      if (ex) { for (const k of CLI_FIELDS) ex[k] = c[k] || ''; ex.updated_by = userId; return ex.id; }
      const id = nextCli++; clientes.set(id, { id, ...Object.fromEntries(CLI_FIELDS.map(k => [k, c[k] || ''])), updated_by: userId }); return id;
    },
    async deleteCliente(id) { return clientes.delete(id); },
    async close() {}
  };
}

function createMysqlDb(env) {
  const mysql = require('mysql2/promise');
  const pool = mysql.createPool({
    host: env.DB_HOST || 'localhost',
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 5,
    charset: 'utf8mb4',
    // Os dados são lidos/escritos como texto; evita problemas de fuso
    timezone: 'Z'
  });
  return {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS users (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(60) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(100) NOT NULL DEFAULT '',
        role VARCHAR(20) NOT NULL DEFAULT 'funcionario',
        active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      // Migração de bancos criados antes dos níveis: adiciona as colunas e torna admin
      // quem já existia (era o único tipo de usuário até então).
      const [cols] = await pool.query(
        "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'");
      const have = new Set(cols.map(c => c.COLUMN_NAME || c.column_name));
      if (!have.has('role')) {
        await pool.query("ALTER TABLE users ADD COLUMN role VARCHAR(20) NOT NULL DEFAULT 'funcionario'");
        await pool.query("UPDATE users SET role = 'admin'");
      }
      if (!have.has('name')) await pool.query("ALTER TABLE users ADD COLUMN name VARCHAR(100) NOT NULL DEFAULT ''");
      if (!have.has('active')) await pool.query("ALTER TABLE users ADD COLUMN active TINYINT(1) NOT NULL DEFAULT 1");
      await pool.query(`CREATE TABLE IF NOT EXISTS kv_store (
        k VARCHAR(100) NOT NULL PRIMARY KEY,
        v LONGTEXT NOT NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        updated_by INT UNSIGNED NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      // Cadastro de clientes atendidos (dados pessoais/saúde: só guardar com autorização)
      await pool.query(`CREATE TABLE IF NOT EXISTS clientes (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        nome VARCHAR(150) NOT NULL,
        nome_norm VARCHAR(150) NOT NULL,
        nasc VARCHAR(10) NOT NULL DEFAULT '',
        doc VARCHAR(30) NOT NULL DEFAULT '',
        doc_dig VARCHAR(30) NOT NULL DEFAULT '',
        tel VARCHAR(30) NOT NULL DEFAULT '',
        tel_dig VARCHAR(30) NOT NULL DEFAULT '',
        endereco VARCHAR(200) NOT NULL DEFAULT '',
        resp VARCHAR(150) NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        updated_by INT UNSIGNED NULL,
        INDEX idx_nome (nome_norm),
        INDEX idx_doc (doc_dig)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      // Histórico para recuperação de erros (últimas gravações de cada chave)
      await pool.query(`CREATE TABLE IF NOT EXISTS kv_history (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        k VARCHAR(100) NOT NULL,
        v LONGTEXT NOT NULL,
        version INT UNSIGNED NOT NULL,
        saved_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        saved_by INT UNSIGNED NULL,
        INDEX idx_k_saved (k, saved_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    },
    async ping() { await pool.query('SELECT 1'); return true; },
    async countUsers() { const [r] = await pool.query('SELECT COUNT(*) AS n FROM users'); return r[0].n; },
    async getUser(username) { const [r] = await pool.query('SELECT * FROM users WHERE username = ?', [username]); return r[0] || null; },
    async getUserById(id) { const [r] = await pool.query('SELECT * FROM users WHERE id = ?', [id]); return r[0] || null; },
    async countActiveAdmins() { const [r] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1"); return r[0].n; },
    async listUsers() {
      const [r] = await pool.query('SELECT id, username, name, role, active FROM users ORDER BY username');
      return r.map(u => ({ ...u, active: !!u.active }));
    },
    async createUser(username, password_hash, role = 'funcionario', name = '') {
      const [r] = await pool.query('INSERT INTO users (username, password_hash, role, name) VALUES (?, ?, ?, ?)', [username, password_hash, role, name]);
      return r.insertId;
    },
    async updateUser(id, f) {
      const sets = [], vals = [];
      for (const k of ['name', 'role', 'password_hash']) if (f[k] !== undefined) { sets.push(k + ' = ?'); vals.push(f[k]); }
      if (f.active !== undefined) { sets.push('active = ?'); vals.push(f.active ? 1 : 0); }
      if (!sets.length) return;
      vals.push(id);
      await pool.query('UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?', vals);
    },
    async updatePassword(username, password_hash) { await pool.query('UPDATE users SET password_hash = ? WHERE username = ?', [password_hash, username]); },
    async getAll() {
      const [rows] = await pool.query('SELECT k, v, version FROM kv_store');
      const o = {}; for (const r of rows) o[r.k] = { v: r.v, version: r.version }; return o;
    },
    async put(k, v, baseVersion, userId) {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [rows] = await conn.query('SELECT version FROM kv_store WHERE k = ? FOR UPDATE', [k]);
        const curVer = rows[0] ? rows[0].version : 0;
        if (baseVersion !== curVer) { await conn.rollback(); return { ok: false, current: curVer }; }
        const nv = curVer + 1;
        if (rows[0]) await conn.query('UPDATE kv_store SET v = ?, version = ?, updated_by = ? WHERE k = ?', [v, nv, userId, k]);
        else await conn.query('INSERT INTO kv_store (k, v, version, updated_by) VALUES (?, ?, ?, ?)', [k, v, nv, userId]);
        await conn.query('INSERT INTO kv_history (k, v, version, saved_by) VALUES (?, ?, ?, ?)', [k, v, nv, userId]);
        // mantém as 50 últimas versões de cada chave
        await conn.query('DELETE FROM kv_history WHERE k = ? AND version <= ?', [k, nv - 50]);
        await conn.commit();
        return { ok: true, version: nv };
      } catch (e) { try { await conn.rollback(); } catch (_) {} throw e; }
      finally { conn.release(); }
    },
    async del(k, baseVersion) {
      const [rows] = await pool.query('SELECT version FROM kv_store WHERE k = ?', [k]);
      const curVer = rows[0] ? rows[0].version : 0;
      if (baseVersion !== curVer) return { ok: false, current: curVer };
      await pool.query('DELETE FROM kv_store WHERE k = ?', [k]);
      return { ok: true, version: 0 };
    },
    // ----- clientes -----
    async findCliente(c) {
      const d = digits(c.doc), n = norm(c.nome);
      if (d) { const [r] = await pool.query('SELECT * FROM clientes WHERE doc_dig = ? LIMIT 1', [d]); return r[0] || null; }
      if (!n) return null;
      const [r] = await pool.query('SELECT * FROM clientes WHERE nome_norm = ? AND nasc = ? AND doc_dig = \'\' LIMIT 1', [n, c.nasc || '']);
      return r[0] || null;
    },
    async searchClientes(q) {
      const n = norm(q), d = digits(q);
      const like = '%' + n.replace(/[%_\\]/g, m => '\\' + m) + '%';
      const [r] = d.length >= 3
        ? await pool.query('SELECT * FROM clientes WHERE nome_norm LIKE ? OR doc_dig LIKE ? OR tel_dig LIKE ? ORDER BY nome_norm LIMIT 8', [like, '%' + d + '%', '%' + d + '%'])
        : await pool.query('SELECT * FROM clientes WHERE nome_norm LIKE ? ORDER BY nome_norm LIMIT 8', [like]);
      return r;
    },
    async saveCliente(c, userId) {
      const ex = await this.findCliente(c);
      const v = [c.nome, norm(c.nome), c.nasc || '', c.doc || '', digits(c.doc), c.tel || '', digits(c.tel), c.endereco || '', c.resp || '', userId];
      if (ex) {
        await pool.query('UPDATE clientes SET nome=?, nome_norm=?, nasc=?, doc=?, doc_dig=?, tel=?, tel_dig=?, endereco=?, resp=?, updated_by=? WHERE id=?', [...v, ex.id]);
        return ex.id;
      }
      const [r] = await pool.query('INSERT INTO clientes (nome, nome_norm, nasc, doc, doc_dig, tel, tel_dig, endereco, resp, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?)', v);
      return r.insertId;
    },
    async deleteCliente(id) { const [r] = await pool.query('DELETE FROM clientes WHERE id = ?', [id]); return r.affectedRows > 0; },
    async close() { await pool.end(); }
  };
}

function createDb(env = process.env) {
  if (env.DB_DRIVER === 'memory') return createMemoryDb();
  return createMysqlDb(env);
}

module.exports = { createDb, createMemoryDb };
