const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const https = require('https');
const { generateSegmentSwaras } = require('../swaragen');

// Try to load ytdl-core for YouTube detection (optional — graceful fallback)
let ytdl;
try { ytdl = require('ytdl-core'); } catch (e) { ytdl = null; }

// Live recording normalization via ffmpeg
let ffmpeg, ffmpegStatic;
try {
  ffmpeg = require('fluent-ffmpeg');
  ffmpegStatic = require('ffmpeg-static');
} catch (e) {
  console.warn('[recognize] fluent-ffmpeg not installed. Live recording normalization disabled.');
}

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

// Helper: detect YouTube URL
function isYouTubeUrl(url) {
  return /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)/.test(url);
}

// Helper: detect direct audio URL
function isDirectAudioUrl(url) {
  return /\.(mp3|wav|ogg|webm|m4a|flac)(\?.*)?$/i.test(url);
}

// Helper: quick 10s YouTube metadata probe
async function probeYouTube(url) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ blocked: true, reason: 'Timed out after 10s' }), 10000);
    if (!ytdl) { clearTimeout(timeout); resolve({ blocked: true, reason: 'ytdl-core not installed' }); return; }
    ytdl.getBasicInfo(url)
      .then(() => { clearTimeout(timeout); resolve({ blocked: false }); })
      .catch(() => { clearTimeout(timeout); resolve({ blocked: true, reason: 'YouTube is actively blocking automated downloads' }); });
  });
}

// Helper: download direct audio URL to temp file
function downloadUrl(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      if (response.statusCode !== 200) { reject(new Error(`HTTP ${response.statusCode}`)); return; }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
    }).on('error', reject);
  });
}

// ==================== MAIN RECOGNIZE HANDLER ====================
router.post('/', async (req, res) => {
  try {
    const hasFile = req.file || (req.files && req.files.audio);
    const url = req.body?.url?.trim();
    let inputPath = null;
    let filename = 'unknown';
    let source = 'unknown';

    // -------- URL handling --------
    if (url && !hasFile) {
      console.log('[GoMaa] URL provided:', url);

      // YouTube URL: fast fail with instructions
      if (isYouTubeUrl(url)) {
        console.log('[GoMaa] YouTube URL detected:', url);
        const probe = await probeYouTube(url);
        if (probe.blocked) {
          console.log('[GoMaa] YouTube metadata test failed:', probe.reason);
          return res.status(400).json({
            error: 'YouTube is actively blocking automated downloads. Please download the audio manually: run yt-dlp -x --audio-format mp3 "' + url + '" then upload the MP3 file here.'
          });
        }
        // If not blocked, you could add yt-dlp download here, but we recommend manual upload
        return res.status(400).json({
          error: 'YouTube downloads are blocked. Please download manually with yt-dlp -x --audio-format mp3 "' + url + '" then upload the MP3.'
        });
      }

      // Direct audio URL: download via Node https
      if (isDirectAudioUrl(url)) {
        console.log('[GoMaa] Direct audio URL detected:', url);
        const tempDir = path.join(__dirname, '..', '..', 'temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const ext = path.extname(new URL(url).pathname) || '.mp3';
        inputPath = path.join(tempDir, `download_${Date.now()}${ext}`);
        await downloadUrl(url, inputPath);
        filename = path.basename(inputPath);
        source = 'url';
      } else {
        return res.status(400).json({ error: 'Unsupported URL. Please provide a direct audio URL (.mp3, .wav, etc.) or upload a file.' });
      }
    }

    // -------- File upload handling --------
    if (hasFile) {
      inputPath = req.file?.path || req.files.audio[0].path;
      filename = req.file?.originalname || req.files.audio[0].originalname || 'upload';
      source = 'upload';
    }

    if (!inputPath) {
      return res.status(400).json({ error: 'No file or valid URL provided.' });
    }

    console.log(`[GoMaa v4.0.2] Analysing: ${filename} (source: ${source})`);

    // Normalize live recordings / WebM to 16kHz WAV for Whisper
    if (ffmpeg && (filename.includes('live_recording') || filename.endsWith('.webm'))) {
      const wavPath = inputPath.replace(/\.webm$/i, '_16k.wav');
      try {
        await normalizeLiveRecording(inputPath, wavPath);
        inputPath = wavPath;
        console.log('[GoMaa] Live recording normalized to:', inputPath);
      } catch (normErr) {
        console.warn('[GoMaa] Normalization failed, using original:', normErr.message);
      }
    }

    // ------------------------------------------------------------------
    // INSERT YOUR EXISTING ANALYSIS PIPELINE HERE:
    // 1. Load audio (e.g., via wav decoder or ffmpeg)
    // 2. YIN pitch detection
    // 3. Comb-filter beat detection
    // 4. Composition DB match
    // 5. generateSegmentSwaras(audioDuration, composition, raga, pitchData)
    // 6. Build response with raga, tala, composer, aroha, avaroha, segments, sahityam
    // ------------------------------------------------------------------

    // Example response structure (replace with your actual analysis result):
    const analysisResult = {
      success: true,
      title: filename,
      raga: 'Unknown',
      tala: 'Unknown',
      composer: 'Unknown',
      duration: 0,
      source: source,
      segments: [],
      sahityam: {},
      aroha: '',
      avaroha: '',
      audioUrl: source === 'url' ? req.body.url : undefined
    };

    // ------------------------------------------------------------------
    // DB SAVE (with new columns)
    // ------------------------------------------------------------------
    try {
      const dbPath = path.join(__dirname, '..', '..', 'models', 'music.db');
      const sqliteModule = require('../../core/db/sqlite');   // ← was '../core/db/sqlite' (wrong)
      const db = typeof sqliteModule === 'function' ? sqliteModule(dbPath) : sqliteModule;
      const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const insert = db.prepare(`
        INSERT INTO music (id, filename, originalName, compositionId, title, raga, tala, composer, duration, sahityam)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      await insert.run(
        id,
        filename,
        filename,
        analysisResult.title || null,
        analysisResult.title || null,
        analysisResult.raga || null,
        analysisResult.tala || null,
        analysisResult.composer || null,
        analysisResult.duration || 0,
        JSON.stringify(analysisResult.sahityam || {})
      );
      console.log(`[GoMaa v4.0.2] Saved to DB: ${id}`);
      if (typeof db.close === 'function') db.close();
    } catch (dbErr) {
      console.log('[GoMaa] DB save failed (non-fatal):', dbErr.message);
    }
    res.json(analysisResult);
  } catch (err) {
    console.error('[GoMaa] Recognize error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
