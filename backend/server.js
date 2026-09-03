"use strict";
/**
 * GoMaa Raga Vidya v4.0 — Express Server
 */

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

const recognizeRouter = require("./routes/recognize");
const composeRouter = require("./routes/compose");
const db = require("../core/db/sqlite");

app.use("/api/recognize", recognizeRouter);
app.use("/api/compose", composeRouter);

// Serve static frontend
app.use(express.static(path.join(__dirname, "../apps/web")));

// List all saved analyses
app.get("/api/analyses", async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT id, title, raga, tala, createdAt FROM music ORDER BY createdAt DESC LIMIT 100`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get single analysis
app.get("/api/analysis/:id", async (req, res) => {
  try {
    const row = await db.get(`SELECT analysisJson FROM music WHERE id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json(JSON.parse(row.analysisJson));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get MusicXML
app.get("/api/sheet/:id", async (req, res) => {
  try {
    const row = await db.get(`SELECT sheetMusic, raga FROM music WHERE id = ?`, [req.params.id]);
    if (!row || !row.sheetMusic) return res.status(404).json({ error: "Not found" });
    res.setHeader("Content-Type", "application/xml");
    res.setHeader("Content-Disposition", `attachment; filename="${row.raga || 'composition'}.musicxml"`);
    res.send(row.sheetMusic);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get MIDI
app.get("/api/midi/:id", async (req, res) => {
  try {
    const row = await db.get(`SELECT midiData, raga FROM music WHERE id = ?`, [req.params.id]);
    if (!row || !row.midiData) return res.status(404).json({ error: "Not found" });
    const buf = Buffer.from(row.midiData, "base64");
    res.setHeader("Content-Type", "audio/midi");
    res.setHeader("Content-Disposition", `attachment; filename="${row.raga || 'composition'}.mid"`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", version: "4.0.0", timestamp: Date.now() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[GoMaa] Server running on http://localhost:${PORT}`);
});

// ADD THESE ROUTES to your backend/server.js

const fs = require('fs').promises;
const COMP_DB_PATH = path.join(__dirname, 'data', 'composition_db.json');

app.get('/api/compositions', async (req, res) => {
  try {
    const data = await fs.readFile(COMP_DB_PATH, 'utf8');
    res.json(JSON.parse(data));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load composition DB' });
  }
});

app.post('/api/compositions', async (req, res) => {
  try {
    const data = await fs.readFile(COMP_DB_PATH, 'utf8');
    const db = JSON.parse(data);

    const existingIndex = db.findIndex(c => 
      c.title?.toLowerCase() === req.body.title?.toLowerCase() &&
      c.raga === req.body.raga
    );

    if (existingIndex >= 0) {
      db[existingIndex] = { ...db[existingIndex], ...req.body, updated: new Date().toISOString() };
    } else {
      db.push({ ...req.body, created: new Date().toISOString() });
    }

    await fs.writeFile(COMP_DB_PATH, JSON.stringify(db, null, 2));
    res.json({ success: true, id: req.body.id });
  } catch (err) {
    console.error('Composition save error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/compositions/reload', (req, res) => {
  try {
    delete require.cache[require.resolve('./data/composition_db.json')];
    const fresh = require('./data/composition_db.json');
    global.compositionDB = fresh;
    res.json({ success: true, count: fresh.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// INSERT INTO YOUR RECOGNIZE ROUTE — Live Recording Normalization
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

async function normalizeLiveRecording(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setFfmpegPath(ffmpegStatic)
      .audioFrequency(16000)
      .audioChannels(1)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .save(outputPath);
  });
}

// Usage inside recognize route:
// if (filename.includes('live_recording') || filename.endsWith('.webm')) {
//   const wavPath = inputPath.replace('.webm', '_16k.wav');
//   await normalizeLiveRecording(inputPath, wavPath);
//   inputPath = wavPath;
// }
