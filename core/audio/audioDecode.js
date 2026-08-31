"use strict";
/**
 * GoMaa Raga Vidya v4.0 — Audio Decoding Utilities
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function isFFmpegAvailable() {
  try { execSync("ffmpeg -version", { stdio: "ignore" }); return true; }
  catch (e) { return false; }
}

function ensureExtension(filePath, originalName) {
  const ext = path.extname(originalName || "").toLowerCase();
  if (ext && !filePath.endsWith(ext)) {
    const newPath = filePath + ext;
    fs.renameSync(filePath, newPath);
    return newPath;
  }
  return filePath;
}

function decodeToFloatPCM(filePath, targetSampleRate = 22050) {
  return new Promise((resolve, reject) => {
    if (!isFFmpegAvailable()) {
      reject(new Error("FFmpeg not available"));
      return;
    }

    const tmpFile = filePath + ".raw";
    const ffmpeg = require("fluent-ffmpeg");
    ffmpeg(filePath)
      .audioFrequency(targetSampleRate)
      .audioChannels(1)
      .audioCodec("pcm_s16le")
      .format("s16le")
      .on("error", (err) => {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        reject(err);
      })
      .on("end", () => {
        try {
          const buffer = fs.readFileSync(tmpFile);
          const floatSamples = new Float32Array(buffer.length / 2);
          for (let i = 0; i < floatSamples.length; i++) {
            floatSamples[i] = buffer.readInt16LE(i * 2) / 32768.0;
          }
          fs.unlinkSync(tmpFile);
          resolve({ floatSamples, sampleRate: targetSampleRate });
        } catch (e) {
          if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
          reject(e);
        }
      })
      .save(tmpFile);
  });
}

function readPCMFloats(filePath, sampleRate = 22050) {
  return decodeToFloatPCM(filePath, sampleRate);
}

module.exports = {
  isFFmpegAvailable,
  ensureExtension,
  decodeToFloatPCM,
  readPCMFloats
};
