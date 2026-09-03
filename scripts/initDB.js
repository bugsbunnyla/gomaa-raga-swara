#!/usr/bin/env node
const path = require('path');

// Your custom sqlite wrapper
const sqliteModule = require('../core/db/sqlite');
const db = typeof sqliteModule === 'function' ? new sqliteModule(path.join(__dirname, '..', 'models', 'music.db')) : sqliteModule;

console.log('[init-db] Connected to:', path.join(__dirname, '..', 'models', 'music.db'));

// Helper: execute SQL regardless of wrapper API
function execSQL(sql) {
  if (typeof db.exec === 'function') {
    db.exec(sql);
  } else if (typeof db.run === 'function') {
    db.run(sql);
  } else if (typeof db.prepare === 'function') {
    db.prepare(sql).run();
  } else {
    throw new Error('No exec/run/prepare method found on db wrapper');
  }
}

// Helper: query all rows regardless of wrapper API
function queryAll(sql) {
  if (typeof db.prepare === 'function') {
    const stmt = db.prepare(sql);
    if (typeof stmt.all === 'function') return stmt.all();
    if (typeof stmt.get === 'function') {
      const rows = []; let row;
      while ((row = stmt.get()) !== undefined) rows.push(row);
      return rows;
    }
    if (typeof stmt.each === 'function') {
      const rows = [];
      stmt.each((err, row) => { if (!err) rows.push(row); });
      return rows;
    }
  }
  if (typeof db.all === 'function') return db.all(sql);
  if (typeof db.query === 'function') return db.query(sql);
  throw new Error('No query method found on db wrapper');
}

// Create table if not exists
const createTable = `
  CREATE TABLE IF NOT EXISTS music (
    id TEXT PRIMARY KEY,
    filename TEXT,
    originalName TEXT,
    compositionId TEXT,
    title TEXT,
    raga TEXT,
    tala TEXT,
    composer TEXT,
    duration REAL,
    sahityam TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`;
try {
  execSQL(createTable);
  console.log('[init-db] Table "music" ensured.');
} catch (e) {
  console.log('[init-db] Table creation skipped (may already exist):', e.message);
}

// Add missing columns
try {
  const columns = queryAll("PRAGMA table_info(music)");
  const colNames = columns.map(c => c.name);
  const needed = ['originalName', 'compositionId', 'sahityam'];

  needed.forEach(col => {
    if (!colNames.includes(col)) {
      execSQL(`ALTER TABLE music ADD COLUMN ${col} TEXT`);
      console.log('[init-db] Added column:', col);
    } else {
      console.log('[init-db] Column already exists:', col);
    }
  });
} catch (e) {
  console.error('[init-db] Schema check failed:', e.message);
  console.log('[init-db] If table does not exist, it will be created on first server start.');
}

console.log('[init-db] Done.');
if (typeof db.close === 'function') db.close();
