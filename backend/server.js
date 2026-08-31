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
