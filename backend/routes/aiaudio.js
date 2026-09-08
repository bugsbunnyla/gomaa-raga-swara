/**
 * GoMaa Raga Vidya v6.1.2 — aiaudio.js
 * /voices, /compose, /midi/:id, /play, /generate endpoints
 */
const express = require('express');
const router = express.Router();
const path = require('path');

const { VOICE_PROFILES, generateSMF, generateAudioComposition } = require('../../core/ai/aiaudio-engine');
const { generateSwaraSequence } = require('../../core/ai/swaraEngine');
const { generateBinauralBeat } = require('../../core/ai/brainwave');
const sqliteModule = require('../../core/db/sqlite');
const db = typeof sqliteModule === 'function' ? sqliteModule() : sqliteModule;

router.get('/voices', (req, res) => {
  const grouped = {};
  for (const [name, profile] of Object.entries(VOICE_PROFILES)) {
    if (!grouped[profile.category]) grouped[profile.category] = [];
    grouped[profile.category].push({ name, ...profile });
  }
  res.json({ success: true, voices: grouped, categories: Object.keys(grouped) });
});

router.post('/compose', async (req, res) => {
  try {
    const { raga, tala, voice, lyrics, tempo, brainwavePreset } = req.body;
    const swaraResult = generateSwaraSequence(raga || 'Unknown', tala || 'Adi', 'pallavi', 16, { includeGamaka: true, language: 'te' });
    const audioJson = generateAudioComposition(swaraResult, { name: raga }, tala, voice || 'Divine Female', lyrics, { tempo: tempo || 120 });
    if (brainwavePreset && brainwavePreset !== 'none') {
      const bw = generateBinauralBeat(brainwavePreset, 30);
      audioJson.brainwave = { preset: brainwavePreset, duration: 30, carrier: bw.preset.carrier };
    }
    const compId = `aivoice_${Date.now()}`;
    await db.prepare(`INSERT INTO ai_compositions (id, raga, tala, voice, tempo, audioJson, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(compId, raga, tala, voice, tempo || 120, JSON.stringify(audioJson), Math.floor(Date.now() / 1000));
    res.json({ success: true, compositionId: compId, audioJson });
  } catch (err) {
    console.error('[aivoice/compose]', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/midi/:id', async (req, res) => {
  try {
    const row = await db.prepare('SELECT audioJson FROM ai_compositions WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Composition not found' });
    const audioJson = JSON.parse(row.audioJson);
    const notes = audioJson.notes || [];
    const midiBuffer = generateSMF(notes, {
      tempo: audioJson.tempo || 120,
      ragaName: audioJson.raga,
      talaName: audioJson.tala,
      voiceName: audioJson.voice
    });
    res.setHeader('Content-Type', 'audio/midi');
    res.setHeader('Content-Disposition', `attachment; filename="gomaa_${audioJson.raga}_${req.params.id}.mid"`);
    res.send(midiBuffer);
  } catch (err) {
    console.error('[aivoice/midi]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/generate', async (req, res) => {
  try {
    const { notes, raga, tala, voice, tempo } = req.body;
    const midiBuffer = generateSMF(notes, { tempo: tempo || 120, ragaName: raga, talaName: tala, voiceName: voice });
    res.json({ success: true, midiBase64: midiBuffer.toString('base64'), format: 'SMF0' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/play', (req, res) => {
  const { raga, tala, voice, lyrics, tempo } = req.body;
  const swaraResult = generateSwaraSequence(raga || 'Unknown', tala || 'Adi', 'pallavi', 16, { includeGamaka: true });
  const audioJson = generateAudioComposition(swaraResult, { name: raga }, tala, voice || 'Divine Female', lyrics, { tempo: tempo || 120 });
  res.json({ success: true, audioJson });
});

module.exports = router;
