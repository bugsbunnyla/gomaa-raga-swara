const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'apps', 'web')));

const upload = multer({ dest: path.join(__dirname, '..', 'uploads') });

const recognizeRouter = require('./routes/recognize');
const searchRouter = require('./routes/search');
const ragasRouter = require('./routes/ragas');
const composeRouter = require('./routes/compose');
const approveRouter = require('./routes/approve');
const transcribeRouter = require('./routes/transcribe');
const scaleRouter = require('./routes/scale');

app.use('/api/recognize', upload.single('audio'), recognizeRouter);
app.use('/api/search', searchRouter);
app.use('/api/ragas', ragasRouter);
app.use('/api/compose', composeRouter);
app.use('/api/approve', approveRouter);
app.use('/api/transcribe', upload.single('audio'), transcribeRouter);
app.use('/api/scale', scaleRouter);

app.get('/api/ragas-chart', async (req, res) => {
  try {
    const data = await fs.promises.readFile(path.join(__dirname, '..', 'models', 'raga_db.json'), 'utf8');
    const ragas = JSON.parse(data);
    const enriched = ragas.map(r => ({ ...r, janyas: r.janyas || ragas.filter(j => j.parent === r.name).map(j => j.name) }));
    res.json(enriched);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Saved list (includes approval status) ──
app.get('/api/saved', async (req, res) => {
  try {
    const sqliteModule = require('../core/db/sqlite');
    const db = typeof sqliteModule === 'function' ? sqliteModule() : sqliteModule;
    const approvedOnly = req.query.approved === '1';
    let sql = 'SELECT * FROM music WHERE 1=1';
    const params = [];
    if (approvedOnly) { sql += ' AND approved = 1'; }
    sql += ' ORDER BY createdAt DESC LIMIT 100';
    const rows = await db.prepare(sql).all(...params);
    if (typeof db.close === 'function') db.close();
    res.json(rows.map(r => ({
      id: r.id, title: r.title, filename: r.filename, artist: r.artist, composer: r.composer,
      raga: r.raga, ragaNumber: r.ragaNumber, ragaId: r.ragaId, janyaOf: r.janyaOf,
      tala: r.tala, tempo: r.tempo, duration: r.duration, approved: r.approved,
      approvedAt: r.approvedAt, approvedBy: r.approvedBy,
      created_at: r.createdAt ? new Date(r.createdAt * 1000).toISOString() : null,
      audioUrl: r.filePath, sahityam: r.sahityam,
      lyricsJson: r.lyricsJson ? JSON.parse(r.lyricsJson) : null,
      analysisJson: r.analysisJson ? JSON.parse(r.analysisJson) : null,
      transcriptionJson: r.transcriptionJson ? JSON.parse(r.transcriptionJson) : null,
      aroha: r.aroha, avaroha: r.avarohana, sheetMusic: r.sheetMusic, midiData: r.midiData
    })));
  } catch (err) { console.error('[api/saved]', err.message); res.json([]); }
});

// ── Approved list for model training ──
app.get('/api/approved', async (req, res) => {
  try {
    const sqliteModule = require('../core/db/sqlite');
    const db = typeof sqliteModule === 'function' ? sqliteModule() : sqliteModule;
    const rows = await db.prepare('SELECT * FROM music WHERE approved = 1 ORDER BY approvedAt DESC LIMIT 500').all();
    if (typeof db.close === 'function') db.close();
    res.json({ count: rows.length, results: rows.map(r => ({ ...r, created_at: r.createdAt ? new Date(r.createdAt * 1000).toISOString() : null })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/compositions', async (req, res) => {
  try {
    const data = await fs.promises.readFile(path.join(__dirname, '..', 'models', 'composition_db.json'), 'utf8');
    res.json(JSON.parse(data));
  } catch (err) { res.status(500).json({ error: 'Failed to load composition DB' }); }
});

app.post('/api/compositions', async (req, res) => {
  try {
    const compPath = path.join(__dirname, '..', 'models', 'composition_db.json');
    const db = JSON.parse(await fs.promises.readFile(compPath, 'utf8'));
    const idx = db.findIndex(c => c.title?.toLowerCase() === req.body.title?.toLowerCase() && c.raga === req.body.raga);
    if (idx >= 0) db[idx] = { ...db[idx], ...req.body, updated: new Date().toISOString() };
    else db.push({ ...req.body, created: new Date().toISOString() });
    await fs.promises.writeFile(compPath, JSON.stringify(db, null, 2));
    res.json({ success: true, id: req.body.id });
  } catch (err) { console.error('[api/compositions]', err); res.status(500).json({ error: err.message }); }
});

app.post('/api/compositions/reload', (req, res) => {
  try {
    delete require.cache[require.resolve(path.join(__dirname, '..', 'models', 'composition_db.json'))];
    global.compositionDB = require(path.join(__dirname, '..', 'models', 'composition_db.json'));
    res.json({ success: true, count: global.compositionDB.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ANN index build
(async () => {
  try {
    const { buildIndex } = require('../core/vector/annIndex');
    const sqliteModule = require('../core/db/sqlite');
    const db = typeof sqliteModule === 'function' ? sqliteModule() : sqliteModule;
    const rows = await db.prepare('SELECT id, chromaVector, title, raga FROM music WHERE chromaVector IS NOT NULL LIMIT 500').all();
    if (typeof db.close === 'function') db.close();
    if (rows && rows.length) { buildIndex(rows); console.log(`[GoMaa] ANN index: ${rows.length} entries`); }
  } catch (e) { console.warn('[GoMaa] ANN index skipped:', e.message); }
})();

app.use((err, req, res, next) => { console.error('[server]', err); res.status(500).json({ error: 'Internal server error' }); });
app.listen(PORT, () => console.log(`[GoMaa] Server on http://localhost:${PORT}`));