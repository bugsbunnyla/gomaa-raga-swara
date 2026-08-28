'use strict';
/**
 * GoMaa Raga Vidya v3 — /api/recognize
 * FIXED execution order:
 *   1. Input (upload / record / youtube-url / file-url)
 *   2. Decode ANY format -> PCM (FFmpeg)
 *   3. Pitch detect -> Scale detect -> Beat detect -> Taalam detect
 *   4. Raga detect (from detected scale + filename hint + DB cosine match)
 *   5. Transcription (faster-whisper integration)
 *   6. Aroha/Avaroha from pitch trajectory
 *   7. Swara evaluation + Sahityam grid + Lyrics
 *   8. Instrument detection + Gamaka detection
 *   9. Sheet music (Western + Carnatic) + MIDI
 *  10. Save to DB -> Return structured result to client
 */

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const http    = require('http');
const https   = require('https');
const os      = require('os');
const { spawn } = require('child_process');

const db       = require('../../core/db/sqlite');
const { generateFingerprint, matchFingerprint } = require('../../core/audio/fingerprint');
const { detectRaga, detectRagamalika, detectRagaFromScale } = require('../../core/ai/ragaModel');
const { decodeToFloatPCM, readPCMFloats, isFFmpegAvailable } = require('../../core/audio/audioDecode');
const { embedAudio }   = require('../../core/ai/audioEmbedding');
const { fuse }         = require('../../core/ai/fusionEngine');
const { generateSheetMusicXml, generateMidi, RAGA_DEMO_LYRICS, SWARA_DISPLAY }
                       = require('../../core/ai/sheetMusicEngine');
const { processAudio, assignTranscriptionToSegments, buildSectionLyrics } = require('../../core/ai/carnaticSegmenter');
const { detectRagaFromChroma } = require('../../core/ai/ragaModel');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 500 * 1024 * 1024 } });

const YT_HOSTS = ['youtube.com','youtu.be','youtube-nocookie.com'];
const FETCH_HEADERS = {
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':'audio/*,video/*,*/*;q=0.8',
  'Accept-Encoding':'identity',
  'Cache-Control':'no-cache',
};

const SWARA_SEMI = {
  S:0, R1:1, R2:2, R3:3,
  G1:2, G2:3, G3:4,
  M1:5, M2:6,
  P:7,
  D1:8, D2:9, D3:10,
  N1:10, N2:11, N3:11
};
const SEMI_TO_SWARA_DEFAULT = {
  0:'S', 1:'R1', 2:'R2', 3:'R3', 4:'G3', 5:'M1', 6:'M2',
  7:'P', 8:'D1', 9:'D2', 10:'D3', 11:'N3'
};

function extractPitchFrames(floatSamples, sampleRate = 22050) {
  const HOP    = 512;
  const WIN    = 2048;
  const MIN_F  = 80;
  const MAX_F  = 1200;
  const minLag = Math.floor(sampleRate / MAX_F);
  const maxLag = Math.floor(sampleRate / MIN_F);
  const frames_n = Math.floor((floatSamples.length - WIN) / HOP);
  const pitchFrames = [];
  for (let fi = 0; fi < frames_n; fi++) {
    const off = fi * HOP;
    let rms = 0;
    for (let n = 0; n < WIN; n++) { const s = floatSamples[off + n] || 0; rms += s * s; }
    rms = Math.sqrt(rms / WIN);
    if (rms < 0.005) { pitchFrames.push({ freq: 0, midi: 0, semi: -1, confidence: 0, rms }); continue; }
    let bestLag = minLag, bestCorr = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0;
      for (let n = 0; n < WIN - lag; n++) corr += floatSamples[off + n] * floatSamples[off + n + lag];
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    const freq = sampleRate / bestLag;
    const midi = Math.round(12 * Math.log2(freq / 440) + 69);
    const semi = ((midi - 60) % 12 + 12) % 12;
    const confidence = Math.min(1.0, rms * 10);
    pitchFrames.push({ freq: +freq.toFixed(2), midi, semi, confidence, rms });
  }
  return pitchFrames;
}

function detectAudioScale(pitchFrames) {
  const energy = new Array(12).fill(0);
  let total = 0;
  for (const f of pitchFrames) {
    if (f.semi < 0 || f.confidence < 0.1) continue;
    energy[f.semi] += f.confidence; total += f.confidence;
  }
  if (total === 0) return { semis: [0, 2, 4, 7, 9], energy: new Array(12).fill(0), chroma: new Array(12).fill(0) };
  const maxE = Math.max(...energy, 1);
  const chroma = energy.map(e => e / maxE);
  const threshold = 0.20;
  const semis = chroma.map((e, i) => ({ semi: i, e })).filter(x => x.e >= threshold).sort((a, b) => a.semi - b.semi).map(x => x.semi);
  return { semis, energy, chroma };
}

function detectArohaAvaroha(pitchFrames, allSemis, ragaAroha, ragaAvaroha) {
  const ragaArohaS = parseSwaras(ragaAroha);
  const ragaAvarohaS = parseSwaras(ragaAvaroha);
  const semiToSwara = buildSemiToSwara(ragaArohaS, ragaAvarohaS);
  const WINDOW = 20;
  let arohaFrames = [], avarohaFrames = [];
  for (let i = WINDOW; i < pitchFrames.length - WINDOW; i++) {
    const f = pitchFrames[i];
    if (f.semi < 0 || f.confidence < 0.1) continue;
    let up = 0, down = 0;
    for (let j = -WINDOW; j < WINDOW; j++) {
      const prev = pitchFrames[i + j]?.midi || 0;
      const next = pitchFrames[i + j + 1]?.midi || 0;
      if (next > prev) up++; else if (next < prev) down++;
    }
    if (up > down * 1.2) arohaFrames.push(f);
    else if (down > up * 1.2) avarohaFrames.push(f);
  }
  function framesToSwaraSeq(frames) {
    if (!frames.length) return [];
    const semis = [...new Set(frames.map(f => f.semi))];
    return semis.sort((a, b) => a - b).map(s => semiToSwara[s] || SEMI_TO_SWARA_DEFAULT[s] || 'S');
  }
  const detectedAroha = framesToSwaraSeq(arohaFrames);
  const detectedAvaroha = framesToSwaraSeq(avarohaFrames).reverse();
  const aroha = detectedAroha.length >= 3 ? detectedAroha : ragaArohaS;
  const avaroha = detectedAvaroha.length >= 3 ? detectedAvaroha : ragaAvarohaS;
  return { aroha: aroha.join(' '), avaroha: avaroha.join(' '), detectedAroha: detectedAroha.join(' '), detectedAvaroha: detectedAvaroha.join(' ') };
}

function parseSwaras(str) { return (str || '').split(/\s+/).filter(t => SWARA_SEMI[t] !== undefined); }

function buildSemiToSwara(arohaS, avarohaS) {
  const map = {};
  for (const sw of [...arohaS, ...avarohaS]) {
    const semi = SWARA_SEMI[sw];
    if (semi !== undefined && !map[semi]) map[semi] = sw;
  }
  for (let s = 0; s < 12; s++) {
    if (!map[s]) {
      let best = 'S', bestDist = 99;
      for (const [k, v] of Object.entries(map)) {
        const d = Math.min(Math.abs(+k - s), 12 - Math.abs(+k - s));
        if (d < bestDist) { bestDist = d; best = v; }
      }
      map[s] = best;
    }
  }
  return map;
}

function evaluateSwaras(pitchFrames, semiToSwara, sampleRate, hop = 512) {
  const swaraFrames = [];
  let prevSwara = null;
  for (let fi = 0; fi < pitchFrames.length; fi++) {
    const f = pitchFrames[fi];
    const time = (fi * hop) / sampleRate;
    if (f.semi < 0 || f.confidence < 0.08) {
      swaraFrames.push({ time: +time.toFixed(3), swara: '.', freq: 0, gamaka: 'silence' });
      prevSwara = null; continue;
    }
    const swara = semiToSwara[f.semi] || 'S';
    const isSustain = (swara === prevSwara);
    swaraFrames.push({ time: +time.toFixed(3), swara, freq: f.freq, midi: f.midi,
      gamaka: isSustain ? 'sustain' : 'attack', confidence: +f.confidence.toFixed(3) });
    prevSwara = swara;
  }
  return swaraFrames;
}

function estimateTempo(floatSamples, sampleRate) {
  const HOP = 512;
  const NFRAMES = Math.floor(floatSamples.length / HOP);
  if (NFRAMES < 8) return { bpm: 80, beatPeriodFrames: Math.round(sampleRate * 0.75 / HOP), confidence: 0 };
  const energy = new Float32Array(NFRAMES);
  for (let f = 0; f < NFRAMES; f++) { let e = 0; for (let n = 0; n < HOP; n++) e += (floatSamples[f * HOP + n] || 0) ** 2; energy[f] = Math.sqrt(e / HOP); }
  const onset = new Float32Array(NFRAMES);
  for (let f = 1; f < NFRAMES; f++) { const d = energy[f] - energy[f - 1]; onset[f] = d > 0 ? d : 0; }
  const segLen = Math.floor(NFRAMES / 3);
  const tempoVotes = [];
  const fPerSec = sampleRate / HOP;
  const lagMin = Math.round(fPerSec * 60 / 240);
  const lagMax = Math.round(fPerSec * 60 / 40);
  for (let pass = 0; pass < 3; pass++) {
    const seg = onset.slice(pass * segLen, (pass + 1) * segLen);
    let bestLag = lagMin, bestCorr = -Infinity;
    for (let lag = lagMin; lag <= Math.min(lagMax, seg.length - 1); lag++) {
      let corr = 0; for (let n = 0; n < seg.length - lag; n++) corr += seg[n] * seg[n + lag];
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    tempoVotes.push(Math.max(40, Math.min(240, Math.round(fPerSec * 60 / bestLag))));
  }
  tempoVotes.sort((a, b) => a - b);
  const bpm = tempoVotes[1];
  return { bpm, beatPeriodFrames: Math.round(fPerSec * 60 / bpm), confidence: tempoVotes[0] === tempoVotes[2] ? 0.9 : Math.abs(tempoVotes[0] - tempoVotes[2]) < 10 ? 0.7 : 0.4 };
}

function detectTala(floatSamples, sampleRate, tempoResult) {
  const HOP = 512;
  const NFRAMES = Math.floor(floatSamples.length / HOP);
  const fPerSec = sampleRate / HOP;
  const beatPeriod = tempoResult.beatPeriodFrames || Math.round(fPerSec * 60 / 80);
  if (NFRAMES < beatPeriod * 8) {
    return { name: 'Adi', beats: 8, sections: [4, 2, 2], clapOn: [true, false, false], tradition: 'carnatic', jati: 'chatusra', angaStr: 'Laghu(4) + Dhrutam(2) + Dhrutam(2) = 8 beats', detectedBeats: 8, cycleVotes: [], confidence: 0.3, note: 'Insufficient audio', alternatives: [] };
  }
  const energy = new Float32Array(NFRAMES);
  for (let f = 0; f < NFRAMES; f++) { let e = 0; for (let n = 0; n < HOP; n++) e += (floatSamples[f * HOP + n] || 0) ** 2; energy[f] = Math.sqrt(e / HOP); }
  const onset = new Float32Array(NFRAMES);
  for (let f = 1; f < NFRAMES; f++) { const d = energy[f] - energy[f - 1]; onset[f] = d > 0 ? d : 0; }
  const segLen = Math.floor(NFRAMES / 3);
  const cycleVotes = [];
  for (let pass = 0; pass < 3; pass++) {
    const seg = onset.slice(pass * segLen, (pass + 1) * segLen);
    const cycleMin = beatPeriod * 3;
    const cycleMax = Math.min(beatPeriod * 20, seg.length - 1);
    let bestCycleLag = cycleMin, bestCycleCorr = -Infinity;
    for (let lag = cycleMin; lag <= cycleMax; lag++) {
      let corr = 0; for (let n = 0; n < seg.length - lag; n++) corr += seg[n] * seg[n + lag];
      corr /= (seg.length - lag);
      if (corr > bestCycleCorr) { bestCycleCorr = corr; bestCycleLag = lag; }
    }
    const beatsPerCycle = Math.round(bestCycleLag / beatPeriod);
    if (beatsPerCycle >= 3 && beatsPerCycle <= 32) cycleVotes.push(beatsPerCycle);
  }
  const talaDB = require('../../models/tala_db.json');
  const ALL_TALAS = talaDB.talas || [];
  if (cycleVotes.length === 0) {
    return { name: 'Adi', beats: 8, sections: [4, 2, 2], clapOn: [true, false, false], tradition: 'carnatic', jati: 'chatusra', angaStr: 'Laghu(4) + Dhrutam(2) + Dhrutam(2) = 8 beats', detectedBeats: 8, cycleVotes: [], confidence: 0.3, note: 'No cycle detected', alternatives: [] };
  }
  cycleVotes.sort((a, b) => a - b);
  const detectedBeats = cycleVotes[Math.floor(cycleVotes.length / 2)];
  const cycleConsistency = cycleVotes.filter(v => v === detectedBeats).length / cycleVotes.length;
  const candidates = ALL_TALAS.map(t => ({ ...t, beatDiff: Math.abs(t.beats - detectedBeats),
    popularityBonus: ({ 'Adi': 10, 'Rupaka': 9, 'Misra Chapu': 8, 'Tisra Triputa': 7, 'Khanda Chapu': 7 })[t.name] || 1
  })).sort((a, b) => a.beatDiff !== b.beatDiff ? a.beatDiff - b.beatDiff : b.popularityBonus - a.popularityBonus);
  const best = candidates[0];
  const confidence = cycleConsistency * (1 - best.beatDiff * 0.1);
  return {
    name: best.name, shortName: best.shortName || best.name, coreTala: best.coreTala || best.name,
    jati: best.jati || 'chatusra', tradition: best.tradition, beats: best.beats,
    sections: best.sections, clapOn: best.clapOn,
    angaStr: (best.sections || []).map(s => s === 1 ? 'Anudhrutam(1)' : s === 2 ? 'Dhrutam(2)' : `Laghu(${s})`).join(' + ') + ` = ${best.beats} beats`,
    detectedBeats, cycleVotes, confidence: +confidence.toFixed(3),
    note: `${best.tradition === 'carnatic' ? 'Carnatic' : 'Hindustani'} ${best.name} — ${detectedBeats === best.beats ? 'exact' : `nearest (detected ${detectedBeats})`} | votes: [${cycleVotes.join(',')}]`,
    alternatives: candidates.slice(1, 4).map(t => ({ name: t.name, beats: t.beats, beatDiff: t.beatDiff }))
  };
}

function detectInstruments(floatSamples, sampleRate) {
  const instruments = [];
  const len = floatSamples.length;
  if (len < 1000) return [{ name: 'unknown', label: 'Unknown', confidence: 0.5 }];
  const bands = [0, 500, 2000, 8000, sampleRate / 2];
  const frameSize = 2048, hop = 512;
  const bandE = new Array(bands.length - 1).fill(0);
  let totalE = 0;
  for (let i = 0; i < len - frameSize; i += hop) {
    for (let b = 0; b < bands.length - 1; b++) {
      let e = 0;
      const startIdx = Math.floor((bands[b] / (sampleRate / 2)) * frameSize);
      const endIdx = Math.floor((bands[b + 1] / (sampleRate / 2)) * frameSize);
      for (let n = startIdx; n < endIdx && n < frameSize; n++) { const v = floatSamples[i + n] || 0; e += v * v; }
      bandE[b] += e; totalE += e;
    }
  }
  if (totalE === 0) return [{ name: 'unknown', label: 'Unknown', confidence: 0.5 }];
  const ratios = bandE.map(e => e / totalE);
  const lowRatio = ratios[0], midRatio = ratios[1] + ratios[2], highRatio = ratios[3];
  let zcr = 0;
  const zcrStep = Math.max(1, Math.floor(len / 8192));
  for (let i = zcrStep; i < len; i += zcrStep) { if (floatSamples[i] * floatSamples[i - zcrStep] < 0) zcr++; }
  const zcrNorm = zcr / (len / zcrStep);
  if (midRatio > 0.55 && zcrNorm > 0.08 && zcrNorm < 0.35) instruments.push({ name: 'vocal', label: 'Human Voice', confidence: +Math.min(0.9, midRatio * 1.3).toFixed(2) });
  if (lowRatio > 0.30 && ratios[1] > 0.30 && zcrNorm < 0.25) instruments.push({ name: 'veena', label: 'Veena / String', confidence: +Math.min(0.85, (lowRatio + ratios[1]) * 0.9).toFixed(2) });
  if (highRatio > 0.25 && zcrNorm > 0.20) instruments.push({ name: 'flute', label: 'Flute / Wind', confidence: +Math.min(0.80, highRatio * 1.5).toFixed(2) });
  if (ratios[0] > ratios[1] * 1.5 && zcrNorm > 0.30) instruments.push({ name: 'mridangam', label: 'Mridangam / Percussion', confidence: +Math.min(0.80, lowRatio * 2).toFixed(2) });
  if (lowRatio > 0.35 && zcrNorm < 0.12) instruments.push({ name: 'tampura', label: 'Tampura / Drone', confidence: +Math.min(0.75, lowRatio * 1.4).toFixed(2) });
  if (ratios[2] > 0.28 && highRatio > 0.15 && zcrNorm > 0.15 && zcrNorm < 0.30) instruments.push({ name: 'violin', label: 'Violin / Bowing', confidence: +Math.min(0.78, (ratios[2] + highRatio)).toFixed(2) });
  if (instruments.length === 0) instruments.push({ name: 'mixed', label: 'Mixed / Ensemble', confidence: 0.5 });
  return instruments.sort((a, b) => b.confidence - a.confidence);
}

function detectGamakas(pitchFrames, sampleRate, hop = 512) {
  const detected = new Set();
  const WINDOW = 30;
  for (let i = WINDOW; i < pitchFrames.length - WINDOW; i++) {
    if (pitchFrames[i].confidence < 0.1) continue;
    const freqs = pitchFrames.slice(i - WINDOW, i + WINDOW).filter(f => f.freq > 0).map(f => f.freq);
    if (freqs.length < 10) continue;
    const mean = freqs.reduce((a, b) => a + b, 0) / freqs.length;
    const variance = freqs.reduce((s, f) => s + (f - mean) ** 2, 0) / freqs.length;
    const stddev = Math.sqrt(variance);
    const deviation = stddev / mean;
    let crossings = 0;
    for (let j = 1; j < freqs.length; j++) { if ((freqs[j] - mean) * (freqs[j-1] - mean) < 0) crossings++; }
    const crossingRate = crossings / (WINDOW * 2 * hop / sampleRate);
    if (deviation > 0.008 && crossingRate > 4) detected.add('kampita');
    if (deviation > 0.015 && crossingRate >= 1 && crossingRate < 4) detected.add('andola');
    if (deviation > 0.004 && deviation <= 0.008) detected.add('spurita');
  }
  const swaraseq = pitchFrames.filter(f => f.confidence > 0.2).map(f => Math.round(f.semi));
  for (let len = 3; len <= 6; len++) {
    for (let i = 0; i < swaraseq.length - len * 2; i++) {
      const pat = swaraseq.slice(i, i + len).join(',');
      const rest = swaraseq.slice(i + len, i + len * 4).join(',');
      if (rest.includes(pat)) { detected.add('neravel'); break; }
    }
    if (detected.has('neravel')) break;
  }
  return [...detected].filter(Boolean);
}

const PY = process.platform === 'win32' ? 'python' : 'python3';

async function runTranscription(audioPath, lang = 'te', modelSize = 'base') {
  const tmpOut = path.join(os.tmpdir(), `gm_trans_${Date.now()}.json`);
  const script = `import sys, json, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
try:
    from faster_whisper import WhisperModel
except Exception as e:
    print(json.dumps({"error": str(e), "available": False}))
    sys.exit(1)
audio = sys.argv[1]; lang = sys.argv[2]; size = sys.argv[3]; outfile = sys.argv[4]
model = WhisperModel(size, device='cpu', compute_type='int8')
segs, info = model.transcribe(audio, language=lang, beam_size=5, vad_filter=True,
    vad_parameters=dict(min_silence_duration_ms=200, speech_pad_ms=100),
    word_timestamps=True, condition_on_previous_text=True, temperature=0.0,
    no_speech_threshold=0.3, log_prob_threshold=-0.6)
result = {'language': info.language, 'confidence': float(info.language_probability),
          'duration': float(info.duration), 'text': '', 'segments': [], 'words': [], 'available': True}
texts = []
for seg in segs:
    t = seg.text.strip(); texts.append(t); wds = []
    if hasattr(seg, 'words') and seg.words:
        for w in seg.words:
            wds.append({'word': w.word, 'start': float(w.start), 'end': float(w.end), 'prob': float(w.probability)})
            result['words'].append(wds[-1])
    result['segments'].append({'start': float(seg.start), 'end': float(seg.end), 'text': t, 'words': wds})
result['text'] = ' '.join(texts)
with open(outfile, 'w', encoding='utf-8') as f:
    f.write(json.dumps(result, ensure_ascii=False))
print('OK')`;
  const tmpScript = path.join(os.tmpdir(), `gm_transcribe_${Date.now()}.py`);
  fs.writeFileSync(tmpScript, script);
  return new Promise((resolve) => {
    const proc = spawn(PY, [tmpScript, audioPath, lang, modelSize, tmpOut], {
      timeout: 300000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
             HF_HUB_DISABLE_SYMLINKS_WARNING: '1', TOKENIZERS_PARALLELISM: 'false' }
    });
    let errBuf = [];
    proc.stderr.on('data', d => errBuf.push(d));
    proc.on('close', code => {
      try { fs.unlinkSync(tmpScript); } catch(_) {}
      if (code === 0 && fs.existsSync(tmpOut)) {
        try { const data = JSON.parse(fs.readFileSync(tmpOut, 'utf8')); fs.unlinkSync(tmpOut); resolve(data); return; } catch(e) {}
      }
      const errStr = Buffer.concat(errBuf).toString('utf8');
      fs.existsSync(tmpOut) && fs.unlinkSync(tmpOut);
      resolve({ available: false, error: errStr.slice(0, 500), text: '', segments: [], words: [] });
    });
  });
}

function buildSahityamGrid(swaraFrames, pitchFrames, talaObj, tempo, ragaName, sampleRate, carnaticSegments = []) {
  const HOP = 512;
  const beatsPerSec = tempo / 60;
  const framesPerBeat = Math.round(sampleRate / HOP / beatsPerSec);
  const tala = (typeof talaObj === 'string') ? { beats: 8, sections: [4, 2, 2], clapOn: [true, false, false] } : (talaObj || { beats: 8, sections: [4, 2, 2], clapOn: [true, false, false] });
  const talaBeats = tala.beats || 8;
  const sections = tala.sections || [4, 2, 2];

  const beatSwaras = [];
  let curBeat = [], beatCount = 0;
  for (let fi = 0; fi < swaraFrames.length; fi++) {
    curBeat.push(swaraFrames[fi]);
    if (curBeat.length >= framesPerBeat || fi === swaraFrames.length - 1) {
      const freq = {};
      for (const f of curBeat) { if (f.swara && f.swara !== '.') freq[f.swara] = (freq[f.swara] || 0) + 1; }
      const domSwara = Object.keys(freq).length ? Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0] : '.';
      beatSwaras.push({ swara: domSwara, beat: beatCount });
      beatCount++; curBeat = [];
    }
  }

  function buildNotation(swaras) {
    const tokens = [];
    let posInCycle = 0, posInSection = 0, sectionIdx = 0;
    for (const bs of swaras) {
      tokens.push(bs.swara || '.');
      posInCycle++; posInSection++;
      const currentSectionLen = sections[sectionIdx] || talaBeats;
      if (posInSection >= currentSectionLen) {
        posInSection = 0; sectionIdx++;
        if (sectionIdx >= sections.length) { tokens.push('||'); posInCycle = 0; sectionIdx = 0; }
        else { tokens.push('|'); }
      }
    }
    return tokens.join(' ');
  }

  function splitByDetectedSections(beatSwaras, segments) {
    if (!segments || !segments.length) {
      const totalBeats = beatSwaras.length;
      const cycleLen = talaBeats;
      const cycles = Math.floor(totalBeats / cycleLen) || 1;
      return {
        pallavi: beatSwaras.slice(0, Math.floor(cycles * 0.4) * cycleLen),
        anupallavi: beatSwaras.slice(Math.floor(cycles * 0.4) * cycleLen, Math.floor(cycles * 0.7) * cycleLen),
        charanam: beatSwaras.slice(Math.floor(cycles * 0.7) * cycleLen)
      };
    }
    const pEnd = Math.max(...segments.filter(s => s.section === 'PALLAVI').map(s => s.end), 0);
    const aEnd = Math.max(...segments.filter(s => s.section === 'ANUPALLAVI').map(s => s.end), pEnd);
    const totalDur = Math.max(...segments.map(s => s.end), beatSwaras.length * (60/tempo));
    const pBeat = Math.floor((pEnd / totalDur) * beatSwaras.length);
    const aBeat = Math.floor((aEnd / totalDur) * beatSwaras.length);
    return {
      pallavi: beatSwaras.slice(0, pBeat),
      anupallavi: beatSwaras.slice(pBeat, aBeat),
      charanam: beatSwaras.slice(aBeat)
    };
  }

  const sectionsData = splitByDetectedSections(beatSwaras, carnaticSegments);
  return {
    tala: tala.name || 'Adi', talaObj: tala, tempo,
    notation: buildNotation(beatSwaras), beatSwaras,
    ...sectionsData
  };
}

function buildLyricsData(raga, sahityamGrid, transcription, sectionLyrics) {
  const sections = sectionLyrics || { pallavi: '', anupallavi: '', charanam: '', sahityam: '' };

  // Fallback: if no section lyrics from segments, split raw transcription by word count
  if (!sections.pallavi && transcription?.text) {
    const words = transcription.text.split(/\s+/);
    const third = Math.floor(words.length / 3);
    sections.pallavi = words.slice(0, third).join(' ');
    sections.anupallavi = words.slice(third, third * 2).join(' ');
    sections.charanam = words.slice(third * 2).join(' ');
    sections.sahityam = transcription.text;
  }

  return {
    raga: raga.label, aroha: raga.aroha, avaroha: raga.avaroha,
    tala: sahityamGrid?.tala || 'Adi', tempo: sahityamGrid?.tempo || 80,
    sections,
    transcription: transcription || null,
    swaraGrid: sahityamGrid?.notation || ''
  };
}

function buildStemInfo(ragaResult, carnaticSegments = []) {
  const swAroha = (ragaResult.aroha || 'S R G M P D N S').split(/\s+/).filter(Boolean);
  const swAvar = (ragaResult.avaroha || 'S N D P M G R S').split(/\s+/).filter(Boolean);

  const pSegs = carnaticSegments.filter(s => s.section === 'PALLAVI' && s.type === 'SAHITYA');
  const aSegs = carnaticSegments.filter(s => s.section === 'ANUPALLAVI' && s.type === 'SAHITYA');

  const swPall = pSegs.length ? extractSwarasFromSegments(pSegs) : swAroha.slice(0, 5);
  const swAnup = aSegs.length ? extractSwarasFromSegments(aSegs) : swAvar.slice(0, 4);

  return {
    stems: [
      { id:'vocal', label:'Human Vocal / Voice', icon:'🎤', role:'Primary melodic voice', swaras:swPall, midiProgram:52, midiChannel:4, lyric: (carnaticSegments.find(s => s.section === 'PALLAVI' && s.line)?.line) || (ragaResult.label + ' — Pallavi'), notes: swPall.map(s => SWARA_DISPLAY[s] || s) },
      { id:'veena', label:'Veena / Melodic Lead', icon:'🪕', role:'Full raga scale', swaras:[...swAroha,...swAvar], midiProgram:24, midiChannel:0, lyric: ragaResult.label + ' — Arohana/Avarohana', notes: [...swAroha,...swAvar].map(s => SWARA_DISPLAY[s] || s) },
      { id:'violin', label:'Violin / Strings', icon:'🎻', role:'Melodic accompaniment', swaras:swAnup, midiProgram:41, midiChannel:1, lyric: (carnaticSegments.find(s => s.section === 'ANUPALLAVI' && s.line)?.line) || (ragaResult.label + ' — Anupallavi'), notes: swAnup.map(s => SWARA_DISPLAY[s] || s) },
      { id:'mridangam', label:'Mridangam / Percussion', icon:'🥁', role:'Tala keeper', swaras:['.'], midiProgram:117, midiChannel:9, lyric: 'Adi Tala', notes:['.'] },
      { id:'flute', label:'Flute / Wind', icon:'🎵', role:'Interlude / Phrases', swaras:swAroha, midiProgram:74, midiChannel:2, lyric: ragaResult.label + ' — Flute phrases', notes: swAroha.map(s => SWARA_DISPLAY[s] || s) }
    ]
  };
}

function extractSwarasFromSegments(segments) {
  const swaraCounts = {};
  for (const seg of segments) {
    if (seg.pitchMean > 0) {
      const midi = Math.round(12 * Math.log2(seg.pitchMean / 440) + 69);
      const semi = ((midi - 60) % 12 + 12) % 12;
      const sw = SEMI_TO_SWARA_DEFAULT[semi] || 'S';
      swaraCounts[sw] = (swaraCounts[sw] || 0) + 1;
    }
  }
  return Object.entries(swaraCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(x => x[0]);
}

const _cache = new Map();
function _cacheKey(buf) { return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16); }
function _cacheGet(key) { return _cache.get(key) || null; }
function _cacheSet(key, val) { _cache.set(key, val); if (_cache.size > 50) _cache.delete(_cache.keys().next().value); }

async function analyseFile(filePath, originalName, fileSize, sourceUrl, opts = {}) {
  filePath = filePath ? String(filePath) : 'unknown.mp3';
  originalName = (originalName && typeof originalName === 'string') ? originalName : path.basename(filePath);
  fileSize = Number(fileSize) || 0;

  let pcmData = null;
  let sampleRate = 22050;
  let decodedPath = filePath;
  const hasFFmpeg = await isFFmpegAvailable();

  if (hasFFmpeg) {
    try {
      const wavPath = path.join(os.tmpdir(), `gm_decoded_${Date.now()}.wav`);
      await decodeToFloatPCM(filePath, wavPath);
      const pcm = readPCMFloats(wavPath);
      pcmData = pcm.samples; sampleRate = pcm.sampleRate; decodedPath = wavPath;
    } catch (e) { console.warn('[GoMaa] FFmpeg decode failed:', e.message); }
  }
  if (!pcmData && filePath.match(/\.wav$/i)) {
    try { const pcm = readPCMFloats(filePath); pcmData = pcm.samples; sampleRate = pcm.sampleRate; } catch(e) {}
  }

  let audioBuf = null;
  try { audioBuf = fs.readFileSync(filePath); } catch(_) {}
  let cacheKey = null;
  if (audioBuf) { try { cacheKey = _cacheKey(audioBuf); } catch(_) {} }
  if (cacheKey) {
    const cached = _cacheGet(cacheKey);
    if (cached) { console.log('[GoMaa] Cache hit:', cached.raga, 'for', originalName.slice(0, 40)); return cached; }
  }

  let pitchFrames = [];
  let audioScale = { semis: [0, 2, 4, 7, 9], energy: new Array(12).fill(0), chroma: new Array(12).fill(0) };
  let tempoResult = { bpm: 80, beatPeriodFrames: 24, confidence: 0 };
  let talaResult = { name: 'Adi', beats: 8, sections: [4, 2, 2], clapOn: [true, false, false], tradition: 'carnatic', jati: 'chatusra', angaStr: 'Laghu(4) + Dhrutam(2) + Dhrutam(2) = 8 beats', detectedBeats: 8, cycleVotes: [], confidence: 0.3, note: 'Default', alternatives: [] };
  let detectedGamakas = ['kampita'];
  let detectedInstruments = [{ name: 'mixed', label: 'Mixed / Ensemble', confidence: 0.5 }];

  if (pcmData && pcmData.length > 4096) {
    pitchFrames = extractPitchFrames(pcmData, sampleRate);
    audioScale = detectAudioScale(pitchFrames);
    tempoResult = estimateTempo(pcmData, sampleRate);
    detectedGamakas = detectGamakas(pitchFrames, sampleRate);
    detectedInstruments = detectInstruments(pcmData, sampleRate);
    talaResult = detectTala(pcmData, sampleRate, tempoResult);
  }

  const detectedScaleStr = audioScale.semis.map(s => SEMI_TO_SWARA_DEFAULT[s] || 'S').join(' ');
  const ragaFromScale = detectRagaFromScale(detectedScaleStr, originalName);
  const ragaFromFile = detectRaga(originalName, fileSize, audioBuf);
  let raga = ragaFromFile;
  if (ragaFromScale.score > ragaFromFile.score + 0.05 && audioScale.semis.length >= 4) raga = ragaFromScale;
  const ragaM = detectRagamalika(originalName, fileSize, audioBuf);
  console.log('[GoMaa DETECT] ' + '-'.repeat(33));
  console.log('[GoMaa DETECT] File    :', originalName.slice(0, 50));
  console.log('[GoMaa DETECT] Raga    :', raga.label, '| Melakarta:', raga.ragaNumber);
  console.log('[GoMaa DETECT] Source  :', raga.detectionSource, '| Score:', raga.score);
  console.log('[GoMaa DETECT] Aroha ↑ :', raga.aroha);
  console.log('[GoMaa DETECT] Avaroha↓:', raga.avaroha);
  console.log('[GoMaa DETECT] ' + '-'.repeat(33));

  let transcription = null;
  if (hasFFmpeg && decodedPath && fs.existsSync(decodedPath)) {
    try {
      transcription = await Promise.race([
        runTranscription(decodedPath, opts.language || 'te', opts.model || 'base'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Transcription timeout')), 300000))
      ]);
    } catch (e) {
      console.warn('[GoMaa] Transcription failed:', e.message);
      transcription = { available: false, error: e.message, text: '', segments: [], words: [] };
    }
  } else {
    transcription = { available: false, error: 'FFmpeg not available or decode failed', text: '', segments: [], words: [] };
  }
  if (decodedPath !== filePath) { setTimeout(() => { try { fs.unlinkSync(decodedPath); } catch(_) {} }, 60000); }

  const semiToSwara = buildSemiToSwara(parseSwaras(raga.aroha || 'S R G M P D N S'), parseSwaras(raga.avaroha || 'S N D P M G R S'));
  const arohaAvaroha = pcmData && pitchFrames.length > 50
    ? detectArohaAvaroha(pitchFrames, audioScale.semis, raga.aroha, raga.avaroha)
    : { aroha: raga.aroha, avaroha: raga.avaroha, detectedAroha: raga.aroha, detectedAvaroha: raga.avaroha };

  const swaraFrames = pitchFrames.length > 0 ? evaluateSwaras(pitchFrames, semiToSwara, sampleRate) : [];
  const totalDuration = pcmData.length / sampleRate;

  // Write PCM to temp file for Python segmenter (non-blocking)
  const pcmTmpPath = path.join(os.tmpdir(), `gm_pcm_${Date.now()}.raw`);
  const floatArray = new Float32Array(pcmData);
  fs.writeFileSync(pcmTmpPath, Buffer.from(floatArray.buffer));

  let carnaticSegments = [];
  try {
    // Audio-only segmentation — NO hardcoded lyrics
    carnaticSegments = await analyzeCarnaticAudio(pcmTmpPath, sampleRate, totalDuration, {
      pallaviEnd: 90, anupallaviEnd: 180
    });
  } catch (e) {
    console.warn('[GoMaa] Segmenter error:', e.message);
  }
  try { fs.unlinkSync(pcmTmpPath); } catch (_) {}

  // Map actual Whisper transcription words to detected segments by timestamp
  const alignedSegments = assignTranscriptionToSegments(transcription, carnaticSegments);

  // Build real Pallavi/Anupallavi/Charanam lyrics from transcription
  const sectionLyrics = buildSectionLyrics(alignedSegments);
  const sahityamGrid = swaraFrames.length > 0 ? buildSahityamGrid(swaraFrames, pitchFrames, talaResult, tempoResult.bpm, raga.label, sampleRate, alignedSegments) : null;
  const lyricsData = buildLyricsData(raga, sahityamGrid, transcription, sectionLyrics);

  const mergedGamakas = [...new Set([...(detectedGamakas.length ? detectedGamakas : []), ...(raga.gamakas || ['kampita'])])];
  raga.gamakas = mergedGamakas;

  let sheet = '', midi = '', stems = {};
  try {
    sheet = generateSheetMusicXml(raga, {
      tala: talaResult.name,
      transcription: {
        full: String(transcription?.text || ''),
        pallavi: String(sectionLyrics?.pallavi || ''),
        anupallavi: String(sectionLyrics?.anupallavi || ''),
        charanam: String(sectionLyrics?.charanam || '')
      },
      pitchFrames: pitchFrames
    });
  } catch(e) { console.warn('[GoMaa] sheet gen error:', e.message); }
  try { midi = generateMidi(raga, { instruments: ['veena', 'tampura', 'mridangam', 'violin'], tempo: tempoResult.bpm }); } catch(e) { console.warn('[GoMaa] midi gen error:', e.message); }
  try { stems = buildStemInfo(raga, alignedSegments); } catch(e) {}

  let fp = { hash: '', peaks: [] };
  let embed = { vector: [] };
  try { fp = generateFingerprint(filePath) || fp; } catch(e) { console.warn('[GoMaa] fingerprint error:', e.message); }
  try { embed = embedAudio(filePath, fileSize, null) || embed; } catch(e) { console.warn('[GoMaa] embed error:', e.message); }

  let fpMatches = [];
  try {
    await Promise.race([db.getDb(), new Promise((_, rej) => setTimeout(() => rej(new Error('DB timeout')), 3000))]);
    const fpRows = db.all('SELECT f.hash,f.music_id,m.title,m.raga,m.artist FROM fingerprint f LEFT JOIN music m ON m.id=f.music_id LIMIT 300') || [];
    fpMatches = matchFingerprint(fp, fpRows.map(r => ({ id: r.music_id, hash: r.hash, title: r.title, raga: r.raga, artist: r.artist, score: r.hash === fp.hash ? 1.0 : 0.2, peaks: fp.peaks })));
    fuse(fpMatches[0] || null, { score: 0.75 }, raga);
  } catch(_) {}

  const recId = crypto.createHash('md5').update(filePath + Date.now()).digest('hex').slice(0, 16);
  const result = {
    id: recId, recognized: fpMatches.length > 0, fileName: originalName, sourceUrl: sourceUrl || null,
    raga: raga.label, ragaNumber: raga.ragaNumber, ragaChakra: raga.chakra,
    aroha: arohaAvaroha.aroha, avaroha: arohaAvaroha.avaroha,
    detectedAroha: arohaAvaroha.detectedAroha, detectedAvaroha: arohaAvaroha.detectedAvaroha,
    mood: raga.mood, gamakas: raga.gamakas, confidence: raga.confidence,
    detectionScore: raga.score, detectionSource: raga.detectionSource, topCandidates: raga.topCandidates,
    isRagamalika: ragaM.isRagamalika, ragamalikaSegments: ragaM.segments,
    audioAnalysis: {
      detectedScale: audioScale.semis, chroma: audioScale.chroma, estimatedTempo: tempoResult.bpm, tempoConfidence: tempoResult.confidence,
      detectedGamakas, instruments: detectedInstruments, pitchFrameCount: pitchFrames.length,
      tala: { name: talaResult.name, beats: talaResult.beats, sections: talaResult.sections, angaStr: talaResult.angaStr, jati: talaResult.jati, coreTala: talaResult.coreTala, tradition: talaResult.tradition, clapOn: talaResult.clapOn, detectedBeats: talaResult.detectedBeats, confidence: talaResult.confidence, cycleVotes: talaResult.cycleVotes, note: talaResult.note, alternatives: talaResult.alternatives }
    },
    instruments: detectedInstruments, gamakaAnalysis: { detected: detectedGamakas, summary: detectedGamakas.join(', ') || 'sustained' },
    swaraFrames: swaraFrames.slice(0, 2000), swaraCount: swaraFrames.length, sahityamGrid: sahityamGrid || null,
    lyricsData, transcription, sheetMusicXml: sheet, midiB64: midi, stems,
    fingerprint: fp, embedding: embed, fpMatches: fpMatches.slice(0, 5)
  };

  try {
    db.run('INSERT OR REPLACE INTO music (id,title,artist,raga,ragaNumber,aroha,avaroha,mood,gamakas,filePath,embedding,analysisJson,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,strftime(\'%s\',\'now\'))',
      [recId, originalName, sourceUrl || 'upload', raga.label, raga.ragaNumber, arohaAvaroha.aroha, arohaAvaroha.avaroha, raga.mood,
       JSON.stringify(raga.gamakas || []), filePath, JSON.stringify(embed.vector), JSON.stringify(result)]);
  } catch(_) {}

  if (cacheKey) _cacheSet(cacheKey, result);
  return result;
}

router.post('/upload', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const result = await analyseFile(req.file.path, req.file.originalname, req.file.size, null, {
      language: req.headers['x-language'] || 'te', model: req.headers['x-model'] || 'base'
    });
    setTimeout(() => { try { fs.unlinkSync(req.file.path); } catch(_) {} }, 60000);
    res.json(result);
  } catch (e) { console.error('recognize/upload:', e.message); res.status(500).json({ error: e.message }); }
});

router.post('/buffer', express.raw({ type: '*/*', limit: '500mb' }), async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'Empty buffer' });
    const id = crypto.randomBytes(8).toString('hex');
    const xfn = decodeURIComponent(req.headers['x-filename'] || 'recording.webm');
    const ext = (xfn.match(/\.(mp3|wav|ogg|flac|webm|m4a|mp4|avi|mov|mkv)$/i) || ['.webm'])[0];
    const fp = path.join(UPLOAD_DIR, `buf_${id}${ext}`);
    fs.writeFileSync(fp, req.body);
    const result = await analyseFile(fp, xfn, req.body.length, null, {
      language: req.headers['x-language'] || 'te', model: req.headers['x-model'] || 'base'
    });
    setTimeout(() => { try { fs.unlinkSync(fp); } catch(_) {} }, 60000);
    res.json(result);
  } catch (e) { console.error('recognize/buffer:', e.message); res.status(500).json({ error: e.message }); }
});

router.post('/url', express.json(), async (req, res) => {
  try {
    const { url, language, model } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    const isYouTube = YT_HOSTS.some(h => url.includes(h));
    let tmpPath = null, originalName = 'url_audio.mp3';
    if (isYouTube) {
      const ytdlp = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
      tmpPath = path.join(UPLOAD_DIR, `yt_${Date.now()}.mp3`);
      originalName = `youtube_${Date.now()}.mp3`;
      try {
        await new Promise((resolve, reject) => {
          const proc = spawn(ytdlp, ['-f', 'bestaudio', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0', '-o', tmpPath, url], { timeout: 120000 });
          let stderr = '';
          proc.stderr.on('data', d => stderr += d);
          proc.on('close', code => { if (code !== 0) reject(new Error(`yt-dlp failed: ${stderr.slice(0, 200)}`)); else resolve(); });
        });
      } catch (e) { return res.status(400).json({ error: 'YouTube download requires yt-dlp. Install: pip install yt-dlp', hint: 'Or download the audio manually and upload it.', ytEmbedHint: true }); }
    } else {
      let parsedUrl;
      try { parsedUrl = new URL(url); } catch (_) { return res.status(400).json({ error: 'Invalid URL' }); }
      const proto = parsedUrl.protocol === 'https:' ? https : http;
      const audioData = await new Promise((resolve, reject) => {
        const chunks = [];
        const opts = { hostname: parsedUrl.hostname, port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80), path: parsedUrl.pathname + parsedUrl.search, method: 'GET', headers: { ...FETCH_HEADERS, Referer: parsedUrl.origin || 'https://' + parsedUrl.hostname }, timeout: 30000 };
        const req2 = proto.request(opts, r => {
          if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) {
            return proto.get(r.headers.location, { headers: FETCH_HEADERS, timeout: 20000 }, r2 => { const chunks2 = []; r2.on('data', c => chunks2.push(c)); r2.on('end', () => resolve(Buffer.concat(chunks2))); }).on('error', reject);
          }
          if (r.statusCode !== 200) return reject(new Error(`Server returned ${r.statusCode}`));
          r.on('data', c => chunks.push(c)); r.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req2.on('error', reject); req2.on('timeout', () => { req2.destroy(); reject(new Error('Timeout (30s)')); }); req2.end();
      });
      if (audioData.length < 1024) return res.status(400).json({ error: 'URL returned too little data' });
      const suffix = (url.match(/\.(mp3|wav|flac|ogg|m4a|mp4|webm)/i) || ['.mp3'])[0];
      tmpPath = path.join(UPLOAD_DIR, `url_${Date.now()}${suffix}`);
      originalName = path.basename(parsedUrl.pathname) || `url_audio${suffix}`;
      fs.writeFileSync(tmpPath, audioData);
    }
    const result = await analyseFile(tmpPath, originalName, fs.statSync(tmpPath).size, url, { language: language || 'te', model: model || 'base' });
    setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch (_) {} }, 30000);
    res.json(result);
  } catch (e) { console.error('recognize/url:', e.message); res.status(500).json({ error: e.message }); }
});

router.get('/stems/:id', async (req, res) => {
  try {
    await db.getDb();
    const row = db.get('SELECT * FROM music WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const raga = { label: row.raga, aroha: row.aroha, avaroha: row.avaroha, mood: row.mood, gamakas: JSON.parse(row.gamakas || '[]') };
    res.json(buildStemInfo(raga, []));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/lyrics/:id', async (req, res) => {
  try {
    await db.getDb();
    const row = db.get('SELECT * FROM music WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const raga = { label: row.raga, aroha: row.aroha, avaroha: row.avaroha, mood: row.mood, gamakas: JSON.parse(row.gamakas || '[]') };
    const analysis = JSON.parse(row.analysisJson || '{}');
    res.json(buildLyricsData(raga, analysis.sahityamGrid, analysis.transcription));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
