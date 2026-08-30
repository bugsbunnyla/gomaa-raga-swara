"use strict";
/**
 * GoMaa Audio Decoder v3.1.1
 * FIXED: Windows FFmpeg compatibility, path handling, silent-file false positives
 * Supports: MP3, WAV, FLAC, OGG, M4A, AIFF, WEBM, OPUS, AAC
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const IS_WIN = process.platform === "win32";
const FFMPEG_BIN = IS_WIN ? "ffmpeg.exe" : "ffmpeg";
const FFPROBE_BIN = IS_WIN ? "ffprobe.exe" : "ffprobe";

function findBinary(baseName) {
  try {
    const { execSync } = require("child_process");
    const cmd = IS_WIN ? `where ${baseName}` : `which ${baseName}`;
    const result = execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    const lines = result.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length > 0) return lines[0].trim();
  } catch (_) {}

  if (IS_WIN) {
    const commonPaths = [
      path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe", "ffmpeg-*-full_build", "bin", "ffmpeg.exe"),
      path.join(process.env.ProgramFiles || "", "ffmpeg", "bin", "ffmpeg.exe"),
      path.join(process.env.ProgramFiles || "", "FFmpeg", "bin", "ffmpeg.exe"),
      path.join("C:", "ffmpeg", "bin", "ffmpeg.exe"),
      path.join("C:", "Program Files", "ffmpeg", "bin", "ffmpeg.exe"),
      path.join("C:", "Program Files", "FFmpeg", "bin", "ffmpeg.exe"),
      path.join(process.env.USERPROFILE || "", "ffmpeg", "bin", "ffmpeg.exe"),
    ];
    for (const p of commonPaths) {
      if (fs.existsSync(p)) return p;
      const dir = path.dirname(p);
      if (fs.existsSync(dir)) {
        try {
          const files = fs.readdirSync(dir);
          const match = files.find(f => f.startsWith("ffmpeg") && f.endsWith(".exe"));
          if (match) return path.join(dir, match);
        } catch (_) {}
      }
    }
  }
  return baseName;
}

const FFMPEG_PATH = findBinary(FFMPEG_BIN);
const FFPROBE_PATH = findBinary(FFPROBE_BIN);

function isFFmpegAvailable() {
  try {
    const { execSync } = require("child_process");
    execSync(`"${FFMPEG_PATH}" -version`, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch (_) {
    return false;
  }
}

function getAudioDuration(filePath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(filePath)) return resolve(0);
    const proc = spawn(FFPROBE_PATH, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath
    ], { stdio: ["ignore", "pipe", "pipe"], timeout: 30000 });
    let out = "";
    proc.stdout.on("data", d => out += d.toString());
    proc.on("close", () => {
      const dur = parseFloat(out.trim());
      resolve(isNaN(dur) ? 0 : dur);
    });
    proc.on("error", () => resolve(0));
  });
}

/**
 * Ensure file has a proper extension for FFmpeg format detection.
 * Multer saves temp files without extensions which can confuse FFmpeg on Windows.
 */
function ensureExtension(filePath, originalName) {
  const ext = path.extname(originalName || "").toLowerCase();
  if (!ext) return filePath; // nothing we can do
  const currentExt = path.extname(filePath).toLowerCase();
  if (currentExt === ext) return filePath; // already has extension

  const newPath = filePath + ext;
  try {
    fs.renameSync(filePath, newPath);
    console.log(`[AudioDecode] Renamed temp file: ${path.basename(filePath)} -> ${path.basename(newPath)}`);
    return newPath;
  } catch (e) {
    console.warn(`[AudioDecode] Could not rename temp file: ${e.message}`);
    return filePath;
  }
}

/**
 * Decode any audio file to mono 22050Hz float32 PCM
 * FIXED v3.1.1:
 *   - Renames extensionless temp files before decoding
 *   - Relaxed sanity check (Carnatic files often start with silence/tanpura drone)
 *   - Uses entire-buffer RMS instead of first-1000-samples threshold
 *   - Better error messages
 */
function decodeToFloatPCM(filePath, targetSampleRate = 22050) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`File not found: ${filePath}`));
    }

    const args = [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-vn",
      "-i", filePath,
      "-acodec", "pcm_f32le",
      "-ar", String(targetSampleRate),
      "-ac", "1",
      "-f", "f32le",
      "pipe:1"
    ];

    console.log(`[AudioDecode] Spawning: ${FFMPEG_PATH}`);
    console.log(`[AudioDecode] Input: ${filePath}`);

    const ffmpeg = spawn(FFMPEG_PATH, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 300000
    });

    const chunks = [];
    let stderrData = "";
    let totalBytes = 0;
    const MAX_BYTES = 500 * 1024 * 1024;

    ffmpeg.stdout.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BYTES) {
        ffmpeg.kill("SIGTERM");
        reject(new Error("Audio file too large (>500MB decoded)"));
        return;
      }
      chunks.push(chunk);
    });

    ffmpeg.stderr.on("data", (chunk) => {
      stderrData += chunk.toString();
    });

    ffmpeg.on("error", (err) => {
      reject(new Error(`FFmpeg spawn failed: ${err.message}. Is FFmpeg installed and in PATH?`));
    });

    ffmpeg.on("close", (code, signal) => {
      if (signal) {
        return reject(new Error(`FFmpeg killed by signal: ${signal}`));
      }

      // Windows sometimes returns non-zero even on success; trust the data
      if (code !== 0 && (chunks.length === 0 || totalBytes < 4096)) {
        const errMsg = stderrData.trim() || `FFmpeg exited with code ${code}`;
        return reject(new Error(`FFmpeg failed (code ${code}): ${errMsg}`));
      }

      if (chunks.length === 0) {
        return reject(new Error("FFmpeg produced no audio data"));
      }

      const buffer = Buffer.concat(chunks);
      const floatSamples = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);

      // FIXED v3.1.1: Relaxed sanity check
      // Carnatic music often starts with silence or very quiet tanpura drone.
      // Instead of checking first 1000 samples, check RMS of entire buffer.
      let sumSq = 0;
      let sampleCount = 0;
      const stride = Math.max(1, Math.floor(floatSamples.length / 10000)); // check up to 10k samples spread across file
      for (let i = 0; i < floatSamples.length; i += stride) {
        const v = floatSamples[i];
        if (!isNaN(v)) {
          sumSq += v * v;
          sampleCount++;
        }
      }
      const rms = sampleCount > 0 ? Math.sqrt(sumSq / sampleCount) : 0;

      // Also check for NaN corruption
      let nanCount = 0;
      for (let i = 0; i < Math.min(floatSamples.length, 1000); i++) {
        if (isNaN(floatSamples[i])) nanCount++;
      }

      if (rms < 0.00001 && floatSamples.length > 10000) {
        // Very likely truly silent/invalid
        console.warn(`[AudioDecode] Warning: decoded audio RMS is extremely low (${rms.toExponential(2)}). File may be silent or corrupted.`);
        // Still resolve — downstream code can handle it
      }

      if (nanCount > 100) {
        return reject(new Error(`FFmpeg output contains ${nanCount} NaN values — corrupted decode`));
      }

      console.log(`[AudioDecode] Decoded ${floatSamples.length} samples @ ${targetSampleRate}Hz (${(floatSamples.length / targetSampleRate).toFixed(1)}s), RMS=${rms.toExponential(2)}`);
      resolve({ floatSamples, sampleRate: targetSampleRate, duration: floatSamples.length / targetSampleRate });
    });
  });
}

/**
 * Fallback decoder using 16-bit signed int if float32 fails
 */
function decodeToFloatPCM_Fallback(filePath, targetSampleRate = 22050) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y", "-hide_banner", "-loglevel", "error",
      "-vn", "-i", filePath,
      "-acodec", "pcm_s16le",
      "-ar", String(targetSampleRate), "-ac", "1",
      "-f", "s16le", "pipe:1"
    ];

    const ffmpeg = spawn(FFMPEG_PATH, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 300000
    });

    const chunks = [];
    let totalBytes = 0;
    const MAX_BYTES = 500 * 1024 * 1024;

    ffmpeg.stdout.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BYTES) { ffmpeg.kill("SIGTERM"); reject(new Error("Too large")); return; }
      chunks.push(chunk);
    });
    ffmpeg.stderr.on("data", () => {});

    ffmpeg.on("close", (code) => {
      if (code !== 0 && (chunks.length === 0 || totalBytes < 4096)) {
        return reject(new Error(`FFmpeg fallback failed (code ${code})`));
      }
      const buffer = Buffer.concat(chunks);
      const intSamples = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
      const floatSamples = new Float32Array(intSamples.length);
      for (let i = 0; i < intSamples.length; i++) {
        floatSamples[i] = intSamples[i] / 32768.0;
      }
      resolve({ floatSamples, sampleRate: targetSampleRate, duration: floatSamples.length / targetSampleRate });
    });

    ffmpeg.on("error", (err) => reject(new Error(`FFmpeg fallback spawn failed: ${err.message}`)));
  });
}

/**
 * Robust decode with automatic fallback
 */
async function decodeToFloatPCM_Robust(filePath, targetSampleRate = 22050) {
  try {
    return await decodeToFloatPCM(filePath, targetSampleRate);
  } catch (e) {
    console.warn(`[AudioDecode] Primary decode failed: ${e.message}. Trying fallback...`);
    return await decodeToFloatPCM_Fallback(filePath, targetSampleRate);
  }
}

function readPCMFloats(filePath, sampleRate = 22050) {
  return decodeToFloatPCM_Robust(filePath, sampleRate);
}

module.exports = {
  decodeToFloatPCM: decodeToFloatPCM_Robust,
  decodeToFloatPCM_Fallback,
  readPCMFloats,
  isFFmpegAvailable,
  getAudioDuration,
  ensureExtension,
  FFMPEG_PATH,
  FFPROBE_PATH
};
