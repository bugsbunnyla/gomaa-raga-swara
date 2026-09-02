/**
 * GoMaa Raga Vidya — instrumentEngine.js v4.0.2
 * Per-beat spectral classification with Carnatic instrument profiles.
 */

function rms(frame) {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

function spectralCentroid(frame, sampleRate) {
  let num = 0, den = 0;
  for (let i = 0; i < frame.length / 2; i++) {
    const mag = Math.abs(frame[i]);
    const freq = i * sampleRate / frame.length;
    num += freq * mag;
    den += mag;
  }
  return den > 0 ? num / den : 0;
}

function spectralRolloff(frame, sampleRate, threshold = 0.85) {
  let total = 0;
  for (let i = 0; i < frame.length / 2; i++) total += Math.abs(frame[i]);
  let cum = 0;
  for (let i = 0; i < frame.length / 2; i++) {
    cum += Math.abs(frame[i]);
    if (cum >= threshold * total) return i * sampleRate / frame.length;
  }
  return 0;
}

function zeroCrossingRate(frame) {
  let zcr = 0;
  for (let i = 1; i < frame.length; i++) {
    if ((frame[i] >= 0) !== (frame[i-1] >= 0)) zcr++;
  }
  return zcr / frame.length;
}

const INSTRUMENT_PROFILES = {
  "Violin": { centroid: [1500, 3500], rolloff: [3000, 6000], zcr: [0.02, 0.08] },
  "Flute": { centroid: [800, 2500], rolloff: [2000, 5000], zcr: [0.03, 0.10] },
  "Veena": { centroid: [600, 1800], rolloff: [1500, 4000], zcr: [0.01, 0.05] },
  "Mridangam": { centroid: [200, 1200], rolloff: [1000, 3000], zcr: [0.10, 0.30] },
  "Ghatam": { centroid: [800, 3000], rolloff: [2500, 7000], zcr: [0.08, 0.25] },
  "Nadaswaram": { centroid: [1200, 4000], rolloff: [3500, 8000], zcr: [0.05, 0.15] },
  "Voice": { centroid: [300, 1200], rolloff: [2000, 4500], zcr: [0.04, 0.12] }
};

function classifyFrame(frame, sampleRate) {
  const c = spectralCentroid(frame, sampleRate);
  const r = spectralRolloff(frame, sampleRate);
  const z = zeroCrossingRate(frame);

  let best = "Unknown";
  let bestScore = -Infinity;
  for (const [inst, prof] of Object.entries(INSTRUMENT_PROFILES)) {
    let score = 0;
    if (c >= prof.centroid[0] && c <= prof.centroid[1]) score += 1;
    else score -= Math.min(1, Math.abs(c - (prof.centroid[0] + prof.centroid[1]) / 2) / 1000);

    if (r >= prof.rolloff[0] && r <= prof.rolloff[1]) score += 1;
    else score -= Math.min(1, Math.abs(r - (prof.rolloff[0] + prof.rolloff[1]) / 2) / 2000);

    if (z >= prof.zcr[0] && z <= prof.zcr[1]) score += 1;
    else score -= Math.min(1, Math.abs(z - (prof.zcr[0] + prof.zcr[1]) / 2) * 10);

    if (score > bestScore) { bestScore = score; best = inst; }
  }
  return { instrument: best, score: bestScore, centroid: c, rolloff: r, zcr: z };
}

function classifyInstrumentsPerBeat(samples, sampleRate, beats) {
  if (!beats || beats.length === 0) {
    return [{ instrument: "Unknown", confidence: 0, perBeat: [] }];
  }
  const frameSize = 2048;
  const hopSize = 512;
  const perBeat = [];
  const counts = {};

  for (let i = 0; i < beats.length; i++) {
    const t = beats[i];
    const startSample = Math.floor(t * sampleRate);
    const endSample = Math.min(startSample + frameSize * 4, samples.length);
    if (startSample >= samples.length) continue;
    const frame = samples.slice(startSample, endSample);
    const res = classifyFrame(frame, sampleRate);
    perBeat.push({ time: t, instrument: res.instrument, confidence: Math.max(0, Math.min(1, res.score / 3)) });
    counts[res.instrument] = (counts[res.instrument] || 0) + 1;
  }

  const total = beats.length;
  const summary = Object.entries(counts)
    .map(([inst, cnt]) => ({ instrument: inst, percentage: Math.round((cnt / total) * 100) }))
    .sort((a, b) => b.percentage - a.percentage);

  return summary.length ? summary : [{ instrument: "Unknown", confidence: 0, perBeat }];
}

module.exports = { classifyInstrumentsPerBeat };
