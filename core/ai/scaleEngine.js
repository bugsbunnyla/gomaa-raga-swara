/**
 * GoMaa Raga Vidya — scaleEngine.js v4.0.2-patch
 * Bayesian chroma with raga prior boosting.
 * Fix: Defensive DB access.
 */

const fs = require("fs");
const path = require("path");

let RAGA_DB = { ragas: [] };
try {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "../../models/raga_db.json"), "utf8"));
  if (raw && Array.isArray(raw.ragas)) RAGA_DB = raw;
} catch { }

const SWARA_TO_SEMI = {
  "s":0,"r1":1,"r2":2,"r3":3,"g1":1,"g2":2,"g3":3,
  "m1":4,"m2":5,"p":6,"d1":7,"d2":8,"d3":9,"n1":7,"n2":8,"n3":9,"s'":0
};

function parseSwaraLine(line) {
  if (!line) return [];
  return line.toLowerCase().split(/\s+/).map(s => SWARA_TO_SEMI[s]).filter(x => x !== undefined);
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

function detectScaleBayesian(pitches, sampleRate, compositionMatch) {
  const chroma = chromaFromPitches(pitches, sampleRate);

  let prior = new Array(12).fill(1);
  if (compositionMatch && RAGA_DB.ragas && RAGA_DB.ragas.length) {
    const raga = RAGA_DB.ragas.find(r => r && r.name && r.name.toLowerCase() === compositionMatch.raga.toLowerCase());
    if (raga) {
      const notes = [...new Set([...parseSwaraLine(raga.aroha), ...parseSwaraLine(raga.avaroha)])];
      notes.forEach(s => { if (s >= 0 && s < 12) prior[s] = 3.0; });
    }
  }

  const posterior = chroma.map((c, i) => c * prior[i]);
  const postSum = posterior.reduce((a,b)=>a+b,0) || 1;
  const norm = posterior.map(v => v / postSum);

  const mean = norm.reduce((a,b)=>a+b,0) / 12;
  const variance = norm.reduce((sum, v) => sum + (v - mean) ** 2, 0) / 12;
  const std = Math.sqrt(variance);
  const threshold = mean + 0.3 * std;
  const detected = norm.map((v, i) => v > threshold ? i : -1).filter(x => x >= 0);

  const noteNames = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

  return {
    chroma: norm,
    detectedSemitones: detected,
    noteNames: detected.map(i => noteNames[i]),
    confidence: Math.round((detected.length / 7) * 1000) / 1000,
    method: "bayesian_chroma_with_raga_prior"
  };
}

module.exports = { detectScaleBayesian };
