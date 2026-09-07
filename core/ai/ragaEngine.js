/**
 * GoMaa Raga Vidya — ragaEngine.js v4.0.2-patch
 * Multi-modal raga detection with unoverrideable composition match.
 * Fix: Defensive against raga_db.json missing or malformed.
 * Fix: Handle recognize.js calling convention (samples, sampleRate, opts).
 * Fix: Handle raga_db.json with array arohana/avarohana and melakarta field.
 */

const fs = require("fs");
const path = require("path");

let RAGA_DB = { ragas: [] };
try {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "../../models/raga_db.json"), "utf8"));
  const ragas = Array.isArray(raw) ? raw : (raw?.ragas || []);
  // Normalize: ensure aroha/avaroha are strings, melakartaNum exists
  RAGA_DB = { ragas: ragas.map(r => {
    if (!r) return r;
    // Handle array arohana -> string aroha
    if (Array.isArray(r.arohana) && !r.aroha) {
      r.aroha = r.arohana.join(' ');
    }
    if (Array.isArray(r.avarohana) && !r.avaroha) {
      r.avaroha = r.avarohana.join(' ');
    }
    // Handle melakarta -> melakartaNum
    if (r.melakarta !== undefined && r.melakartaNum === undefined) {
      r.melakartaNum = r.melakarta;
    }
    return r;
  }).filter(Boolean) };
} catch (e) {
  console.warn("[ragaEngine] raga_db.json not found or invalid — raga detection limited:", e.message);
}

const MELO_MATRIX = [
  [1,1,1,1,1,1,1],[1,1,1,1,1,1,2],[1,1,1,1,1,2,2],[1,1,1,1,1,2,3],
  [1,1,1,1,2,2,2],[1,1,1,1,2,2,3],[1,1,1,1,2,3,3],[1,1,1,2,2,2,2],
  [1,1,1,2,2,2,3],[1,1,1,2,2,3,3],[1,1,1,2,3,3,3],[1,1,2,2,2,2,2],
  [1,1,2,2,2,2,3],[1,1,2,2,2,3,3],[1,1,2,2,3,3,3],[1,1,2,3,3,3,3],
  [1,2,2,2,2,2,2],[1,2,2,2,2,2,3],[1,2,2,2,2,3,3],[1,2,2,2,3,3,3],
  [1,2,2,3,3,3,3],[1,2,3,3,3,3,3],[2,2,2,2,2,2,2],[2,2,2,2,2,2,3],
  [2,2,2,2,2,3,3],[2,2,2,2,3,3,3],[2,2,2,3,3,3,3],[2,2,3,3,3,3,3],
  [2,3,3,3,3,3,3],[3,3,3,3,3,3,3],[3,3,3,3,3,3,4],[3,3,3,3,3,4,4],
  [3,3,3,3,4,4,4],[3,3,3,4,4,4,4],[3,3,4,4,4,4,4],[3,4,4,4,4,4,4]
];

function parseSwaraLine(line) {
  if (!line) return [];
  const map = {
    "s":0,"r1":1,"r2":2,"r3":3,"g1":1,"g2":2,"g3":3,
    "m1":4,"m2":5,"p":6,"d1":7,"d2":8,"d3":9,"n1":7,"n2":8,"n3":9,"s'":10
  };
  return line.toLowerCase().split(/\s+/).map(s => map[s] ?? null).filter(x => x !== null);
}

function chromaFromPitches(pitches, sampleRate) {
  const hist = new Array(12).fill(0);
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
  return hist.map(v => v / count);
}

function intervalDTWProfile(pitches) {
  const intervals = [];
  for (let i = 1; i < pitches.length; i++) {
    if (pitches[i] > 0 && pitches[i-1] > 0) {
      const c1 = 69 + 12 * Math.log2(pitches[i-1] / 440);
      const c2 = 69 + 12 * Math.log2(pitches[i] / 440);
      intervals.push(Math.round(c2 - c1));
    }
  }
  const hist = new Array(25).fill(0);
  intervals.forEach(v => { const idx = v + 12; if (idx >= 0 && idx < 25) hist[idx]++; });
  const sum = hist.reduce((a,b)=>a+b,0) || 1;
  return hist.map(v => v / sum);
}

function coverageScore(ar, av, chroma) {
  const aro = parseSwaraLine(ar);
  const ava = parseSwaraLine(av);
  const uniq = [...new Set([...aro, ...ava])];
  let covered = 0;
  for (const s of uniq) {
    const semi = s === 10 ? 0 : s;
    if (chroma[semi] > 0.02) covered++;
  }
  return uniq.length ? covered / uniq.length : 0;
}

function dtwDistance(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({length: n+1}, () => new Array(m+1).fill(Infinity));
  dp[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = Math.abs(a[i-1] - b[j-1]);
      dp[i][j] = cost + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[n][m] / Math.max(n, m);
}

// ── Simple pitch extraction from raw PCM samples (YIN-like) ────────────
// Used when recognize.js calls us with (audioBuffer, sampleRate, opts)
function extractPitchesFromSamples(samples, sr) {
  const FRAME = 2048;
  const HOP = 512;
  const frames = Math.floor((samples.length - FRAME) / HOP);
  const pitches = [];
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    const frame = samples.slice(off, off + FRAME);
    // Simple energy gate
    let energy = 0;
    for (let i = 0; i < FRAME; i++) energy += frame[i] * frame[i];
    energy = Math.sqrt(energy / FRAME);
    if (energy < 0.006) { pitches.push(0); continue; }

    // Autocorrelation for fundamental
    const N = frame.length;
    const half = Math.floor(N / 2);
    let bestLag = 0, bestCorr = -1;
    for (let tau = 40; tau < half; tau++) { // 40 ≈ 22050/550Hz max
      let c = 0;
      for (let i = 0; i < half; i++) c += frame[i] * frame[i + tau];
      if (c > bestCorr) { bestCorr = c; bestLag = tau; }
    }
    const freq = bestLag > 0 ? sr / bestLag : 0;
    if (freq > 140 && freq < 900) pitches.push(freq);
    else pitches.push(0);
  }
  return pitches;
}

function detectRagaEnhanced(pitchesOrSamples, sampleRateOrScaleResult, optsOrTalaResult, compositionMatch, duration) {
  // v4.0.2: If composition match exists, return immediately.
  if (compositionMatch) {
    return {
      raga: compositionMatch.raga,
      parentRaga: compositionMatch.parent || compositionMatch.raga,
      parent: compositionMatch.parent || compositionMatch.raga,
      aroha: compositionMatch.aroha || "",
      avaroha: compositionMatch.avaroha || "",
      confidence: 0.99,
      method: "composition_hint",
      ragaNumber: compositionMatch.melakartaNum || null,
      melakartaNum: compositionMatch.melakartaNum || null,
      janya: compositionMatch.janya || false,
      timeOfDay: compositionMatch.timeOfDay || "",
      mood: compositionMatch.mood || ""
    };
  }

  // Detect calling convention from recognize.js: (audioBuffer, sampleRate, { composition: null })
  let pitches, scaleResult, talaResult;
  if (pitchesOrSamples instanceof Float32Array && typeof sampleRateOrScaleResult === 'number') {
    // Called with raw PCM samples — extract pitches
    pitches = extractPitchesFromSamples(pitchesOrSamples, sampleRateOrScaleResult);
    scaleResult = null;
    talaResult = optsOrTalaResult || {};
    compositionMatch = null;
  } else {
    // Standard calling convention
    pitches = pitchesOrSamples;
    scaleResult = sampleRateOrScaleResult;
    talaResult = optsOrTalaResult;
  }

  const chroma = scaleResult?.chroma || chromaFromPitches(pitches, 44100);
  const intervalProf = intervalDTWProfile(pitches);
  const candidates = RAGA_DB.ragas || [];

  if (!candidates.length) {
    return { raga: "Unknown", parent: "Unknown", parentRaga: "Unknown", aroha: "", avaroha: "", confidence: 0, method: "no_raga_db", ragaNumber: 0, melakartaNum: null, janya: false };
  }

  let best = null;
  let bestScore = -Infinity;

  for (const raga of candidates) {
    if (!raga || !raga.aroha) continue;
    const aro = parseSwaraLine(raga.aroha);
    const ava = parseSwaraLine(raga.avaroha);
    const ragaChroma = new Array(12).fill(0);
    [...new Set([...aro, ...ava])].forEach(s => {
      const semi = s === 10 ? 0 : s;
      if (semi >= 0 && semi < 12) ragaChroma[semi] = 1;
    });
    const chromaDot = chroma.reduce((sum, v, i) => sum + v * ragaChroma[i], 0);
    const chromaScore = Math.min(chromaDot * 2.5, 1.0);

    const ragaIntervals = [];
    for (let i = 1; i < aro.length; i++) ragaIntervals.push(aro[i] - aro[i-1]);
    const intScore = ragaIntervals.length
      ? Math.max(0, 1 - dtwDistance(ragaIntervals, intervalProf.slice(10, 16)) / 5)
      : 0.5;

    const cov = coverageScore(raga.aroha, raga.avaroha, chroma);
    const covScore = Math.min(cov * 1.2, 1.0);

    const score = chromaScore * 0.45 + intScore * 0.35 + covScore * 0.20;

    if (score > bestScore) {
      bestScore = score;
      best = raga;
    }
  }

  if (!best) {
    return { raga: "Unknown", parent: "Unknown", parentRaga: "Unknown", aroha: "", avaroha: "", confidence: 0, method: "none", ragaNumber: 0, melakartaNum: null, janya: false };
  }

  // Janya detection
  let janya = false;
  let parent = best.name;
  if (best.melakartaNum) {
    const melo = MELO_MATRIX[best.melakartaNum - 1];
    const aro = parseSwaraLine(best.aroha);
    const expected = [0, melo[0], melo[1], melo[2], 6, melo[3], melo[4], melo[5], melo[6], 10];
    const isFull = aro.length >= 7 && expected.every((v, i) => aro[i] === v || aro[i] === v + 1);
    if (!isFull) {
      janya = true;
      for (const r of candidates) {
        if (r && r.melakartaNum === best.melakartaNum) {
          const parAro = parseSwaraLine(r.aroha);
          if (parAro.length >= 7) { parent = r.name; break; }
        }
      }
    }
  }

  return {
    raga: best.name,
    parent,
    parentRaga: parent,
    aroha: best.aroha,
    avaroha: best.avaroha,
    confidence: Math.round(bestScore * 1000) / 1000,
    method: "multi_modal_chroma_interval_coverage",
    ragaNumber: best.melakartaNum || null,
    melakartaNum: best.melakartaNum || null,
    janya,
    timeOfDay: best.timeOfDay || "",
    mood: best.mood || ""
  };
}

module.exports = { detectRagaEnhanced };