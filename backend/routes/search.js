'use strict';
const express = require('express');
const router = express.Router();
const sqliteModule = require('../../core/db/sqlite');
const db = typeof sqliteModule === 'function' ? sqliteModule() : sqliteModule;
const { searchANN, addToIndex } = require('../../core/vector/annIndex');

router.get('/', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const raga = (req.query.raga || '').trim();
    const janya = (req.query.janya || '').trim();
    const melakartaNum = req.query.melakartaNum ? parseInt(req.query.melakartaNum, 10) : null;
    const mood = (req.query.mood || '').trim();
    const tala = (req.query.tala || '').trim();
    const composer = (req.query.composer || '').trim();
    const limit = Math.min(parseInt(req.query.limit) || 40, 100);

    let sql = `SELECT id, title, filename, artist, composer, raga, ragaNumber, ragaId, janyaOf,
      aroha, avarohana, mood, tala, tempo, duration, filePath,
      chromaVector, analysisJson, lyricsJson, sahityam, createdAt
      FROM music WHERE 1=1`;
    const params = [];

    if (q) {
      sql += ` AND (lower(title) LIKE ? OR lower(artist) LIKE ? OR lower(composer) LIKE ?
        OR lower(raga) LIKE ? OR lower(sahityam) LIKE ? OR lower(lyricsJson) LIKE ?
        OR lower(analysisJson) LIKE ?)`;
      const lq = `%${q.toLowerCase()}%`;
      params.push(lq, lq, lq, lq, lq, lq, lq);
    }
    if (raga) { sql += ' AND lower(raga) LIKE ?'; params.push(`%${raga.toLowerCase()}%`); }
    if (janya) { sql += ' AND lower(janyaOf) LIKE ?'; params.push(`%${janya.toLowerCase()}%`); }
    if (melakartaNum) { sql += ' AND ragaNumber = ?'; params.push(melakartaNum); }
    if (mood) { sql += ' AND lower(mood) LIKE ?'; params.push(`%${mood.toLowerCase()}%`); }
    if (tala) { sql += ' AND lower(tala) LIKE ?'; params.push(`%${tala.toLowerCase()}%`); }
    if (composer) { sql += ' AND lower(composer) LIKE ?'; params.push(`%${composer.toLowerCase()}%`); }
    sql += ' ORDER BY createdAt DESC LIMIT ?'; params.push(limit);

    const rows = await db.prepare(sql).all(...params);

    // Semantic vector search
    let vids = new Set();
    if (q) {
      try {
        const queryVec = textToChromaEmbedding(q);
        const vr = searchANN(queryVec, 20);
        vr.forEach(r => vids.add(r.id));
      } catch (e) {}
    }
    const seen = new Set(rows.map(r => r.id));
    for (const vid of vids) {
      if (!seen.has(vid)) {
        const row = await db.prepare('SELECT * FROM music WHERE id = ?').get(vid);
        if (row) { rows.push(row); seen.add(vid); }
      }
    }

    res.json({
      count: rows.length,
      results: rows.map(r => ({
        ...r,
        lyricsJson: r.lyricsJson ? JSON.parse(r.lyricsJson) : null,
        analysisJson: r.analysisJson ? JSON.parse(r.analysisJson) : null,
        created_at: r.createdAt ? new Date(r.createdAt * 1000).toISOString() : null
      }))
    });
  } catch (e) { console.error('[search]', e.message); res.status(500).json({ error: e.message }); }
});

router.get('/suggest', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) return res.json([]);
    const lq = `%${q.toLowerCase()}%`;
    const items = [];
    const ragas = await db.prepare('SELECT DISTINCT raga, ragaNumber, janyaOf FROM music WHERE lower(raga) LIKE ? ORDER BY ragaNumber LIMIT 6', [lq]);
    (ragas || []).forEach(r => items.push({ type: 'raga', value: r.raga, number: r.ragaNumber, janyaOf: r.janyaOf }));
    const titles = await db.prepare('SELECT title, raga FROM music WHERE lower(title) LIKE ? LIMIT 5', [lq]);
    (titles || []).forEach(t => items.push({ type: 'song', value: t.title, raga: t.raga }));
    const composers = await db.prepare('SELECT DISTINCT composer FROM music WHERE lower(composer) LIKE ? AND composer IS NOT NULL LIMIT 4', [lq]);
    (composers || []).forEach(c => items.push({ type: 'composer', value: c.composer }));
    const artists = await db.prepare('SELECT DISTINCT artist FROM music WHERE lower(artist) LIKE ? AND artist IS NOT NULL LIMIT 4', [lq]);
    (artists || []).forEach(a => items.push({ type: 'artist', value: a.artist }));
    const janyas = await db.prepare('SELECT DISTINCT janyaOf FROM music WHERE lower(janyaOf) LIKE ? AND janyaOf IS NOT NULL LIMIT 4', [lq]);
    (janyas || []).forEach(j => items.push({ type: 'janya', value: j.janyaOf }));
    res.json(items.slice(0, 12));
  } catch (e) { console.error('[search/suggest]', e.message); res.status(500).json({ error: e.message }); }
});

router.get('/ragas', async (req, res) => {
  try {
    const rows = await db.prepare('SELECT DISTINCT raga, ragaNumber, janyaOf, aroha, avarohana, mood FROM music WHERE raga IS NOT NULL ORDER BY ragaNumber').all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function textToChromaEmbedding(text) {
  const vec = new Array(12).fill(0);
  const swaraMap = { 's': 0, 'r1': 1, 'r2': 2, 'r3': 3, 'g1': 1, 'g2': 2, 'g3': 3, 'm1': 4, 'm2': 5, 'p': 6, 'd1': 7, 'd2': 8, 'd3': 9, 'n1': 7, 'n2': 8, 'n3': 9 };
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/);
  for (const t of tokens) { if (swaraMap[t] !== undefined) vec[swaraMap[t]] += 1; }
  const sum = vec.reduce((a, b) => a + b, 0) || 1;
  return vec.map(v => v / sum);
}

module.exports = router;