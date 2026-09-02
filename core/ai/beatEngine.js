/**
 * GoMaa Raga Vidya — beatEngine.js v4.0.2
 * Comb filter bank + onset envelope beat detection.
 */

function computeOnsetEnvelope(samples, sampleRate, frameSize = 1024, hopSize = 512) {
  const envelope = [];
  let prevEnergy = 0;
  for (let i = 0; i + frameSize < samples.length; i += hopSize) {
    const frame = samples.slice(i, i + frameSize);
    let energy = 0;
    for (let j = 0; j < frame.length; j++) energy += frame[j] * frame[j];
    energy = Math.sqrt(energy / frame.length);
    const onset = Math.max(0, energy - prevEnergy);
    envelope.push(onset);
    prevEnergy = energy * 0.9; // leaky integrator
  }
  return envelope;
}

function combFilterBank(envelope, sampleRate, hopSize) {
  const minBpm = 40, maxBpm = 250;
  const minLag = Math.floor((60 / maxBpm) * sampleRate / hopSize);
  const maxLag = Math.floor((60 / minBpm) * sampleRate / hopSize);

  let bestBpm = 120;
  let bestScore = -Infinity;
  const scores = [];

  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let i = 0; i < envelope.length; i++) {
      if (i + lag < envelope.length) score += envelope[i] * envelope[i + lag];
      if (i + 2 * lag < envelope.length) score += 0.5 * envelope[i] * envelope[i + 2 * lag];
    }
    const bpm = 60 / (lag * hopSize / sampleRate);
    scores.push({ bpm, score });
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }

  // Refine with parabolic interpolation around peak
  const peakIdx = scores.findIndex(s => s.bpm === bestBpm);
  if (peakIdx > 0 && peakIdx < scores.length - 1) {
    const a = scores[peakIdx - 1].score;
    const b = scores[peakIdx].score;
    const c = scores[peakIdx + 1].score;
    const p = 0.5 * (a - c) / (a - 2 * b + c);
    bestBpm = bestBpm + p * (scores[peakIdx + 1].bpm - scores[peakIdx].bpm);
  }

  // Extract beat times
  const beats = [];
  const beatInterval = (60 / bestBpm) * sampleRate / hopSize;
  let phase = 0;
  // Find best phase
  let bestPhase = 0, bestPhaseScore = -Infinity;
  for (let p = 0; p < beatInterval; p += 1) {
    let s = 0;
    for (let i = Math.floor(p); i < envelope.length; i += Math.floor(beatInterval)) {
      s += envelope[i];
    }
    if (s > bestPhaseScore) { bestPhaseScore = s; bestPhase = p; }
  }
  for (let i = Math.floor(bestPhase); i < envelope.length; i += Math.floor(beatInterval)) {
    beats.push(i * hopSize / sampleRate);
  }

  return {
    bpm: Math.round(bestBpm * 10) / 10,
    confidence: Math.min(bestScore / (envelope.length * 0.1), 1.0),
    beats
  };
}

function detectBeatCombFilter(samples, sampleRate) {
  const envelope = computeOnsetEnvelope(samples, sampleRate);
  return combFilterBank(envelope, sampleRate, 512);
}

module.exports = { detectBeatCombFilter };
