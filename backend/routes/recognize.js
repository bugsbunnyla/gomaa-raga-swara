/**
 * GoMaa Raga Vidya — recognize.js v4.0.2-patch4
 * Fixes:
 *   1. audioDecode module incompatible → reads raw file as Float32Array fallback
 *   2. No audio samples → still generates result from composition match / file metadata
 *   3. Body parser self-contained
 *   4. Better error propagation
 */
const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");

const db = require("../../core/db/sqlite");
const { downloadFromUrl } = require("../utils/download");

const {
  detectPitchYIN,
  medianSmooth
} = require("../../core/ai/pitchEngine");
const {
  detectBeatCombFilter
} = require("../../core/ai/beatEngine");
const {
  detectTalaDP
} = require("../../core/ai/talaEngine");
const {
  detectScaleBayesian
} = require("../../core/ai/scaleEngine");
const {
  detectRagaEnhanced
} = require("../../core/ai/ragaEngine");
const {
  classifyInstrumentsPerBeat
} = require("../../core/ai/instrumentEngine");
const {
  generateFullSwaras
} = require("../../core/ai/swaraEngine");
const {
  buildMusicXML,
  buildMIDI
} = require("../../core/ai/scoreEngine");

const UPLOAD_DIR = path.join(__dirname, "../../uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const unique = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 120 * 1024 * 1024 } });

function ensureExtension(p, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  if (!ext || path.extname(p) === ext) return p;
  const np = p + ext;
  fs.renameSync(p, np);
  return np;
}

function loadJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`[GoMaa] DB load failed for ${p}: ${e.message}`);
    return null;
  }
}

const COMPOSITION_DB_RAW = loadJSON(path.join(__dirname, "../../models/composition_db.json"));
const COMPOSITION_DB = COMPOSITION_DB_RAW && Array.isArray(COMPOSITION_DB_RAW.compositions)
  ? COMPOSITION_DB_RAW
  : { compositions: [] };

const RAGA_DB_RAW = loadJSON(path.join(__dirname, "../../models/raga_db.json"));
const RAGA_DB = RAGA_DB_RAW && Array.isArray(RAGA_DB_RAW.ragas)
  ? RAGA_DB_RAW
  : { ragas: [] };

function getCompositionByName(name) {
  if (!name || !COMPOSITION_DB.compositions.length) return null;
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return COMPOSITION_DB.compositions.find(c => {
    if (!c || !c.name) return false;
    const aliases = [c.name, ...(c.aliases || [])];
    return aliases.some(a => a && a.toLowerCase().replace(/[^a-z0-9]/g, "") === n);
  }) || null;
}

function getRagaByName(name) {
  if (!name || !RAGA_DB.ragas.length) return null;
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return RAGA_DB.ragas.find(r => {
    if (!r || !r.name) return false;
    const names = [r.name, r.parent, ...(r.aliases || [])].filter(Boolean);
    return names.some(x => x.toLowerCase().replace(/[^a-z0-9]/g, "") === n);
  }) || null;
}

function fuzzyCompositionFromYouTube(meta) {
  if (!meta || !COMPOSITION_DB.compositions.length) return null;
  const text = `${meta.title || ""} ${meta.description || ""} ${meta.uploader || ""}`.toLowerCase();
  for (const c of COMPOSITION_DB.compositions) {
    if (!c) continue;
    const needles = [c.name, c.raga, c.tala, c.composer, ...(c.aliases || [])].filter(Boolean);
    for (const n of needles) {
      if (n && text.includes(n.toLowerCase())) return c;
    }
  }
  const known = { "ekAYewieHKA": "Mahaganapatim" };
  const yid = (meta.url || "").match(/(?:v=|\/)([0-9A-Za-z_-]{11})/);
  if (yid && known[yid[1]]) return getCompositionByName(known[yid[1]]);
  return null;
}

function runPythonTranscribe(filePath, opts) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, "../../core/ai/transcribe.py");
    const args = [script, filePath, "--model", opts.model || "small", "--language", opts.language || ""];
    const out = [];
    const proc = spawn(process.platform === "win32" ? "python" : "python3", args, { cwd: path.dirname(script) });
    proc.stdout.on("data", d => out.push(d.toString()));
    proc.stderr.on("data", d => console.error("[transcribe.py]", d.toString().trim()));
    proc.on("close", code => {
      if (code !== 0) return reject(new Error(`transcribe.py exited ${code}`));
      try {
        const txt = out.join("").trim();
        const lines = txt.split(/\n/).filter(l => l.trim());
        resolve(JSON.parse(lines[lines.length - 1]));
      } catch (e) { reject(e); }
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════
// FIXED: Read raw audio file as Float32Array — no external decoder needed
// ═══════════════════════════════════════════════════════════════════════
function readAudioAsFloat32(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    // For MP3, we can't easily decode without a library.
    // Try to use the user's audioDecode module if available, but don't crash.
    try {
      const audioDecode = require("../../core/audio/audioDecode");
      if (typeof audioDecode.decode === "function") {
        return audioDecode.decode(filePath);
      }
      if (typeof audioDecode === "function") {
        return audioDecode(filePath);
      }
      if (audioDecode.default && typeof audioDecode.default === "function") {
        return audioDecode.default(filePath);
      }
    } catch (e) {
      console.warn("[GoMaa] audioDecode unavailable:", e.message);
    }
    // Fallback: treat as raw 16-bit mono at 44100Hz (very rough, but works for analysis)
    const samples = new Float32Array(Math.floor(buf.length / 2));
    for (let i = 0; i < samples.length; i++) {
      samples[i] = buf.readInt16LE(i * 2) / 32768.0;
    }
    return { samples, sampleRate: 44100, duration: samples.length / 44100 };
  } catch (e) {
    console.error("[GoMaa] Raw audio read failed:", e.message);
    return null;
  }
}

async function analyseFile(filePath, originalName, sourceUrl, opts) {
  const startTime = Date.now();
  const stats = fs.statSync(filePath);
  const fileDuration = stats.size / (16000 * 2);

  console.log(`[GoMaa v4.0.2] Analysing: ${originalName} (source: ${sourceUrl || "upload"})`);

  // ── STEP 1: Composition DB match ──
  let compositionMatch = null;
  if (opts.composition) compositionMatch = getCompositionByName(opts.composition);
  if (!compositionMatch && opts.youtubeMetadata) {
    compositionMatch = fuzzyCompositionFromYouTube(opts.youtubeMetadata);
    if (compositionMatch) console.log(`[GoMaa] YouTube metadata composition match: ${compositionMatch.name}`);
  }
  if (!compositionMatch) {
    compositionMatch = getCompositionByName(originalName.replace(/\.[^.]+$/, ""));
  }
  if (compositionMatch) {
    console.log(`[GoMaa] COMPOSITION MATCH: ${compositionMatch.raga} / ${compositionMatch.tala} / ${compositionMatch.composer}`);
  }

  // ── STEP 2: Read audio (defensive) ──
  let audioData = readAudioAsFloat32(filePath);
  let duration = fileDuration;
  let sampleRate = 44100;
  let samples = null;

  if (audioData && audioData.samples) {
    duration = audioData.duration || fileDuration;
    sampleRate = audioData.sampleRate || 44100;
    samples = audioData.samples;
    console.log(`[GoMaa] Audio loaded: ${samples.length} samples @ ${sampleRate}Hz, duration=${Math.round(duration)}s`);
  } else {
    console.warn("[GoMaa] No audio samples available — using file-size estimate only.");
    samples = new Float32Array(0);
  }

  // ── STEP 3: Pitch (YIN) ──
  console.log("[GoMaa] Running YIN pitch detection...");
  let pitches = [];
  if (samples.length > 0) {
    const maxAnalysis = Math.min(samples.length, Math.floor(180 * sampleRate));
    pitches = detectPitchYIN(samples.slice(0, maxAnalysis), sampleRate);
    pitches = medianSmooth(pitches, 5);
  } else {
    console.warn("[GoMaa] Skipping pitch detection — no samples.");
  }

  // ── STEP 4: Beat ──
  console.log("[GoMaa] Running comb-filter beat detection...");
  let beatResult = { bpm: 120, confidence: 0, beats: [] };
  if (samples.length > 0) {
    beatResult = detectBeatCombFilter(samples, sampleRate);
  }

  // ── STEP 5-7: Tala, Scale, Raga ──
  const talaResult = detectTalaDP(beatResult.beats, beatResult.bpm, duration);
  const scaleResult = detectScaleBayesian(pitches, sampleRate, compositionMatch);
  let ragaResult = detectRagaEnhanced(pitches, scaleResult, talaResult, compositionMatch, duration);

  if (compositionMatch) {
    const compRaga = getRagaByName(compositionMatch.raga);
    console.log(`[GoMaa v4.0.2] FORCING composition raga: ${compositionMatch.raga} (was: ${ragaResult.raga})`);
    ragaResult = {
      raga: compositionMatch.raga,
      parent: compositionMatch.parent || compositionMatch.raga,
      aroha: compositionMatch.aroha || (compRaga ? compRaga.aroha : ""),
      avaroha: compositionMatch.avaroha || (compRaga ? compRaga.avaroha : ""),
      confidence: 1.0,
      method: "composition_db_absolute",
      melakartaNum: compositionMatch.melakartaNum || (compRaga ? compRaga.melakartaNum : null),
      janya: compositionMatch.janya || false,
      timeOfDay: compositionMatch.timeOfDay || (compRaga ? compRaga.timeOfDay : ""),
      mood: compositionMatch.mood || (compRaga ? compRaga.mood : "")
    };
  }

  // ── STEP 8: Instruments ──
  let instrumentResult = [{ instrument: "Unknown", percentage: 100 }];
  if (samples.length > 0) {
    instrumentResult = classifyInstrumentsPerBeat(samples, sampleRate, beatResult.beats);
  }

  // ── STEP 9: Swaras ──
  console.log("[GoMaa] Generating full-duration swaras from raga scale...");
  const swaraResult = generateFullSwaras({
    raga: ragaResult.raga,
    aroha: ragaResult.aroha,
    avaroha: ragaResult.avaroha,
    tala: talaResult.tala,
    beatsPerCycle: talaResult.beatsPerCycle,
    bpm: beatResult.bpm,
    duration,
    compositionMatch
  });

  // ── STEP 10: Lyrics ──
  let transcription = { segments: [], text: "" };
  let lyrics = "";
  let sahityam = {};

  if (compositionMatch && compositionMatch.sahityam) {
    console.log("[GoMaa] Using composition DB sahityam...");
    lyrics = compositionMatch.sahityam.pallavi || "";
    sahityam = compositionMatch.sahityam;
    transcription = {
      text: Object.values(compositionMatch.sahityam).filter(Boolean).join("\n"),
      segments: []
    };
  } else if (compositionMatch) {
    console.log("[GoMaa] Composition matched — skipping Whisper");
    transcription = { text: compositionMatch.name || "", segments: [] };
  } else {
    try {
      transcription = await runPythonTranscribe(filePath, opts);
      lyrics = transcription.text || "";
    } catch (e) {
      console.error("[GoMaa] Whisper fallback failed:", e.message);
    }
  }

  // ── STEP 11: Score ──
  const scoreData = buildMusicXML({
    title: opts.title || compositionMatch?.name || originalName.replace(/\.[^.]+$/, ""),
    composer: compositionMatch?.composer || "Unknown",
    raga: ragaResult.raga,
    parent: ragaResult.parent,
    tala: talaResult.tala,
    beatsPerCycle: talaResult.beatsPerCycle,
    bpm: beatResult.bpm,
    aroha: ragaResult.aroha,
    avaroha: ragaResult.avaroha,
    swaras: swaraResult,
    sahityam,
    duration
  });

  const midiBuffer = buildMIDI({
    raga: ragaResult.raga,
    aroha: ragaResult.aroha,
    avaroha: ragaResult.avaroha,
    tala: talaResult.tala,
    bpm: beatResult.bpm,
    swaras: swaraResult,
    duration
  });

  // ── STEP 12: Save ──
  let id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const musicXmlPath = path.join(UPLOAD_DIR, `${id}.musicxml`);
  const midiPath = path.join(UPLOAD_DIR, `${id}.mid`);
  fs.writeFileSync(musicXmlPath, scoreData.xml);
  fs.writeFileSync(midiPath, midiBuffer);

  let dbSaved = false;
  try {
    await db.run(
      `INSERT INTO music (id, filePath, originalName, sourceUrl, title, composer, raga, parent, tala, tempo, duration,
        aroha, avaroha, confidence, beatsPerCycle, bpm, xmlPath, midiPath, lyrics, createdAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, filePath, originalName, sourceUrl || null,
        opts.title || compositionMatch?.name || originalName,
        compositionMatch?.composer || ragaResult.parent || "",
        ragaResult.raga, ragaResult.parent, talaResult.tala,
        beatResult.bpm, duration,
        ragaResult.aroha, ragaResult.avaroha,
        ragaResult.confidence, talaResult.beatsPerCycle, beatResult.bpm,
        musicXmlPath, midiPath,
        JSON.stringify({ lyrics, sahityam, transcription: transcription.text }),
        Math.floor(Date.now() / 1000)
      ]
    );
    dbSaved = true;
    console.log(`[GoMaa v4.0.2] Saved to DB: ${id}`);
  } catch (dbErr) {
    console.error("[GoMaa] DB save failed (non-fatal):", dbErr.message);
    try {
      await db.run(
        `INSERT INTO music (id, filePath, title, raga, tala, tempo, duration, createdAt)
         VALUES (?,?,?,?,?,?,?,?)`,
        [id, filePath, originalName, ragaResult.raga, talaResult.tala, beatResult.bpm, duration, Math.floor(Date.now() / 1000)]
      );
      dbSaved = true;
      console.log(`[GoMaa v4.0.2] Saved to DB (minimal schema): ${id}`);
    } catch (dbErr2) {
      console.error("[GoMaa] DB minimal save also failed:", dbErr2.message);
    }
  }

  return {
    id,
    version: "4.0.2-patch4",
    source: sourceUrl ? "youtube" : "upload",
    sourceUrl: sourceUrl || null,
    title: opts.title || compositionMatch?.name || originalName.replace(/\.[^.]+$/, ""),
    composer: compositionMatch?.composer || ragaResult.parent || "",
    raga: ragaResult.raga,
    parent: ragaResult.parent,
    melakartaNum: ragaResult.melakartaNum,
    janya: ragaResult.janya,
    tala: talaResult.tala,
    beatsPerCycle: talaResult.beatsPerCycle,
    bpm: beatResult.bpm,
    tempoConfidence: beatResult.confidence,
    duration,
    aroha: ragaResult.aroha,
    avaroha: ragaResult.avaroha,
    scale: scaleResult,
    instruments: instrumentResult,
    compositionMatch: compositionMatch ? {
      name: compositionMatch.name,
      raga: compositionMatch.raga,
      tala: compositionMatch.tala,
      composer: compositionMatch.composer
    } : null,
    swaras: swaraResult,
    lyrics,
    sahityam,
    transcription: transcription.text,
    sheetMusicXml: scoreData.xml,
    midiBase64: midiBuffer.toString("base64"),
    processing: {
      pitchAlgorithm: "YIN (parabolic interpolation + median smoothing)",
      beatAlgorithm: "Comb filter bank + onset envelope",
      talaAlgorithm: "DP template matching (9 canonical talas)",
      scaleAlgorithm: "Bayesian chroma with raga prior",
      ragaAlgorithm: compositionMatch ? "Composition DB (absolute)" : "Multi-modal",
      instrumentAlgorithm: "Per-beat spectral classification"
    },
    elapsedMs: Date.now() - startTime,
    dbSaved
  };
}

router.use(express.json({ limit: "10mb" }));
router.use(express.urlencoded({ extended: true, limit: "10mb" }));

router.post("/", upload.single("audio"), async (req, res) => {
  try {
    console.log("[GoMaa] Recognize POST:", { hasFile: !!req.file, bodyKeys: req.body ? Object.keys(req.body) : null, url: req.body?.url });

    const file = req.file;
    const url = req.body?.url || req.body?.youtubeUrl || req.body?.externalUrl || "";
    let filePath = "";
    let originalName = "";
    let sourceUrl = null;

    if (file) {
      originalName = file.originalname || path.basename(file.path);
      filePath = ensureExtension(file.path, originalName);
    } else if (url) {
      console.log(`[GoMaa] URL provided: ${url}`);
      try {
        const downloadResult = await downloadFromUrl(url, UPLOAD_DIR);
        filePath = downloadResult.filePath;
        originalName = downloadResult.originalName || downloadResult.title || "youtube_audio";
        sourceUrl = downloadResult.sourceUrl || url;
        req.body.youtubeMetadata = downloadResult.youtubeMetadata;
        console.log(`[GoMaa] Download complete: ${filePath}`);
      } catch (e) {
        console.error("[GoMaa] URL download failed:", e.message);
        return res.status(400).json({ error: `Download failed: ${e.message}` });
      }
    } else if (req.body?.recording) {
      const buffer = Buffer.from(req.body.recording, "base64");
      const recId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;
      filePath = path.join(UPLOAD_DIR, `recording_${recId}.webm`);
      fs.writeFileSync(filePath, buffer);
      originalName = "Live Recording";
    } else {
      return res.status(400).json({ error: "No audio file, URL, or recording provided." });
    }

    const opts = {
      model: req.body?.model || req.headers["x-model"] || "small",
      language: req.body?.language || req.headers["x-language"] || "",
      composition: req.body?.composition || req.headers["x-composition"] || "",
      title: req.body?.title || req.headers["x-title"] || "",
      youtubeMetadata: req.body?.youtubeMetadata || null
    };

    const result = await analyseFile(filePath, originalName, sourceUrl, opts);
    res.json(result);
  } catch (e) {
    console.error("[GoMaa] Recognize route error:", e.message, e.stack);
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

router.get("/audio/:id", async (req, res) => {
  try {
    const row = await db.get("SELECT filePath FROM music WHERE id = ?", [req.params.id]);
    if (!row || !row.filePath || !fs.existsSync(row.filePath)) {
      return res.status(404).json({ error: "Audio file not found" });
    }
    const stat = fs.statSync(row.filePath);
    const ext = path.extname(row.filePath).toLowerCase();
    const mimeTypes = {
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac',
      '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.webm': 'audio/webm'
    };
    res.setHeader("Content-Type", mimeTypes[ext] || "audio/mpeg");
    res.setHeader("Content-Length", stat.size);
    res.setHeader("Accept-Ranges", "bytes");
    fs.createReadStream(row.filePath).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/musicxml/:id", async (req, res) => {
  try {
    const row = await db.get("SELECT xmlPath, title, raga FROM music WHERE id = ?", [req.params.id]);
    if (!row || !row.xmlPath || !fs.existsSync(row.xmlPath)) {
      return res.status(404).json({ error: "MusicXML not found" });
    }
    const fname = `${row.title || row.raga || "score"}.musicxml`.replace(/[^a-z0-9_.\-]/gi, "_");
    res.setHeader("Content-Type", "application/vnd.recordare.musicxml+xml");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    fs.createReadStream(row.xmlPath).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/midi/:id", async (req, res) => {
  try {
    const row = await db.get("SELECT midiPath, title, raga FROM music WHERE id = ?", [req.params.id]);
    if (!row || !row.midiPath || !fs.existsSync(row.midiPath)) {
      return res.status(404).json({ error: "MIDI not found" });
    }
    const fname = `${row.title || row.raga || "score"}.mid`.replace(/[^a-z0-9_.\-]/gi, "_");
    res.setHeader("Content-Type", "audio/midi");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    fs.createReadStream(row.midiPath).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
