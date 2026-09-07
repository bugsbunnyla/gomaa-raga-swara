/**
 * GoMaa Raga Vidya — ragaEngine.js v4.0.3-patch
 * Multi-modal raga detection with unoverrideable composition match.
 * CRITICAL FIX: Janya preference when detected note count is low (audava/shadava).
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
  // Normalize: ensure aroha/avaroha are strings, melakartaNum exists
  RAGA_DB.ragas = RAGA_DB.ragas.map(r => {
    if (!r) return r;
    if (Array.isArray(r.arohana) && !r.aroha) r.aroha = r.arohana.join(' ');
    if (Array.isArray(r.avarohana) && !r.avaroha) r.avaroha = r.avarohana.join(' ');
    if (r.melakarta !== undefined && r.melakartaNum === undefined) r.melakartaNum = r.melakarta;
    return r;
  }).filter(Boolean);
} catch (e) {
  console.warn("[ragaEngine] raga_db.json not found or invalid:", e.message);
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

function countDetectedPeaks(chroma) {
  const mean = chroma.reduce((a,b)=>a+b,0) / 12;
  const variance = chroma.reduce((sum, v) => sum + (v - mean) ** 2, 0) / 12;
  const std = Math.sqrt(variance);
  const threshold = mean + 0.15 * std;
  return chroma.filter(v => v > threshold).length;
}

function detectRagaEnhanced(pitchesOrSamples, sampleRateOrScaleResult, optsOrTalaResult, compositionMatch, duration) {
  // v4.0.3: If composition match exists, return immediately.
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

  // Detect calling convention: (pitchesArray, sampleRate, opts)
  let pitches, scaleResult, talaResult;
  if (Array.isArray(pitchesOrSamples) || pitchesOrSamples instanceof Float32Array) {
    pitches = Array.from(pitchesOrSamples).filter(p => p > 0);
    scaleResult = null;
    talaResult = optsOrTalaResult || {};
  } else if (pitchesOrSamples instanceof Float32Array && typeof sampleRateOrScaleResult === 'number') {
    pitches = extractPitchesFromSamples(pitchesOrSamples, sampleRateOrScaleResult);
    scaleResult = null;
    talaResult = optsOrTalaResult || {};
  } else {
    pitches = pitchesOrSamples;
    scaleResult = sampleRateOrScaleResult;
    talaResult = optsOrTalaResult;
  }

  if (!pitches || pitches.length < 10) {
    return { raga: "Unknown", parent: "Unknown", parentRaga: "Unknown", aroha: "", avaroha: "", confidence: 0, method: "no_pitches", ragaNumber: 0, melakartaNum: null, janya: false };
  }

  const chroma = scaleResult?.chroma || chromaFromPitches(pitches, 44100);
  const intervalProf = intervalDTWProfile(pitches);
  const candidates = RAGA_DB.ragas || [];
  const detectedPeaks = countDetectedPeaks(chroma);

  if (!candidates.length) {
    return { raga: "Unknown", parent: "Unknown", parentRaga: "Unknown", aroha: "", avaroha: "", confidence: 0, method: "no_raga_db", ragaNumber: 0, melakartaNum: null, janya: false };
  }

  let best = null;
  let bestScore = -Infinity;
  let scores = [];

  for (const raga of candidates) {
    if (!raga || !raga.aroha) continue;
    const aro = parseSwaraLine(raga.aroha);
    const ava = parseSwaraLine(raga.avaroha);
    if (!aro.length) continue;

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

    // Janya bonus: if raga has fewer notes and detected peaks match, boost
    const ragaNoteCount = [...new Set([...aro, ...ava])].length;
    const janyaBonus = (ragaNoteCount < 7 && Math.abs(detectedPeaks - ragaNoteCount) <= 1) ? 0.25 : 0;
    // Melakarta penalty: if detected peaks are much fewer than 7, penalize full melakarta
    const melakartaPenalty = (ragaNoteCount >= 7 && detectedPeaks < 6) ? -0.3 : 0;

    const score = chromaScore * 0.40 + intScore * 0.30 + covScore * 0.20 + janyaBonus + melakartaPenalty;

    scores.push({ raga, score, chromaScore, intScore, covScore, janyaBonus, melakartaPenalty, aro, ava, ragaNoteCount });

    if (score > bestScore) {
      bestScore = score;
      best = raga;
    }
  }

  if (!best) {
    return { raga: "Unknown", parent: "Unknown", parentRaga: "Unknown", aroha: "", avaroha: "", confidence: 0, method: "none", ragaNumber: 0, melakartaNum: null, janya: false };
  }

  // ── POST-PROCESSING: Janya preference ──
  // If best is a melakarta (7+ notes) but a janya of same parent has close score
  // AND detected peaks match janya better, prefer the janya.
  const bestEntry = scores.find(s => s.raga === best);
  if (bestEntry && bestEntry.ragaNoteCount >= 7 && best.melakartaNum) {
    const janyaCandidates = scores.filter(s => 
      s.raga.parent && s.raga.parent.toLowerCase() === best.name.toLowerCase() &&
      s.ragaNoteCount < 7 &&
      s.score >= bestScore - 0.15 &&
      Math.abs(detectedPeaks - s.ragaNoteCount) <= 1
    );
    if (janyaCandidates.length > 0) {
      // Pick the janya with highest score
      janyaCandidates.sort((a, b) => b.score - a.score);
      best = janyaCandidates[0].raga;
      bestScore = janyaCandidates[0].score;
      console.log(`[ragaEngine] Janya preference: ${best.name} over parent ${bestEntry.raga.name} (detected ${detectedPeaks} peaks vs janya ${janyaCandidates[0].ragaNoteCount} notes)`);
    }
  }

  // Janya detection
  let janya = false;
  let parent = best.name;
  const bestAro = parseSwaraLine(best.aroha);
  const bestAva = parseSwaraLine(best.avaroha);
  const bestNotes = [...new Set([...bestAro, ...bestAva])];

  if (best.melakartaNum && best.melakartaNum >= 1 && best.melakartaNum <= 72) {
    const melo = MELO_MATRIX[best.melakartaNum - 1];
    const expectedNotes = [0, melo[0], melo[1], melo[2], 6, melo[3], melo[4], melo[5], melo[6], 10];
    const expectedSet = new Set(expectedNotes);
    const detectedSet = new Set(bestNotes);
    const missing = [...expectedSet].filter(n => !detectedSet.has(n));
    const extra = [...detectedSet].filter(n => !expectedSet.has(n));
    if (missing.length > 0 || extra.length > 0) {
      janya = true;
      for (const r of candidates) {
        if (r && r.melakartaNum === best.melakartaNum && !r.parent && r.name !== best.name) {
          const parAro = parseSwaraLine(r.aroha);
          const parNotes = [...new Set([...parAro, ...parseSwaraLine(r.avaroha)])];
          if (parNotes.length >= 7) { parent = r.name; break; }
        }
      }
      if (parent === best.name) {
        const melakarta = candidates.find(r => r.melakartaNum === best.melakartaNum && !r.parent);
        if (melakarta) parent = melakarta.name;
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

// Legacy helper — kept for backward compatibility
function extractPitchesFromSamples(samples, sr) {
  const FRAME = 2048;
  const HOP = 512;
  const frames = Math.floor((samples.length - FRAME) / HOP);
  const pitches = [];
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    const frame = samples.slice(off, off + FRAME);
    let energy = 0;
    for (let i = 0; i < FRAME; i++) energy += frame[i] * frame[i];
    energy = Math.sqrt(energy / FRAME);
    if (energy < 0.006) { pitches.push(0); continue; }
    const N = frame.length;
    const half = Math.floor(N / 2);
    let bestLag = 0, bestCorr = -1;
    for (let tau = 40; tau < half; tau++) {
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

module.exports = { detectRagaEnhanced };
