/**
 * GoMaa Raga Vidya v6.1.2 — brainwave.js
 * αβγδ entrainment engine for neural audio synthesis.
 */
'use strict';

const BRAINWAVE_PRESETS = {
  'meditation': { alpha: 0.6, beta: 0.1, gamma: 0.05, delta: 0.25, carrier: 110, description: 'Deep meditation with delta grounding' },
  'focus': { alpha: 0.2, beta: 0.7, gamma: 0.1, delta: 0.0, carrier: 220, description: 'Beta-dominant focus with gamma bursts' },
  'creative': { alpha: 0.5, beta: 0.2, gamma: 0.3, delta: 0.0, carrier: 174, description: 'Alpha-gamma creative flow' },
  'sleep': { alpha: 0.1, beta: 0.0, gamma: 0.0, delta: 0.9, carrier: 55, description: 'Delta-dominant sleep induction' },
  'learning': { alpha: 0.3, beta: 0.5, gamma: 0.2, delta: 0.0, carrier: 144, description: 'Beta-alpha learning state' }
};

function generateBinauralBeat(presetName, durationSec = 60, sampleRate = 44100) {
  const preset = BRAINWAVE_PRESETS[presetName] || BRAINWAVE_PRESETS['meditation'];
  const samples = durationSec * sampleRate;
  const buffer = new Float32Array(samples);
  const freqs = { alpha: 10, beta: 18, gamma: 40, delta: 2 };
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    let sample = 0, amp = 0;
    for (const band of ['delta', 'alpha', 'beta', 'gamma']) {
      sample += preset[band] * Math.sin(2 * Math.PI * freqs[band] * t);
      amp += preset[band];
    }
    const carrierL = Math.sin(2 * Math.PI * preset.carrier * t);
    const envelope = (1 + sample / amp) * 0.5;
    buffer[i] = carrierL * envelope * 0.3;
  }
  return { buffer, sampleRate, preset, duration: durationSec, format: 'float32-mono' };
}

function getBrainwavePresets() {
  return Object.entries(BRAINWAVE_PRESETS).map(([name, data]) => ({ name, ...data }));
}

module.exports = { generateBinauralBeat, getBrainwavePresets, BRAINWAVE_PRESETS };
