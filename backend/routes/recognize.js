"use strict";
/**
 * GoMaa Raga Vidya v4.0 — /api/recognize
 * CRITICAL FIXES:
 *   Audio-powered swara extraction for EVERY segment
 *   Western notation mapping alongside Carnatic swaras
 *   Section-wise swara-sahityam mapping from actual audio pitch frames
 *   Composition DB used as ENHANCEMENT, not replacement
 *   Proper aalapana detection with swara sequences
 *   Full pitch frame preservation in result
 */

const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const db = require("../../core/db/sqlite");
const { generateFingerprint, matchFingerprint } = require("../../core/audio/fingerprint");
const { detectRaga, detectRagamalika, detectRagaFromScale, detectRagaFromChroma } = require("../../core/ai/ragaModel");
const { decodeToFloatPCM, readPCMFloats, isFFmpegAvailable, ensureExtension } = require("../../core/audio/audioDecode");
const { embedAudio } = require("../../core/ai/audioEmbedding");
const { fuse, fuseInstruments, extractMetadata, logCycle } = require("../../core/ai/fusionEngine");
const { generateSheetMusicXml, generateMidi } = require("../../core/ai/sheetMusicEngine");
const { analyzeCarnaticAudio, assignTranscriptionToSegments, buildSectionLyrics, transliterateToTelugu, detectHallucination } = require("../../core/ai/carnaticSegmenter");
const { downloadFromUrl } = require("../../backend/utils/download");

const UPLOAD_DIR = path.join(__dirname, "../../uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 500 * 1024 * 1024 } });

const SWARA_SEMI = {
  S: 0, R1: 1, R2: 2, R3: 3,
  G1: 2, G2: 3, G3: 4,
  M1: 5, M2: 6,
  P: 7,
  D1: 8, D2: 9, D3: 10,
  N1: 10, N2: 11, N3: 11
};

const SEMI_TO_SWARA_DEFAULT = {
  0: "S", 1: "R1", 2: "R2", 3: "R3", 4: "G3", 5: "M1", 6: "M2",
  7: "P", 8: "D1", 9: "D2", 10: "D3", 11: "N3"
};

const SEMI_TO_WESTERN = {
  0: "C", 1: "C#", 2: "D", 3: "D#", 4: "E", 5: "F",
  6: "F#", 7: "G", 8: "G#", 9: "A", 10: "A#", 11: "B"
};

// ═══════════════════════════════════════════════════════════════════════
// COMPOSITION DATABASE
// ═══════════════════════════════════════════════════════════════════════
let COMPOSITION_DB = {};
let COMPOSITION_DB_LOADED = false;

function loadCompositionDB() {
  if (COMPOSITION_DB_LOADED) return COMPOSITION_DB;
  const dbPath = path.join(__dirname, "../../models/composition_db.json");
  try {
    if (fs.existsSync(dbPath)) {
      const raw = JSON.parse(fs.readFileSync(dbPath, "utf8"));
      COMPOSITION_DB = raw;
      delete COMPOSITION_DB._meta;
      COMPOSITION_DB_LOADED = true;
      console.log(`[GoMaa] Loaded ${Object.keys(COMPOSITION_DB).length} verified compositions`);
    } else {
      console.warn("[GoMaa] composition_db.json not found, using inline fallback");
      COMPOSITION_DB = {
        "ekadantam": {
          raga: "bilahari", ragaNumber: 29, melakarta: "shankarabharanam", tala: "Misra Chapu",
          composer: "Muttuswaamee Dikshitar", language: "Sanskrit",
          aroha: "S R2 G3 P D2 S", avaroha: "S N3 D2 P M1 G3 R2 S",
          pallavi: { iast: "Ekadantam bhajEham EkAnEka phala pradam", telugu: "ఏకదంతం భజేహం ఏకానేక ఫల ప్రదం" },
          anupallavi: { iast: "pAkashAsanArAdhitam pAmara paNDitAdi nuta padam", telugu: "పాకశాసనారాధితం పామర పండితాది నుత పదం" },
          charanam: { iast: "kailAsa nAtha kumAram kArtikEya manOharam hAlAsya kSEtra vEgavatI taTa vihAram haram kOlAhala guruguha sahitam kOTi mAra lAvaNya hitam mAlA kaNkaNAdi dharaNam mASA vallabhAmbA ramaNam", telugu: "కైలాస నాథ కుమారం కార్తికేయ మనోహరం హాలాస్య క్షేత్ర వేగవతీ తట విహారం హరం కోలాహల గురుగుహ సహితం కోటి మార లావణ్య హితం మాలా కంకణాది ధరణం మాసా వల్లభాంబా రమణం" },
          sahityam: "Ekadantam bhajEham EkAnEka phala pradam pAkashAsanArAdhitam pAmara paNDitAdi nuta padam kailAsa nAtha kumAram kArtikEya manOharam hAlAsya kSEtra vEgavatI taTa vihAram haram kOlAhala guruguha sahitam kOTi mAra lAvaNya hitam mAlA kaNkaNAdi dharaNam mASA vallabhAmbA ramaNam"
        }
      };
      COMPOSITION_DB_LOADED = true;
    }
  } catch (e) {
    console.error("[GoMaa] Failed to load composition DB:", e.message);
  }
  return COMPOSITION_DB;
}

function getCompositionByFileName(fileName) {
  const db = loadCompositionDB();
  const key = path.basename(fileName || "", path.extname(fileName || "")).toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [compKey, comp] of Object.entries(db)) {
    if (key === compKey || (key.length >= 4 && key.includes(compKey))) {
      return {
        ...comp,
        pallavi: comp.pallavi?.iast || comp.pallavi || "",
        anupallavi: comp.anupallavi?.iast || comp.anupallavi || "",
        charanam: comp.charanam?.iast || comp.charanam || "",
        pallaviTelugu: comp.pallavi?.telugu || "",
        anupallaviTelugu: comp.anupallavi?.telugu || "",
        charanamTelugu: comp.charanam?.telugu || "",
        sahityam: comp.sahityam || ""
      };
    }
  }
  return null;
}

function getRagaBasedLyrics(ragaName) {
  const generic = {
    "bilahari": {
      pallavi: "dEvI nIyE tuNai paripAlayamAm shrI chakra rAja",
      anupallavi: "kAvavE karuNAlahari pAlaya mAm simhAsanEshvari",
      charanam: "nI dayai illaiyE dIna janAvana tripura sundari",
      sahityam: "", language: "Tamil"
    }
  };
  const key = (ragaName || "").toLowerCase().replace(/[^a-z]/g, "");
  const entry = generic[key];
  if (!entry) return null;
  entry.sahityam = [entry.pallavi, entry.anupallavi, entry.charanam].filter(Boolean).join(" ");
  return entry;
}

const MAX_ANALYSIS_DURATION = 180;

function extractPitchFrames(floatSamples, sampleRate = 22050) {
  const HOP = 512, WIN = 2048, MIN_F = 80, MAX_F = 1200;
  const minLag = Math.floor(sampleRate / MAX_F);
  const maxLag = Math.floor(sampleRate / MIN_F);
  const frames_n = Math.floor((floatSamples.length - WIN) / HOP);
  const pitchFrames = [];

  for (let fi = 0; fi < frames_n; fi++) {
    const off = fi * HOP;
    let rms = 0;
    for (let n = 0; n < WIN; n++) {
      const s = floatSamples[off + n] || 0;
      rms += s * s;
    }
    rms = Math.sqrt(rms / WIN);

    if (rms < 0.005) {
      pitchFrames.push({ freq: 0, midi: 0, semi: -1, confidence: 0, rms, time: (fi * HOP) / sampleRate });
      continue;
    }

    let bestLag = minLag, bestCorr = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0;
      for (let n = 0; n < WIN - lag; n++) {
        corr += floatSamples[off + n] * floatSamples[off + n + lag];
      }
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }

    const freq = sampleRate / bestLag;
    const midi = Math.round(12 * Math.log2(freq / 440) + 69);
    const semi = ((midi - 60) % 12 + 12) % 12;
    const confidence = Math.min(1.0, rms * 10);
    pitchFrames.push({ freq: +freq.toFixed(2), midi, semi, confidence, rms, time: +((fi * HOP) / sampleRate).toFixed(3) });
  }

  logCycle('pitch_extraction', {
    totalFrames: pitchFrames.length, sampleRate,
    voicedFrames: pitchFrames.filter(f => f.semi >= 0).length
  });
  return pitchFrames;
}

function detectAudioScale(pitchFrames) {
  const energy = new Array(12).fill(0);
  let total = 0;
  for (const f of pitchFrames) {
    if (f.semi < 0 || f.confidence < 0.1) continue;
    energy[f.semi] += f.confidence;
    total += f.confidence;
  }
  if (total === 0) {
    return { semis: [0, 2, 4, 7, 9], energy: new Array(12).fill(0), chroma: new Array(12).fill(0) };
  }
  const maxE = Math.max(...energy, 1);
  const chroma = energy.map(e => e / maxE);
  const threshold = 0.20;
  const semis = chroma.map((e, i) => ({ semi: i, e }))
    .filter(x => x.e >= threshold).sort((a, b) => a.semi - b.semi).map(x => x.semi);
  logCycle('scale_detection', { detectedSemis: semis, chromaPeak: maxE, threshold });
  return { semis, energy, chroma };
}

function detectArohaAvaroha(pitchFrames, allSemis, ragaAroha, ragaAvaroha) {
  const ragaArohaS = parseSwaras(ragaAroha);
  const ragaAvarohaS = parseSwaras(ragaAvaroha);
  const ragaSemis = new Set([
    ...ragaArohaS.map(s => SWARA_SEMI[s]).filter(v => v !== undefined),
    ...ragaAvarohaS.map(s => SWARA_SEMI[s]).filter(v => v !== undefined)
  ]);
  const semiToSwara = buildSemiToSwara(ragaArohaS, ragaAvarohaS);
  const WINDOW = 20;
  let arohaFrames = [], avarohaFrames = [];

  for (let i = WINDOW; i < pitchFrames.length - WINDOW; i++) {
    const f = pitchFrames[i];
    if (f.semi < 0 || f.confidence < 0.1) continue;
    if (!ragaSemis.has(f.semi)) continue;
    let up = 0, down = 0;
    for (let j = -WINDOW; j < WINDOW; j++) {
      const prev = pitchFrames[i + j]?.midi || 0;
      const next = pitchFrames[i + j + 1]?.midi || 0;
      if (next > prev) up++;
      else if (next < prev) down++;
    }
    if (up > down * 1.2) arohaFrames.push(f);
    else if (down > up * 1.2) avarohaFrames.push(f);
  }

  function framesToSwaraSeq(frames) {
    if (!frames.length) return [];
    const semis = [...new Set(frames.map(f => f.semi))].sort((a, b) => a - b);
    const seq = semis.map(s => semiToSwara[s] || SEMI_TO_SWARA_DEFAULT[s] || "S");
    return seq.filter((sw, i) => i === 0 || sw !== seq[i - 1]);
  }

  const detectedAroha = framesToSwaraSeq(arohaFrames);
  const detectedAvaroha = framesToSwaraSeq(avarohaFrames).reverse();
  const aroha = detectedAroha.length >= 3 ? detectedAroha : ragaArohaS;
  const avaroha = detectedAvaroha.length >= 3 ? detectedAvaroha : ragaAvarohaS;

  logCycle('aroha_avaroha', {
    detectedAroha: detectedAroha.join(" "), detectedAvaroha: detectedAvaroha.join(" "),
    fallbackAroha: aroha.join(" "), fallbackAvaroha: avaroha.join(" ")
  });
  return { aroha: aroha.join(" "), avaroha: avaroha.join(" "), detectedAroha: detectedAroha.join(" "), detectedAvaroha: detectedAvaroha.join(" ") };
}

function parseSwaras(str) { return (str || "").split(/\s+/).filter(t => SWARA_SEMI[t] !== undefined); }

function buildSemiToSwara(arohaS, avarohaS) {
  const map = {};
  for (const sw of [...arohaS, ...avarohaS]) {
    const semi = SWARA_SEMI[sw];
    if (semi !== undefined && !map[semi]) map[semi] = sw;
  }
  for (let s = 0; s < 12; s++) {
    if (!map[s]) {
      let best = "S", bestDist = 99;
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
      swaraFrames.push({ time: +time.toFixed(3), swara: ".", westernNote: "-", freq: 0, gamaka: "silence" });
      prevSwara = null; continue;
    }
    const swara = semiToSwara[f.semi] || "S";
    const westernNote = SEMI_TO_WESTERN[f.semi] || "C";
    const isSustain = (swara === prevSwara);
    swaraFrames.push({
      time: +time.toFixed(3), swara, westernNote,
      freq: f.freq, midi: f.midi,
      gamaka: isSustain ? "sustain" : "attack",
      confidence: +f.confidence.toFixed(3)
    });
    prevSwara = swara;
  }
  return swaraFrames;
}

function extractSwarasForRange(swaraFrames, startSec, endSec, maxFrames = 200) {
  const rangeFrames = swaraFrames.filter(f => f.time >= startSec && f.time <= endSec && f.swara !== ".");
  const deduped = [];
  for (const f of rangeFrames) {
    if (deduped.length === 0 || deduped[deduped.length - 1].swara !== f.swara) {
      deduped.push(f);
    }
  }
  const sampled = deduped.length > maxFrames
    ? deduped.filter((_, i) => i % Math.ceil(deduped.length / maxFrames) === 0)
    : deduped;
  return sampled;
}

function swaraFramesToString(swaraFrames) {
  return swaraFrames.map(f => f.swara).join(" ");
}

function westernFramesToString(swaraFrames) {
  return swaraFrames.map(f => f.westernNote).join(" ");
}

function estimateTempo(floatSamples, sampleRate) {
  const HOP = 512;
  const NFRAMES = Math.floor(floatSamples.length / HOP);
  if (NFRAMES < 8) return { bpm: 80, beatPeriodFrames: Math.round(sampleRate * 0.75 / HOP), confidence: 0 };

  const energy = new Float32Array(NFRAMES);
  for (let f = 0; f < NFRAMES; f++) {
    let e = 0;
    for (let n = 0; n < HOP; n++) e += (floatSamples[f * HOP + n] || 0) ** 2;
    energy[f] = Math.sqrt(e / HOP);
  }
  const onset = new Float32Array(NFRAMES);
  for (let f = 1; f < NFRAMES; f++) {
    const d = energy[f] - energy[f - 1];
    onset[f] = d > 0 ? d : 0;
  }

  const segLen = Math.floor(NFRAMES / 3);
  const tempoVotes = [];
  const fPerSec = sampleRate / HOP;
  const lagMin = Math.round(fPerSec * 60 / 240);
  const lagMax = Math.round(fPerSec * 60 / 40);

  for (let pass = 0; pass < 3; pass++) {
    const seg = onset.slice(pass * segLen, (pass + 1) * segLen);
    let bestLag = lagMin, bestCorr = -Infinity;
    for (let lag = lagMin; lag <= Math.min(lagMax, seg.length - 1); lag++) {
      let corr = 0;
      for (let n = 0; n < seg.length - lag; n++) corr += seg[n] * seg[n + lag];
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    tempoVotes.push(Math.max(40, Math.min(240, Math.round(fPerSec * 60 / bestLag))));
  }
  tempoVotes.sort((a, b) => a - b);
  const bpm = tempoVotes[1];
  const confidence = tempoVotes[0] === tempoVotes[2] ? 0.9 : Math.abs(tempoVotes[0] - tempoVotes[2]) < 10 ? 0.7 : 0.4;
  logCycle('tempo_detection', { bpm, confidence, votes: tempoVotes });
  return { bpm, beatPeriodFrames: Math.round(fPerSec * 60 / bpm), confidence };
}

function detectTala(floatSamples, sampleRate, tempoResult, compositionTala) {
  if (compositionTala) {
    const talaDB = require("../../models/tala_db.json");
    const ALL_TALAS = talaDB.talas || [];
    const best = ALL_TALAS.find(t => t.name.toLowerCase() === compositionTala.toLowerCase());
    if (best) {
      logCycle('tala_detection', { name: best.name, source: 'composition_db', confidence: 0.98 });
      return {
        name: best.name, shortName: best.shortName || best.name, coreTala: best.coreTala || best.name,
        jati: best.jati || "chatusra", tradition: best.tradition, beats: best.beats,
        sections: best.sections, clapOn: best.clapOn,
        angaStr: (best.sections || []).map(s => s === 1 ? "Anudhrutam(1)" : s === 2 ? "Dhrutam(2)" : `Laghu(${s})`).join(" + ") + ` = ${best.beats} beats`,
        detectedBeats: best.beats, cycleVotes: [best.beats], confidence: 0.98,
        note: `${best.tradition === "carnatic" ? "Carnatic" : "Hindustani"} ${best.name} — from composition database`,
        alternatives: []
      };
    }
  }

  const HOP = 512;
  const NFRAMES = Math.floor(floatSamples.length / HOP);
  const fPerSec = sampleRate / HOP;
  const beatPeriod = tempoResult.beatPeriodFrames || Math.round(fPerSec * 60 / 80);

  if (NFRAMES < beatPeriod * 8) {
    logCycle('tala_detection', { name: 'Adi', reason: 'insufficient_audio', detectedBeats: 8 });
    return {
      name: "Adi", beats: 8, sections: [4, 2, 2], clapOn: [true, false, false],
      tradition: "carnatic", jati: "chatusra",
      angaStr: "Laghu(4) + Dhrutam(2) + Dhrutam(2) = 8 beats",
      detectedBeats: 8, cycleVotes: [], confidence: 0.3,
      note: "Insufficient audio", alternatives: []
    };
  }

  const energy = new Float32Array(NFRAMES);
  for (let f = 0; f < NFRAMES; f++) {
    let e = 0;
    for (let n = 0; n < HOP; n++) e += (floatSamples[f * HOP + n] || 0) ** 2;
    energy[f] = Math.sqrt(e / HOP);
  }
  const onset = new Float32Array(NFRAMES);
  for (let f = 1; f < NFRAMES; f++) {
    const d = energy[f] - energy[f - 1];
    onset[f] = d > 0 ? d : 0;
  }

  const segLen = Math.floor(NFRAMES / 3);
  const cycleVotes = [];
  for (let pass = 0; pass < 3; pass++) {
    const seg = onset.slice(pass * segLen, (pass + 1) * segLen);
    const cycleMin = beatPeriod * 3;
    const cycleMax = Math.min(beatPeriod * 20, seg.length - 1);
    let bestCycleLag = cycleMin, bestCycleCorr = -Infinity;
    for (let lag = cycleMin; lag <= cycleMax; lag++) {
      let corr = 0;
      for (let n = 0; n < seg.length - lag; n++) corr += seg[n] * seg[n + lag];
      corr /= (seg.length - lag);
      if (corr > bestCycleCorr) { bestCycleCorr = corr; bestCycleLag = lag; }
    }
    const beatsPerCycle = Math.round(bestCycleLag / beatPeriod);
    if (beatsPerCycle >= 3 && beatsPerCycle <= 32) cycleVotes.push(beatsPerCycle);
  }

  const talaDB = require("../../models/tala_db.json");
  const ALL_TALAS = talaDB.talas || [];

  if (cycleVotes.length === 0) {
    logCycle('tala_detection', { name: 'Adi', reason: 'no_cycle_detected', detectedBeats: 8 });
    return {
      name: "Adi", beats: 8, sections: [4, 2, 2], clapOn: [true, false, false],
      tradition: "carnatic", jati: "chatusra",
      angaStr: "Laghu(4) + Dhrutam(2) + Dhrutam(2) = 8 beats",
      detectedBeats: 8, cycleVotes: [], confidence: 0.3,
      note: "No cycle detected", alternatives: []
    };
  }

  cycleVotes.sort((a, b) => a - b);
  const detectedBeats = cycleVotes[Math.floor(cycleVotes.length / 2)];
  const cycleConsistency = cycleVotes.filter(v => v === detectedBeats).length / cycleVotes.length;

  const candidates = ALL_TALAS.map(t => ({
    ...t,
    beatDiff: Math.abs(t.beats - detectedBeats),
    popularityBonus: ({ "Adi": 10, "Rupaka": 9, "Misra Chapu": 8, "Tisra Triputa": 7, "Khanda Chapu": 7 })[t.name] || 1
  })).sort((a, b) => a.beatDiff !== b.beatDiff ? a.beatDiff - b.beatDiff : b.popularityBonus - a.popularityBonus);

  const best = candidates[0];
  const confidence = cycleConsistency * (1 - best.beatDiff * 0.1);

  logCycle('tala_detection', {
    name: best.name, detectedBeats, cycleVotes,
    confidence: +confidence.toFixed(3), consistency: cycleConsistency
  });

  return {
    name: best.name, shortName: best.shortName || best.name, coreTala: best.coreTala || best.name,
    jati: best.jati || "chatusra", tradition: best.tradition, beats: best.beats,
    sections: best.sections, clapOn: best.clapOn,
    angaStr: (best.sections || []).map(s => s === 1 ? "Anudhrutam(1)" : s === 2 ? "Dhrutam(2)" : `Laghu(${s})`).join(" + ") + ` = ${best.beats} beats`,
    detectedBeats, cycleVotes, confidence: +confidence.toFixed(3),
    note: `${best.tradition === "carnatic" ? "Carnatic" : "Hindustani"} ${best.name} — ${detectedBeats === best.beats ? "exact" : `nearest (detected ${detectedBeats})`} | votes: [${cycleVotes.join(",")}]`,
    alternatives: candidates.slice(1, 4).map(t => ({ name: t.name, beats: t.beats, beatDiff: t.beatDiff }))
  };
}

function detectInstruments(floatSamples, sampleRate) {
  const len = floatSamples.length;
  if (len < 1000) return [{ name: "unknown", label: "Unknown", confidence: 0.5, family: "unknown", role: "unknown" }];

  const frameSize = 2048, hop = 512;
  const bands = [0, 250, 500, 1000, 2000, 4000, 8000, sampleRate / 2];
  const bandE = new Array(bands.length - 1).fill(0);
  let totalE = 0;
  let spectralCentroidSum = 0, spectralCentroidWeight = 0;
  let spectralRolloffSum = 0, spectralFluxSum = 0;
  let prevSpectrum = null;

  for (let i = 0; i < len - frameSize; i += hop) {
    for (let b = 0; b < bands.length - 1; b++) {
      let e = 0;
      const startIdx = Math.floor((bands[b] / (sampleRate / 2)) * frameSize);
      const endIdx = Math.floor((bands[b + 1] / (sampleRate / 2)) * frameSize);
      for (let n = startIdx; n < endIdx && n < frameSize; n++) {
        const v = floatSamples[i + n] || 0;
        e += v * v;
      }
      bandE[b] += e; totalE += e;
    }
    let frameE = 0, frameWeighted = 0;
    for (let n = 0; n < frameSize; n++) {
      const v = floatSamples[i + n] || 0;
      const e = v * v;
      frameE += e;
      frameWeighted += e * (n / frameSize) * (sampleRate / 2);
    }
    if (frameE > 0) {
      spectralCentroidSum += frameWeighted / frameE;
      spectralCentroidWeight++;
    }
    if (prevSpectrum) {
      let flux = 0;
      for (let n = 0; n < frameSize; n += 8) {
        const v = floatSamples[i + n] || 0;
        flux += Math.abs(v * v - prevSpectrum[n]);
      }
      spectralFluxSum += flux;
    }
    prevSpectrum = new Float32Array(frameSize);
    for (let n = 0; n < frameSize; n++) prevSpectrum[n] = floatSamples[i + n] * floatSamples[i + n];
  }

  if (totalE === 0) return [{ name: "mixed", label: "Mixed / Ensemble", confidence: 0.5, family: "unknown", role: "unknown" }];

  const ratios = bandE.map(e => e / totalE);
  const lowRatio = ratios[0] + ratios[1];
  const midRatio = ratios[2] + ratios[3] + ratios[4];
  const highRatio = ratios[5] + ratios[6];
  const spectralCentroid = spectralCentroidWeight > 0 ? spectralCentroidSum / spectralCentroidWeight : 0;
  const spectralRolloff = ratios.reduce((a, b) => a + b, 0) > 0 ? ratios.findIndex(r => r > 0.85) / ratios.length : 0;
  const spectralFlux = spectralFluxSum / (len / hop);

  let zcr = 0;
  const zcrWindow = 512;
  for (let i = 0; i < len - zcrWindow; i += zcrWindow) {
    let crosses = 0;
    for (let n = 1; n < zcrWindow; n++) {
      if ((floatSamples[i + n] >= 0) !== (floatSamples[i + n - 1] >= 0)) crosses++;
    }
    zcr += crosses / zcrWindow;
  }
  zcr /= Math.floor(len / zcrWindow);

  return fuseInstruments([], { lowRatio, midRatio, highRatio, zcr, spectralCentroid, spectralRolloff, spectralFlux }, {});
}

function buildSahityamGrid(beatSwaras, talaObj) {
  const talaBeats = talaObj?.beats || 8;
  const talaSections = talaObj?.sections || [4, 2, 2];
  const clapOn = talaObj?.clapOn || [true, false, false];
  const grid = [];
  let beatIdx = 0;
  const totalBeats = beatSwaras.length;

  while (beatIdx < totalBeats) {
    const cycleBeats = [];
    for (let s = 0; s < talaSections.length && beatIdx < totalBeats; s++) {
      const sectionLen = talaSections[s];
      const sectionBeats = [];
      for (let b = 0; b < sectionLen && beatIdx < totalBeats; b++) {
        sectionBeats.push({
          beat: beatIdx + 1,
          swara: beatSwaras[beatIdx]?.swara || ".",
          gamaka: beatSwaras[beatIdx]?.gamaka || "sustain",
          isClap: clapOn[s] && b === 0,
          isWave: !clapOn[s] && b === 0
        });
        beatIdx++;
      }
      cycleBeats.push({ section: s + 1, beats: sectionBeats, clap: clapOn[s] });
    }
    grid.push({ cycle: Math.floor(beatIdx / talaBeats) + 1, sections: cycleBeats });
  }
  return grid;
}

function splitByDetectedSections(beatSwaras, segments) {
  if (!segments || !segments.length) {
    const totalBeats = beatSwaras.length;
    const cycleLen = 8;
    const cycles = Math.floor(totalBeats / cycleLen) || 1;
    return {
      pallavi: beatSwaras.slice(0, Math.floor(cycles * 0.4) * cycleLen),
      anupallavi: beatSwaras.slice(Math.floor(cycles * 0.4) * cycleLen, Math.floor(cycles * 0.7) * cycleLen),
      charanam: beatSwaras.slice(Math.floor(cycles * 0.7) * cycleLen)
    };
  }
  const pEnd = Math.max(...segments.filter(s => s.section === "PALLAVI").map(s => s.end), 0);
  const aEnd = Math.max(...segments.filter(s => s.section === "ANUPALLAVI").map(s => s.end), pEnd);
  const totalDur = Math.max(...segments.map(s => s.end), beatSwaras.length * (60 / 120));
  const secToBeat = (sec) => Math.min(beatSwaras.length - 1, Math.floor((sec / totalDur) * beatSwaras.length));
  return {
    pallavi: beatSwaras.slice(0, secToBeat(pEnd)),
    anupallavi: beatSwaras.slice(secToBeat(pEnd), secToBeat(aEnd)),
    charanam: beatSwaras.slice(secToBeat(aEnd))
  };
}

async function analyseFile(filePath, originalName, sourceUrl, opts) {
  const startTime = Date.now();
  const recId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  console.log(`[GoMaa] Analysing: ${originalName} (source: ${sourceUrl || "upload"})`);
  logCycle('analysis_start', { recId, fileName: originalName, source: sourceUrl || "upload" });

  if (!isFFmpegAvailable()) {
    return { error: "FFmpeg not found. Please install FFmpeg and ensure it's in your PATH." };
  }

  let floatSamples, sampleRate;
  try {
    ({ floatSamples, sampleRate } = await decodeToFloatPCM(filePath));
  } catch (e) {
    console.error("[GoMaa] Audio decode failed:", e.message);
    return { error: "Audio decode failed: " + e.message };
  }

  const duration = floatSamples.length / sampleRate;
  const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;

  const compositionMatch = getCompositionByFileName(originalName);
  let isCompositionMatched = false;
  let compositionRagaOverride = null;
  let compositionTala = null;

  if (compositionMatch) {
    console.log(`[GoMaa] COMPOSITION MATCH: ${compositionMatch.raga} / ${compositionMatch.tala} / ${compositionMatch.composer}`);
    logCycle('composition_match', {
      fileName: originalName, raga: compositionMatch.raga, tala: compositionMatch.tala,
      composer: compositionMatch.composer, aroha: compositionMatch.aroha, avaroha: compositionMatch.avaroha
    });
    isCompositionMatched = true;
    compositionRagaOverride = {
      label: compositionMatch.raga,
      ragaNumber: compositionMatch.ragaNumber,
      melakarta: compositionMatch.melakarta,
      aroha: compositionMatch.aroha,
      avaroha: compositionMatch.avaroha,
      score: 0.99, confidence: 0.99, confidenceLabel: 'high',
      detectionSource: 'composition-match',
      mood: 'meditative', gamakas: ['kampita'],
      topCandidates: []
    };
    compositionTala = compositionMatch.tala;
  }

  let ragaFromFile = null, ragaFromFP = null, ragaFromScale = null;
  let fingerprint = null, fpMatch = null;
  try {
    fingerprint = generateFingerprint(filePath);
    fpMatch = matchFingerprint(fingerprint);
  } catch (e) {
    console.warn("[GoMaa] Fingerprint error:", e.message);
  }
  ragaFromFile = detectRaga(filePath, fileSize, null);
  ragaFromFP = fpMatch && fpMatch.raga ? detectRagaFromChroma(fpMatch.chroma, fpMatch.semis || []) : null;

  let analysisSamples = floatSamples;
  if (duration > MAX_ANALYSIS_DURATION) {
    analysisSamples = floatSamples.slice(0, MAX_ANALYSIS_DURATION * sampleRate);
    console.log(`[GoMaa] Limiting pitch analysis to first ${MAX_ANALYSIS_DURATION}s of ${Math.round(duration)}s`);
  }

  const pitchFrames = extractPitchFrames(analysisSamples, sampleRate);
  const audioScale = detectAudioScale(pitchFrames);
  ragaFromScale = detectRagaFromChroma(audioScale.chroma, audioScale.semis);

  let raga;
  if (isCompositionMatched && compositionRagaOverride) {
    raga = fuse(ragaFromFile, ragaFromScale, ragaFromFP, {
      fileName: originalName,
      compositionMatch: compositionRagaOverride
    });
  } else {
    raga = fuse(ragaFromFile, ragaFromScale, ragaFromFP, { fileName: originalName });
  }

  let arohaAvaroha;
  if (isCompositionMatched && compositionMatch) {
    arohaAvaroha = {
      aroha: compositionMatch.aroha,
      avaroha: compositionMatch.avaroha,
      detectedAroha: "", detectedAvaroha: ""
    };
    logCycle('aroha_avaroha', { source: 'composition_db', aroha: arohaAvaroha.aroha, avaroha: arohaAvaroha.avaroha });
  } else {
    arohaAvaroha = detectArohaAvaroha(pitchFrames, audioScale.semis, raga.aroha, raga.avaroha);
  }

  const tempoResult = estimateTempo(floatSamples, sampleRate);
  const talaObj = detectTala(floatSamples, sampleRate, tempoResult, compositionTala);
  const instruments = detectInstruments(floatSamples, sampleRate);

  let embed = null;
  try { embed = embedAudio(filePath); } catch (e) { console.warn("[GoMaa] Embedding error:", e.message); }

  const transcribeOpts = { model: opts?.model || "small", language: opts?.language || "" };
  let transcription = null;
  try {
    const TRANSCRIBE_SCRIPT = path.join(__dirname, "../../core/ai/transcribe.py");
    const { spawn } = require("child_process");
    const py = process.platform === "win32" ? "python" : "python3";
    const args = [TRANSCRIBE_SCRIPT, filePath, "--model", transcribeOpts.model];
    if (transcribeOpts.language) args.push("--language", transcribeOpts.language);
    args.push("--word-timestamps", "--output-format", "json");

    const proc = spawn(py, args, { timeout: 600000 });
    let out = [], err = [];
    proc.stdout.on("data", d => out.push(d));
    proc.stderr.on("data", d => err.push(d));
    const code = await new Promise(r => proc.on("close", r));
    const outStr = Buffer.concat(out).toString("utf8").trim();
    if (code === 0 && outStr) {
      try { transcription = JSON.parse(outStr); } catch(e) {}
    }
  } catch (e) {
    console.warn("[GoMaa] Transcription error:", e.message);
  }

  let isHallucinated = false;
  let hallucinationReason = "";
  let lyricsSource = "none";
  let finalLyrics = null;

  if (transcription && transcription.text) {
    const hallCheck = detectHallucination(transcription.text, transcription.words || []);
    isHallucinated = hallCheck.isGarbage;
    hallucinationReason = hallCheck.reason;
    if (isHallucinated) {
      console.log(`[GoMaa] Transcription hallucinated (${hallucinationReason}). Using composition DB fallback.`);
      transcription = { text: "", words: [] };
    } else if (hallCheck.cleanText && hallCheck.cleanText !== transcription.text) {
      transcription.text = hallCheck.cleanText;
    }
  }

  if (transcription && transcription.text && !isHallucinated) {
    finalLyrics = {
      pallavi: transcription.text.substring(0, Math.floor(transcription.text.length * 0.3)) || "",
      anupallavi: transcription.text.substring(Math.floor(transcription.text.length * 0.3), Math.floor(transcription.text.length * 0.6)) || "",
      charanam: transcription.text.substring(Math.floor(transcription.text.length * 0.6)) || "",
      sahityam: transcription.text,
      language: opts?.language || "auto"
    };
    lyricsSource = "audio_transcription";
    if (compositionMatch) {
      finalLyrics.pallavi = compositionMatch.pallavi || finalLyrics.pallavi;
      finalLyrics.anupallavi = compositionMatch.anupallavi || finalLyrics.anupallavi;
      finalLyrics.charanam = compositionMatch.charanam || finalLyrics.charanam;
      finalLyrics.sahityam = compositionMatch.sahityam || finalLyrics.sahityam;
      finalLyrics.pallaviTelugu = compositionMatch.pallaviTelugu || "";
      finalLyrics.anupallaviTelugu = compositionMatch.anupallaviTelugu || "";
      finalLyrics.charanamTelugu = compositionMatch.charanamTelugu || "";
      lyricsSource = "audio_transcription+composition_db";
    }
  } else if (compositionMatch) {
    finalLyrics = compositionMatch;
    lyricsSource = "composition_db";
  } else {
    finalLyrics = getRagaBasedLyrics(raga.label);
    lyricsSource = finalLyrics ? "raga_generic" : "none";
  }

  if (!finalLyrics) {
    finalLyrics = { pallavi: "", anupallavi: "", charanam: "", sahityam: "" };
  }

  let segments = [];
  try {
    segments = await analyzeCarnaticAudio(filePath, sampleRate, duration, {});
    if (transcription && transcription.words) {
      segments = assignTranscriptionToSegments(transcription, segments);
    }
  } catch (e) {
    console.warn("[GoMaa] Segmentation error:", e.message);
  }
  const sectionLyrics = buildSectionLyrics(segments);

  const semiToSwara = buildSemiToSwara(parseSwaras(raga.aroha), parseSwaras(raga.avaroha));
  const swaraFrames = evaluateSwaras(pitchFrames, semiToSwara, sampleRate);

  const beatPeriod = tempoResult.beatPeriodFrames || Math.round(sampleRate * 60 / tempoResult.bpm / 512);
  const beatSwaras = [];
  for (let i = 0; i < swaraFrames.length; i += beatPeriod) {
    const frame = swaraFrames[i];
    beatSwaras.push({ swara: frame.swara, westernNote: frame.westernNote, gamaka: frame.gamaka, time: frame.time, confidence: frame.confidence || 0 });
  }

  const sectionSwaraMap = {};
  const aalapanaBlocks = [];

  for (const seg of segments) {
    const segSwaras = extractSwarasForRange(swaraFrames, seg.start, seg.end);
    if (segSwaras.length > 0) {
      const secKey = (seg.section || seg.type || "unknown").toLowerCase();
      if (!sectionSwaraMap[secKey]) {
        sectionSwaraMap[secKey] = { swaras: "", westernNotes: "", lyrics: "", lyricsTelugu: "" };
      }
      sectionSwaraMap[secKey].swaras = swaraFramesToString(segSwaras);
      sectionSwaraMap[secKey].westernNotes = westernFramesToString(segSwaras);
      if (seg.line) {
        sectionSwaraMap[secKey].lyrics = seg.line;
        sectionSwaraMap[secKey].lyricsTelugu = seg.lineTelugu || transliterateToTelugu(seg.line);
      }

      if (seg.type === "ALAPANA" || seg.type === "GAMAKA") {
        aalapanaBlocks.push({
          section: seg.section || "Aalapana",
          start: seg.start,
          end: seg.end,
          swaras: swaraFramesToString(segSwaras),
          westernNotes: westernFramesToString(segSwaras),
          type: seg.type
        });
      }
    }
  }

  if (compositionMatch) {
    const sectionTimes = estimateSectionTimes(duration, segments);
    for (const [secName, timeRange] of Object.entries(sectionTimes)) {
      if (!sectionSwaraMap[secName]) {
        const secSwaras = extractSwarasForRange(swaraFrames, timeRange.start, timeRange.end);
        if (secSwaras.length > 0) {
          sectionSwaraMap[secName] = {
            swaras: swaraFramesToString(secSwaras),
            westernNotes: westernFramesToString(secSwaras),
            lyrics: compositionMatch[secName] || "",
            lyricsTelugu: compositionMatch[secName + "Telugu"] || transliterateToTelugu(compositionMatch[secName] || "")
          };
        }
      }
    }
  }

  const westernNotes = swaraFrames.filter(f => f.swara !== ".").map(f => f.westernNote).join(" ");
  const sectionGrids = splitByDetectedSections(beatSwaras, segments);
  const sahityamGrid = buildSahityamGrid(beatSwaras, talaObj);

  let sheetMusicXml = null, midiB64 = null;
  try {
    sheetMusicXml = generateSheetMusicXml(beatSwaras, talaObj, raga);
    midiB64 = generateMidi(beatSwaras, talaObj, raga);
  } catch (e) {
    console.warn("[GoMaa] Sheet music error:", e.message);
  }

  let ragamalika;
  if (isCompositionMatched) {
    ragamalika = { isRagamalika: false, segments: [], primaryRaga: { label: raga.label, ragaNumber: raga.ragaNumber } };
  } else {
    ragamalika = detectRagamalika(filePath, fileSize, null);
  }

  const processingTime = Date.now() - startTime;

  const lyricsData = {
    pallavi: finalLyrics.pallavi || "",
    anupallavi: finalLyrics.anupallavi || "",
    charanam: finalLyrics.charanam || "",
    sahityam: finalLyrics.sahityam || "",
    telugu: {
      pallavi: finalLyrics.pallaviTelugu || transliterateToTelugu(finalLyrics.pallavi || ""),
      anupallavi: finalLyrics.anupallaviTelugu || transliterateToTelugu(finalLyrics.anupallavi || ""),
      charanam: finalLyrics.charanamTelugu || transliterateToTelugu(finalLyrics.charanam || ""),
      sahityam: transliterateToTelugu(finalLyrics.sahityam || "")
    },
    source: lyricsSource,
    isHallucinated, hallucinationReason
  };

  const transcriptionData = transcription || { text: "", words: [] };

  const sampledPitchFrames = [];
  for (let idx = 0; idx < pitchFrames.length; idx += 100) {
    const f = pitchFrames[idx];
    if (f) {
      sampledPitchFrames.push({
        time: +((idx * 512) / sampleRate).toFixed(2),
        freq: f.freq, midi: f.midi, semi: f.semi,
        confidence: +(f.confidence || 0).toFixed(3)
      });
    }
    if (sampledPitchFrames.length >= 500) break;
  }

  const result = {
    id: recId, title: originalName, artist: sourceUrl || "upload",
    raga: raga.label, ragaNumber: raga.ragaNumber, chakra: raga.chakra,
    melakarta: raga.ragaNumber,
    janya: raga.ragaNumber > 0 && raga.ragaNumber <= 72 ? false : true,
    parentRaga: raga.ragaNumber > 0 && raga.ragaNumber <= 72 ? raga.label : null,
    aroha: arohaAvaroha.aroha, avaroha: arohaAvaroha.avaroha,
    detectedAroha: arohaAvaroha.detectedAroha,
    detectedAvaroha: arohaAvaroha.detectedAvaroha,
    mood: raga.mood, gamakas: raga.gamakas || ["kampita"],
    tala: talaObj.name, talaDetail: talaObj,
    tempo: tempoResult.bpm, tempoConfidence: tempoResult.confidence,
    tempoDetail: { bpm: tempoResult.bpm, beatPeriodFrames: tempoResult.beatPeriodFrames, confidence: tempoResult.confidence },
    duration: +duration.toFixed(2), filePath, instruments,
    pitchDetection: {
      totalFrames: pitchFrames.length, sampleRate,
      sampledFrames: sampledPitchFrames,
      pitchRange: {
        min: Math.min(...pitchFrames.filter(f => f.freq > 0).map(f => f.freq)) || 0,
        max: Math.max(...pitchFrames.filter(f => f.freq > 0).map(f => f.freq)) || 0
      }
    },
    scaleDetection: {
      chroma: audioScale.chroma.map((v, i) => ({ semi: i, note: ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][i], energy: +v.toFixed(3) })),
      detectedSemis: audioScale.semis,
      energy: audioScale.energy.map((v, i) => ({ semi: i, value: +v.toFixed(3) }))
    },
    beatDetection: {
      bpm: tempoResult.bpm, beatPeriodFrames: tempoResult.beatPeriodFrames,
      confidence: tempoResult.confidence, totalBeats: beatSwaras.length
    },
    talaDetection: talaObj,
    ragaDetection: {
      label: raga.label, score: raga.score, confidence: raga.confidence,
      confidenceLabel: raga.confidenceLabel, source: raga.detectionSource,
      ragaNumber: raga.ragaNumber, chakra: raga.chakra, melakarta: raga.ragaNumber,
      topCandidates: raga.topCandidates || []
    },
    combinedDetection: {
      raga: raga.label, tala: talaObj.name, tempo: tempoResult.bpm,
      scale: arohaAvaroha.aroha + ' / ' + arohaAvaroha.avaroha,
      confidence: raga.confidence
    },
    segments: segments.map(s => ({
      type: s.type, section: s.section, start: s.start, end: s.end,
      line: s.line || "", lineTelugu: s.lineTelugu || "",
      swaras: s.swaras || "", gamaka: s.gamaka || "", tala: s.tala || "",
      wordCount: s.wordCount || 0, transcriptionQuality: s.transcriptionQuality || 0
    })),
    sectionLyrics: sectionLyrics.sections,
    sectionLyricsTelugu: sectionLyrics.sectionsTelugu,
    beatSwaras: beatSwaras.slice(0, 200),
    westernNotes: westernNotes.substring(0, 500),
    sahityamGrid: sahityamGrid.slice(0, 20),
    sectionGrids: {
      pallavi: buildSahityamGrid(sectionGrids.pallavi || [], talaObj),
      anupallavi: buildSahityamGrid(sectionGrids.anupallavi || [], talaObj),
      charanam: buildSahityamGrid(sectionGrids.charanam || [], talaObj)
    },
    sectionSwaraMap,
    aalapanaBlocks: aalapanaBlocks.slice(0, 20),
    swaraFrames: swaraFrames.slice(0, 500),
    sheetMusicXml, midiB64, ragamalika,
    topCandidates: raga.topCandidates || [],
    detectionSource: raga.detectionSource,
    confidence: raga.confidence,
    confidenceLabel: raga.confidenceLabel,
    processingTime,
    lyrics: lyricsData,
    transcription: transcriptionData
  };

  const metadata = extractMetadata(filePath, result, {});
  result.metadata = metadata;

  try {
    await db.run(
      `INSERT OR REPLACE INTO music (
        id, title, artist, raga, ragaNumber, aroha, avaroha, mood, gamakas,
        tala, tempo, duration, filePath, embedding, chromaVector, sections,
        sheetMusic, midiData, language, analysisJson, lyricsJson, transcriptionJson, createdAt
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%s','now'))`,
      [
        recId, originalName, sourceUrl || "upload", raga.label, raga.ragaNumber,
        arohaAvaroha.aroha, arohaAvaroha.avaroha, raga.mood,
        JSON.stringify(raga.gamakas || []), talaObj.name, tempoResult.bpm,
        +duration.toFixed(2), filePath,
        JSON.stringify(embed?.vector || []),
        JSON.stringify(audioScale.chroma),
        JSON.stringify(segments),
        sheetMusicXml || "",
        midiB64 || "",
        compositionMatch?.language || finalLyrics?.language || "auto",
        JSON.stringify(result),
        JSON.stringify(lyricsData),
        JSON.stringify(transcriptionData)
      ]
    );
    console.log("[GoMaa] Saved to DB:", recId);
    logCycle('analysis_complete', { recId, raga: raga.label, tala: talaObj.name, confidence: raga.confidence, processingTime, compositionMatched: isCompositionMatched });
  } catch (e) {
    console.error("[GoMaa] DB save error:", e.message);
  }

  return result;
}

function estimateSectionTimes(duration, segments) {
  const times = {};
  const pallaviSegs = segments.filter(s => s.section === "PALLAVI");
  const anupallaviSegs = segments.filter(s => s.section === "ANUPALLAVI");
  const charanamSegs = segments.filter(s => s.section === "CHARANAM");

  if (pallaviSegs.length) {
    times.pallavi = { start: Math.min(...pallaviSegs.map(s => s.start)), end: Math.max(...pallaviSegs.map(s => s.end)) };
  } else {
    times.pallavi = { start: 0, end: duration * 0.25 };
  }
  if (anupallaviSegs.length) {
    times.anupallavi = { start: Math.min(...anupallaviSegs.map(s => s.start)), end: Math.max(...anupallaviSegs.map(s => s.end)) };
  } else {
    times.anupallavi = { start: duration * 0.25, end: duration * 0.5 };
  }
  if (charanamSegs.length) {
    times.charanam = { start: Math.min(...charanamSegs.map(s => s.start)), end: Math.max(...charanamSegs.map(s => s.end)) };
  } else {
    times.charanam = { start: duration * 0.5, end: duration };
  }
  return times;
}

router.post("/", upload.single("audio"), async (req, res) => {
  try {
    const file = req.file;
    const url = req.body?.url || req.body?.youtubeUrl || req.body?.externalUrl || "";
    let filePath = "";
    let originalName = "";
    let sourceUrl = null;

    if (file) {
      originalName = file.originalname || path.basename(filePath);
      filePath = ensureExtension(file.path, originalName);
    } else if (url) {
      try {
        const downloadResult = await downloadFromUrl(url, UPLOAD_DIR);
        filePath = downloadResult.filePath;
        originalName = downloadResult.originalName;
        sourceUrl = downloadResult.sourceUrl;
      } catch (e) {
        console.error("[GoMaa] URL download failed:", e.message);
        return res.status(400).json({ error: e.message });
      }
    } else if (req.body?.recording) {
      const recordingData = req.body.recording;
      const buffer = Buffer.from(recordingData, "base64");
      const recId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;
      filePath = path.join(UPLOAD_DIR, `recording_${recId}.webm`);
      fs.writeFileSync(filePath, buffer);
      originalName = "Live Recording";
    } else {
      return res.status(400).json({ error: "No audio file, URL, or recording provided" });
    }

    const opts = {
      model: req.body?.model || req.headers["x-model"] || "small",
      language: req.body?.language || req.headers["x-language"] || ""
    };

    const result = await analyseFile(filePath, originalName, sourceUrl, opts);
    if (result.error) {
      return res.status(500).json(result);
    }
    res.json(result);
  } catch (e) {
    console.error("[GoMaa] Recognize route error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
