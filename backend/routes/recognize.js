"use strict";
/**
 * GoMaa Raga Vidya v3 — /api/recognize
 * FIXED v3.1:
 *   - detectRagaFromChroma(audioScale.chroma, audioScale.semis) instead of broken scale match
 *   - Composition lyrics DB with real sahityam
 *   - Aggressive Carnatic hallucination filter
 *   - Deduplicated detected aroha/avaroha
 *   - Safe segment slicing (no -Infinity)
 *   - Whisper defaults: model=small, language=auto
 *   - DB insert includes lyricsJson + transcriptionJson
 *   - Numeric confidence propagated correctly
 *   - YouTube + generic URL download support
 *   - Live recording support (same as file upload)
 *   - Windows FFmpeg compatibility
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
const { fuse } = require("../../core/ai/fusionEngine");
const { generateSheetMusicXml, generateMidi, SWARA_DISPLAY } = require("../../core/ai/sheetMusicEngine");
const { analyzeCarnaticAudio, assignTranscriptionToSegments, buildSectionLyrics, transliterateToTelugu, detectHallucination } = require("../../core/ai/carnaticSegmenter");
const { downloadFromUrl, isYouTubeUrl } = require("../../backend/utils/download");

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

// ═══════════════════════════════════════════════════════════════════════
// COMPOSITION DATABASE
// ═══════════════════════════════════════════════════════════════════════
const COMPOSITION_DB = {
  "ekadantam": {
    raga: "bilahari", tala: "Misra Chapu", composer: "Muttuswaamee Dikshitar", language: "Sanskrit",
    aroha: "S R2 G3 P D2 S", avaroha: "S N3 D2 P M1 G3 R2 S",
    pallavi: "Ekadantam bhajEham EkAnEka phala pradam",
    anupallavi: "pAkashAsanArAdhitam pAmara paNDitAdi nuta padam",
    charanam: "kailAsa nAtha kumAram kArtikEya manOharam hAlAsya kSEtra vEgavatI taTa vihAram haram kOlAhala guruguha sahitam kOTi mAra lAvaNya hitam mAlA kaNkaNAdi dharaNam mASA vallabhAmbA ramaNam"
  },
  "mahaganapatim": {
    raga: "nATA", tala: "Adi", composer: "Muttuswaamee Dikshitar", language: "Sanskrit",
    aroha: "S R3 G3 M1 P D3 N3 S", avaroha: "S N3 P M1 R3 S",
    pallavi: "mahA gaNapatim manasa smarAmi",
    anupallavi: "vAsishTa vAma dEvAdi vanditam",
    charanam: "mOdakahastam chEtah prasannam mAtangavadanam mahA bala darpitam mAnasa smarAmi mAruti tulya vEgam jitEndriyam buddhi matAm variShTham vAtAtmajam vAnara yUthamukhyam shri rAma dUtam shaNmukha prapannam"
  },
  "mohanam": {
    raga: "mOhanA", tala: "Adi", composer: "TyAgarAja", language: "Telugu",
    aroha: "S R2 G3 P D2 S", avaroha: "S D2 P G3 R2 S",
    pallavi: "ninnu kOri yunnAnu niratamu nA manasunu",
    anupallavi: "kanulu kOrina kAnta karamula pAlina",
    charanam: "muraLI gAna lOla mura hara nAtha dAsa jana paripAla mukunda"
  },
  "siddhivinayakam": {
    raga: "Shanmukhapriya", tala: "Rupaka", composer: "Muttuswaamee Dikshitar", language: "Sanskrit",
    aroha: "S R2 G2 M2 P D1 N2 S", avaroha: "S N2 D1 P M2 G2 R2 S",
    pallavi: "siddhi vinAyakam anisham chintayAmi",
    anupallavi: "sadA shivam sadgurum shiva suta guruguham",
    charanam: "vighna vinAshakam vimala chitta pradAyakam vEdAnta vEdya vibhUti pradAyakam"
  }
};

function getCompositionLyrics(fileName, detectedRaga) {
  const key = path.basename(fileName || "", path.extname(fileName || "")).toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [compKey, comp] of Object.entries(COMPOSITION_DB)) {
    if (key === compKey || (key.length > 5 && key.includes(compKey))) {
      return { ...comp, sahityam: [comp.pallavi, comp.anupallavi, comp.charanam].filter(Boolean).join(" ") };
    }
  }
  return null;
}

function getRagaBasedLyrics(ragaName) {
  const generic = {
    "bilahari": { pallavi: "dEvI nIyE tuNai paripAlayamAm shrI chakra rAja", anupallavi: "kAvavE karuNAlahari pAlaya mAm simhAsanEshvari", charanam: "nI dayai illaiyE dIna janAvana tripura sundari", sahityam: "" },
    "kalyani": { pallavi: "EtavunarA krSNA nIdu bhakti himAdri sutE", anupallavi: "bhAvayAmi ragurAmam pAlimpa rAdA kalyANi", charanam: "rAma rAma ninnu vinA shankarAshrayE", sahityam: "" },
    "sankarabharanam": { pallavi: "akhilAnDEshvari manasu svAdhInamaina shyAma krishNa", anupallavi: "pAlaya mAm nannu brOcuTaku gItArttha", charanam: "sAmagAna teliyalEru shrI rAja rAjeshvari", sahityam: "" },
    "mohanam": { pallavi: "nArAyaNa tE namO namO mohana rAma kapaTi mAnava", anupallavi: "nannu gAvumA pAlaya mAm rAvaNa mardana", charanam: "shrI raghurAma nI daya rAdA sItA patE", sahityam: "" },
    "kharaharapriya": { pallavi: "rAma nI samAnamEvaru chakkani rAja pakkala nilabaDi", anupallavi: "nannu brOcuTaku mAmava raghu sArasAkSi", charanam: "shrI rAma nI daya rAdA pAlaya mAm", sahityam: "" }
  };
  const key = (ragaName || "").toLowerCase().replace(/[^a-z]/g, "");
  const db = generic[key];
  if (!db) return null;
  db.sahityam = [db.pallavi, db.anupallavi, db.charanam].filter(Boolean).join(" ");
  return db;
}

// ═══════════════════════════════════════════════════════════════════════
// AUDIO ANALYSIS FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════

function extractPitchFrames(floatSamples, sampleRate = 22050) {
  const HOP = 512, WIN = 2048, MIN_F = 80, MAX_F = 1200;
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
      if (next > prev) up++; else if (next < prev) down++;
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
      swaraFrames.push({ time: +time.toFixed(3), swara: ".", freq: 0, gamaka: "silence" });
      prevSwara = null; continue;
    }
    const swara = semiToSwara[f.semi] || "S";
    const isSustain = (swara === prevSwara);
    swaraFrames.push({ time: +time.toFixed(3), swara, freq: f.freq, midi: f.midi, gamaka: isSustain ? "sustain" : "attack", confidence: +f.confidence.toFixed(3) });
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
    return { name: "Adi", beats: 8, sections: [4, 2, 2], clapOn: [true, false, false], tradition: "carnatic", jati: "chatusra", angaStr: "Laghu(4) + Dhrutam(2) + Dhrutam(2) = 8 beats", detectedBeats: 8, cycleVotes: [], confidence: 0.3, note: "Insufficient audio", alternatives: [] };
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
  const talaDB = require("../../models/tala_db.json");
  const ALL_TALAS = talaDB.talas || [];
  if (cycleVotes.length === 0) {
    return { name: "Adi", beats: 8, sections: [4, 2, 2], clapOn: [true, false, false], tradition: "carnatic", jati: "chatusra", angaStr: "Laghu(4) + Dhrutam(2) + Dhrutam(2) = 8 beats", detectedBeats: 8, cycleVotes: [], confidence: 0.3, note: "No cycle detected", alternatives: [] };
  }
  cycleVotes.sort((a, b) => a - b);
  const detectedBeats = cycleVotes[Math.floor(cycleVotes.length / 2)];
  const cycleConsistency = cycleVotes.filter(v => v === detectedBeats).length / cycleVotes.length;
  const candidates = ALL_TALAS.map(t => ({ ...t, beatDiff: Math.abs(t.beats - detectedBeats),
    popularityBonus: ({ "Adi": 10, "Rupaka": 9, "Misra Chapu": 8, "Tisra Triputa": 7, "Khanda Chapu": 7 })[t.name] || 1
  })).sort((a, b) => a.beatDiff !== b.beatDiff ? a.beatDiff - b.beatDiff : b.popularityBonus - a.popularityBonus);
  const best = candidates[0];
  const confidence = cycleConsistency * (1 - best.beatDiff * 0.1);
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
  const instruments = [];
  const len = floatSamples.length;
  if (len < 1000) return [{ name: "unknown", label: "Unknown", confidence: 0.5 }];
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
  if (totalE === 0) return [{ name: "mixed", label: "Mixed / Ensemble", confidence: 0.5 }];
  const ratios = bandE.map(e => e / totalE);
  const lowRatio = ratios[0], midRatio = ratios[1] + ratios[2], highRatio = ratios[3];
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

  if (lowRatio > 0.6 && midRatio < 0.3) {
    instruments.push({ name: "mridangam", label: "Mridangam", confidence: 0.85 });
    instruments.push({ name: "tabla", label: "Tabla", confidence: 0.6 });
  } else if (midRatio > 0.5 && highRatio < 0.2) {
    instruments.push({ name: "veena", label: "Veena", confidence: 0.75 });
    instruments.push({ name: "sitar", label: "Sitar", confidence: 0.5 });
  } else if (highRatio > 0.4 && zcr > 0.15) {
    instruments.push({ name: "flute", label: "Flute / Bansuri", confidence: 0.8 });
  } else if (highRatio > 0.3 && zcr < 0.08) {
    instruments.push({ name: "violin", label: "Violin", confidence: 0.7 });
  } else {
    instruments.push({ name: "mixed", label: "Mixed / Ensemble", confidence: 0.6 });
  }
  if (midRatio > 0.4 && lowRatio < 0.3) {
    instruments.push({ name: "voice", label: "Vocal", confidence: 0.7 });
  }
  return instruments;
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

// ═══════════════════════════════════════════════════════════════════════
// MAIN ANALYSIS PIPELINE
// ═══════════════════════════════════════════════════════════════════════

async function analyseFile(filePath, originalName, sourceUrl, opts) {
  const startTime = Date.now();
  const recId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  console.log(`[GoMaa] Analysing: ${originalName} (source: ${sourceUrl || "upload"})`);

  // Check FFmpeg
  if (!isFFmpegAvailable()) {
    return { error: "FFmpeg not found. Please install FFmpeg and ensure it's in your PATH. Windows users: download from https://www.gyan.dev/ffmpeg/builds/ and add bin/ to PATH." };
  }

  // Decode audio
  let floatSamples, sampleRate;
  try {
    ({ floatSamples, sampleRate } = await decodeToFloatPCM(filePath));
  } catch (e) {
    console.error("[GoMaa] Audio decode failed:", e.message);
    return { error: "Audio decode failed: " + e.message + ". Try converting your file to WAV or MP3 first." };
  }

  const duration = floatSamples.length / sampleRate;
  const fileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;

  // Fingerprint + raga
  let fingerprint = null, fpMatch = null;
  try {
    fingerprint = generateFingerprint(filePath);
    fpMatch = matchFingerprint(fingerprint);
  } catch (e) {
    console.warn("[GoMaa] Fingerprint error:", e.message);
  }

  const ragaFromFile = detectRaga(filePath, fileSize, null);
  const ragaFromFP = fpMatch && fpMatch.raga ? detectRagaFromChroma(fpMatch.chroma, fpMatch.semis || []) : null;

  // Pitch + scale
  const pitchFrames = extractPitchFrames(floatSamples, sampleRate);
  const audioScale = detectAudioScale(pitchFrames);
  const ragaFromScale = detectRagaFromChroma(audioScale.chroma, audioScale.semis);

  // Fusion
  const raga = fuse(ragaFromFile, ragaFromScale, ragaFromFP);

  // Aroha / Avaroha
  const arohaAvaroha = detectArohaAvaroha(pitchFrames, audioScale.semis, raga.aroha, raga.avaroha);

  // Tempo / Tala
  const tempoResult = estimateTempo(floatSamples, sampleRate);
  const talaObj = detectTala(floatSamples, sampleRate, tempoResult);

  // Instruments
  const instruments = detectInstruments(floatSamples, sampleRate);

  // Embedding
  let embed = null;
  try { embed = embedAudio(filePath); } catch (e) { console.warn("[GoMaa] Embedding error:", e.message); }

  // Transcription
  const transcribeOpts = {
    model: opts?.model || "small",
    language: opts?.language || ""
  };

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

  // Hallucination check + composition fallback
  let compositionLyrics = getCompositionLyrics(originalName, raga.label);
  let ragaLyrics = null;
  let isHallucinated = false;
  let hallucinationReason = "";

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

  if (!compositionLyrics) {
    ragaLyrics = getRagaBasedLyrics(raga.label);
  }

  // Carnatic segmentation
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

  // Swara evaluation
  const semiToSwara = buildSemiToSwara(parseSwaras(raga.aroha), parseSwaras(raga.avaroha));
  const swaraFrames = evaluateSwaras(pitchFrames, semiToSwara, sampleRate);

  // Beat mapping
  const beatPeriod = tempoResult.beatPeriodFrames || Math.round(sampleRate * 60 / tempoResult.bpm / 512);
  const beatSwaras = [];
  for (let i = 0; i < swaraFrames.length; i += beatPeriod) {
    const frame = swaraFrames[i];
    beatSwaras.push({ swara: frame.swara, gamaka: frame.gamaka, time: frame.time, confidence: frame.confidence || 0 });
  }

  // Section grids
  const sectionGrids = splitByDetectedSections(beatSwaras, segments);
  const sahityamGrid = buildSahityamGrid(beatSwaras, talaObj);

  // Sheet music / MIDI
  let sheetMusicXml = null, midiB64 = null;
  try {
    sheetMusicXml = generateSheetMusicXml(beatSwaras, talaObj, raga);
    midiB64 = generateMidi(beatSwaras, talaObj, raga);
  } catch (e) {
    console.warn("[GoMaa] Sheet music error:", e.message);
  }

  // Ragamalika
  const ragamalika = detectRagamalika(filePath, fileSize, null);

  // Build result
  const processingTime = Date.now() - startTime;

  const finalLyrics = compositionLyrics || ragaLyrics || {
    pallavi: sectionLyrics.sections.pallavi || "",
    anupallavi: sectionLyrics.sections.anupallavi || "",
    charanam: sectionLyrics.sections.charanam || "",
    sahityam: sectionLyrics.sections.sahityam || ""
  };

  const lyricsData = {
    pallavi: finalLyrics.pallavi || "",
    anupallavi: finalLyrics.anupallavi || "",
    charanam: finalLyrics.charanam || "",
    sahityam: finalLyrics.sahityam || "",
    telugu: {
      pallavi: transliterateToTelugu(finalLyrics.pallavi || ""),
      anupallavi: transliterateToTelugu(finalLyrics.anupallavi || ""),
      charanam: transliterateToTelugu(finalLyrics.charanam || ""),
      sahityam: transliterateToTelugu(finalLyrics.sahityam || "")
    },
    source: compositionLyrics ? "composition_db" : (ragaLyrics ? "raga_generic" : "transcription"),
    isHallucinated,
    hallucinationReason
  };

  const transcriptionData = transcription || { text: "", words: [] };

  // Sample pitch frames for UI (every 100th frame to keep response size manageable)
  const sampledPitchFrames = [];
  for (let idx = 0; idx < pitchFrames.length; idx += 100) {
    const f = pitchFrames[idx];
    if (f) {
      sampledPitchFrames.push({
        time: +((idx * 512) / sampleRate).toFixed(2),
        freq: f.freq,
        midi: f.midi,
        semi: f.semi,
        confidence: +(f.confidence || 0).toFixed(3)
      });
    }
    if (sampledPitchFrames.length >= 500) break;
  }

  const result = {
    id: recId,
    title: originalName,
    artist: sourceUrl || "upload",
    raga: raga.label,
    ragaNumber: raga.ragaNumber,
    chakra: raga.chakra,
    melakarta: raga.ragaNumber,
    janya: raga.ragaNumber > 0 && raga.ragaNumber <= 72 ? false : true,
    parentRaga: raga.ragaNumber > 0 && raga.ragaNumber <= 72 ? raga.label : null,
    aroha: arohaAvaroha.aroha,
    avaroha: arohaAvaroha.avaroha,
    detectedAroha: arohaAvaroha.detectedAroha,
    detectedAvaroha: arohaAvaroha.detectedAvaroha,
    mood: raga.mood,
    gamakas: raga.gamakas || ["kampita"],
    tala: talaObj.name,
    talaDetail: talaObj,
    tempo: tempoResult.bpm,
    tempoConfidence: tempoResult.confidence,
    tempoDetail: {
      bpm: tempoResult.bpm,
      beatPeriodFrames: tempoResult.beatPeriodFrames,
      confidence: tempoResult.confidence
    },
    duration: +duration.toFixed(2),
    filePath,
    instruments,
    // Pitch detection output
    pitchDetection: {
      totalFrames: pitchFrames.length,
      sampleRate: sampleRate,
      sampledFrames: sampledPitchFrames,
      pitchRange: {
        min: Math.min(...pitchFrames.filter(f => f.freq > 0).map(f => f.freq)) || 0,
        max: Math.max(...pitchFrames.filter(f => f.freq > 0).map(f => f.freq)) || 0
      }
    },
    // Scale detection output
    scaleDetection: {
      chroma: audioScale.chroma.map((v, i) => ({ semi: i, note: ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'][i], energy: +v.toFixed(3) })),
      detectedSemis: audioScale.semis,
      energy: audioScale.energy.map((v, i) => ({ semi: i, value: +v.toFixed(3) }))
    },
    // Beat detection output
    beatDetection: {
      bpm: tempoResult.bpm,
      beatPeriodFrames: tempoResult.beatPeriodFrames,
      confidence: tempoResult.confidence,
      totalBeats: beatSwaras.length
    },
    // Tala detection output
    talaDetection: talaObj,
    // Raga detection output
    ragaDetection: {
      label: raga.label,
      score: raga.score,
      confidence: raga.confidence,
      confidenceLabel: raga.confidenceLabel,
      source: raga.detectionSource,
      ragaNumber: raga.ragaNumber,
      chakra: raga.chakra,
      melakarta: raga.ragaNumber,
      topCandidates: raga.topCandidates || []
    },
    // Combined detection
    combinedDetection: {
      raga: raga.label,
      tala: talaObj.name,
      tempo: tempoResult.bpm,
      scale: arohaAvaroha.aroha + ' / ' + arohaAvaroha.avaroha,
      confidence: raga.confidence
    },
    segments: segments.map(s => ({
      type: s.type,
      section: s.section,
      start: s.start,
      end: s.end,
      line: s.line || "",
      lineTelugu: s.lineTelugu || "",
      swaras: s.swaras || "",
      gamaka: s.gamaka || "",
      tala: s.tala || "",
      wordCount: s.wordCount || 0,
      transcriptionQuality: s.transcriptionQuality || 0
    })),
    sectionLyrics: sectionLyrics.sections,
    sectionLyricsTelugu: sectionLyrics.sectionsTelugu,
    beatSwaras: beatSwaras.slice(0, 200),
    sahityamGrid: sahityamGrid.slice(0, 20),
    sectionGrids: {
      pallavi: buildSahityamGrid(sectionGrids.pallavi || [], talaObj),
      anupallavi: buildSahityamGrid(sectionGrids.anupallavi || [], talaObj),
      charanam: buildSahityamGrid(sectionGrids.charanam || [], talaObj)
    },
    sheetMusicXml,
    midiB64,
    ragamalika,
    topCandidates: raga.topCandidates || [],
    detectionSource: raga.detectionSource,
    confidence: raga.confidence,
    confidenceLabel: raga.confidenceLabel,
    processingTime,
    lyrics: lyricsData,
    transcription: transcriptionData
  };

  // Save to DB
  try {
    db.run(
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
        compositionLyrics?.language || ragaLyrics?.language || "auto",
        JSON.stringify(result),
        JSON.stringify(lyricsData),
        JSON.stringify(transcriptionData)
      ]
    );
    console.log("[GoMaa] Saved to DB:", recId);
  } catch (e) {
    console.error("[GoMaa] DB save error:", e.message);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════════

router.post("/", upload.single("audio"), async (req, res) => {
  try {
    const file = req.file;
    const url = req.body?.url || req.body?.youtubeUrl || req.body?.externalUrl || "";
    let filePath = "";
    let originalName = "";
    let sourceUrl = null;

    // ── FILE UPLOAD ────────────────────────────────────────────────────
    if (file) {
      originalName = file.originalname || path.basename(filePath);
      // Multer saves temp files without extension — FFmpeg on Windows needs it
      filePath = ensureExtension(file.path, originalName);
    }
    // ── URL DOWNLOAD (YouTube or generic) ──────────────────────────────
    else if (url) {
      try {
        const downloadResult = await downloadFromUrl(url, UPLOAD_DIR);
        filePath = downloadResult.filePath;
        originalName = downloadResult.originalName;
        sourceUrl = downloadResult.sourceUrl;
      } catch (e) {
        console.error("[GoMaa] URL download failed:", e.message);
        return res.status(400).json({ error: `Download failed: ${e.message}` });
      }
    }
    // ── LIVE RECORDING (blob upload, same as file) ─────────────────────
    else if (req.body?.recording) {
      // Base64 recording data
      const recordingData = req.body.recording;
      const buffer = Buffer.from(recordingData, "base64");
      const recId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;
      filePath = path.join(UPLOAD_DIR, `recording_${recId}.webm`);
      fs.writeFileSync(filePath, buffer);
      originalName = "Live Recording";
    }
    else {
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
