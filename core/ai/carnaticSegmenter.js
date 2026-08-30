"use strict";
/**
 * GoMaa Unified Audio Processor — Node.js wrapper v3.2
 * FIXED v3.1:
 *   - Carnatic-specific hallucination detection (tadhari/gapadasa/garechani patterns)
 *   - Word-probability filtering in segment assignment
 *   - Complete IAST → Telugu transliteration engine
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const UNIFIED_SCRIPT = path.join(__dirname, "unified_processor.py");
const SEGMENTER_SCRIPT = path.join(__dirname, "carnatic_segmenter.py");

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
console.log("[CarnaticSegmenter] Using Python:", PY);

/* ═══════════════════════════════════════════════════════════════════════
   HALLUCINATION DETECTION — filters Whisper garbage on Carnatic singing
   ═══════════════════════════════════════════════════════════════════════ */

const HALLUCINATION_PATTERNS = [
  /^(na\s+){3,}$/i,
  /^(la\s+){3,}$/i,
  /^(da\s+){3,}$/i,
  /^(ta\s+){3,}$/i,
  /^(di\s+){3,}$/i,
  /^(ti\s+){3,}$/i,
  /^(ra\s+){3,}$/i,
  /^(ri\s+){3,}$/i,
  /^(ma\s+){3,}$/i,
  /^(mi\s+){3,}$/i,
  /^(ka\s+){3,}$/i,
  /^(ki\s+){3,}$/i,
  /^(pa\s+){3,}$/i,
  /^(pi\s+){3,}$/i,
  /^(sa\s+){3,}$/i,
  /^(si\s+){3,}$/i,
  /^(ha\s+){3,}$/i,
  /^(hi\s+){3,}$/i,
  /^(ja\s+){3,}$/i,
  /^(ji\s+){3,}$/i,
  /^(va\s+){3,}$/i,
  /^(vi\s+){3,}$/i,
  /^(ga\s+){3,}$/i,
  /^(gi\s+){3,}$/i,
  /^(ba\s+){3,}$/i,
  /^(bi\s+){3,}$/i,
  /^(na\s+na\s+)+/i,
  /^(la\s+la\s+)+/i,
  /^(da\s+da\s+)+/i,
  /^(ta\s+ta\s+)+/i,
  // Carnatic-sounding gibberish patterns
  /tadhari/gi,
  /gapadasa/gi,
  /garechani/gi,
  /dapadasa/gi,
  /darechani/gi,
  /(dha|ga|pa|da|ta|ri|ni|na|la|ma|sa)\s+(dha|ga|pa|da|ta|ri|ni|na|la|ma|sa)\s+(dha|ga|pa|da|ta|ri|ni|na|la|ma|sa)\s+(dha|ga|pa|da|ta|ri|ni|na|la|ma|sa)/i,
];

const GARBAGE_WORDS = new Set([
  "na", "la", "da", "ta", "di", "ti", "ra", "ri", "ma", "mi",
  "ka", "ki", "pa", "pi", "sa", "si", "ha", "hi", "ja", "ji",
  "va", "vi", "ga", "gi", "ba", "bi", "uh", "um", "oh", "ah",
  "tadhari", "gapadasa", "garechani", "dapadasa", "darechani", "dhari", "pada", "gari", "chani", "dapa"
]);

// Common Sanskrit/Telugu/Tamil phonemes that appear in real Carnatic lyrics
const VALID_CARNATIC_WORDS = new Set([
  "bhaja", "bhaje", "bhajami", "bhajema", "namo", "namah", "namami",
  "shri", "sri", "jaya", "jai", "raga", "raga", "tala", "swara",
  "pallavi", "anupallavi", "charanam", "sahityam", "gamaka",
  "kamala", "karuna", "daya", "pada", "pada", "kripa", "krpa",
  "deva", "devi", "natha", "natha", "isha", "isha", "shiva",
  "vishnu", "krishna", "rama", "gana", "gana", "pati", "pati",
  "mata", "pita", "guru", "guha", "mura", "mura", "hari", "hari",
  "mukunda", "murari", "govinda", "gopala", "yadava", "madhava",
  "keshava", "narayana", "vasudeva", "radha", "sita", "lakshmi",
  "saraswati", "durga", "kali", "gauri", "parvati", "uma",
  "shankara", "parameshwara", "brahma", "surya", "chandra",
  "ananda", "ananda", "chandra", "vimala", "shubha", "shanta",
  "shanti", "mangala", "mangalam", "kalyani", "kalyana",
  "sundara", "sundari", "kamala", "kamalam", "manjula",
  "manohara", "manorama", "mohana", "mohana", "madhurya",
  "madhava", "madhusudana", "murali", "muralidhara", "vamsi",
  "venu", "venugopala", "yashoda", "nandana", "nandakumara",
  "gopikanta", "gopijana", "vrindavana", "vrnda", "vrndavana",
  "kaliya", "mardana", "mardana", "damodara", "dāmodara",
  "ajamila", "ajamila", "dhruva", "prahlaada", "prahlad",
  "bhishma", "bhisma", "karna", "arjuna", "bhima", "nakula",
  "sahadeva", "yudhisthira", "draupadi", "subhadra", "balarama",
  "aniruddha", "pradyumna", "sambha", "sambhu", "sankarshana",
  "vasudeva", "devaki", "yashoda", "nandagopa", "upendra",
  "trivikrama", "vamana", "narasimha", "nrsimha", "kurma",
  "matsya", "varaha", "hayagriva", "hayagreeva", "buddha",
  "kalki", "kalkin",
]);

/**
 * Detect if transcription is hallucinated garbage.
 * Returns { isGarbage, reason, cleanText }
 */
function detectHallucination(text, words = []) {
  if (!text || typeof text !== "string") {
    return { isGarbage: true, reason: "empty", cleanText: "" };
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return { isGarbage: true, reason: "empty", cleanText: "" };
  }

  // Check pure repetition patterns
  for (const re of HALLUCINATION_PATTERNS) {
    if (re.test(trimmed)) {
      return { isGarbage: true, reason: "repetition_pattern", cleanText: "" };
    }
  }

  const wordList = trimmed.split(/\s+/).filter(Boolean);
  if (wordList.length === 0) {
    return { isGarbage: true, reason: "empty", cleanText: "" };
  }

  // Count garbage words
  let garbageCount = 0;
  let validCount = 0;
  for (const w of wordList) {
    const clean = w.toLowerCase().replace(/[^a-z]/g, "");
    if (GARBAGE_WORDS.has(clean) || clean.length <= 1) {
      garbageCount++;
    } else if (VALID_CARNATIC_WORDS.has(clean) || clean.length >= 5) {
      validCount++;
    }
  }
  const garbageRatio = garbageCount / wordList.length;
  const validRatio = validCount / wordList.length;

  // Check for excessive repetition of same word
  const uniqueWords = new Set(wordList.map(w => w.toLowerCase()));
  const diversity = uniqueWords.size / wordList.length;

  // Check average word probability if available
  let avgProb = 1.0;
  if (Array.isArray(words) && words.length > 0) {
    const probs = words.filter(w => w && typeof w.prob === "number").map(w => w.prob);
    if (probs.length > 0) {
      avgProb = probs.reduce((a, b) => a + b, 0) / probs.length;
    }
  }

  // If >70% garbage words or <15% diversity or avg prob < 0.3 → hallucination
  if (garbageRatio > 0.70) {
    return { isGarbage: true, reason: `garbage_ratio_${Math.round(garbageRatio * 100)}%`, cleanText: "" };
  }
  if (diversity < 0.15 && wordList.length > 10) {
    return { isGarbage: true, reason: `low_diversity_${Math.round(diversity * 100)}%`, cleanText: "" };
  }
  if (avgProb < 0.25 && wordList.length > 5) {
    return { isGarbage: true, reason: `low_probability_${Math.round(avgProb * 100)}%`, cleanText: "" };
  }
  if (validRatio < 0.10 && wordList.length > 8) {
    return { isGarbage: true, reason: `no_valid_words_${Math.round(validRatio * 100)}%`, cleanText: "" };
  }

  // Clean the text: remove standalone garbage words
  const cleanWords = wordList.filter(w => {
    const clean = w.toLowerCase().replace(/[^a-z]/g, "");
    return clean.length > 1 && !GARBAGE_WORDS.has(clean);
  });

  return {
    isGarbage: false,
    reason: "ok",
    cleanText: cleanWords.join(" "),
    garbageRatio: Math.round(garbageRatio * 100),
    diversity: Math.round(diversity * 100),
    avgProb: +avgProb.toFixed(3)
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   COMPLETE TRANSLITERATION ENGINE
   ═══════════════════════════════════════════════════════════════════════ */

const SCRIPTS = {
  telugu: {
    a: "\u0c05", "\u0101": "\u0c06", i: "\u0c07", "\u012b": "\u0c08",
    u: "\u0c09", "\u016b": "\u0c0a", "\u1e5b": "\u0c0b", e: "\u0c0e",
    "\u0113": "\u0c0f", ai: "\u0c10", o: "\u0c12", "\u014d": "\u0c13",
    au: "\u0c14", "\u1e43": "\u0c02", "\u1e25": "\u0c03",
    "\u0101_sign": "\u0c3e", i_sign: "\u0c3f", "\u012b_sign": "\u0c40",
    u_sign: "\u0c41", "\u016b_sign": "\u0c42", e_sign: "\u0c47",
    "\u0113_sign": "\u0c47", ai_sign: "\u0c48", o_sign: "\u0c4b",
    "\u014d_sign": "\u0c4b", au_sign: "\u0c4c",
    k: "\u0c15", kh: "\u0c16", g: "\u0c17", gh: "\u0c18", "\u1e45": "\u0c19",
    c: "\u0c1a", ch: "\u0c1b", j: "\u0c1c", jh: "\u0c1d", "\u00f1": "\u0c1e",
    "\u1e6d": "\u0c1f", "\u1e6dh": "\u0c20", "\u1e0d": "\u0c21", "\u1e0dh": "\u0c22", "\u1e47": "\u0c23",
    t: "\u0c24", th: "\u0c25", d: "\u0c26", dh: "\u0c27", n: "\u0c28",
    p: "\u0c2a", ph: "\u0c2b", b: "\u0c2c", bh: "\u0c2d", m: "\u0c2e",
    y: "\u0c2f", r: "\u0c30", l: "\u0c32", v: "\u0c35",
    "\u015b": "\u0c36", "\u1e63": "\u0c37", s: "\u0c38", h: "\u0c39",
    "k\u1e63": "\u0c15\u0c4d\u0c37", "j\u00f1": "\u0c1c\u0c4d\u0c1e",
    tr: "\u0c24\u0c4d\u0c30", "\u015br": "\u0c36\u0c4d\u0c30",
    br: "\u0c2c\u0c4d\u0c30", pr: "\u0c2a\u0c4d\u0c30",
    kr: "\u0c15\u0c4d\u0c30", gr: "\u0c17\u0c4d\u0c30",
    dr: "\u0c26\u0c4d\u0c30", vr: "\u0c35\u0c4d\u0c30",
    mr: "\u0c2e\u0c4d\u0c30", nr: "\u0c28\u0c4d\u0c30",
    yr: "\u0c2f\u0c4d\u0c30", lr: "\u0c32\u0c4d\u0c30",
    cr: "\u0c1a\u0c4d\u0c30", jr: "\u0c1c\u0c4d\u0c30",
    phr: "\u0c2b\u0c4d\u0c30", bhr: "\u0c2d\u0c4d\u0c30",
    "\u1e6dr": "\u0c1f\u0c4d\u0c30", "\u1e0dr": "\u0c21\u0c4d\u0c30",
    "\u1e47r": "\u0c23\u0c4d\u0c30", thr: "\u0c25\u0c4d\u0c30",
    dhr: "\u0c27\u0c4d\u0c30", sr: "\u0c38\u0c4d\u0c30",
    hr: "\u0c39\u0c4d\u0c30", "\u1e63r": "\u0c37\u0c4d\u0c30",
    ky: "\u0c15\u0c4d\u0c2f", gy: "\u0c17\u0c4d\u0c2f",
    cy: "\u0c1a\u0c4d\u0c2f", jy: "\u0c1c\u0c4d\u0c2f",
    ty: "\u0c24\u0c4d\u0c2f", dy: "\u0c26\u0c4d\u0c2f",
    ny: "\u0c28\u0c4d\u0c2f", py: "\u0c2a\u0c4d\u0c2f",
    by: "\u0c2c\u0c4d\u0c2f", my: "\u0c2e\u0c4d\u0c2f",
    vy: "\u0c35\u0c4d\u0c2f", ly: "\u0c32\u0c4d\u0c2f",
    sy: "\u0c38\u0c4d\u0c2f", hy: "\u0c39\u0c4d\u0c2f",
    ry: "\u0c30\u0c4d\u0c2f", "\u015by": "\u0c36\u0c4d\u0c2f",
    "\u1e63y": "\u0c37\u0c4d\u0c2f", khy: "\u0c16\u0c4d\u0c2f",
    ghy: "\u0c18\u0c4d\u0c2f", thy: "\u0c25\u0c4d\u0c2f",
    dhy: "\u0c27\u0c4d\u0c2f", phy: "\u0c2b\u0c4d\u0c2f",
    bhy: "\u0c2d\u0c4d\u0c2f",
    tv: "\u0c24\u0c4d\u0c35", dv: "\u0c26\u0c4d\u0c35",
    sv: "\u0c38\u0c4d\u0c35", nv: "\u0c28\u0c4d\u0c35",
    rv: "\u0c30\u0c4d\u0c35", lv: "\u0c32\u0c4d\u0c35",
    yv: "\u0c2f\u0c4d\u0c35", mv: "\u0c2e\u0c4d\u0c35",
    pv: "\u0c2a\u0c4d\u0c35", bv: "\u0c2c\u0c4d\u0c35",
    kv: "\u0c15\u0c4d\u0c35", gv: "\u0c17\u0c4d\u0c35",
    hv: "\u0c39\u0c4d\u0c35", "\u015bv": "\u0c36\u0c4d\u0c35",
    "\u1e63v": "\u0c37\u0c4d\u0c35", cv: "\u0c1a\u0c4d\u0c35",
    jv: "\u0c1c\u0c4d\u0c35",
    kty: "\u0c15\u0c4d\u0c24\u0c4d\u0c2f", ktv: "\u0c15\u0c4d\u0c24\u0c4d\u0c35",
    dvy: "\u0c26\u0c4d\u0c35\u0c4d\u0c2f", ndr: "\u0c28\u0c4d\u0c26\u0c4d\u0c30",
    ntr: "\u0c28\u0c4d\u0c24\u0c4d\u0c30", rty: "\u0c30\u0c4d\u0c24\u0c4d\u0c2f",
    rtr: "\u0c30\u0c4d\u0c24\u0c4d\u0c30", rdr: "\u0c30\u0c4d\u0c26\u0c4d\u0c30",
    rdy: "\u0c30\u0c4d\u0c26\u0c4d\u0c2f", stry: "\u0c38\u0c4d\u0c24\u0c4d\u0c30\u0c4d\u0c2f",
    sthy: "\u0c38\u0c4d\u0c25\u0c4d\u0c2f", skr: "\u0c38\u0c4d\u0c15\u0c4d\u0c30",
    skhy: "\u0c38\u0c4d\u0c16\u0c4d\u0c2f", spr: "\u0c38\u0c4d\u0c2a\u0c4d\u0c30",
    sphr: "\u0c38\u0c4d\u0c2b\u0c4d\u0c30", smr: "\u0c38\u0c4d\u0c2e\u0c4d\u0c30",
    snr: "\u0c38\u0c4d\u0c28\u0c4d\u0c30", syr: "\u0c38\u0c4d\u0c2f\u0c4d\u0c30",
    shr: "\u0c38\u0c4d\u0c39\u0c4d\u0c30", shv: "\u0c38\u0c4d\u0c39\u0c4d\u0c35",
    shy: "\u0c38\u0c4d\u0c39\u0c4d\u0c2f", "\u015b\u1e63": "\u0c36\u0c4d\u0c37",
  }
};

const VOWELS = ["ai", "au", "\u0101", "\u012b", "\u016b", "\u1e5b", "\u0113", "\u014d", "e", "o", "a", "i", "u", "\u1e43", "\u1e25"];

const SCRIPT_KEYS = {};
for (const [script, map] of Object.entries(SCRIPTS)) {
  const multi = Object.keys(map).filter(k => k.length > 1 && !k.includes("_sign")).sort((a, b) => b.length - a.length);
  const single = Object.keys(map).filter(k => k.length === 1 && !k.includes("_sign")).sort((a, b) => b.length - a.length);
  SCRIPT_KEYS[script] = { multi, single };
}

const IAST_CLEAN_RE = /[^\w\s\u0101\u012b\u016b\u1e5b\u1e43\u1e25\u1e45\u00f1\u1e47\u1e6d\u1e0d\u015b\u1e63\u1e3a\u1e5f\u0113\u014d]/g;
const TELUGU_RE = /[\u0c00-\u0c7f]/;

function transliterateToTelugu(iast) {
  if (!iast) return "";
  if (TELUGU_RE.test(iast)) return iast;

  const m = SCRIPTS.telugu;
  const keys = SCRIPT_KEYS.telugu;
  const text = iast.toLowerCase().replace(IAST_CLEAN_RE, " ").trim();
  const out = [];
  let i = 0;
  const n = text.length;

  while (i < n) {
    if (text[i] === " ") {
      out.push(" ");
      i++;
      continue;
    }
    let cons = "";
    for (const c of keys.multi) {
      if (text.substring(i, i + c.length) === c) {
        cons = c;
        i += c.length;
        break;
      }
    }
    if (!cons) {
      for (const c of keys.single) {
        if (text.substring(i, i + c.length) === c) {
          cons = c;
          i += c.length;
          break;
        }
      }
    }
    let vowel = "";
    for (const v of VOWELS) {
      if (text.substring(i, i + v.length) === v) {
        vowel = v;
        i += v.length;
        break;
      }
    }
    if (cons && !vowel) vowel = "a";
    if (!cons && !vowel) {
      i++;
      continue;
    }
    if (!cons) {
      out.push(m[vowel] || vowel);
    } else {
      const base = m[cons] || cons;
      out.push(vowel === "a" ? base : base + (m[vowel + "_sign"] || ""));
    }
  }
  return out.join("");
}

/* ═══════════════════════════════════════════════════════════════════════
   PYTHON BACKEND WRAPPERS
   ═══════════════════════════════════════════════════════════════════════ */

async function runPythonScript(scriptPath, audioFilePath, jsonArgs) {
  return new Promise((resolve) => {
    const proc = spawn(PY, [scriptPath, audioFilePath, JSON.stringify(jsonArgs)], {
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
        console.error(`[CarnaticSegmenter] Python exited ${code} for ${path.basename(scriptPath)}`);
        if (errStr) console.error("[CarnaticSegmenter] stderr:", errStr.slice(0, 800));
        return resolve({ error: errStr || `Exit code ${code}`, segments: [], pitchFrames: [], chroma: new Array(12).fill(0) });
      }
      if (!outStr) {
        console.error("[CarnaticSegmenter] Empty stdout from Python");
        return resolve({ error: "Empty stdout", segments: [], pitchFrames: [], chroma: new Array(12).fill(0) });
      }
      // Sanitize Python NaN/Infinity/-Infinity which are not valid JSON
      const sanitizedOut = outStr
        .replace(/: NaN/g, ': null')
        .replace(/: Infinity/g, ': null')
        .replace(/: -Infinity/g, ': null');
      try {
        const result = JSON.parse(sanitizedOut);
        if (result.error) {
          console.error("[CarnaticSegmenter] Analysis error:", result.error);
          return resolve({ ...result, segments: result.segments || [], pitchFrames: result.pitchFrames || [], chroma: result.chroma || new Array(12).fill(0) });
        }
        resolve(result);
      } catch (e) {
        console.error("[CarnaticSegmenter] JSON parse error:", e.message);
        console.error("[CarnaticSegmenter] Raw stdout:", outStr.slice(0, 500));
        resolve({ error: "JSON parse error", segments: [], pitchFrames: [], chroma: new Array(12).fill(0) });
      }
    });
    proc.on("error", e => {
      console.error("[CarnaticSegmenter] Spawn error:", e.message);
      resolve({ error: e.message, segments: [], pitchFrames: [], chroma: new Array(12).fill(0) });
    });
  });
}

async function processAudio(audioFilePath, options) {
  return await runPythonScript(UNIFIED_SCRIPT, audioFilePath, { options: options || {} });
}

async function analyzeCarnaticAudio(pcmFilePath, sampleRate, totalDuration, options) {
  const args = {
    totalDuration: totalDuration || 0,
    kriti: {},
    options: options || {},
    script: "telugu"
  };
  const result = await runPythonScript(SEGMENTER_SCRIPT, pcmFilePath, args);
  return result.segments || [];
}

function assignTranscriptionToSegments(transcription, segments) {
  if (!transcription?.words || !Array.isArray(segments)) return segments || [];

  // Filter hallucinated words + low-confidence words
  const cleanWords = (transcription.words || []).filter(w => {
    if (!w || !w.word) return false;
    const word = w.word.trim().toLowerCase();
    // Skip pure garbage single-syllable words
    if (word.length <= 2 && GARBAGE_WORDS.has(word)) return false;
    // Skip very low confidence words (< 0.3 probability)
    if (typeof w.prob === "number" && w.prob < 0.3) return false;
    return true;
  });

  for (const seg of segments) {
    const segType = seg.type || "";
    if (!["SAHITYA", "GAMAKA"].includes(segType)) {
      seg.line = seg.line || "";
      seg.lineTelugu = seg.lineTelugu || "";
      continue;
    }
    const segWords = cleanWords.filter(w => w.end > seg.start && w.start < seg.end);
    const rawLine = segWords.map(w => w.word).join(" ").trim();
    seg.line = rawLine || seg.line || "";
    seg.lineTelugu = transliterateToTelugu(seg.line);
    seg.wordCount = segWords.length;
    seg.transcriptionQuality = segWords.length > 0 ?
      Math.round(segWords.reduce((s, w) => s + (w.prob || 0), 0) / segWords.length * 100) : 0;
  }
  return segments;
}

function buildSectionLyrics(segments) {
  const sections = { pallavi: "", anupallavi: "", charanam: "", sahityam: "" };
  const sectionsTelugu = { pallavi: "", anupallavi: "", charanam: "", sahityam: "" };

  if (!Array.isArray(segments) || !segments.length) {
    return { sections, sectionsTelugu };
  }

  const tmp = { pallavi: [], anupallavi: [], charanam: [], sahityam: [] };
  for (const seg of segments) {
    const line = seg.line || "";
    if (!line || !["SAHITYA", "GAMAKA"].includes(seg.type || "")) continue;
    const sec = (seg.section || "").toLowerCase();
    if (tmp[sec]) tmp[sec].push(line);
  }

  for (const k of Object.keys(tmp)) {
    const seen = new Set();
    const lines = tmp[k].filter(x => {
      const key = x.trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    sections[k] = lines.join(" ");
    sectionsTelugu[k] = lines.map(l => transliterateToTelugu(l)).join(" ");
  }

  const allLines = segments
    .filter(s => ["SAHITYA", "GAMAKA"].includes(s.type || "") && s.line)
    .map(s => s.line.trim())
    .filter(x => x);
  const seenAll = new Set();
  const uniqueAll = allLines.filter(x => {
    if (seenAll.has(x)) return false;
    seenAll.add(x);
    return true;
  });
  sections.sahityam = uniqueAll.join(" ");
  sectionsTelugu.sahityam = uniqueAll.map(l => transliterateToTelugu(l)).join(" ");

  return { sections, sectionsTelugu };
}

module.exports = {
  processAudio,
  analyzeCarnaticAudio,
  assignTranscriptionToSegments,
  buildSectionLyrics,
  transliterateToTelugu,
  detectHallucination
};
