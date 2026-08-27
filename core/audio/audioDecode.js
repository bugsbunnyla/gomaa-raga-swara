'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function isFFmpegAvailable() {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
}

function decodeToFloatPCM(inputPath, outputWavPath) {
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', inputPath, '-ac', '1', '-ar', '22050', '-sample_fmt', 's16', '-vn', outputWavPath];
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(outputWavPath) || fs.statSync(outputWavPath).size < 1024) {
        return reject(new Error(`FFmpeg failed (code ${code}): ${stderr.slice(0, 500)}`));
      }
      resolve(outputWavPath);
    });
  });
}

function readPCMFloats(wavPath) {
  const buf = fs.readFileSync(wavPath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Invalid WAV file');
  }
  let offset = 12, dataOffset = 0, dataSize = 0, sampleRate = 22050, bitsPerSample = 16;
  while (offset < buf.length - 8) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') { sampleRate = buf.readUInt32LE(offset + 12); bitsPerSample = buf.readUInt16LE(offset + 22); }
    else if (chunkId === 'data') { dataOffset = offset + 8; dataSize = chunkSize; break; }
    offset += 8 + chunkSize;
    if (chunkSize % 2 === 1) offset++;
  }
  if (dataOffset === 0) throw new Error('No data chunk in WAV');
  const samples = [];
  const bytesPerSample = bitsPerSample / 8;
  const end = Math.min(dataOffset + dataSize, buf.length);
  for (let i = dataOffset; i < end; i += bytesPerSample) {
    if (bitsPerSample === 16) samples.push(buf.readInt16LE(i) / 32768.0);
    else if (bitsPerSample === 8) samples.push((buf.readUInt8(i) - 128) / 128.0);
    else if (bitsPerSample === 24) { let val = (buf[i] | (buf[i+1] << 8) | (buf[i+2] << 16)); if (val & 0x800000) val |= ~0xFFFFFF; samples.push(val / 8388608.0); }
    else if (bitsPerSample === 32) samples.push(buf.readFloatLE(i));
  }
  return { samples, sampleRate, bitsPerSample };
}

async function extractAudioFromVideo(videoPath, outDir) {
  const base = path.basename(videoPath, path.extname(videoPath));
  const outPath = path.join(outDir || os.tmpdir(), `${base}_audio_${Date.now()}.wav`);
  await decodeToFloatPCM(videoPath, outPath);
  return outPath;
}

module.exports = { isFFmpegAvailable, decodeToFloatPCM, readPCMFloats, extractAudioFromVideo };
