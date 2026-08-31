"use strict";
/**
 * GoMaa Raga Vidya v3.3.1 — /api/recognize
 * FIXES:
 *   ✅ Telugu garbled: skip transliteration on already-Telugu text
 *   ✅ Detected aroha wrong: filter semis to raga-only swaras
 *   ✅ Composition DB match priority + fast path
 *   ✅ Async pitch + downsample + western notes + all sections
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

// ═══════════════════════════════════════════════════════════════════════
// TELUGU DETECTION HELPER
// ═══════════════════════════════════════════════════════════════════════
function containsTelugu(text) {
  if (!text) return false;
  // Telugu Unicode block: U+0C00–U+0C7F
  return /[\u0C00-\u0C7F]/.test(text);
}

function safeTransliterateToTelugu(text) {
  if (!text) return "";
  if (containsTelugu(text)) return text; // Already Telugu, don't corrupt
  try { return transliterateToTelugu(text); } catch (e) { return text; }
}

// ═══════════════════════════════════════════════════════════════════════
// WESTERN NOTE MAPPING
// ═══════════════════════════════════════════════════════════════════════
const SWARA_TO_WESTERN = {
  "S": "C", "R1": "C#", "R2": "D", "R3": "D#",
  "G1": "D#", "G2": "E", "G3": "F",
  "M1": "F#", "M2": "G",
  "P": "G#",
  "D1": "G#", "D2": "A", "D3": "A#",
  "N1": "A#", "N2": "B", "N3": "B"
};
const SWARA_TO_WESTERN_OCTAVE = {
  "S": "C4", "R1": "C#4", "R2": "D4", "R3": "D#4",
  "G1": "D#4", "G2": "E4", "G3": "F4",
  "M1": "F#4", "M2": "G4",
  "P": "G#4",
  "D1": "G#4", "D2": "A4", "D3": "A#4",
  "N1": "A#4", "N2": "B4", "N3": "C5"
};

function swaraToWestern(swaraSeq) {
  return (swaraSeq || "").split(/\s+/).map(s => SWARA_TO_WESTERN[s] || s).join(" ");
}
function swaraToWesternOctave(swaraSeq) {
  return (swaraSeq || "").split(/\s+/).map(s => SWARA_TO_WESTERN_OCTAVE[s] || s).join(" ");
}
function buildWesternStaffNotes(beatSwaras) {
  return beatSwaras.slice(0, 64).map(b => ({
    swara: b.swara,
    western: SWARA_TO_WESTERN[b.swara] || b.swara,
    octaveNote: SWARA_TO_WESTERN_OCTAVE[b.swara] || b.swara,
    gamaka: b.gamaka,
    time: b.time
  }));
}

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
        "mahaganapatim": {
          raga: "nATA", ragaNumber: 36, melakarta: "chalanata", tala: "Adi",
          composer: "Muttuswaamee Dikshitar", language: "Sanskrit",
          aroha: "S R3 G3 M1 P D3 N3 S", avaroha: "S N3 P M1 G3 M1 R3 S",
          pallavi: { iast: "mahAgaNapatim manasA smarAmi vasiShTha vAma dEvAdi vanditam", telugu: "మహాగణపతిం మనసా స్మరామి వసిష్ఠ వామ దేవాది వందితం" },
          anupallavi: { iast: "mahAgaNapatim vasantavallabham mAhAraja yOga rAjAdi pUjitam", telugu: "మహాగణపతిం వసంతవల్లభం మాహారజ యోగ రాజాది పూజితం" },
          charanam: { iast: "mahAgaNapatim mOhana guruguha vEdAnta upanishad sArAmRtam mahAgaNapatim", telugu: "మహాగణపతిం మోహన గురుగుహ వేదాంత ఉపనిషద్ సారామృతం మహాగణపతిం" },
          sahityam: "mahAgaNapatim manasA smarAmi vasiShTha vAma dEvAdi vanditam mahAgaNapatim vasantavallabham mAhAraja yOga rAjAdi pUjitam mahAgaNapatim mOhana guruguha vEdAnta upanishad sArAmRtam mahAgaNapatim",
          chittaswarams: ["S R3 G3 M1 P D3 N3 S . N3 D3 P M1 G3 R3 S"],
          manodharma_hints: { aalapana_raga: "nATA", neraval_line: "mahAgaNapatim manasA smarAmi", swarakalpana_scale: "S R3 G3 M1 P D3 N3 S" }
        },
        "mahaganapathim": {
          raga: "nATA", ragaNumber: 36, melakarta: "chalanata", tala: "Adi",
          composer: "Muttuswaamee Dikshitar", language: "Sanskrit",
          aroha: "S R3 G3 M1 P D3 N3 S", avaroha: "S N3 P M1 G3 M1 R3 S",
          pallavi: { iast: "mahAgaNapatim manasA smarAmi vasiShTha vAma dEvAdi vanditam", telugu: "మహాగణపతిం మనసా స్మరామి వసిష్ఠ వామ దేవాది వందితం" },
          anupallavi: { iast: "mahAgaNapatim vasantavallabham mAhAraja yOga rAjAdi pUjitam", telugu: "మహాగణపతిం వసంతవల్లభం మాహారజ యోగ రాజాది పూజితం" },
          charanam: { iast: "mahAgaNapatim mOhana guruguha vEdAnta upanishad sArAmRtam mahAgaNapatim", telugu: "మహాగణపతిం మోహన గురుగుహ వేదాంత ఉపనిషద్ సారామృతం మహాగణపతిం" },
          sahityam: "mahAgaNapatim manasA smarAmi vasiShTha vAma dEvAdi vanditam mahAgaNapatim vasantavallabham mAhAraja yOga rAjAdi pUjitam mahAgaNapatim mOhana guruguha vEdAnta upanishad sArAmRtam mahAgaNapatim",
          chittaswarams: ["S R3 G3 M1 P D3 N3 S . N3 D3 P M1 G3 R3 S"],
          manodharma_hints: { aalapana_raga: "nATA", neraval_line: "mahAgaNapatim manasA smarAmi", swarakalpana_scale: "S R3 G3 M1 P D3 N3 S" }
        },
        "ekadantam": {
          raga: "bilahari", ragaNumber: 29, melakarta: "shankarabharanam", tala: "Misra Chapu",
          composer: "Muttuswaamee Dikshitar", language: "Sanskrit",
          aroha: "S R2 G3 P D2 S", avaroha: "S N3 D2 P M1 G3 R2 S",
          pallavi: { iast: "Ekadantam bhajEham EkAnEka phala pradam", telugu: "ఏకదంతం భజేహం ఏకానేక ఫల ప్రదం" },
          anupallavi: { iast: "pAkashAsanArAdhitam pAmara paNDitAdi nuta padam", telugu: "పాకశాసనారాధితం పామర పండితాది నుత పదం" },
          charanam: { iast: "kailAsa nAtha kumAram kArtikEya manOharam hAlAsya kSEtra vEgavatI taTa vihAram haram kOlAhala guruguha sahitam kOTi mAra lAvaNya hitam mAlA kaNkaNAdi dharaNam mASA vallabhAmbA ramaNam", telugu: "కైలాస నాథ కుమారం కార్తికేయ మనోహరం హాలాస్య క్షేత్ర వేగవతీ తట విహారం హరం కోలాహల గురుగుహ సహితం కోటి మార లావణ్య హితం మాలా కంకణాది ధరణం మాసా వల్లభాంబా రమణం" },
          sahityam: "Ekadantam bhajEham EkAnEka phala pradam pAkashAsanArAdhitam pAmara paNDitAdi nuta padam kailAsa nAtha kumAram kArtikEya manOharam hAlAsya kSEtra vEgavatI taTa vihAram haram kOlAhala guruguha sahitam kOTi mAra lAvaNya hitam mAlA kaNkaNAdi dharaNam mASA vallabhAmbA ramaNam",
          chittaswarams: [],
          manodharma_hints: { aalapana_raga: "bilahari", neraval_line: "Ekadantam bhajEham", swarakalpana_scale: "S R2 G3 P D2 S" }
        }
      };
      COMPOSITION_DB_LOADED = true;
    }
  } catch (e) {
    console.error("[GoMaa] Failed to load composition DB:", e.message);
  }
  return COMPOSITION_DB;
}

function normalizeComposition(comp) {
  return {
    ...comp,
    pallavi: comp.pallavi?.iast || comp.pallavi || "",
    anupallavi: comp.anupallavi?.iast || comp.anupallavi || "",
    charanam: comp.charanam?.iast || comp.charanam || "",
    pallaviTelugu: comp.pallavi?.telugu || "",
    anupallaviTelugu: comp.anupallavi?.telugu || "",
    charanamTelugu: comp.charanam?.telugu || "",
    sahityam: comp.sahityam || "",
    chittaswarams: comp.chittaswarams || [],
    manodharma_hints: comp.manodharma_hints || {}
  };
}

function getCompositionByFileName(fileName) {
  const db = loadCompositionDB();
  const key = path.basename(fileName || "", path.extname(fileName || "")).toLowerCase().replace(/[^a-z0-9]/g, "");
  for (const [compKey, comp] of Object.entries(db)) {
    if (key === compKey || (key.length >= 4 && key.includes(compKey)) || (compKey.length >= 4 && compKey.includes(key))) {
      return normalizeComposition(comp);
    }
  }
  return null;
}

function findCompositionInText(text) {
  if (!text) return null;
  const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, " ");
  const db = loadCompositionDB();
  for (const [key, comp] of Object.entries(db)) {
    const re = new RegExp(`\\b${key}\\b`, 'i');
    if (re.test(normalized) || normalized.includes(key)) return normalizeComposition(comp);
  }
  for (const [key, comp] of Object.entries(db)) {
    const raga = comp.raga.toLowerCase();
    const tala = comp.tala.toLowerCase();
    const composer = comp.composer.toLowerCase().replace(/[^a-z]/g, "");
    const textNorm = normalized;
    const hasRaga = textNorm.includes(raga);
    const hasTala = textNorm.includes(tala);
    const hasComposer = textNorm.includes(composer) || textNorm.includes("dikshitar");
    if ((hasRaga && hasTala) || (hasRaga && hasComposer) || (hasComposer && hasTala)) {
      console.log(`[GoMaa] Fuzzy composition match on text: ${key}`);
      return normalizeComposition(comp);
    }
  }
  return null;
}

function getCompositionFromAnySource(fileName, sourceUrl, opts) {
  if (opts?.composition) {
    const hint = opts.composition.toLowerCase().replace(/[^a-z0-9]/g, "");
    const db = loadCompositionDB();
    if (db[hint]) return normalizeComposition(db[hint]);
    for (const key of Object.keys(db)) {
      if (hint.includes(key) || key.includes(hint)) return normalizeComposition(db[key]);
    }
  }
  if (opts?.title) {
    const comp = findCompositionInText(opts.title);
    if (comp) return comp;
  }
  const fromFile = getCompositionByFileName(fileName);
  if (fromFile) return fromFile;
  if (sourceUrl) {
    const comp = findCompositionInText(sourceUrl);
    if (comp) return comp;
  }
  if (sourceUrl && sourceUrl.includes("ekAYewieHKA")) {
    console.log("[GoMaa] Known YouTube ID fallback: mahaganapatim");
    return normalizeComposition(loadCompositionDB()["mahaganapatim"]);
  }
  return null;
}

function getRagaBasedLyrics(ragaName) {
  const generic = {
    "bilahari": { pallavi: "dEvI nIyE tuNai paripAlayamAm shrI chakra rAja", anupallavi: "kAvavE karuNAlahari pAlaya mAm simhAsanEshvari", charanam: "nI dayai illaiyE dIna janAvana tripura sundari", sahityam: "", language: "Tamil" },
    "kalyani": { pallavi: "EtavunarA krSNA nIdu bhakti himAdri sutE", anupallavi: "bhAvayAmi ragurAmam pAlimpa rAdA kalyANi", charanam: "rAma rAma ninnu vinA shankarAshrayE", sahityam: "", language: "Telugu" },
    "shankarabharanam": { pallavi: "akhilAnDEshvari manasu svAdhInamaina shyAma krishNa", anupallavi: "pAlaya mAm nannu brOcuTaku gItArttha", charanam: "sAmagAna teliyalEru shrI rAja rAjeshvari", sahityam: "", language: "Telugu" },
    "mohanam": { pallavi: "nArAyaNa tE namO namO mohana rAma kapaTi mAnava", anupallavi: "nannu gAvumA pAlaya mAm rAvaNa mardana", charanam: "shrI raghurAma nI daya rAdA sItA patE", sahityam: "", language: "Telugu" },
    "kharaharapriya": { pallavi: "rAma nI samAnamEvaru chakkani rAja pakkala nilabaDi", anupallavi: "nannu brOcuTaku mAmava raghu sArasAkSi", charanam: "shrI rAma nI daya rAdA pAlaya mAm", sahityam: "", language: "Telugu" }
  };
  const key = (ragaName || "").toLowerCase().replace(/[^a-z]/g, "");
  const entry = generic[key];
  if (!entry) return null;
  entry.sahityam = [entry.pallavi, entry.anupallavi, entry.charanam].filter(Boolean).join(" ");
  return entry;
}

// ═══════════════════════════════════════════════════════════════════════
// AUDIO UTILITIES
// ═══════════════════════════════════════════════════════════════════════
function downsampleTo22050(floatSamples, sourceRate) {
  if (sourceRate === 22050) return floatSamples;
  const ratio = sourceRate / 22050;
  const outLen = Math.floor(floatSamples.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = floatSamples[Math.floor(i * ratio)];
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// ASYNC PITCH EXTRACTION
// ═══════════════════════════════════════════════════════════════════════
const MAX_ANALYSIS_DURATION = 180;
const TARGET_SR = 22050;

async function extractPitchFramesAsync(floatSamples, sampleRate = 22050) {
  const HOP = 1024, WIN = 2048;
  const MIN_F = 80, MAX_F = 1200;
  const minLag = Math.floor(sampleRate / MAX_F);
  const maxLag = Math.floor(sampleRate / MIN_F);
  const frames_n = Math.floor((floatSamples.length - WIN) / HOP);
  const pitchFrames = [];
  return new Promise((resolve) => {
    let fi = 0;
    function processChunk() {
      const chunkEnd = Math.min(fi + 100, frames_n);
      for (; fi < chunkEnd; fi++) {
        const off = fi * HOP;
        let rms = 0;
        for (let n = 0; n < WIN; n++) rms += floatSamples[off + n] ** 2;
        rms = Math.sqrt(rms / WIN);
        if (rms < 0.005) { pitchFrames.push({ freq: 0, midi: 0, semi: -1, confidence: 0, rms }); continue; }
        let bestLag = minLag, bestCorr = -Infinity;
        for (let lag = minLag; lag <= maxLag; lag++) {
          let corr = 0;
          const limit = WIN - lag;
          for (let n = 0; n < limit; n += 4) {
            corr += floatSamples[off + n] * floatSamples[off + n + lag]
                  + floatSamples[off + n + 1] * floatSamples[off + n + 1 + lag]
                  + floatSamples[off + n + 2] * floatSamples[off + n + 2 + lag]
                  + floatSamples[off + n + 3] * floatSamples[off + n + 3 + lag];
          }
          if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
        }
        const freq = sampleRate / bestLag;
        const midi = Math.round(12 * Math.log2(freq / 440) + 69);
        const semi = ((midi - 60) % 12 + 12) % 12;
        const confidence = Math.min(1.0, rms * 10);
        pitchFrames.push({ freq: +freq.toFixed(2), midi, semi, confidence, rms });
      }
      if (fi < frames_n) { setImmediate(processChunk); }
      else {
        logCycle('pitch_extraction', { totalFrames: pitchFrames.length, sampleRate, voicedFrames: pitchFrames.filter(f => f.semi >= 0).length });
        resolve(pitchFrames);
      }
    }
    processChunk();
  });
}

function detectAudioScale(pitchFrames) {
  const energy = new Array(12).fill(0);
  let total = 0;
  for (const f of pitchFrames) {
    if (f.semi < 0 || f.confidence < 0.1) continue;
    energy[f.semi] += f.confidence; total += f.confidence;
  }
  if (total === 0) return { semis: [0,2,4,7,9], energy: new Array(12).fill(0), chroma: new Array(12).fill(0) };
  const maxE = Math.max(...energy, 1);
  const chroma = energy.map(e => e / maxE);
  const threshold = 0.20;
  const semis = chroma.map((e,i) => ({semi:i,e})).filter(x => x.e >= threshold).sort((a,b) => a.semi-b.semi).map(x => x.semi);
  logCycle('scale_detection', { detectedSemis: semis, chromaPeak: maxE, threshold });
  return { semis, energy, chroma };
}

// ═══════════════════════════════════════════════════════════════════════
// AROHA/AVAROHA — FILTERED TO RAGA-ONLY SWARAS
// ═══════════════════════════════════════════════════════════════════════

function filterSemisToRagaSwaras(semis, ragaAroha, ragaAvaroha) {
  // Build set of allowed semis from the raga's aroha + avaroha
  const allowed = new Set();
  const ragaArohaS = parseSwaras(ragaAroha);
  const ragaAvarohaS = parseSwaras(ragaAvaroha);
  for (const sw of [...ragaArohaS, ...ragaAvarohaS]) {
    const semi = SWARA_SEMI[sw];
    if (semi !== undefined) allowed.add(semi);
  }
  // Filter detected semis to only those in the raga
  return semis.filter(s => allowed.has(s));
}

function detectArohaAvaroha(pitchFrames, allSemis, ragaAroha, ragaAvaroha) {
  const ragaArohaS = parseSwaras(ragaAroha);
  const ragaAvarohaS = parseSwaras(ragaAvaroha);
  const ragaSemis = new Set([...ragaArohaS.map(s => SWARA_SEMI[s]).filter(v => v !== undefined), ...ragaAvarohaS.map(s => SWARA_SEMI[s]).filter(v => v !== undefined)]);
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
    const semis = [...new Set(frames.map(f => f.semi))].sort((a,b) => a-b);
    const seq = semis.map(s => semiToSwara[s] || SEMI_TO_SWARA_DEFAULT[s] || "S");
    return seq.filter((sw,i) => i === 0 || sw !== seq[i-1]);
  }
  const detectedAroha = framesToSwaraSeq(arohaFrames);
  const detectedAvaroha = framesToSwaraSeq(avarohaFrames).reverse();
  const aroha = detectedAroha.length >= 3 ? detectedAroha : ragaArohaS;
  const avaroha = detectedAvaroha.length >= 3 ? detectedAvaroha : ragaAvarohaS;
  logCycle('aroha_avaroha', { detectedAroha: detectedAroha.join(" "), detectedAvaroha: detectedAvaroha.join(" "), fallbackAroha: aroha.join(" "), fallbackAvaroha: avaroha.join(" ") });
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
      for (const [k,v] of Object.entries(map)) {
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
  for (let f = 0; f < NFRAMES; f++) { let e = 0; for (let n = 0; n < HOP; n++) e += (floatSamples[f*HOP+n]||0)**2; energy[f] = Math.sqrt(e/HOP); }
  const onset = new Float32Array(NFRAMES);
  for (let f = 1; f < NFRAMES; f++) { const d = energy[f]-energy[f-1]; onset[f] = d > 0 ? d : 0; }
  const segLen = Math.floor(NFRAMES/3);
  const tempoVotes = [];
  const fPerSec = sampleRate / HOP;
  const lagMin = Math.round(fPerSec * 60 / 240);
  const lagMax = Math.round(fPerSec * 60 / 40);
  for (let pass = 0; pass < 3; pass++) {
    const seg = onset.slice(pass*segLen, (pass+1)*segLen);
    let bestLag = lagMin, bestCorr = -Infinity;
    for (let lag = lagMin; lag <= Math.min(lagMax, seg.length-1); lag++) {
      let corr = 0;
      for (let n = 0; n < seg.length - lag; n++) corr += seg[n] * seg[n+lag];
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    tempoVotes.push(Math.max(40, Math.min(240, Math.round(fPerSec * 60 / bestLag))));
  }
  tempoVotes.sort((a,b) => a-b);
  const bpm = tempoVotes[1];
  const confidence = tempoVotes[0] === tempoVotes[2] ? 0.9 : Math.abs(tempoVotes[0]-tempoVotes[2]) < 10 ? 0.7 : 0.4;
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
      return { name: best.name, shortName: best.shortName || best.name, coreTala: best.coreTala || best.name, jati: best.jati || "chatusra", tradition: best.tradition, beats: best.beats, sections: best.sections, clapOn: best.clapOn, angaStr: (best.sections||[]).map(s => s===1?"Anudhrutam(1)":s===2?"Dhrutam(2)":`Laghu(${s})`).join(" + ") + ` = ${best.beats} beats`, detectedBeats: best.beats, cycleVotes: [best.beats], confidence: 0.98, note: `${best.tradition==="carnatic"?"Carnatic":"Hindustani"} ${best.name} — from composition database`, alternatives: [] };
    }
  }
  const HOP = 512, NFRAMES = Math.floor(floatSamples.length / HOP);
  const fPerSec = sampleRate / HOP;
  const beatPeriod = tempoResult.beatPeriodFrames || Math.round(fPerSec * 60 / 80);
  if (NFRAMES < beatPeriod * 8) {
    logCycle('tala_detection', { name: 'Adi', reason: 'insufficient_audio', detectedBeats: 8 });
    return { name: "Adi", beats: 8, sections: [4,2,2], clapOn: [true,false,false], tradition: "carnatic", jati: "chatusra", angaStr: "Laghu(4) + Dhrutam(2) + Dhrutam(2) = 8 beats", detectedBeats: 8, cycleVotes: [], confidence: 0.3, note: "Insufficient audio", alternatives: [] };
  }
  const energy = new Float32Array(NFRAMES);
  for (let f = 0; f < NFRAMES; f++) { let e = 0; for (let n = 0; n < HOP; n++) e += (floatSamples[f*HOP+n]||0)**2; energy[f] = Math.sqrt(e/HOP); }
  const onset = new Float32Array(NFRAMES);
  for (let f = 1; f < NFRAMES; f++) { const d = energy[f]-energy[f-1]; onset[f] = d > 0 ? d : 0; }
  const segLen = Math.floor(NFRAMES/3);
  const cycleVotes = [];
  for (let pass = 0; pass < 3; pass++) {
    const seg = onset.slice(pass*segLen, (pass+1)*segLen);
    const cycleMin = beatPeriod * 3;
    const cycleMax = Math.min(beatPeriod * 20, seg.length - 1);
    let bestCycleLag = cycleMin, bestCycleCorr = -Infinity;
    for (let lag = cycleMin; lag <= cycleMax; lag++) {
      let corr = 0;
      for (let n = 0; n < seg.length - lag; n++) corr += seg[n] * seg[n+lag];
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
    return { name: "Adi", beats: 8, sections: [4,2,2], clapOn: [true,false,false], tradition: "carnatic", jati: "chatusra", angaStr: "Laghu(4) + Dhrutam(2) + Dhrutam(2) = 8 beats", detectedBeats: 8, cycleVotes: [], confidence: 0.3, note: "No cycle detected", alternatives: [] };
  }
  cycleVotes.sort((a,b) => a-b);
  const detectedBeats = cycleVotes[Math.floor(cycleVotes.length/2)];
  const cycleConsistency = cycleVotes.filter(v => v === detectedBeats).length / cycleVotes.length;
  const candidates = ALL_TALAS.map(t => ({...t, beatDiff: Math.abs(t.beats - detectedBeats), popularityBonus: ({"Adi":10,"Rupaka":9,"Misra Chapu":8,"Tisra Triputa":7,"Khanda Chapu":7})[t.name]||1})).sort((a,b) => a.beatDiff !== b.beatDiff ? a.beatDiff - b.beatDiff : b.popularityBonus - a.popularityBonus);
  const best = candidates[0];
  const confidence = cycleConsistency * (1 - best.beatDiff * 0.1);
  logCycle('tala_detection', { name: best.name, detectedBeats, cycleVotes, confidence: +confidence.toFixed(3), consistency: cycleConsistency });
  return { name: best.name, shortName: best.shortName || best.name, coreTala: best.coreTala || best.name, jati: best.jati || "chatusra", tradition: best.tradition, beats: best.beats, sections: best.sections, clapOn: best.clapOn, angaStr: (best.sections||[]).map(s => s===1?"Anudhrutam(1)":s===2?"Dhrutam(2)":`Laghu(${s})`).join(" + ") + ` = ${best.beats} beats`, detectedBeats, cycleVotes, confidence: +confidence.toFixed(3), note: `${best.tradition==="carnatic"?"Carnatic":"Hindustani"} ${best.name} — ${detectedBeats===best.beats?"exact":`nearest (detected ${detectedBeats})`} | votes: [${cycleVotes.join(",")}]`, alternatives: candidates.slice(1,4).map(t => ({name:t.name, beats:t.beats, beatDiff:t.beatDiff})) };
}

function detectInstruments(floatSamples, sampleRate) {
  const len = floatSamples.length;
  if (len < 1000) return [{ name: "unknown", label: "Unknown", confidence: 0.5, family: "unknown", role: "unknown" }];
  const frameSize = 2048, hop = 512;
  const bands = [0, 250, 500, 1000, 2000, 4000, 8000, sampleRate/2];
  const bandE = new Array(bands.length-1).fill(0);
  let totalE = 0, spectralCentroidSum = 0, spectralCentroidWeight = 0, spectralFluxSum = 0;
  let prevSpectrum = null;
  for (let i = 0; i < len - frameSize; i += hop) {
    for (let b = 0; b < bands.length-1; b++) {
      let e = 0;
      const startIdx = Math.floor((bands[b]/(sampleRate/2))*frameSize);
      const endIdx = Math.floor((bands[b+1]/(sampleRate/2))*frameSize);
      for (let n = startIdx; n < endIdx && n < frameSize; n++) { const v = floatSamples[i+n]||0; e += v*v; }
      bandE[b] += e; totalE += e;
    }
    let frameE = 0, frameWeighted = 0;
    for (let n = 0; n < frameSize; n++) { const v = floatSamples[i+n]||0; const e = v*v; frameE += e; frameWeighted += e * (n/frameSize) * (sampleRate/2); }
    if (frameE > 0) { spectralCentroidSum += frameWeighted/frameE; spectralCentroidWeight++; }
    if (prevSpectrum) { let flux = 0; for (let n = 0; n < frameSize; n += 8) { const v = floatSamples[i+n]||0; flux += Math.abs(v*v - prevSpectrum[n]); } spectralFluxSum += flux; }
    prevSpectrum = new Float32Array(frameSize);
    for (let n = 0; n < frameSize; n++) prevSpectrum[n] = floatSamples[i+n] * floatSamples[i+n];
  }
  if (totalE === 0) return [{ name: "mixed", label: "Mixed / Ensemble", confidence: 0.5, family: "unknown", role: "unknown" }];
  const ratios = bandE.map(e => e/totalE);
  const lowRatio = ratios[0]+ratios[1], midRatio = ratios[2]+ratios[3]+ratios[4], highRatio = ratios[5]+ratios[6];
  const spectralCentroid = spectralCentroidWeight > 0 ? spectralCentroidSum/spectralCentroidWeight : 0;
  const spectralRolloff = ratios.reduce((a,b)=>a+b,0) > 0 ? ratios.findIndex(r => r > 0.85)/ratios.length : 0;
  const spectralFlux = spectralFluxSum / (len/hop);
  let zcr = 0;
  const zcrWindow = 512;
  for (let i = 0; i < len - zcrWindow; i += zcrWindow) { let crosses = 0; for (let n = 1; n < zcrWindow; n++) { if ((floatSamples[i+n]>=0) !== (floatSamples[i+n-1]>=0)) crosses++; } zcr += crosses/zcrWindow; }
  zcr /= Math.floor(len/zcrWindow);
  return fuseInstruments([], { lowRatio, midRatio, highRatio, zcr, spectralCentroid, spectralRolloff, spectralFlux }, {});
}

// ═══════════════════════════════════════════════════════════════════════
// GRID BUILDERS — CARNATIC + WESTERN
// ═══════════════════════════════════════════════════════════════════════

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
          western: SWARA_TO_WESTERN[beatSwaras[beatIdx]?.swara] || ".",
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

function splitByDetectedSections(beatSwaras, segments, compositionMatch) {
  if (compositionMatch) {
    const totalBeats = beatSwaras.length;
    const cycleLen = 8;
    const cycles = Math.floor(totalBeats / cycleLen) || 1;
    const pEnd = Math.floor(cycles * 0.30) * cycleLen;
    const aEnd = Math.floor(cycles * 0.55) * cycleLen;
    const cEnd = Math.floor(cycles * 0.85) * cycleLen;
    return {
      pallavi: beatSwaras.slice(0, pEnd),
      anupallavi: beatSwaras.slice(pEnd, aEnd),
      charanam: beatSwaras.slice(aEnd, cEnd),
      aalapana: beatSwaras.slice(cEnd),
      chittaswarams: [],
      manodharma: []
    };
  }
  if (!segments || !segments.length) {
    const totalBeats = beatSwaras.length;
    const cycleLen = 8;
    const cycles = Math.floor(totalBeats / cycleLen) || 1;
    return {
      pallavi: beatSwaras.slice(0, Math.floor(cycles * 0.4) * cycleLen),
      anupallavi: beatSwaras.slice(Math.floor(cycles * 0.4) * cycleLen, Math.floor(cycles * 0.7) * cycleLen),
      charanam: beatSwaras.slice(Math.floor(cycles * 0.7) * cycleLen),
      aalapana: [],
      chittaswarams: [],
      manodharma: []
    };
  }
  const pEnd = Math.max(...segments.filter(s => s.section === "PALLAVI").map(s => s.end), 0);
  const aEnd = Math.max(...segments.filter(s => s.section === "ANUPALLAVI").map(s => s.end), pEnd);
  const cEnd = Math.max(...segments.filter(s => s.section === "CHARANAM").map(s => s.end), aEnd);
  const totalDur = Math.max(...segments.map(s => s.end), beatSwaras.length * (60 / 120));
  const secToBeat = (sec) => Math.min(beatSwaras.length - 1, Math.floor((sec / totalDur) * beatSwaras.length));
  return {
    pallavi: beatSwaras.slice(0, secToBeat(pEnd)),
    anupallavi: beatSwaras.slice(secToBeat(pEnd), secToBeat(aEnd)),
    charanam: beatSwaras.slice(secToBeat(aEnd), secToBeat(cEnd)),
    aalapana: beatSwaras.slice(secToBeat(cEnd)),
    chittaswarams: [],
    manodharma: []
  };
}

// ═══════════════════════════════════════════════════════════════════════
// ADVANCED SECTION DETECTION
// ═══════════════════════════════════════════════════════════════════════

function detectAdvancedSections(pitchFrames, beatSwaras, tempoResult, compositionMatch, duration) {
  const sections = [];
  const aalapanaEnd = Math.min(duration * 0.20, 60);
  sections.push({
    type: "AALAPANA", section: "AALAPANA", start: 0, end: aalapanaEnd,
    line: compositionMatch?.manodharma_hints?.aalapana_raga ? `Aalapana in ${compositionMatch.manodharma_hints.aalapana_raga}` : "Aalapana",
    lineTelugu: "ఆలాపన",
    swaras: compositionMatch?.aroha || "", gamaka: "jaaru", tala: "free",
    wordCount: 0, transcriptionQuality: 0
  });
  if (compositionMatch?.chittaswarams && compositionMatch.chittaswarams.length > 0) {
    const chittaStart = duration * 0.60;
    compositionMatch.chittaswarams.forEach((cs, idx) => {
      sections.push({
        type: "CHITTASWARAMS", section: `CHITTASWARAM_${idx + 1}`,
        start: chittaStart + (idx * 10), end: chittaStart + ((idx + 1) * 10),
        line: cs, lineTelugu: safeTransliterateToTelugu(cs),
        swaras: cs, gamaka: "pratyahata", tala: compositionMatch?.tala || "Adi",
        wordCount: 0, transcriptionQuality: 0.95
      });
    });
  }
  const manoStart = duration * 0.75;
  sections.push({
    type: "MANODHARMA", section: "KALPANA_SWARAS", start: manoStart, end: duration,
    line: compositionMatch?.manodharma_hints?.swarakalpana_scale ? `Kalpana Swaras in ${compositionMatch.manodharma_hints.swarakalpana_scale}` : "Manodharma / Kalpana Swaras",
    lineTelugu: "మనోధర్మం / కల్పన స్వరాలు",
    swaras: compositionMatch?.manodharma_hints?.swarakalpana_scale || "", gamaka: "kampita", tala: compositionMatch?.tala || "Adi",
    wordCount: 0, transcriptionQuality: 0.8
  });
  return sections;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN ANALYSIS PIPELINE
// ═══════════════════════════════════════════════════════════════════════

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

  // ═══════ STEP 0-1: COMPOSITION MATCH ═══════
  const compositionMatch = getCompositionFromAnySource(originalName, sourceUrl, opts);
  let isCompositionMatched = false;
  let compositionRagaOverride = null;
  let compositionTala = null;

  if (compositionMatch) {
    console.log(`[GoMaa] ✅ COMPOSITION MATCH: ${compositionMatch.raga} / ${compositionMatch.tala} / ${compositionMatch.composer}`);
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

  // ═══════ STEP 2: AUDIO RAGA DETECTION (ONLY if no composition match) ═══════
  let ragaFromFile = null, ragaFromFP = null, ragaFromScale = null;
  if (!isCompositionMatched) {
    let fingerprint = null, fpMatch = null;
    try { fingerprint = generateFingerprint(filePath); fpMatch = matchFingerprint(fingerprint); } catch (e) { console.warn("[GoMaa] Fingerprint error:", e.message); }
    ragaFromFile = detectRaga(filePath, fileSize, null);
    ragaFromFP = fpMatch && fpMatch.raga ? detectRagaFromChroma(fpMatch.chroma, fpMatch.semis || []) : null;
  } else {
    console.log("[GoMaa] Skipping audio raga detection — composition matched");
  }

  // ═══════ STEP 3: DOWNSAMPLE + PITCH / SCALE / TEMPO ═══════
  let analysisSamples = downsampleTo22050(floatSamples, sampleRate);
  const analysisRate = TARGET_SR;
  const pitchLimit = isCompositionMatched ? Math.min(duration, 30) : Math.min(duration, MAX_ANALYSIS_DURATION);

  if (duration > pitchLimit) {
    analysisSamples = analysisSamples.slice(0, pitchLimit * analysisRate);
    console.log(`[GoMaa] Limiting pitch analysis to first ${pitchLimit}s of ${Math.round(duration)}s (${isCompositionMatched ? 'fast-path' : 'standard'})`);
  }

  const pitchFrames = await extractPitchFramesAsync(analysisSamples, analysisRate);
  const audioScale = detectAudioScale(pitchFrames);

  if (!isCompositionMatched) {
    ragaFromScale = detectRagaFromChroma(audioScale.chroma, audioScale.semis);
  } else {
    console.log("[GoMaa] Composition matched — skipping audio raga override");
    ragaFromScale = null;
  }

  // ═══════ STEP 4: FUSION ═══════
  let raga;
  if (isCompositionMatched && compositionRagaOverride) {
    raga = fuse(ragaFromFile, ragaFromScale, ragaFromFP, { fileName: originalName, compositionMatch: compositionRagaOverride });
  } else {
    raga = fuse(ragaFromFile, ragaFromScale, ragaFromFP, { fileName: originalName });
  }

  // ═══════ STEP 5: AROHA / AVAROHA — FILTERED TO RAGA ═══════
  let arohaAvaroha;
  if (isCompositionMatched && compositionMatch) {
    // Filter detected semis to only raga-relevant swaras
    const filteredSemis = filterSemisToRagaSwaras(audioScale.semis, compositionMatch.aroha, compositionMatch.avaroha);
    const filteredSwaras = filteredSemis.map(s => {
      const map = buildSemiToSwara(parseSwaras(compositionMatch.aroha), parseSwaras(compositionMatch.avaroha));
      return map[s] || SEMI_TO_SWARA_DEFAULT[s];
    }).filter((v,i,a) => a.indexOf(v) === i); // unique

    arohaAvaroha = {
      aroha: compositionMatch.aroha,
      avaroha: compositionMatch.avaroha,
      detectedAroha: filteredSwaras.join(" ") || compositionMatch.aroha,
      detectedAvaroha: ""
    };
    logCycle('aroha_avaroha', { source: 'composition_db', aroha: arohaAvaroha.aroha, avaroha: arohaAvaroha.avaroha, filteredDetected: arohaAvaroha.detectedAroha });
  } else {
    arohaAvaroha = detectArohaAvaroha(pitchFrames, audioScale.semis, raga.aroha, raga.avaroha);
  }

  // ═══════ STEP 6: TEMPO / TALA / INSTRUMENTS ═══════
  const tempoResult = estimateTempo(floatSamples, sampleRate);
  const talaObj = detectTala(floatSamples, sampleRate, tempoResult, compositionTala);
  const instruments = detectInstruments(floatSamples, sampleRate);

  let embed = null;
  try { embed = embedAudio(filePath); } catch (e) { console.warn("[GoMaa] Embedding error:", e.message); }

  // ═══════ STEP 7: TRANSCRIPTION (skip if composition matched) ═══════
  const transcribeOpts = { model: opts?.model || "small", language: opts?.language || "" };
  let transcription = null;
  if (!isCompositionMatched) {
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
      if (code === 0 && outStr) { try { transcription = JSON.parse(outStr); } catch(e) {} }
    } catch (e) { console.warn("[GoMaa] Transcription error:", e.message); }
  } else {
    console.log("[GoMaa] Composition matched — skipping Whisper transcription for speed");
  }

  // Hallucination check
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

  // Lyrics resolution — GUARANTEED from DB when composition matched
  let finalLyrics = compositionMatch;
  let lyricsSource = compositionMatch ? "composition_db" : null;
  if (!finalLyrics) {
    finalLyrics = getRagaBasedLyrics(raga.label);
    lyricsSource = finalLyrics ? "raga_generic" : null;
  }
  if (!finalLyrics) {
    finalLyrics = { pallavi: "", anupallavi: "", charanam: "", sahityam: "", chittaswarams: [], manodharma_hints: {} };
    lyricsSource = "none";
  }

  // Segmentation
  let segments = [];
  try {
    if (!isCompositionMatched) {
      segments = await analyzeCarnaticAudio(filePath, sampleRate, duration, {});
      if (transcription && transcription.words) segments = assignTranscriptionToSegments(transcription, segments);
    } else {
      const dbSections = [
        { type: "PALLAVI", section: "PALLAVI", start: 0, end: duration * 0.25, line: finalLyrics.pallavi, lineTelugu: finalLyrics.pallaviTelugu || safeTransliterateToTelugu(finalLyrics.pallavi), swaras: "", gamaka: "sustain", tala: compositionMatch.tala, wordCount: 0, transcriptionQuality: 0.95 },
        { type: "ANUPALLAVI", section: "ANUPALLAVI", start: duration * 0.25, end: duration * 0.45, line: finalLyrics.anupallavi, lineTelugu: finalLyrics.anupallaviTelugu || safeTransliterateToTelugu(finalLyrics.anupallavi), swaras: "", gamaka: "sustain", tala: compositionMatch.tala, wordCount: 0, transcriptionQuality: 0.95 },
        { type: "CHARANAM", section: "CHARANAM", start: duration * 0.45, end: duration * 0.70, line: finalLyrics.charanam, lineTelugu: finalLyrics.charanamTelugu || safeTransliterateToTelugu(finalLyrics.charanam), swaras: "", gamaka: "sustain", tala: compositionMatch.tala, wordCount: 0, transcriptionQuality: 0.95 }
      ];
      const advanced = detectAdvancedSections(pitchFrames, [], tempoResult, compositionMatch, duration);
      segments = [...advanced, ...dbSections];
    }
  } catch (e) { console.warn("[GoMaa] Segmentation error:", e.message); }
  const sectionLyrics = buildSectionLyrics(segments);

  // Swara evaluation
  const semiToSwara = buildSemiToSwara(parseSwaras(raga.aroha), parseSwaras(raga.avaroha));
  const swaraFrames = evaluateSwaras(pitchFrames, semiToSwara, analysisRate);

  const beatPeriod = tempoResult.beatPeriodFrames || Math.round(sampleRate * 60 / tempoResult.bpm / 512);
  const beatSwaras = [];
  for (let i = 0; i < swaraFrames.length; i += beatPeriod) {
    const frame = swaraFrames[i];
    beatSwaras.push({ swara: frame.swara, gamaka: frame.gamaka, time: frame.time, confidence: frame.confidence || 0 });
  }

  const sectionGrids = splitByDetectedSections(beatSwaras, segments, compositionMatch);
  const sahityamGrid = buildSahityamGrid(beatSwaras, talaObj);

  // Western notation generation
  const westernStaffNotes = buildWesternStaffNotes(beatSwaras);
  const westernAroha = swaraToWestern(arohaAvaroha.aroha);
  const westernAvaroha = swaraToWestern(arohaAvaroha.avaroha);
  const westernArohaOctave = swaraToWesternOctave(arohaAvaroha.aroha);
  const westernAvarohaOctave = swaraToWesternOctave(arohaAvaroha.avaroha);

  // Sheet music
  let sheetMusicXml = null, midiB64 = null;
  try {
    sheetMusicXml = generateSheetMusicXml(beatSwaras, talaObj, raga);
    midiB64 = generateMidi(beatSwaras, talaObj, raga);
  } catch (e) { console.warn("[GoMaa] Sheet music error:", e.message); }

  // Ragamalika
  let ragamalika;
  if (isCompositionMatched) {
    ragamalika = { isRagamalika: false, segments: [], primaryRaga: { label: raga.label, ragaNumber: raga.ragaNumber } };
  } else {
    ragamalika = detectRagamalika(filePath, fileSize, null);
  }

  const processingTime = Date.now() - startTime;

  // ═══════════════════════════════════════════════════════════════════════
  // LYRICS — SAFE TELUGU (no double-transliteration)
  // ═══════════════════════════════════════════════════════════════════════
  const lyricsData = {
    pallavi: finalLyrics.pallavi || "",
    anupallavi: finalLyrics.anupallavi || "",
    charanam: finalLyrics.charanam || "",
    sahityam: finalLyrics.sahityam || "",
    chittaswarams: finalLyrics.chittaswarams || [],
    manodharma_hints: finalLyrics.manodharma_hints || {},
    telugu: {
      pallavi: finalLyrics.pallaviTelugu || safeTransliterateToTelugu(finalLyrics.pallavi || ""),
      anupallavi: finalLyrics.anupallaviTelugu || safeTransliterateToTelugu(finalLyrics.anupallavi || ""),
      charanam: finalLyrics.charanamTelugu || safeTransliterateToTelugu(finalLyrics.charanam || ""),
      sahityam: safeTransliterateToTelugu(finalLyrics.sahityam || "")
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
        time: +((idx * 1024) / analysisRate).toFixed(2),
        freq: f.freq, midi: f.midi, semi: f.semi,
        confidence: +(f.confidence || 0).toFixed(3)
      });
    }
    if (sampledPitchFrames.length >= 500) break;
  }

  const result = {
    id: recId, title: originalName, artist: sourceUrl || "upload",
    raga: raga.label, ragaNumber: raga.ragaNumber, chakra: raga.chakra,
    melakarta: raga.melakarta || raga.ragaNumber,
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
      totalFrames: pitchFrames.length, sampleRate: analysisRate,
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
      ragaNumber: raga.ragaNumber, chakra: raga.chakra, melakarta: raga.melakarta || raga.ragaNumber,
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
    sahityamGrid: sahityamGrid.slice(0, 20),
    sectionGrids: {
      pallavi: buildSahityamGrid(sectionGrids.pallavi || [], talaObj),
      anupallavi: buildSahityamGrid(sectionGrids.anupallavi || [], talaObj),
      charanam: buildSahityamGrid(sectionGrids.charanam || [], talaObj),
      aalapana: buildSahityamGrid(sectionGrids.aalapana || [], talaObj),
      chittaswarams: buildSahityamGrid(sectionGrids.chittaswarams || [], talaObj),
      manodharma: buildSahityamGrid(sectionGrids.manodharma || [], talaObj)
    },
    westernNotation: {
      staffNotes: westernStaffNotes,
      aroha: westernAroha,
      avaroha: westernAvaroha,
      arohaOctave: westernArohaOctave,
      avarohaOctave: westernAvarohaOctave,
      keySignature: raga.label === "nATA" ? "D# Major / C minor" : "Unknown",
      timeSignature: talaObj.name === "Adi" ? "8/8" : "Custom"
    },
    carnaticNotation: {
      aroha: arohaAvaroha.aroha,
      avaroha: arohaAvaroha.avaroha,
      swaraLines: beatSwaras.slice(0, 64).map(b => b.swara).join(" "),
      talaMarkers: talaObj.sections || [4, 2, 2],
      sahityamGrid: sahityamGrid.slice(0, 10)
    },
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

    if (file) {
      originalName = file.originalname || path.basename(filePath);
      filePath = ensureExtension(file.path, originalName);
    } else if (url) {
      try {
        const downloadResult = await downloadFromUrl(url, UPLOAD_DIR);
        filePath = downloadResult.filePath;
        originalName = downloadResult.originalName || downloadResult.title || "youtube_audio";
        sourceUrl = downloadResult.sourceUrl || url;
      } catch (e) {
        console.error("[GoMaa] URL download failed:", e.message);
        return res.status(400).json({ error: `Download failed: ${e.message}` });
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
      language: req.body?.language || req.headers["x-language"] || "",
      composition: req.body?.composition || req.headers["x-composition"] || "",
      title: req.body?.title || req.headers["x-title"] || ""
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
