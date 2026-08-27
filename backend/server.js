'use strict';
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit:'500mb' }));
app.use(express.urlencoded({ extended:true, limit:'500mb' }));

app.use(express.static(path.join(__dirname,'../apps/web')));

app.use('/api/recognize', require('./routes/recognize'));
app.use('/api/search',    require('./routes/search'));
app.use('/api/compose',   require('./routes/compose'));
app.use('/api/dataset',   require('./routes/dataset'));
app.use('/api/ingest',    require('./routes/ingest'));
app.use('/api/recognize/scale', require('./routes/scale'));
app.use('/api/transcribe',      require('./routes/transcribe'));

app.get('/api/health', (_req,res)=>{
  res.json({ status:'ok', app:'GoMaa Raga Vidya v3', version:'3.0.0',
             timestamp:new Date().toISOString() });
});
app.get('/api/ragas', (_req,res)=>{
  res.json(require('../models/knowledge_base.json'));
});

app.get('/api/sheet/:compositionId', async(req,res)=>{
  const db = require('../core/db/sqlite');
  await db.getDb();
  const row = db.get('SELECT sheetMusicXml,title FROM compositions WHERE id=?',[req.params.compositionId]);
  if(!row||!row.sheetMusicXml) return res.status(404).send('not found');
  res.setHeader('Content-Type','application/xml');
  res.setHeader('Content-Disposition',`attachment; filename="${(row.title||'composition').replace(/[^a-z0-9]/gi,'_')}.musicxml"`);
  res.send(row.sheetMusicXml);
});

app.get('/api/midi/:compositionId', async(req,res)=>{
  const db = require('../core/db/sqlite');
  await db.getDb();
  const row = db.get('SELECT midiB64,title FROM compositions WHERE id=?',[req.params.compositionId]);
  if(!row||!row.midiB64) return res.status(404).send('not found');
  res.setHeader('Content-Type','audio/midi');
  res.setHeader('Content-Disposition',`attachment; filename="${(row.title||'composition').replace(/[^a-z0-9]/gi,'_')}.mid"`);
  res.send(Buffer.from(row.midiB64,'base64'));
});

app.get('/api/analysis/:id', async (req, res) => {
  try {
    const db = require('../core/db/sqlite');
    await db.getDb();
    const row = db.get('SELECT * FROM music WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const result = JSON.parse(row.analysisJson || '{}');
    res.json({ ...result, id: row.id, savedAt: row.createdAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/analyses', async (_req, res) => {
  try {
    const db = require('../core/db/sqlite');
    await db.getDb();
    const rows = db.all('SELECT id, title, raga, ragaNumber, createdAt FROM music ORDER BY createdAt DESC LIMIT 100');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('*',(_req,res)=>{
  res.sendFile(path.join(__dirname,'../apps/web/index.html'));
});

const PORT = process.env.PORT||3000;
app.listen(PORT,()=>{
  console.log(`\n🎼  GoMaa Raga Vidya v3  →  http://localhost:${PORT}\n`);
});
module.exports=app;
