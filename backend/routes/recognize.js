const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { decodeAudio } = require('../../core/audio/audioDecode');
const { getAudioMetadata } = require('../../core/audio/audioMeta');
const { detectBeatCombFilter } = require('../../core/ai/beatEngine');
const { detectTala } = require('../../core/ai/talaDetect');
const { analysePitch } = require('../../core/ai/pitchDetect');
const { detectRagaEnhanced } = require('../../core/ai/ragaEngine');
const { detectScaleBayesian } = require('../../core/ai/scaleEngine');
const { generateSwaraSequence } = require('../../core/ai/swaraEngine');
const { generateSheetMusicXml } = require('../../core/ai/sheetMusicEngine');
const { generateScoreXML } = require('../../core/ai/scoreEngine');
const { transliterateToTelugu } = require('../../core/ai/carnaticSegmenter');
const { generateSegmentSwaras } = require('../swaragen');
const { addToIndex } = require('../../core/vector/annIndex');
const { downloadFromUrl } = require('../utils/download');
const { analyzeLyrics } = require('../../core/ai/lyricsNLP');
const sqliteModule = require('../../core/db/sqlite');
const db = typeof sqliteModule === 'function' ? sqliteModule() : sqliteModule;

let ffmpeg = null, ffmpegStatic = null;
try {
  ffmpeg = require('fluent-ffmpeg');
  ffmpegStatic = require('ffmpeg-static');
  if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);
} catch (e) { console.warn('[recognize] fluent-ffmpeg not installed.'); }

let COMPOSITION_DB = [];
try {
  COMPOSITION_DB = JSON.parse(fs.readFileSync(path.join(__dirname, '../../models/composition_db.json'), 'utf8'));
} catch (e) { console.warn('[GoMaa] composition_db.json not loaded:', e.message); }

function findCompositionByFilename(filename) {
  if (!filename || !COMPOSITION_DB.length) return null;
  const base = filename.replace(/\.[^.]+$/i, '').toLowerCase().replace(/[_-]+/g, ' ');
  for (const comp of COMPOSITION_DB) {
    if (!comp.aliases) continue;
    for (const alias of comp.aliases) {
      const a = alias.toLowerCase().replace(/[_-]+/g, ' ');
      if (base.includes(a) || a.includes(base)) return comp;
    }
  }
  return null;
}

function findCompositionByRaga(ragaName) {
  if (!ragaName || ragaName === 'Unknown' || !COMPOSITION_DB.length) return null;
  const matches = COMPOSITION_DB.filter(c => c.raga && c.raga.toLowerCase() === ragaName.toLowerCase());
  return matches.length ? matches[0] : null;
}

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

function cleanupTranscription(text) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').replace(/\b(music|instrumental|applause|laughter|singing)\b/gi, '').trim();
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

async function _transcribeWithModel(filePath, opts) {
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
        return resolve({ error: errStr || `Exit ${code}`, text: '', words: [], garbage: true });
      }
      try {
        const result = JSON.parse(outStr);
        const cleaned = cleanupTranscription(result.text || '');
        const isGarbage = detectHallucination(cleaned);
        resolve({ text: isGarbage ? '' : cleaned, words: result.words || [], language: result.language || 'auto', garbage: isGarbage, model: opts.model });
      } catch (e) { resolve({ error: 'JSON parse error', text: '', words: [], garbage: true }); }
    });
    proc.on('error', e => resolve({ error: e.message, text: '', words: [], garbage: true }));
  });
}

async function transcribeAudio(filePath, opts = {}) {
  const models = [opts.model || 'base', 'medium'];
  for (const model of models) {
    const result = await _transcribeWithModel(filePath, { ...opts, model });
    if (!result.garbage && result.text) return result;
    if (result.garbage && model !== 'medium') {
      console.log(`[GoMaa] Hallucination detected with ${model}, retrying with medium...`);
      continue;
    }
    return result;
  }
  return { error: 'Transcription failed after retry', text: '', words: [], garbage: true };
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

router.post('/', async (req, res) => {
  let inputPath = null, normalizedPath = null, downloadedPath = null;
  try {
    const uploadedFile = getUploadedFile(req);
    const hasFile = !!uploadedFile;
    const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    let filename = 'unknown', source = 'unknown';

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

    if (hasFile) {
      inputPath = uploadedFile.path;
      filename = uploadedFile.originalname || path.basename(uploadedFile.path) || 'upload';
      source = 'upload';
      if (!inputPath || !fs.existsSync(inputPath)) return res.status(400).json({ error: 'Uploaded file not found' });
    }

    if (!inputPath) return res.status(400).json({ error: 'No file or valid URL provided.' });
    console.log(`[GoMaa v6.1.2] Analysing: ${filename} (source: ${source})`);

    let compositionMatch = findCompositionByFilename(filename);
    if (compositionMatch) {
      console.log(`[GoMaa] Composition matched by filename: ${compositionMatch.name} (fallback only)`);
    }

    const lowerFn = filename.toLowerCase();
    if (ffmpeg && ffmpegStatic && (lowerFn.includes('live_recording') || lowerFn.endsWith('.webm'))) {
      normalizedPath = inputPath.replace(/\.[^.]+$/i, '_16k.wav');
      try { await normalizeLiveRecording(inputPath, normalizedPath); inputPath = normalizedPath; console.log('[GoMaa] Normalized to:', inputPath); }
      catch (normErr) { console.warn('[GoMaa] Normalization failed:', normErr.message); normalizedPath = null; }
    }

    let meta = { duration: 0, sampleRate: 44100, channels: 1 }, audioBuffer = null;
    try { meta = await getAudioMetadata(inputPath); audioBuffer = await decodeAudio(inputPath); console.log(`[GoMaa] Audio decoded: ${meta.duration.toFixed(1)}s @ ${meta.sampleRate}Hz`); }
    catch (e) { console.warn('[GoMaa] Audio decode failed:', e.message); }

    const sampleRate = meta.sampleRate || 44100;
    const duration = meta.duration || 0;

    let unified = null;
    try { unified = await runUnifiedProcessor(inputPath); if (unified) console.log('[GoMaa] Unified processor succeeded'); } catch (e) {}

    let beatResult = { bpm: 0, beats: [], confidence: 0, method: 'none' };
    try { if (audioBuffer) { beatResult = detectBeatCombFilter(audioBuffer, sampleRate); console.log(`[GoMaa] Beat: ${beatResult.bpm?.toFixed(1)} BPM`); } } catch (e) { console.warn('[GoMaa] Beat failed:', e.message); }

    let talaResult = { tala: 'Unknown', confidence: 0, tempo: 0, sections: [] };
    try { if (audioBuffer) { talaResult = detectTala(audioBuffer, sampleRate, { composition: null }); console.log(`[GoMaa] Tala: ${talaResult.tala}`); } } catch (e) { console.warn('[GoMaa] Tala failed:', e.message); }

    let pitchResult = { shruti: 0, detectedSwaras: [], aroha: '', avarohana: '', pitches: [], noteTimeline: [], ascSemis: [], descSemis: [] };
    try {
      if (audioBuffer) {
        pitchResult = analysePitch(audioBuffer, sampleRate);
        console.log(`[GoMaa] Pitch: tonic ${pitchResult.shruti?.toFixed(1)}Hz, swaras: ${pitchResult.detectedSwaras?.join(' ')}`);
      }
    } catch (e) { console.warn('[GoMaa] Pitch failed:', e.message); }

    let ragaResult = { raga: 'Unknown', parentRaga: null, confidence: 0, ragaNumber: 0, janya: false };
    try {
      if (pitchResult.pitches && pitchResult.pitches.length > 0) {
        ragaResult = detectRagaEnhanced(pitchResult.pitches, sampleRate, {}, compositionMatch);
        console.log(`[GoMaa] Raga: ${ragaResult.raga} (parent: ${ragaResult.parentRaga || '—'}, conf: ${(ragaResult.confidence * 100).toFixed(0)}%)`);
      }
    } catch (e) { console.warn('[GoMaa] Raga failed:', e.message); }

    if (!compositionMatch && ragaResult.raga && ragaResult.raga !== 'Unknown' && ragaResult.confidence > 0.5) {
      const ragaComp = findCompositionByRaga(ragaResult.raga);
      if (ragaComp) { compositionMatch = ragaComp; console.log(`[GoMaa] Composition matched by raga (fallback): ${compositionMatch.name}`); }
    }

    let scaleResult = { chroma: [], detectedSemitones: [], noteNames: [], confidence: 0 };
    try {
      if (pitchResult.pitches && pitchResult.pitches.length > 0) {
        scaleResult = detectScaleBayesian(pitchResult.pitches, sampleRate, ragaResult, pitchResult.shruti);
        console.log(`[GoMaa] Scale: ${scaleResult.noteNames?.join(' ')} (conf: ${(scaleResult.confidence * 100).toFixed(0)}%)`);
      }
    } catch (e) { console.warn('[GoMaa] Scale failed:', e.message); }

    // ═══════════════════════════════════════════════════════════════════════
    // 8. TRANSCRIPTION (Point 5) — WHISPER IS PRIMARY with medium retry
    // ═══════════════════════════════════════════════════════════════════════
    let transcribeResult = { text: '', words: [], language: 'auto', garbage: false, skipped: false, source: 'whisper', confidence: 0 };
    const skipTranscribe = req.body?.skipTranscribe === '1' || req.body?.skipTranscribe === true;
    const userSahityam = req.body?.sahityam || req.body?.lyrics || '';

    if (!skipTranscribe) {
      try {
        console.log(`[GoMaa] Starting transcription with Whisper (~${Math.ceil(duration/60)}min audio)...`);
        transcribeResult = await transcribeAudio(inputPath, { model: 'base', language: '', wordTimestamps: true });
        transcribeResult.confidence = transcribeResult.garbage ? 0 : Math.min((transcribeResult.words?.length || 0) / 10, 0.95);
        console.log(`[GoMaa] Transcription: ${transcribeResult.text?.substring(0, 80)}... (conf: ${(transcribeResult.confidence*100).toFixed(0)}%)`);
      } catch (e) { console.warn('[GoMaa] Transcription failed:', e.message); transcribeResult.error = e.message; }
    } else {
      transcribeResult.skipped = true; transcribeResult.source = 'user_skip';
    }

    // ── LYRICS NLP AUGMENTATION (v6.1.2) ──
    let lyricsNlpResult = null;
    if (userSahityam) {
      console.log('[GoMaa] User-provided sahityam detected — using as ground truth');
      lyricsNlpResult = analyzeLyrics(userSahityam);
      console.log(`[GoMaa] Lyrics NLP: raga=${lyricsNlpResult.raga}, tala=${lyricsNlpResult.tala}, conf=${(lyricsNlpResult.overallConfidence*100).toFixed(0)}%`);
    }

    // ── FUSION LOGIC: Transcription primitive + Lyrics override ──
    let finalText = transcribeResult.text || '';
    let finalSource = transcribeResult.source || 'whisper';

    if (userSahityam) {
      finalText = userSahityam;
      finalSource = 'user_ground_truth';
    }

    // If audio confidence < 40% AND lyrics NLP available, augment
    if (transcribeResult.confidence < 0.40 && lyricsNlpResult && lyricsNlpResult.augmentationReady) {
      console.log('[GoMaa] Audio confidence < 40% — falling back to lyrics NLP augmentation');
      if (!finalText) finalText = userSahityam || '';
      finalSource = 'lyrics_nlp_fallback';
      if (lyricsNlpResult.ragaConfidence > 0.6 && (!ragaResult.raga || ragaResult.raga === 'Unknown')) {
        ragaResult = {
          raga: lyricsNlpResult.raga,
          parentRaga: lyricsNlpResult.ragaDetails.parent,
          confidence: lyricsNlpResult.ragaConfidence,
          method: 'lyrics_nlp_override',
          ragaNumber: lyricsNlpResult.ragaDetails.melakarta,
          melakartaNum: lyricsNlpResult.ragaDetails.melakarta,
          janya: !!lyricsNlpResult.ragaDetails.parent
        };
      }
      if (lyricsNlpResult.talaConfidence > 0.5 && (!talaResult.tala || talaResult.tala === 'Unknown')) {
        talaResult = { ...talaResult, tala: lyricsNlpResult.tala, confidence: lyricsNlpResult.talaConfidence, method: 'lyrics_nlp_override' };
      }
    }

    // Composition DB fallback (only if no user sahityam and no valid transcription)
    if ((!finalText || transcribeResult.garbage) && compositionMatch && compositionMatch.sahityam && !userSahityam) {
      console.log('[GoMaa] Using composition DB sahityam as fallback.');
      finalText = compositionMatch.sahityam?.pallavi || '';
      finalSource = 'composition_db_fallback';
    }

    let teluguText = '';
    if (finalText) {
      try { teluguText = transliterateToTelugu(finalText); } catch (e) { console.warn('[GoMaa] Transliteration failed:', e.message); }
    }

    let swaraResult = { swaras: [], gamakas: [], pattern: '', language: 'te' };
    try { swaraResult = generateSwaraSequence(ragaResult.raga || 'Unknown', talaResult.tala || 'Adi', 'pallavi', 16, { includeGamaka: true, language: 'te' }); } catch (e) { console.warn('[GoMaa] Swara gen failed:', e.message); }

    let arohaSemis = pitchResult.ascSemis || [];
    let avarohaSemis = pitchResult.descSemis || [];

    if (compositionMatch && compositionMatch.aroha && (!finalText || transcribeResult.garbage)) {
      pitchResult.aroha = compositionMatch.aroha;
      pitchResult.avarohana = compositionMatch.avaroha;
      talaResult.tala = compositionMatch.tala || talaResult.tala;
      talaResult.name = compositionMatch.tala || talaResult.name;
      ragaResult.raga = compositionMatch.raga;
      ragaResult.parentRaga = compositionMatch.parent || compositionMatch.raga;
      ragaResult.confidence = 0.99;
      ragaResult.method = 'composition_hint';
    }

    let segments = [];
    try { segments = generateSegmentSwaras(duration, compositionMatch, ragaResult.raga, pitchResult); } catch (e) { console.warn('[GoMaa] Segment swaras failed:', e.message); }

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

    const sahityam = {
      pallavi: finalText,
      anupallavi: compositionMatch?.sahityam?.anupallavi || lyricsNlpResult?.ragaDetails?.mood || '',
      charanam1: compositionMatch?.sahityam?.charanam1 || '',
      charanam2: compositionMatch?.sahityam?.charanam2 || '',
      charanam3: compositionMatch?.sahityam?.charanam3 || '',
      chittaswaram: '',
      manodharma: '',
      telugu: teluguText,
      source: finalSource,
      lyricsNlp: lyricsNlpResult || undefined
    };

    const analysisResult = {
      success: true,
      title: compositionMatch && (!finalText || transcribeResult.garbage) ? compositionMatch.name : filename.replace(/\.[^.]+$/i, ''),
      filename: filename, artist: 'Unknown', composer: compositionMatch && (!finalText || transcribeResult.garbage) ? compositionMatch.composer : 'Unknown',
      raga: ragaResult.raga || 'Unknown', parentRaga: ragaResult.parentRaga || null,
      ragaNumber: ragaResult.ragaNumber || 0, janya: ragaResult.janya || false,
      tala: talaResult.tala || 'Unknown', tempo: talaResult.tempo || beatResult.bpm || 0,
      duration: duration, source: source, audioUrl: source === 'url' ? url : undefined,
      analysis: {
        beat: { bpm: beatResult.bpm || 0, confidence: beatResult.confidence || 0, method: beatResult.method || 'comb-filter-bank', beatCount: beatResult.beats?.length || 0 },
        tala: { name: talaResult.tala || 'Unknown', confidence: talaResult.confidence || 0, tempo: talaResult.tempo || 0, sections: talaResult.sections || [], method: talaResult.method || 'onset-autocorrelation' },
        pitch: { tonic: pitchResult.shruti || 0, detectedSwaras: pitchResult.detectedSwaras || [], noteTimeline: pitchResult.noteTimeline || [], method: 'yin-autocorrelation' },
        scale: { chroma: scaleResult.chroma || [], detectedSemitones: scaleResult.detectedSemitones || [], noteNames: scaleResult.noteNames || [], confidence: scaleResult.confidence || 0, method: scaleResult.method || 'bayesian-chroma' },
        aroha: pitchResult.aroha || '',
        avaroha: pitchResult.avarohana || '',
        arohaSemis: arohaSemis,
        avarohaSemis: avarohaSemis,
        ragaDetection: { raga: ragaResult.raga || 'Unknown', parentRaga: ragaResult.parentRaga || null, confidence: ragaResult.confidence || 0, method: ragaResult.method || 'multi-modal', janya: ragaResult.janya || false },
        transcription: { text: finalText, language: transcribeResult.language || 'auto', wordCount: (transcribeResult.words || []).length, garbage: transcribeResult.garbage || false, skipped: transcribeResult.skipped || false, source: finalSource, confidence: transcribeResult.confidence || 0 },
        transliteration: { telugu: teluguText }, swaras: swaraResult, segments: segments || []
      },
      sahityam: sahityam,
      aroha: pitchResult.aroha || (compositionMatch ? compositionMatch.aroha : ''),
      avaroha: pitchResult.avarohana || (compositionMatch ? compositionMatch.avaroha : ''),
      sheetMusicXml: sheetMusicXml || '', scoreXml: scoreXml || '',
      musicXml: scoreXml || sheetMusicXml || '', midiData: midiB64, chroma: scaleResult.chroma || []
    };

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
        JSON.stringify(transcribeResult || {}), finalText || '',
        Math.floor(Date.now() / 1000)
      );
      savedId = id;
      console.log(`[GoMaa v6.1.2] Saved to DB: ${id}`);
      try { addToIndex(id, scaleResult.chroma || [], { title: analysisResult.title, raga: analysisResult.raga }); } catch (e) {}
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
