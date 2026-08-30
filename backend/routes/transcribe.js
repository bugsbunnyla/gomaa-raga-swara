"use strict";
/**
 * GoMaa Raga Vidya v3 — /api/transcribe
 * FIXED v3.1:
 *   - Default model: small (much better than base for singing)
 *   - Default language: auto-detect (empty string)
 *   - Better hallucination cleanup
 *   - YouTube + generic URL download support
 */

const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { downloadFromUrl } = require("../../backend/utils/download");
const { ensureExtension } = require("../../core/audio/audioDecode");

const UPLOAD_DIR = path.join(__dirname, "../../uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 500 * 1024 * 1024 } });

function findPython() {
  const candidates = process.platform === "win32"
    ? ["python", "python3", "py"]
    : ["python3", "python"];
  for (const py of candidates) {
    try {
      const { execSync } = require("child_process");
      execSync(py + " -V", { stdio: "ignore" });
      return py;
    } catch (_) {}
  }
  return candidates[0];
}

const PY = findPython();
const TRANSCRIBE_SCRIPT = path.join(__dirname, "../../core/ai/transcribe.py");

async function transcribeAudio(filePath, opts) {
  return new Promise((resolve) => {
    const args = [TRANSCRIBE_SCRIPT, filePath];
    if (opts.model) args.push("--model", opts.model);
    if (opts.language) args.push("--language", opts.language);
    if (opts.timestamps) args.push("--timestamps");
    if (opts.wordTimestamps) args.push("--word-timestamps");
    if (opts.outputFormat) args.push("--output-format", opts.outputFormat);
    if (opts.outputFile) args.push("--output", opts.outputFile);
    if (opts.verbose) args.push("--verbose");

    const proc = spawn(PY, args, {
      timeout: 600000,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }
    });
    let out = [];
    let err = [];
    proc.stdout.on("data", d => out.push(d));
    proc.stderr.on("data", d => err.push(d));
    proc.on("close", code => {
      const outStr = Buffer.concat(out).toString("utf8").trim();
      const errStr = Buffer.concat(err).toString("utf8").trim();
      if (code !== 0) {
        console.error("[Transcribe] Python exited", code);
        if (errStr) console.error("[Transcribe] stderr:", errStr.slice(0, 800));
        return resolve({ error: errStr || `Exit code ${code}`, text: "", words: [] });
      }
      if (!outStr) {
        console.error("[Transcribe] Empty stdout from Python");
        return resolve({ error: "Empty stdout", text: "", words: [] });
      }
      try {
        const result = JSON.parse(outStr);
        if (result.error) {
          console.error("[Transcribe] Transcription error:", result.error);
          return resolve({ ...result, text: result.text || "", words: result.words || [] });
        }
        resolve(result);
      } catch (e) {
        console.error("[Transcribe] JSON parse error:", e.message);
        console.error("[Transcribe] Raw stdout:", outStr.slice(0, 500));
        resolve({ error: "JSON parse error", text: "", words: [] });
      }
    });
    proc.on("error", e => {
      console.error("[Transcribe] Spawn error:", e.message);
      resolve({ error: e.message, text: "", words: [] });
    });
  });
}

function detectHallucination(text) {
  if (!text || typeof text !== "string") return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  const patterns = [
    /^(na\s+){3,}$/i, /^(la\s+){3,}$/i, /^(da\s+){3,}$/i, /^(ta\s+){3,}$/i,
    /^(di\s+){3,}$/i, /^(ti\s+){3,}$/i, /^(ra\s+){3,}$/i, /^(ri\s+){3,}$/i,
    /^(ma\s+){3,}$/i, /^(mi\s+){3,}$/i, /^(ka\s+){3,}$/i, /^(ki\s+){3,}$/i,
    /^(pa\s+){3,}$/i, /^(pi\s+){3,}$/i, /^(sa\s+){3,}$/i, /^(si\s+){3,}$/i,
    /^(ha\s+){3,}$/i, /^(hi\s+){3,}$/i, /^(ja\s+){3,}$/i, /^(ji\s+){3,}$/i,
    /^(va\s+){3,}$/i, /^(vi\s+){3,}$/i, /^(ga\s+){3,}$/i, /^(gi\s+){3,}$/i,
    /^(ba\s+){3,}$/i, /^(bi\s+){3,}$/i,
    /^(na\s+na\s+)+/i, /^(la\s+la\s+)+/i, /^(da\s+da\s+)+/i, /^(ta\s+ta\s+)+/i,
    /tadhari/gi, /gapadasa/gi, /garechani/gi, /dapadasa/gi, /darechani/gi,
  ];
  for (const re of patterns) {
    if (re.test(trimmed)) return true;
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  const unique = new Set(words.map(w => w.toLowerCase()));
  if (words.length > 10 && unique.size / words.length < 0.15) return true;
  return false;
}

function cleanupTranscription(text) {
  if (!text) return "";
  return text
    .replace(/\s+/g, " ")
    .replace(/\[.*?\]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/\b(music|instrumental|applause|laughter|singing)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

router.post("/", upload.single("audio"), async (req, res) => {
  try {
    const file = req.file;
    const url = req.body?.url || req.body?.youtubeUrl || req.body?.externalUrl || "";
    let filePath = "";
    let originalName = "";

    if (file) {
      originalName = file.originalname || path.basename(filePath);
      filePath = ensureExtension(file.path, originalName);
    } else if (url) {
      try {
        const downloadResult = await downloadFromUrl(url, UPLOAD_DIR);
        filePath = downloadResult.filePath;
        originalName = downloadResult.originalName;
      } catch (e) {
        console.error("[GoMaa] URL download failed:", e.message);
        return res.status(400).json({ error: `Download failed: ${e.message}` });
      }
    } else {
      return res.status(400).json({ error: "No audio file or URL provided" });
    }

    const opts = {
      model: req.body?.model || req.headers["x-model"] || "small",
      language: req.body?.language || req.headers["x-language"] || "",
      timestamps: true,
      wordTimestamps: true,
      outputFormat: "json",
      verbose: req.body?.verbose === "true" || req.headers["x-verbose"] === "true"
    };

    console.log("[GoMaa] Transcribing with model=" + opts.model + ", lang=" + (opts.language || "auto") + "...");
    const result = await transcribeAudio(filePath, opts);

    if (result.error) {
      console.error("[GoMaa] Transcription failed:", result.error);
      return res.status(500).json({ error: result.error, text: "", words: [] });
    }

    const cleaned = cleanupTranscription(result.text || "");
    const isGarbage = detectHallucination(cleaned);

    if (isGarbage) {
      console.log("[GoMaa] Transcription detected as garbage. Retained 0/" + (result.words?.length || 0) + " words.");
      return res.json({
        text: "",
        words: [],
        language: result.language || opts.language || "auto",
        model: opts.model,
        duration: result.duration || 0,
        cleaned: true,
        garbage: true,
        note: "Transcription was detected as hallucinated. Using composition database fallback."
      });
    }

    console.log("[GoMaa] Transcription complete. Words:", (result.words || []).length);
    res.json({
      text: cleaned,
      words: result.words || [],
      language: result.language || opts.language || "auto",
      model: opts.model,
      duration: result.duration || 0,
      cleaned: true,
      garbage: false
    });
  } catch (e) {
    console.error("[GoMaa] Transcription route error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
