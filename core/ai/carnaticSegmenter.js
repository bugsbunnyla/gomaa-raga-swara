'use strict';
/**
 * GoMaa Unified Audio Processor — Node.js wrapper
 * Calls Python backend for: pitch extraction, chroma, segmentation
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, 'unified_processor.py');

function findPython() {
  const candidates = process.platform === 'win32'
    ? ['python', 'python3', 'py']
    : ['python3', 'python'];
  for (const py of candidates) {
    try {
      const { execSync } = require('child_process');
      execSync(py + ' -V', { stdio: 'ignore' });
      return py;
    } catch (_) {}
  }
  return candidates[0];
}

const PY = findPython();
console.log('[UnifiedProcessor] Using Python:', PY);

async function runUnifiedProcessor(audioFilePath, options) {
  const args = JSON.stringify({ options: options || {} });

  return new Promise((resolve) => {
    const proc = spawn(PY, [SCRIPT, audioFilePath, args], {
      timeout: 600000, // 10 min for long files
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
    });

    let out = [];
    let err = [];
    proc.stdout.on('data', d => out.push(d));
    proc.stderr.on('data', d => err.push(d));

    proc.on('close', code => {
      const outStr = Buffer.concat(out).toString('utf8').trim();
      const errStr = Buffer.concat(err).toString('utf8').trim();

      if (code !== 0) {
        console.error('[UnifiedProcessor] Python exited with code', code);
        if (errStr) console.error('[UnifiedProcessor] stderr:', errStr.slice(0, 1000));
        if (outStr) console.error('[UnifiedProcessor] stdout:', outStr.slice(0, 500));
        if (errStr.includes('not installed') || outStr.includes('not installed')) {
          console.error('');
          console.error('╔══════════════════════════════════════════════════════════════════════╗');
          console.error('║  MISSING PYTHON DEPENDENCIES                                         ║');
          console.error('║  The audio analyzer requires numpy and scipy.                        ║');
          console.error('║                                                                     ║');
          console.error('║  Install with:  pip install numpy scipy                             ║');
          console.error('╚══════════════════════════════════════════════════════════════════════╝');
        }
        return resolve({ pitchFrames: [], chroma: [0]*12, detectedSemis: [], segments: [] });
      }

      if (!outStr) {
        console.error('[UnifiedProcessor] Empty stdout from Python');
        return resolve({ pitchFrames: [], chroma: [0]*12, detectedSemis: [], segments: [] });
      }

      try {
        const result = JSON.parse(outStr);
        if (result.error) {
          console.error('[UnifiedProcessor] Analysis error:', result.error);
          return resolve({ pitchFrames: [], chroma: [0]*12, detectedSemis: [], segments: [] });
        }
        resolve(result);
      } catch (e) {
        console.error('[UnifiedProcessor] JSON parse error:', e.message);
        console.error('[UnifiedProcessor] Raw stdout:', outStr.slice(0, 500));
        resolve({ pitchFrames: [], chroma: [0]*12, detectedSemis: [], segments: [] });
      }
    });

    proc.on('error', e => {
      console.error('[UnifiedProcessor] Spawn error:', e.message);
      resolve({ pitchFrames: [], chroma: [0]*12, detectedSemis: [], segments: [] });
    });
  });
}

/**
 * Main entry: process audio file and return everything.
 */
async function processAudio(audioFilePath, options) {
  return await runUnifiedProcessor(audioFilePath, options);
}

/**
 * Map Whisper transcription words to detected segments by timestamp overlap.
 */
function assignTranscriptionToSegments(transcription, segments) {
  if (!transcription?.words || !segments?.length) return segments;
  const words = transcription.words;
  for (const seg of segments) {
    if (!['SAHITYA', 'GAMAKA'].includes(seg.type)) {
      seg.line = '';
      continue;
    }
    const segWords = words.filter(w => w.end > seg.start && w.start < seg.end);
    seg.line = segWords.map(w => w.word).join(' ').trim();
    seg.wordCount = segWords.length;
  }
  return segments;
}

/**
 * Build section lyrics from segments.
 * ALWAYS returns string values.
 */
function buildSectionLyrics(segments) {
  const sections = { pallavi: '', anupallavi: '', charanam: '', sahityam: '' };
  if (!segments?.length) return sections;

  const tmp = { pallavi: [], anupallavi: [], charanam: [], sahityam: [] };
  for (const seg of segments) {
    if (!seg.line || !['SAHITYA', 'GAMAKA'].includes(seg.type)) continue;
    const sec = seg.section?.toLowerCase();
    if (tmp[sec]) tmp[sec].push(seg.line);
  }

  for (const k of Object.keys(tmp)) {
    const seen = new Set();
    sections[k] = tmp[k].filter(x => {
      const key = x.trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).join(' ');
  }

  const allLines = segments
    .filter(s => ['SAHITYA', 'GAMAKA'].includes(s.type) && s.line)
    .map(s => s.line.trim())
    .filter(x => x);
  const seenAll = new Set();
  sections.sahityam = allLines.filter(x => {
    if (seenAll.has(x)) return false;
    seenAll.add(x);
    return true;
  }).join(' ');

  return sections;
}

module.exports = {
  processAudio,
  assignTranscriptionToSegments,
  buildSectionLyrics
};
