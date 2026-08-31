"use strict";
/**
 * GoMaa Raga Vidya v4.0 — Database Initialization
 */

const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const MODELS_DIR = path.join(__dirname, "../models");
fs.mkdirSync(MODELS_DIR, { recursive: true });

const DB_PATH = path.join(MODELS_DIR, "music.db");

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("[GoMaa] Failed to open DB:", err.message);
    process.exit(1);
  }
  console.log("[GoMaa] DB opened:", DB_PATH);
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS music (
    id TEXT PRIMARY KEY,
    title TEXT,
    artist TEXT,
    raga TEXT,
    ragaNumber INTEGER,
    aroha TEXT,
    avaroha TEXT,
    mood TEXT,
    gamakas TEXT,
    tala TEXT,
    tempo REAL,
    duration REAL,
    filePath TEXT,
    embedding TEXT,
    chromaVector TEXT,
    sections TEXT,
    sheetMusic TEXT,
    midiData TEXT,
    language TEXT,
    analysisJson TEXT,
    lyricsJson TEXT,
    transcriptionJson TEXT,
    createdAt INTEGER
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_music_raga ON music(raga)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_music_tala ON music(tala)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_music_created ON music(createdAt)`);

  console.log("[GoMaa] Database initialized successfully.");
});

db.close((err) => {
  if (err) console.error("[GoMaa] DB close error:", err.message);
  else console.log("[GoMaa] DB connection closed.");
});
