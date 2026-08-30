"use strict";
/**
 * GoMaa SQLite Wrapper v3.1.1 (better-sqlite3 version)
 * No native compilation issues, synchronous API, much faster
 * Drop-in replacement for sqlite3 wrapper
 */

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_DIR = path.join(__dirname, "../../models");
const DB_PATH = path.join(DB_DIR, "music.db");

let _db = null;

function ensureDir() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
}

function initDb() {
  if (_db) return _db;
  ensureDir();
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  console.log("[SQLite] Connected to", DB_PATH);
  return _db;
}

function getDb() {
  return initDb();
}

function run(sql, params = []) {
  const db = initDb();
  const stmt = db.prepare(sql);
  const info = stmt.run(...(Array.isArray(params) ? params : [params]));
  return { lastID: info.lastInsertRowid, changes: info.changes };
}

function get(sql, params = []) {
  const db = initDb();
  const stmt = db.prepare(sql);
  return stmt.get(...(Array.isArray(params) ? params : [params])) || null;
}

function all(sql, params = []) {
  const db = initDb();
  const stmt = db.prepare(sql);
  return stmt.all(...(Array.isArray(params) ? params : [params]));
}

function exec(sql) {
  const db = initDb();
  db.exec(sql);
}

function close() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

module.exports = {
  getDb,
  run,
  get,
  all,
  exec,
  close,
  initDb,
  DB_PATH
};
