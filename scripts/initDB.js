#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const sqliteModule = require('../core/db/sqlite');
const db = typeof sqliteModule === 'function' ? sqliteModule() : sqliteModule;
const dbPath = path.join(__dirname, '..', 'models', 'music.db');
console.log('[init-db] Connected to:', dbPath);

async function execSQL(sql, params = []) {
  if (typeof db.run === 'function') return await db.run(sql, params);
  if (typeof db.exec === 'function') return await db.exec(sql);
  if (typeof db.prepare === 'function') {
    const stmt = db.prepare(sql);
    if (typeof stmt.run === 'function') return await stmt.run(...params);
  }
  throw new Error('No exec/run/prepare method found');
}
async function queryAll(sql, params = []) {
  if (typeof db.all === 'function') return await db.all(sql, params);
  if (typeof db.prepare === 'function') {
    const stmt = db.prepare(sql);
    if (typeof stmt.all === 'function') return await stmt.all(...params);
  }
  throw new Error('No query method found');
}
async function queryGet(sql, params = []) {
  if (typeof db.get === 'function') return await db.get(sql, params);
  if (typeof db.prepare === 'function') {
    const stmt = db.prepare(sql);
    if (typeof stmt.get === 'function') return await stmt.get(...params);
  }
  throw new Error('No get method found');
}

(async () => {
  try {
    await execSQL('PRAGMA foreign_keys = ON');

    // ── Ragas reference table ──
    await execSQL(`CREATE TABLE IF NOT EXISTS ragas (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, melakartaNum INTEGER, parent TEXT,
      aroha TEXT, avarohana TEXT, isMelakarta INTEGER DEFAULT 0,
      frequencyMap TEXT, westernEquiv TEXT, character TEXT
    )`);
    await execSQL('CREATE INDEX IF NOT EXISTS idx_ragas_melakarta ON ragas(melakartaNum)');
    await execSQL('CREATE INDEX IF NOT EXISTS idx_ragas_parent ON ragas(parent)');
    await execSQL('CREATE UNIQUE INDEX IF NOT EXISTS idx_ragas_name ON ragas(name)');
    console.log('[init-db] Table "ragas" ensured.');

    // Populate from raga_db.json
    const ragaDbPath = path.join(__dirname, '..', 'models', 'raga_db.json');
    if (fs.existsSync(ragaDbPath)) {
      const ragaData = JSON.parse(fs.readFileSync(ragaDbPath, 'utf8'));
      const ragas = Array.isArray(ragaData) ? ragaData : (ragaData.ragas || []);
      let inserted = 0;
      for (const r of ragas) {
        if (!r || !r.name) continue;
        const exists = await queryGet('SELECT 1 FROM ragas WHERE id = ?', [r.name]);
        if (!exists) {
          await execSQL(
            `INSERT INTO ragas (id, name, melakartaNum, parent, aroha, avarohana, isMelakarta, frequencyMap, westernEquiv, character)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              r.name, r.name, r.melakarta || null, r.parent || null,
              Array.isArray(r.arohana) ? r.arohana.join(' ') : (r.arohana || ''),
              Array.isArray(r.avarohana) ? r.avarohana.join(' ') : (r.avarohana || ''),
              r.parent ? 0 : 1,
              r.frequency_map ? JSON.stringify(r.frequency_map) : null,
              r.western_equiv || null, r.character || null
            ]
          );
          inserted++;
        }
      }
      console.log(`[init-db] Populated ${inserted} ragas`);
    }

    // ── Music table (merged schema) ──
    await execSQL(`CREATE TABLE IF NOT EXISTS music (
      id TEXT PRIMARY KEY, filename TEXT, title TEXT NOT NULL, artist TEXT, composer TEXT,
      raga TEXT, ragaNumber INTEGER, ragaId TEXT, janyaOf TEXT,
      aroha TEXT, avarohana TEXT, mood TEXT, gamakas TEXT, tala TEXT, tempo REAL, duration REAL,
      filePath TEXT, embedding TEXT, chromaVector TEXT, sections TEXT, sheetMusic TEXT, midiData TEXT,
      language TEXT, analysisJson TEXT, lyricsJson TEXT, transcriptionJson TEXT, sahityam TEXT,
      createdAt INTEGER DEFAULT (strftime('%s','now')),
      FOREIGN KEY (ragaId) REFERENCES ragas(id) ON DELETE SET NULL
    )`);
    console.log('[init-db] Table "music" ensured.');

    // Indexes
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_music_ragaId ON music(ragaId)',
      'CREATE INDEX IF NOT EXISTS idx_music_ragaNumber ON music(ragaNumber)',
      'CREATE INDEX IF NOT EXISTS idx_music_createdAt ON music(createdAt)',
      'CREATE INDEX IF NOT EXISTS idx_music_title ON music(title)',
      'CREATE INDEX IF NOT EXISTS idx_music_artist ON music(artist)',
      'CREATE INDEX IF NOT EXISTS idx_music_composer ON music(composer)',
      'CREATE INDEX IF NOT EXISTS idx_music_raga ON music(raga)',
      'CREATE INDEX IF NOT EXISTS idx_music_tala ON music(tala)',
    ];
    for (const idx of indexes) { try { await execSQL(idx); } catch (e) {} }

    // Add missing columns
    const columns = await queryAll("PRAGMA table_info(music)");
    if (!Array.isArray(columns)) throw new Error('PRAGMA did not return array');
    const colNames = columns.map(c => c.name);
    const needed = {
      filename: 'TEXT', composer: 'TEXT', ragaId: 'TEXT', janyaOf: 'TEXT', sahityam: 'TEXT',
      artist: 'TEXT', ragaNumber: 'INTEGER', aroha: 'TEXT', avarohana: 'TEXT', mood: 'TEXT',
      gamakas: 'TEXT', tempo: 'REAL', filePath: 'TEXT', embedding: 'TEXT', chromaVector: 'TEXT',
      sections: 'TEXT', sheetMusic: 'TEXT', midiData: 'TEXT', language: 'TEXT',
      analysisJson: 'TEXT', lyricsJson: 'TEXT', transcriptionJson: 'TEXT',
      createdAt: "INTEGER DEFAULT (strftime('%s','now'))"
    };
    for (const [col, type] of Object.entries(needed)) {
      if (!colNames.includes(col)) {
        await execSQL(`ALTER TABLE music ADD COLUMN ${col} ${type}`);
        console.log('[init-db] Added column:', col);
      }
    }

    // Other tables
    await execSQL(`CREATE TABLE IF NOT EXISTS fingerprint (hash TEXT NOT NULL, music_id TEXT NOT NULL, time_offset REAL DEFAULT 0, PRIMARY KEY (hash, music_id))`);
    await execSQL(`CREATE TABLE IF NOT EXISTS edges (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, weight REAL DEFAULT 1.0, PRIMARY KEY (from_id, to_id, type))`);
    await execSQL(`CREATE TABLE IF NOT EXISTS segments (id TEXT PRIMARY KEY, music_id TEXT NOT NULL, type TEXT, raga TEXT, start_time REAL, end_time REAL, swaras TEXT, gamaka TEXT, stress TEXT, tala TEXT, lyrics TEXT)`);
    await execSQL(`CREATE TABLE IF NOT EXISTS compositions (id TEXT PRIMARY KEY, title TEXT, raga TEXT, tala TEXT, tempo REAL, instruments TEXT, lyrics TEXT, sheetMusicXml TEXT, midiB64 TEXT, createdAt INTEGER DEFAULT (strftime('%s','now')))`);

    console.log('[init-db] Schema check complete.');
  } catch (err) {
    console.error('[init-db] Error:', err.message);
  } finally {
    if (typeof db.close === 'function') await db.close();
    console.log('[init-db] Done.');
  }
})();