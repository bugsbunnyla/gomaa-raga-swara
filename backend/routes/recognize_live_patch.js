// INSERT THIS into your existing recognize.js upload handler
// BEFORE passing file to Whisper / YIN analysis

const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

async function normalizeLiveRecording(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setFfmpegPath(ffmpegStatic)
      .audioFrequency(16000)
      .audioChannels(1)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .save(outputPath);
  });
}

// Usage inside your recognize route:
// if (filename.includes('live_recording') || filename.endsWith('.webm')) {
//   const wavPath = inputPath.replace('.webm', '_16k.wav');
//   await normalizeLiveRecording(inputPath, wavPath);
//   inputPath = wavPath;
// }
