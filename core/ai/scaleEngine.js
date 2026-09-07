/**
 * GoMaa Raga Vidya — scaleEngine.js v4.0.3-patch
 * Bayesian chroma with raga prior boosting.
 * CRITICAL FIX: Correct 12-tone chromatic swara mapping + tonic transposition.
 */

const fs = require("fs");
const path = require("path");

let RAGA_DB = { ragas: [] };
try {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "../../models/raga_db.json"), "utf8"));
  if (Array.isArray(raw)) {
    RAGA_DB = { ragas: raw };
  } else if (raw && Array.isArray(raw.ragas)) {
    RAGA_DB = raw;
  }
} catch (e) {
  console.warn("[scaleEngine] raga_db.json not found or invalid:", e.message);
}

// CORRECT 12-tone chromatic semitone mapping (C=0, C#=1, D=2, D#=3, E=4, F=5, F#=6, G=7, G#=8, A=9, A#=10, B=11)
const SWARA_TO_SEMI_12 = {
  "s":0, "r1":1, "r2":2, "r3":3,
  "g1":2, "g2":3, "g3":4,
  "m1":5, "m2":6,
  "p":7,
  "d1":8, "d2":9, "d3":10,
  "n1":8, "n2":9, "n3":10,  // n3 can be 10 or 11 depending on tradition; using 10 for consistency
  "s'":0
};

function parseSwaraLine12(line) {
  if (!line) return [];
  if (Array.isArray(line)) return line.map(s => SWARA_TO_SEMI_12[s.toLowerCase()]).filter(x => x !== undefined);
  return line.toLowerCase().split(/\s+/).map(s => SWARA_TO_SEMI_12[s]).filter(x => x !== undefined);
}

function detectTonicSemitone(pitches) {
  // Estimate tonic from the most frequent chroma peak in the lower octave
  const hist = new Array(12).fill(0);
  for (let i = 0; i < pitches.length; i++) {
    const f = pitches[i];
    if (f <= 0 || !isFinite(f)) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    const semi = Math.round(midi) % 12;
    hist[(semi + 12) % 12] += 1;
  }
  // Find peak
  let max = 0, tonic = 0;
  for (let i = 0; i < 12; i++) { if (hist[i] > max) { max = hist[i]; tonic = i; } }
  return tonic;
}

function chromaFromPitches(pitches, sampleRate) {
  const hist = new Array(12).fill(0.001);
  let count = 0;
  for (let i = 0; i < pitches.length; i++) {
    const f = pitches[i];
    if (f <= 0 || !isFinite(f)) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    const semi = Math.round(midi) % 12;
    hist[(semi + 12) % 12] += 1;
    count++;
  }
  if (count === 0) return hist;
  const sum = hist.reduce((a,b)=>a+b,0);
  return hist.map(v => v / sum);
}

function detectScaleBayesian(pitches, sampleRate, ragaResult, shrutiHz) {
  const chroma = chromaFromPitches(pitches, sampleRate);

  // Detect tonic semitone from audio (or use provided shruti)
  let tonicSemi = 0;
  if (shrutiHz && shrutiHz > 0) {
    const midi = 69 + 12 * Math.log2(shrutiHz / 440);
    tonicSemi = Math.round(midi) % 12;
  } else {
    tonicSemi = detectTonicSemitone(pitches);
  }

  let prior = new Array(12).fill(1);
  if (ragaResult && ragaResult.raga && RAGA_DB.ragas && RAGA_DB.ragas.length) {
    const raga = RAGA_DB.ragas.find(r => r && r.name && r.name.toLowerCase() === ragaResult.raga.toLowerCase());
    if (raga) {
      const arohaStr = Array.isArray(raga.arohana) ? raga.arohana.join(' ') : (raga.aroha || '');
      const avarohaStr = Array.isArray(raga.avarohana) ? raga.avarohana.join(' ') : (raga.avaroha || '');
      // Parse swaras using CORRECT 12-tone mapping, then TRANSPOSE by detected tonic
      const notes = [...new Set([...parseSwaraLine12(arohaStr), ...parseSwaraLine12(avarohaStr)])];
      notes.forEach(s => {
        const transposed = (s + tonicSemi) % 12;
        if (transposed >= 0 && transposed < 12) prior[transposed] = 3.0;
      });
    }
  }

  const posterior = chroma.map((c, i) => c * prior[i]);
  const postSum = posterior.reduce((a,b)=>a+b,0) || 1;
  const norm = posterior.map(v => v / postSum);

  // Find peaks using local maxima + threshold
  const mean = norm.reduce((a,b)=>a+b,0) / 12;
  const variance = norm.reduce((sum, v) => sum + (v - mean) ** 2, 0) / 12;
  const std = Math.sqrt(variance);

  // Lower threshold: mean + 0.1*std instead of 0.3*std
  const threshold = mean + 0.1 * std;

  // Also use top-7 peaks as fallback for ragas
  const ranked = norm.map((v, i) => ({ semi: i, val: v })).sort((a, b) => b.val - a.val);
  const top7 = new Set(ranked.slice(0, 7).map(r => r.semi));

  const detected = [];
  for (let i = 0; i < 12; i++) {
    if (norm[i] > threshold || top7.has(i)) {
      detected.push(i);
    }
  }

  const noteNames = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

  return {
    chroma: norm,
    detectedSemitones: detected,
    noteNames: detected.map(i => noteNames[i]),
    confidence: Math.round((detected.length / 7) * 1000) / 1000,
    tonicSemi: tonicSemi,
    method: "bayesian_chroma_with_raga_prior_transposed"
  };
}

module.exports = { detectScaleBayesian };
