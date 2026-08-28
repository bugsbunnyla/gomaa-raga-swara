'use strict';
/**
 * Minimal FFT helpers for carnaticSegmenter.js
 * Pure JS implementation — no external deps
 */

function rfft(signal) {
  const n = signal.length;
  const out = [];
  for (let k = 0; k < Math.floor(n / 2) + 1; k++) {
    let real = 0, imag = 0;
    for (let t = 0; t < n; t++) {
      const angle = -2 * Math.PI * k * t / n;
      real += signal[t] * Math.cos(angle);
      imag += signal[t] * Math.sin(angle);
    }
    out.push(Math.sqrt(real * real + imag * imag));
  }
  return out;
}

function rfftfreq(n, d) {
  const out = [];
  for (let i = 0; i < Math.floor(n / 2) + 1; i++) out.push(i / (n * d));
  return out;
}

module.exports = { rfft, rfftfreq };
