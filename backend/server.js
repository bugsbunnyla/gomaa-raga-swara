const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files (frontend)
app.use(express.static(path.join(__dirname, '..', 'apps', 'web')));

// Import routes
const recognizeRouter = require('./routes/recognize');
app.use('/api/recognize', recognizeRouter);

// ==================== RAGA CHART API ====================
app.get('/api/ragas', async (req, res) => {
  try {
    const ragaDbPath = path.join(__dirname, '..', 'models', 'raga_db.json');
    const data = await fs.promises.readFile(ragaDbPath, 'utf8');
    const ragas = JSON.parse(data);
    const enriched = ragas.map(r => ({
      ...r,
      janyas: r.janyas || ragas.filter(j => j.parent === r.name).map(j => j.name)
    }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== SAVED LIST API ====================
app.get('/api/saved', async (req, res) => {
  try {
    const dbPath = path.join(__dirname, '..', 'models', 'music.db');
    const sqliteModule = require('../core/db/sqlite');
    const db = typeof sqliteModule === 'function' ? sqliteModule(dbPath) : sqliteModule;
    const rows = db.prepare('SELECT * FROM music ORDER BY created_at DESC LIMIT 100').all();
    if (typeof db.close === 'function') db.close();
    res.json(rows.map(r => ({
      ...r,
      sahityam: r.sahityam ? JSON.parse(r.sahityam) : null
    })));
  } catch (err) {
    console.error('[api/saved] Error:', err.message);
    res.json([]);
  }
});

// ==================== COMPOSITION CRUD + RELOAD ====================
app.get('/api/compositions', async (req, res) => {
  try {
    const data = await fs.promises.readFile(path.join(__dirname, '..', 'models', 'composition_db.json'), 'utf8');
    res.json(JSON.parse(data));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load composition DB' });
  }
});

app.post('/api/compositions', async (req, res) => {
  try {
    const compPath = path.join(__dirname, '..', 'models', 'composition_db.json');
    const data = await fs.promises.readFile(compPath, 'utf8');
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
    await fs.promises.writeFile(compPath, JSON.stringify(db, null, 2));
    res.json({ success: true, id: req.body.id });
  } catch (err) {
    console.error('[api/compositions] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/compositions/reload', (req, res) => {
  try {
    delete require.cache[require.resolve(path.join(__dirname, '..', 'models', 'composition_db.json'))];
    const fresh = require(path.join(__dirname, '..', 'models', 'composition_db.json'));
    global.compositionDB = fresh;
    res.json({ success: true, count: fresh.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== ERROR HANDLING ====================
app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`[GoMaa] Server running on http://localhost:${PORT}`);
});
