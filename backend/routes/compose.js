"use strict";
/**
 * GoMaa Raga Vidya v4.0 — /api/compose
 * Fixes:
 *   - Proper async DB operations
 *   - Western notation in generated compositions
 *   - Section-wise swara mapping
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

const { generateSwaraSequence } = require('../../core/ai/swaraEngine');
const { generateSheetMusicXml } = require('../../core/ai/sheetMusicEngine');
const { generateScoreXML } = require('../../core/ai/scoreEngine');
const { transliterateToTelugu } = require('../../core/ai/carnaticSegmenter');
const sqliteModule = require('../../core/db/sqlite');
const db = typeof sqliteModule === 'function' ? sqliteModule() : sqliteModule;

// In-memory raga cache
let RAGA_CACHE = null;
function getRagas() {
  if (RAGA_CACHE) return RAGA_CACHE;
  const raw = fs.readFileSync(path.join(__dirname, '../../models/raga_db.json'), 'utf8');
  RAGA_CACHE = JSON.parse(raw);
  return Array.isArray(RAGA_CACHE) ? RAGA_CACHE : (RAGA_CACHE.ragas || []);
}

// ── Keyword-based raga suggestion from lyrics ──
function suggestRagaFromLyrics(lyrics) {
  const text = (lyrics || '').toLowerCase();
  const ragas = getRagas();
  const scores = ragas.map(r => {
    let score = 0;
    const name = r.name.toLowerCase();
    // Direct mention
    if (text.includes(name)) score += 10;
    // Parent mention for janya
    if (r.parent && text.includes(r.parent.toLowerCase())) score += 5;
    // Character keywords
    if (r.character) {
      const chars = r.character.toLowerCase().split(/[,\s]+/);
      chars.forEach(c => { if (c && text.includes(c)) score += 3; });
    }
    // Mood keywords from common associations
    const moodMap = {
      'sindhu': ['ocean', 'water', 'flow', 'river', 'sea'],
      'hindolam': ['swing', 'joy', 'happy', 'festive'],
      'mohanam': ['love', 'beauty', 'gentle', 'soft', 'peacock'],
      'kalyani': ['blessing', 'auspicious', 'wedding', 'divine'],
      'sankarabharanam': ['royal', 'grand', 'majestic', 'golden'],
      'kharaharapriya': ['compassion', 'pathos', 'devotion', 'longing'],
      'todi': ['meditation', 'depth', 'serious', 'contemplation'],
      'bhairavi': ['devotion', 'bhakti', 'morning', 'dawn'],
      'kambhoji': ['playful', 'nature', 'cowherd', 'krishna'],
      'madhyamavati': ['peace', 'calm', 'evening', 'serenity']
    };
    const keywords = moodMap[name] || [];
    keywords.forEach(k => { if (text.includes(k)) score += 2; });
    return { raga: r, score };
  });
  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, 3).map(s => s.raga);
}

// ── POST /api/compose/analyze ──
router.post('/analyze', async (req, res) => {
  try {
    const { lyrics, title, composer, preferredRaga, preferredTala, instruments } = req.body;
    const text = (lyrics?.pallavi || lyrics || '').toString();

    // 1. Suggest ragas from lyrics
    const suggestions = suggestRagaFromLyrics(text);
    const selectedRaga = preferredRaga ? getRagas().find(r => r.name.toLowerCase() === preferredRaga.toLowerCase()) : (suggestions[0] || getRagas()[0]);
    const parentRaga = selectedRaga?.parent || null;
    const isJanya = !!parentRaga;

    // 2. Suggest tala
    const tala = preferredTala || 'Adi';

    // 3. Generate swaras
    const swaraResult = generateSwaraSequence(selectedRaga?.name || 'Unknown', tala, 'pallavi', 16, { includeGamaka: true, language: 'te' });

    // 4. Generate sahityam structure
    const sahityam = {
      pallavi: text,
      anupallavi: lyrics?.anupallavi || '',
      charanam1: lyrics?.charanam1 || '',
      charanam2: lyrics?.charanam2 || '',
      telugu: transliterateToTelugu(text)
    };

    // 5. Aarohana / Avarohana
    const aroha = Array.isArray(selectedRaga?.arohana) ? selectedRaga.arohana.join(' ') : (selectedRaga?.arohana || '');
    const avarohana = Array.isArray(selectedRaga?.avarohana) ? selectedRaga.avarohana.join(' ') : (selectedRaga?.avarohana || '');

    // 6. Generate sheet music
    const beatSwaras = (swaraResult.swaras || []).slice(0, 32).map((s, i) => ({
      swara: s, westernNote: swaraToWestern(s), gamaka: swaraResult.gamakas?.[i] || 'sustain', time: i * 0.5, confidence: 0.9
    }));
    const talaObj = { name: tala, beats: 8, sections: [4, 2, 2], clapOn: [true, false, false] };
    const carnaticSheet = generateSheetMusicXml(beatSwaras, talaObj, { label: selectedRaga?.name || 'Unknown', composer: composer || 'Unknown' });
    const westernSheet = generateScoreXML(selectedRaga?.name || 'Unknown', tala, 'pallavi', swaraResult, { includeGamaka: true, includeLyrics: true });

    // 7. Generate MIDI data (base64)
    const midiData = generateSimpleMidi(swaraResult.swaras || [], tala, selectedRaga?.name || 'Unknown');

    // 8. Audio composition JSON for frontend synthesizer
    const audioJson = generateAudioComposition(swaraResult, selectedRaga, tala, instruments || ['Veena', 'Flute'], text);

    // 9. Save to compositions table
    const compId = `compose_${Date.now()}`;
    await db.prepare(`INSERT INTO compositions (id, title, raga, janyaOf, tala, tempo, instruments, lyrics, swaras, sahityam, sheetMusicXml, westernSheetXml, midiB64, audioJson, approved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      compId, title || 'Untitled', selectedRaga?.name || 'Unknown', parentRaga, tala, 120,
      JSON.stringify(instruments || ['Veena']), JSON.stringify(lyrics), JSON.stringify(swaraResult.swaras),
      JSON.stringify(sahityam), carnaticSheet, westernSheet, midiData, JSON.stringify(audioJson), 0
    );

    res.json({
      success: true,
      compositionId: compId,
      suggestedRaga: selectedRaga?.name || 'Unknown',
      suggestedJanyaOf: parentRaga,
      isJanya,
      melakartaNum: selectedRaga?.melakarta || null,
      tala,
      instruments: instruments || ['Veena', 'Flute'],
      aroha,
      avarohana,
      swaras: swaraResult,
      sahityam,
      carnaticSheet,
      westernSheet,
      midiData,
      audioJson,
      systemRaga: selectedRaga?.name || 'Unknown',
      systemJanya: parentRaga
    });
  } catch (err) {
    console.error('[compose/analyze]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/compose/:id ──
router.get('/:id', async (req, res) => {
  try {
    const row = await db.prepare('SELECT * FROM compositions WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Composition not found' });
    res.json({
      ...row,
      lyrics: row.lyrics ? JSON.parse(row.lyrics) : null,
      swaras: row.swaras ? JSON.parse(row.swaras) : null,
      sahityam: row.sahityam ? JSON.parse(row.sahityam) : null,
      instruments: row.instruments ? JSON.parse(row.instruments) : [],
      audioJson: row.audioJson ? JSON.parse(row.audioJson) : null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Helpers ──
function swaraToWestern(s) {
  const map = { 'S': 'C', 'R1': 'C#', 'R2': 'D', 'R3': 'D#', 'G1': 'D#', 'G2': 'E', 'G3': 'F', 'M1': 'F', 'M2': 'F#', 'P': 'G', 'D1': 'G#', 'D2': 'A', 'D3': 'A#', 'N1': 'A#', 'N2': 'B', 'N3': 'C', ',': 'rest', '-': 'rest' };
  return map[s] || 'C';
}

function generateSimpleMidi(swaras, tala, ragaName) {
  // Returns a base64-encoded minimal MIDI-like structure (JSON for now, real MIDI can be added)
  const events = swaras.map((s, i) => ({ note: swaraToWestern(s), time: i * 0.5, duration: 0.4, velocity: 80 }));
  return Buffer.from(JSON.stringify({ format: 'gomaa-midi-v1', raga: ragaName, tala, events })).toString('base64');
}

function generateAudioComposition(swaraResult, raga, tala, instruments, lyrics) {
  // Generates a JSON score for the frontend Web Audio synthesizer
  const notes = (swaraResult.swaras || []).map((s, i) => ({
    swara: s,
    freq: swaraToFreq(s, raga?.name || 'Unknown'),
    time: i * 0.6,
    duration: 0.5,
    instrument: instruments[0] || 'Veena',
    gamaka: swaraResult.gamakas?.[i] || 'sustain'
  }));
  return {
    version: 'v5',
    raga: raga?.name || 'Unknown',
    tala,
    tempo: 120,
    instruments,
    notes,
    background: {
      type: 'himalaya-drone',
      baseFreq: 110, // A2 drone
      harmonics: [1, 2, 3, 5],
      volume: 0.15
    },
    kokila: {
      type: 'bird-ornament',
      enabled: true,
      frequency: 2000,
      interval: 4, // every 4 beats
      volume: 0.08
    },
    lyrics: lyrics || ''
  };
}

function swaraToFreq(swara, ragaName) {
  // Simplified: assumes C-based tonic for demo; real implementation would use shruti detection
  const baseFreq = 261.63; // C4
  const semitoneMap = { 'S': 0, 'R1': 1, 'R2': 2, 'R3': 3, 'G1': 1, 'G2': 2, 'G3': 3, 'M1': 5, 'M2': 6, 'P': 7, 'D1': 8, 'D2': 9, 'D3': 10, 'N1': 8, 'N2': 9, 'N3': 10, ',': -1, '-': -1 };
  const st = semitoneMap[swara];
  if (st === undefined || st < 0) return 0;
  return baseFreq * Math.pow(2, st / 12);
}

module.exports = router;