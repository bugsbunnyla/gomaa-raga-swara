const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const sqliteModule = require('../../core/db/sqlite');
const db = typeof sqliteModule === 'function' ? sqliteModule() : sqliteModule;
const { addToIndex } = require('../../core/vector/annIndex');

// Ensure approved folder exists
const approvedDir = path.join(__dirname, '..', '..', 'models', 'approved');
if (!fs.existsSync(approvedDir)) fs.mkdirSync(approvedDir, { recursive: true });

// ── POST /api/approve/:id ──
router.post('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const user = req.body.user || 'system';

    // Get the music record
    const row = await db.prepare('SELECT * FROM music WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Recording not found' });

    // Already approved?
    if (row.approved) return res.json({ success: true, message: 'Already approved', id });

    // Copy audio to approved folder
    let approvedPath = null;
    if (row.filePath && fs.existsSync(row.filePath)) {
      const ext = path.extname(row.filePath) || '.mp3';
      approvedPath = path.join(approvedDir, `${id}_${row.raga || 'unknown'}${ext}`);
      fs.copyFileSync(row.filePath, approvedPath);
      console.log(`[Approve] Copied audio to: ${approvedPath}`);
    }

    // Update DB
    await db.prepare('UPDATE music SET approved = 1, approvedAt = ?, approvedBy = ?, filePath = COALESCE(?, filePath) WHERE id = ?')
      .run(Math.floor(Date.now() / 1000), user, approvedPath, id);

    // Add to ANN index for training search
    try {
      if (row.chromaVector) {
        const chroma = typeof row.chromaVector === 'string' ? JSON.parse(row.chromaVector) : row.chromaVector;
        addToIndex(id, chroma, { title: row.title, raga: row.raga, approved: true });
      }
    } catch (e) { console.warn('[Approve] ANN index add failed:', e.message); }

    res.json({ success: true, id, approvedPath, message: 'Recording approved and added to trained model' });
  } catch (err) {
    console.error('[Approve]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/approve/unapprove/:id ──
router.post('/unapprove/:id', async (req, res) => {
  try {
    const id = req.params.id;
    await db.prepare('UPDATE music SET approved = 0, approvedAt = NULL, approvedBy = NULL WHERE id = ?').run(id);
    res.json({ success: true, id, message: 'Approval revoked' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;