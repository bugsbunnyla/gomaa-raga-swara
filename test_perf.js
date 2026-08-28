
const { decodeToFloatPCM, readPCMFloats } = require('./core/audio/audioDecode');
const fs = require('fs');

function extractPitchFrames(floatSamples, sampleRate = 22050) {
  const HOP    = 512;
  const WIN    = 2048;
  const MIN_F  = 80;
  const MAX_F  = 1200;
  const minLag = Math.floor(sampleRate / MAX_F);
  const maxLag = Math.floor(sampleRate / MIN_F);
  const frames_n = Math.floor((floatSamples.length - WIN) / HOP);
  const pitchFrames = [];
  for (let fi = 0; fi < frames_n; fi++) {
    const off = fi * HOP;
    let rms = 0;
    for (let n = 0; n < WIN; n++) { const s = floatSamples[off + n] || 0; rms += s * s; }
    rms = Math.sqrt(rms / WIN);
    if (rms < 0.005) { pitchFrames.push({ freq: 0, midi: 0, semi: -1, confidence: 0, rms }); continue; }
    let bestLag = minLag, bestCorr = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0;
      for (let n = 0; n < WIN - lag; n++) corr += floatSamples[off + n] * floatSamples[off + n + lag];
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    const freq = sampleRate / bestLag;
    const midi = Math.round(12 * Math.log2(freq / 440) + 69);
    const semi = ((midi - 60) % 12 + 12) % 12;
    const confidence = Math.min(1.0, rms * 10);
    pitchFrames.push({ freq: +freq.toFixed(2), midi, semi, confidence, rms });
  }
  return pitchFrames;
}

async function test() {
  const filePath = '/mnt/agents/upload/Rama_Ika_Nannu.mp3';
  const wavPath = '/tmp/test_decoded.wav';
  await decodeToFloatPCM(filePath, wavPath);
  const pcm = readPCMFloats(wavPath);
  console.log('samples=' + pcm.samples.length + ', sr=' + pcm.sampleRate);

  console.log('extractPitchFrames...');
  const t2 = Date.now();
  const frames = extractPitchFrames(pcm.samples, pcm.sampleRate);
  console.log('Pitch frames took ' + (Date.now()-t2) + 'ms, count=' + frames.length);

  fs.unlinkSync(wavPath);
}

test().catch(e => console.error(e));
