"use strict";
/**
 * GoMaa Raga Vidya v4.0 — SQLite Database (Async, Fixed)
 * Patch: added .prepare() defensive fallback for better-sqlite3-style callers
 */

const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const DB_PATH = path.join(__dirname, "../../models/music.db");

let db = null;

function getDB() {
  if (!db) {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) console.error("[GoMaa] DB open error:", err.message);
      else console.log("[GoMaa] DB connected:", DB_PATH);
    });
    db.on("error", (err) => {
      console.error("[GoMaa] DB error:", err.message);
    });
  }
  return db;
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDB().run(sql, params, function(err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDB().get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    getDB().all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function close() {
  return new Promise((resolve, reject) => {
    if (!db) { resolve(); return; }
    db.close((err) => {
      if (err) reject(err);
      else { db = null; resolve(); }
    });
  });
}

/* ── DEFENSIVE FALLBACK: .prepare() for better-sqlite3-style callers ── */
function prepare(sql) {
  return {
    run: (...params) => run(sql, params.flat()),
    get: (...params) => get(sql, params.flat()),
    all: (...params) => all(sql, params.flat()),
  };
}

const api = { getDB, run, get, all, close, prepare };

/* Allow: const db = require('./sqlite')(dbPath) — same pattern as better-sqlite3 */
function createDB(overriddenPath) {
  if (overriddenPath && overriddenPath !== DB_PATH) {
    console.warn("[sqlite] Path override ignored; using", DB_PATH);
  }
  return api;
}
Object.assign(createDB, api);
module.exports = createDB;
