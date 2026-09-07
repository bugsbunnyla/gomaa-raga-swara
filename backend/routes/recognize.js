const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { decodeAudio } = require('../../core/audio/audioDecode');
const { getAudioMetadata } = require('../../core/audio/audioMeta');
const { detectBeatCombFilter } = require('../../core/ai/beatEngine');
const { detectTala } = require('../../core/ai/talaDetect');
const { analysePitch, extractDirectionalSemis } = require('../../core/ai/pitchDetect');
const { detectRagaEnhanced } = require('../../core/ai/ragaEngine');
const { detectScaleBayesian } = require('../../core/ai/scaleEngine');
const { generateSwaraSequence } = require('../../core/ai/swaraEngine');
const { generateSheetMusicXml } = require('../../core/ai/sheetMusicEngine');
const { generateScoreXML } = require('../../core/ai/scoreEngine');
const { transliterateToTelugu } = require('../../core/ai/carnaticSegmenter');
const { generateSegmentSwaras } = require('../swaragen');
const { addToIndex } = require('../../core/vector/annIndex');
const { downloadFromUrl } = require('../utils/download');
const sqliteModule = require('../../core/db/sqlite');
const db = typeof sqliteModule === 'function' ? sqliteModule() : sqliteModule;

let ffmpeg = null, ffmpegStatic = null;
try {
  ffmpeg = require('fluent-ffmpeg');
  ffmpegStatic = require('ffmpeg-static');
  if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);
} catch (e) { console.warn('[recognize] fluent-ffmpeg not installed.'); }

async function normalizeLiveRecording(inputPath, outputPath) {
  if (!ffmpeg || !ffmpegStatic) throw new Error('FFmpeg unavailable');
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath).audioFrequency(16000).audioChannels(1)
      .audioCodec('pcm_s16le').format('wav')
      .on('end', () => resolve(outputPath)).on('error', reject).save(outputPath);
  });
}

function getUploadedFile(req) {
  if (req.file) return req.file;
  if (req.files?.audio) return Array.isArray(req.files.audio) ? req.files.audio[0] : req.files.audio;
  return null;
}

function findPython() {
  const candidates = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python'];
  const { execSync } = require('child_process');
  for (const py of candidates) { try { execSync(py + ' -V', { stdio: 'ignore' }); return py; } catch (_) {} }
  return candidates[0];
}
const PY = findPython();
const TRANSCRIBE_SCRIPT = path.join(__dirname, '../../core/ai/transcribe.py');

async function transcribeAudio(filePath, opts = {}) {
  return new Promise((resolve) => {
    const args = [TRANSCRIBE_SCRIPT, filePath];
    if (opts.model) args.push('--model', opts.model);
    if (opts.language) args.push('--language', opts.language);
    if (opts.wordTimestamps) args.push('--word-timestamps');
    args.push('--output-format', 'json');
    const proc = spawn(PY, args, { timeout: 600000, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    let out = [], err = [];
    proc.stdout.on('data', d => out.push(d));
    proc.stderr.on('data', d => err.push(d));
    proc.on('close', code => {
      const outStr = Buffer.concat(out).toString('utf8').trim();
      if (code !== 0) {
        const errStr = Buffer.concat(err).toString('utf8').trim();
        console.error('[Transcribe] Python exited', code, errStr.slice(0, 400));
        return resolve({ error: errStr || `Exit ${code}`, text: '', words: [] });
      }
      try {
        const result = JSON.parse(outStr);
        resolve({ text: result.text || '', words: result.words || [], language: result.language || 'auto' });
      } catch (e) { resolve({ error: 'JSON parse error', text: '', words: [] }); }
    });
    proc.on('error', e => resolve({ error: e.message, text: '', words: [] }));
  });
}

async function runUnifiedProcessor(audioPath) {
  const script = path.join(__dirname, '../../core/ai/unified_processor.py');
  if (!fs.existsSync(script)) return null;
  return new Promise((resolve) => {
    const proc = spawn(PY, [script, audioPath, '16000', path.dirname(audioPath), 'small'], { timeout: 300000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    let out = [];
    proc.stdout.on('data', d => out.push(d));
    proc.on('close', code => {
      if (code !== 0) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(out).toString('utf8'))); } catch (e) { resolve(null); }
    });
    proc.on('error', () => resolve(null));
  });
}

function detectHallucination(text) {
  if (!text || typeof text !== 'string') return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  const patterns = [/^(na\s+){3,}$/i, /^(la\s+){3,}$/i, /^(da\s+){3,}$/i, /^(ta\s+){3,}$/i, /tadhari/gi, /gapadasa/gi, /garechani/gi, /dapadasa/gi, /darechani/gi];
  for (const re of patterns) if (re.test(trimmed)) return true;
  const words = trimmed.split(/\s+/).filter(Boolean);
  const unique = new Set(words.map(w => w.toLowerCase()));
  if (words.length > 10 && unique.size / words.length < 0.15) return true;
  return false;
}

function cleanupTranscription(text) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').replace(/\b(music|instrumental|applause|laughter|singing)\b/gi, '').trim();
}

// ═══════════════════════════════════════════════════════════════
// MAIN RECOGNIZE HANDLER — 10-Point Complete Analysis
// ═══════════════════════════════════════════════════════════════
router.post('/', async (req, res) => {
  let inputPath = null, normalizedPath = null, downloadedPath = null;
  try {
    const uploadedFile = getUploadedFile(req);
    const hasFile = !!uploadedFile;
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    let filename = 'unknown', source = 'unknown';

    // ── URL download ──
    if (url && !hasFile) {
      console.log('[GoMaa] URL provided:', url);
      const tempDir = path.join(__dirname, '..', '..', 'temp');
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      try {
        const downloaded = await downloadFromUrl(url, tempDir);
        if (!downloaded?.filePath) throw new Error('URL downloader did not return audio');
        inputPath = downloaded.filePath; downloadedPath = downloaded.filePath;
        filename = downloaded.originalName || path.basename(downloaded.filePath) || 'audio';
        source = 'url';
        if (downloaded.youtubeMetadata?.title) filename = `${downloaded.youtubeMetadata.title}.mp3`;
        console.log('[GoMaa] URL audio ready:', inputPath);
      } catch (dlErr) {
        console.error('[GoMaa] Download failed:', dlErr.message);
        return res.status(400).json({ error: dlErr.message || 'Download failed' });
      }
    }

    // ── File upload ──
    if (hasFile) {
      inputPath = uploadedFile.path;
      filename = uploadedFile.originalname || path.basename(uploadedFile.path) || 'upload';
      source = 'upload';
      if (!inputPath || !fs.existsSync(inputPath)) return res.status(400).json({ error: 'Uploaded file not found' });
    }

    if (!inputPath) return res.status(400).json({ error: 'No file or valid URL provided.' });
    console.log(`[GoMaa v4.0.4] Analysing: ${filename} (source: ${source})`);

    // Normalize live recordings / WebM
    const lowerFn = filename.toLowerCase();
    if (ffmpeg && ffmpegStatic && (lowerFn.includes('live_recording') || lowerFn.endsWith('.webm'))) {
      normalizedPath = inputPath.replace(/\.[^.]+$/i, '_16k.wav');
      try { await normalizeLiveRecording(inputPath, normalizedPath); inputPath = normalizedPath; console.log('[GoMaa] Normalized to:', inputPath); }
      catch (normErr) { console.warn('[GoMaa] Normalization failed:', normErr.message); normalizedPath = null; }
    }

    // ═══════════════════════════════════════════════════════
    // 10-POINT ANALYSIS PIPELINE
    // ═══════════════════════════════════════════════════════

    // 1. Audio metadata & decode
    let meta = { duration: 0, sampleRate: 44100, channels: 1 }, audioBuffer = null;
    try { meta = await getAudioMetadata(inputPath); audioBuffer = await decodeAudio(inputPath); console.log(`[GoMaa] Audio decoded: ${meta.duration.toFixed(1)}s @ ${meta.sampleRate}Hz`); }
    catch (e) { console.warn('[GoMaa] Audio decode failed:', e.message); }

    const sampleRate = meta.sampleRate || 44100;
    const duration = meta.duration || 0;

    // 2. Unified processor (optional)
    let unified = null;
    try { unified = await runUnifiedProcessor(inputPath); if (unified) console.log('[GoMaa] Unified processor succeeded'); } catch (e) {}

    // 3. BEAT (Point 1)
    let beatResult = { bpm: 0, beats: [], confidence: 0, method: 'none' };
    try { if (audioBuffer) { beatResult = detectBeatCombFilter(audioBuffer, sampleRate); console.log(`[GoMaa] Beat: ${beatResult.bpm?.toFixed(1)} BPM`); } } catch (e) { console.warn('[GoMaa] Beat failed:', e.message); }

    // 4. TAALAM (Point 2)
    let talaResult = { tala: 'Unknown', confidence: 0, tempo: 0, sections: [] };
    try { if (audioBuffer) { talaResult = detectTala(audioBuffer, sampleRate, { composition: null }); console.log(`[GoMaa] Tala: ${talaResult.tala}`); } } catch (e) { console.warn('[GoMaa] Tala failed:', e.message); }

    // 5. PITCH (Point 3)
    let pitchResult = { shruti: 0, detectedSwaras: [], aroha: '', avarohana: '', pitches: [], noteTimeline: [] };
    try { if (audioBuffer) { pitchResult = analysePitch(audioBuffer, sampleRate); console.log(`[GoMaa] Pitch: tonic ${pitchResult.shruti?.toFixed(1)}Hz`); } } catch (e) { console.warn('[GoMaa] Pitch failed:', e.message); }

    // 6. RAGA / JANYA (Point 9)
    let ragaResult = { raga: 'Unknown', parentRaga: null, confidence: 0, ragaNumber: 0, janya: false };
    try { if (audioBuffer) { ragaResult = detectRagaEnhanced(audioBuffer, sampleRate, { composition: null }); console.log(`[GoMaa] Raga: ${ragaResult.raga} (parent: ${ragaResult.parentRaga || 'melakarta'})`); } } catch (e) { console.warn('[GoMaa] Raga failed:', e.message); }

    // 7. SCALE (Point 4)
    let scaleResult = { chroma: [], detectedSemitones: [], noteNames: [], confidence: 0 };
    try { if (pitchResult.pitches?.length) { scaleResult = detectScaleBayesian(pitchResult.pitches, sampleRate, ragaResult); console.log(`[GoMaa] Scale: ${scaleResult.noteNames?.join(' ')}`); } } catch (e) { console.warn('[GoMaa] Scale failed:', e.message); }

    // 8. TRANSCRIPTION (Point 5)
    let transcribeResult = { text: '', words: [], language: 'auto' };
    try {
      transcribeResult = await transcribeAudio(inputPath, { model: 'small', language: '', wordTimestamps: true });
      const cleaned = cleanupTranscription(transcribeResult.text);
      if (detectHallucination(cleaned)) { console.log('[GoMaa] Transcription hallucinated'); transcribeResult.text = ''; transcribeResult.words = []; transcribeResult.garbage = true; }
      else { transcribeResult.text = cleaned; transcribeResult.garbage = false; }
      console.log(`[GoMaa] Transcription: ${transcribeResult.text?.substring(0, 60)}...`);
    } catch (e) { console.warn('[GoMaa] Transcription failed:', e.message); }

    // 9. TRANSLITERATION (Point 6)
    let teluguText = '';
    try { if (transcribeResult.text) teluguText = transliterateToTelugu(transcribeResult.text); } catch (e) { console.warn('[GoMaa] Transliteration failed:', e.message); }

    // 10. SWARA GENERATION (Point 10)
    let swaraResult = { swaras: [], gamakas: [], pattern: '', language: 'te' };
    try { swaraResult = generateSwaraSequence(ragaResult.raga || 'Unknown', talaResult.tala || 'Adi', 'pallavi', 16, { includeGamaka: true, language: 'te' }); } catch (e) { console.warn('[GoMaa] Swara gen failed:', e.message); }

    // 11. AAROHANA / AVAROHANA (Points 7 & 8)
    let arohaSemis = [], avarohaSemis = [];
    try { if (pitchResult.pitches?.length) { arohaSemis = extractDirectionalSemis(pitchResult.pitches, sampleRate, true); avarohaSemis = extractDirectionalSemis(pitchResult.pitches, sampleRate, false); } } catch (e) { console.warn('[GoMaa] Directional semis failed:', e.message); }

    // 12. SEGMENTS
    let segments = [];
    try { segments = generateSegmentSwaras(duration, null, ragaResult.raga, pitchResult); } catch (e) { console.warn('[GoMaa] Segment swaras failed:', e.message); }

    // 13. SHEET MUSIC
    let sheetMusicXml = '', scoreXml = '', midiB64 = '';
    try {
      const beatSwaras = (beatResult.beats || []).slice(0, 32).map((b, i) => ({
        swara: swaraResult.swaras[i % (swaraResult.swaras.length || 1)] || 'S', westernNote: 'C',
        gamaka: swaraResult.gamakas?.[i] || 'sustain', time: b.time || 0, confidence: 0.8
      }));
      const talaObj = { name: talaResult.tala || 'Adi', beats: talaResult.sections?.reduce((a, b) => a + b, 8) || 8, sections: talaResult.sections || [4, 2, 2], clapOn: talaResult.clapOn || [true, false, false] };
      sheetMusicXml = generateSheetMusicXml(beatSwaras, talaObj, { label: ragaResult.raga || 'Unknown', composer: ragaResult.parentRaga ? `${ragaResult.raga} (janya of ${ragaResult.parentRaga})` : (ragaResult.raga || 'Unknown') });
      scoreXml = generateScoreXML(ragaResult.raga || 'Unknown', talaResult.tala || 'Adi', 'pallavi', swaraResult, { includeGamaka: true, includeLyrics: true });
    } catch (e) { console.warn('[GoMaa] Sheet music failed:', e.message); }

    // ── Compose result ──
    const analysisResult = {
      success: true,
      title: filename.replace(/\.[^.]+$/i, ''),
      filename: filename, artist: 'Unknown', composer: 'Unknown',
      raga: ragaResult.raga || 'Unknown', parentRaga: ragaResult.parentRaga || null,
      ragaNumber: ragaResult.ragaNumber || 0, janya: ragaResult.janya || false,
      tala: talaResult.tala || 'Unknown', tempo: talaResult.tempo || beatResult.bpm || 0,
      duration: duration, source: source, audioUrl: source === 'url' ? url : undefined,
      analysis: {
        beat: { bpm: beatResult.bpm || 0, confidence: beatResult.confidence || 0, method: beatResult.method || 'comb-filter-bank', beatCount: beatResult.beats?.length || 0 },
        tala: { name: talaResult.tala || 'Unknown', confidence: talaResult.confidence || 0, tempo: talaResult.tempo || 0, sections: talaResult.sections || [], method: talaResult.method || 'onset-autocorrelation' },
        pitch: { tonic: pitchResult.shruti || 0, detectedSwaras: pitchResult.detectedSwaras || [], noteTimeline: pitchResult.noteTimeline || [], method: 'yin-autocorrelation' },
        scale: { chroma: scaleResult.chroma || [], detectedSemitones: scaleResult.detectedSemitones || [], noteNames: scaleResult.noteNames || [], confidence: scaleResult.confidence || 0, method: scaleResult.method || 'bayesian-chroma' },
        aroha: pitchResult.aroha || '', avaroha: pitchResult.avarohana || '',
        arohaSemis, avarohaSemis,
        ragaDetection: { raga: ragaResult.raga || 'Unknown', parentRaga: ragaResult.parentRaga || null, confidence: ragaResult.confidence || 0, method: ragaResult.method || 'multi-modal', janya: ragaResult.janya || false },
        transcription: { text: transcribeResult.text || '', language: transcribeResult.language || 'auto', wordCount: (transcribeResult.words || []).length, garbage: transcribeResult.garbage || false },
        transliteration: { telugu: teluguText }, swaras: swaraResult, segments: segments || []
      },
      sahityam: { pallavi: transcribeResult.text || '', anupallavi: '', charanam1: '', telugu: teluguText },
      aroha: pitchResult.aroha || '', avaroha: pitchResult.avarohana || '',
      sheetMusicXml: sheetMusicXml || '', scoreXml: scoreXml || '',
      musicXml: scoreXml || sheetMusicXml || '', midiData: midiB64, chroma: scaleResult.chroma || []
    };

    // ── DB SAVE (merged schema) ──
    let savedId = null;
    try {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
      const insert = db.prepare(`INSERT INTO music (
        id, filename, title, artist, composer, raga, ragaNumber, ragaId, janyaOf,
        aroha, avarohana, mood, gamakas, tala, tempo, duration, filePath,
        chromaVector, sections, sheetMusic, midiData, language,
        analysisJson, lyricsJson, transcriptionJson, sahityam, createdAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      await insert.run(
        id, filename, analysisResult.title, analysisResult.artist, analysisResult.composer,
        analysisResult.raga, analysisResult.ragaNumber, analysisResult.raga, analysisResult.parentRaga,
        analysisResult.aroha, analysisResult.avaroha, null, null,
        analysisResult.tala, analysisResult.tempo, analysisResult.duration, inputPath,
        JSON.stringify(scaleResult.chroma || []), JSON.stringify(segments || []),
        sheetMusicXml || '', midiB64 || '', transcribeResult.language || 'auto',
        JSON.stringify(analysisResult.analysis || {}), JSON.stringify(analysisResult.sahityam || {}),
        JSON.stringify(transcribeResult || {}), transcribeResult.text || '',
        Math.floor(Date.now() / 1000)
      );
      savedId = id;
      console.log(`[GoMaa v4.0.4] Saved to DB: ${id}`);
      try { addToIndex(id, scaleResult.chroma || [], { title: analysisResult.title, raga: analysisResult.raga }); } catch (e) {}
      if (typeof db.close === 'function') db.close();
    } catch (dbErr) { console.error('[GoMaa] DB save failed (non-fatal):', dbErr.message); }

    analysisResult.id = savedId;
    return res.json(analysisResult);

  } catch (err) {
    console.error('[GoMaa] Recognize error:', err);
    return res.status(500).json({ error: err.message || 'Audio recognition failed.' });
  } finally {
    if (normalizedPath && fs.existsSync(normalizedPath)) try { fs.unlinkSync(normalizedPath); } catch (e) {}
    if (downloadedPath && downloadedPath !== normalizedPath && fs.existsSync(downloadedPath)) try { fs.unlinkSync(downloadedPath); } catch (e) {}
  }
});

module.exports = router;