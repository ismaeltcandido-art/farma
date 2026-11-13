'use strict';
// Camada de banco. Produção: MySQL (mysql2). Testes: DB_DRIVER=memory.
const crypto = require('crypto');

function createMemoryDb() {
  const users = new Map(); // username -> {id, username, password_hash}
  const kv = new Map();    // k -> {v, version, updated_at, updated_by}
  let nextId = 1;
  return {
    async init() {},
    async ping() { return true; },
    async countUsers() { return users.size; },
    async getUser(username) { return users.get(username) || null; },
    async getUserById(id) { for (const u of users.values()) if (u.id === id) return u; return null; },
    async createUser(username, password_hash) {
      if (users.has(username)) throw new Error('Usuário já existe');
      users.set(username, { id: nextId++, username, password_hash });
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
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      await pool.query(`CREATE TABLE IF NOT EXISTS kv_store (
        k VARCHAR(100) NOT NULL PRIMARY KEY,
        v LONGTEXT NOT NULL,
        version INT UNSIGNED NOT NULL DEFAULT 1,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        updated_by INT UNSIGNED NULL
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
    async createUser(username, password_hash) { await pool.query('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, password_hash]); },
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
    async close() { await pool.end(); }
  };
}

function createDb(env = process.env) {
  if (env.DB_DRIVER === 'memory') return createMemoryDb();
  return createMysqlDb(env);
}

module.exports = { createDb, createMemoryDb };
