const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const sqliteModule = require('../../core/db/sqlite');
const db = typeof sqliteModule === 'function' ? sqliteModule() : sqliteModule;
let RAGA_CACHE = null;
function getRagaCache() {
  if (RAGA_CACHE) return RAGA_CACHE;
  const raw = fs.readFileSync(path.join(__dirname, '../../models/raga_db.json'), 'utf8');
  const data = JSON.parse(raw);
  RAGA_CACHE = Array.isArray(data) ? data : (data.ragas || []);
  return RAGA_CACHE;
}

router.get('/lookup', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    if (!q) return res.status(400).json({ error: 'Query required' });
    const ragas = getRagaCache();
    let match = ragas.find(r => r.name.toLowerCase() === q) || ragas.find(r => (r.aliases || []).some(a => a.toLowerCase() === q));
    if (!match) {
      const row = await db.prepare('SELECT * FROM ragas WHERE lower(name) = ? OR lower(id) = ?').get(q, q);
      if (!row) return res.status(404).json({ error: 'Raga not found' });
      return res.json({ id: row.id, name: row.name, melakartaNum: row.melakartaNum, parent: row.parent, isJanya: !row.isMelakarta, isMelakarta: !!row.isMelakarta, aroha: row.aroha, avarohana: row.avarohana, westernEquiv: row.westernEquiv, character: row.character });
    }
    let melakarta = null;
    if (match.parent) melakarta = ragas.find(r => r.name === match.parent);
    else if (match.melakarta) melakarta = ragas.find(r => r.melakarta === match.melakarta && !r.parent);
    const janyas = ragas.filter(r => r.parent === match.name).map(r => r.name);
    res.json({
      id: match.name, name: match.name, melakartaNum: match.melakarta || (melakarta ? melakarta.melakarta : null),
      parent: match.parent || null, isJanya: !!match.parent, isMelakarta: !match.parent,
      aroha: Array.isArray(match.arohana) ? match.arohana.join(' ') : match.arohana,
      avarohana: Array.isArray(match.avarohana) ? match.avarohana.join(' ') : match.avarohana,
      frequencyMap: match.frequency_map || null, westernEquiv: match.western_equiv || null,
      character: match.character || null, janyas: janyas.length ? janyas : null,
      melakartaInfo: melakarta ? { name: melakarta.name, aroha: Array.isArray(melakarta.arohana) ? melakarta.arohana.join(' ') : melakarta.arohana, avarohana: Array.isArray(melakarta.avarohana) ? melakarta.avarohana.join(' ') : melakarta.avarohana } : null
    });
  } catch (err) { console.error('[ragas/lookup]', err.message); res.status(500).json({ error: err.message }); }
});

router.get('/melakarta/:num', async (req, res) => {
  try {
    const num = parseInt(req.params.num, 10);
    const ragas = getRagaCache();
    const melakarta = ragas.find(r => r.melakarta === num && !r.parent);
    if (!melakarta) return res.status(404).json({ error: 'Melakarta not found' });
    const janyas = ragas.filter(r => r.parent === melakarta.name);
    res.json({ ...melakarta, janyas: janyas.map(j => j.name) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/janya/:parent', async (req, res) => {
  try {
    const parent = req.params.parent.toLowerCase();
    const ragas = getRagaCache();
    res.json(ragas.filter(r => r.parent && r.parent.toLowerCase() === parent));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;