/**
 * GoMaa Raga Vidya — pitchEngine.js v4.0.2
 * YIN pitch detection with parabolic interpolation and median smoothing.
 */

function difference(buffer, tauMax) {
  const n = buffer.length;
  const diff = new Float32Array(tauMax);
  for (let tau = 1; tau < tauMax; tau++) {
    let sum = 0;
    for (let i = 0; i < n - tauMax; i++) {
      const d = buffer[i] - buffer[i + tau];
      sum += d * d;
    }
    diff[tau] = sum;
  }
  return diff;
}

function cumulativeMeanNormalized(diff) {
  const tauMax = diff.length;
  const cmnd = new Float32Array(tauMax);
  cmnd[0] = 1;
  let runningSum = 0;
  for (let tau = 1; tau < tauMax; tau++) {
    runningSum += diff[tau];
    cmnd[tau] = diff[tau] / (runningSum / tau);
  }
  return cmnd;
}

function absoluteThreshold(cmnd, threshold = 0.1) {
  for (let tau = 2; tau < cmnd.length; tau++) {
    if (cmnd[tau] < threshold) {
      // Ensure local minimum
      while (tau + 1 < cmnd.length && cmnd[tau + 1] < cmnd[tau]) tau++;
      return tau;
    }
  }
  return -1;
}

function parabolicInterpolation(buffer, tau) {
  if (tau <= 0 || tau >= buffer.length - 1) return tau;
  const alpha = buffer[tau - 1];
  const beta = buffer[tau];
  const gamma = buffer[tau + 1];
  const p = 0.5 * (alpha - gamma) / (alpha - 2 * beta + gamma);
  return tau + p;
}

function detectPitchYIN(samples, sampleRate, frameSize = 2048, hopSize = 512) {
  const pitches = [];
  const tauMax = Math.floor(frameSize / 2);
  const threshold = 0.1;

  for (let i = 0; i + frameSize < samples.length; i += hopSize) {
    const frame = samples.slice(i, i + frameSize);
    const diff = difference(frame, tauMax);
    const cmnd = cumulativeMeanNormalized(diff);
    const tau = absoluteThreshold(cmnd, threshold);

    if (tau > 0) {
      const betterTau = parabolicInterpolation(cmnd, tau);
      const freq = sampleRate / betterTau;
      if (freq > 50 && freq < 2000) {
        pitches.push(freq);
      } else {
        pitches.push(0);
      }
    } else {
      pitches.push(0);
    }
  }
  return pitches;
}

function medianSmooth(arr, window = 5) {
  if (window < 3) return arr;
  const half = Math.floor(window / 2);
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const slice = [];
    for (let j = -half; j <= half; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < arr.length) slice.push(arr[idx]);
    }
    slice.sort((a, b) => a - b);
    out[i] = slice[Math.floor(slice.length / 2)];
  }
  return out;
}

module.exports = { detectPitchYIN, medianSmooth };
