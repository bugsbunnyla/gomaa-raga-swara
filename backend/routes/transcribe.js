'use strict';
/**
 * POST /api/transcribe
 * Real-time audio transcription via faster-whisper (Python).
 * Writes JSON result to a temp file to avoid Windows cp1252 encoding issues with Telugu.
 * Engine: https://github.com/SYSTRAN/faster-whisper
 */
const express    = require('express');
const router     = express.Router();
const { execFile, spawn } = require('child_process');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');

// Use 'python' on Windows, 'python3' on Linux/Mac
const PY = process.platform === 'win32' ? 'python' : 'python3';

// Check faster-whisper availability once
let _available = null;
function _checkAvail() {
  return new Promise(res => {
    if (_available !== null) return res(_available);
    execFile(PY, ['-c', 'import faster_whisper; print("ok")'],
      { timeout: 8000 },
      (err, out) => { _available = !err && out.includes('ok'); res(_available); });
  });
}

// Python script — writes JSON to file (avoids Windows cp1252 Telugu encoding crash)
const WHISPER_PY = `
import sys, json, io
# Force UTF-8 stdout/stderr regardless of Windows console encoding
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

from faster_whisper import WhisperModel

audio   = sys.argv[1]
lang    = sys.argv[2] if len(sys.argv) > 2 else 'te'
size    = sys.argv[3] if len(sys.argv) > 3 else 'base'
outfile = sys.argv[4] if len(sys.argv) > 4 else None

model = WhisperModel(size, device='cpu', compute_type='int8')
segs, info = model.transcribe(
    audio, language=lang, beam_size=5,
    vad_filter=True,
    vad_parameters=dict(min_silence_duration_ms=200, speech_pad_ms=100),
    word_timestamps=True,
    condition_on_previous_text=True,
    temperature=0.0,
    no_speech_threshold=0.3,
    log_prob_threshold=-0.6,
)
result = {'language': info.language, 'confidence': float(info.language_probability),
          'duration': float(info.duration), 'text': '', 'segments': [], 'words': []}
texts = []
for seg in segs:
    t = seg.text.strip()
    texts.append(t)
    wds = []
    if hasattr(seg, 'words') and seg.words:
        for w in seg.words:
            wds.append({'word': w.word, 'start': float(w.start),
                        'end': float(w.end), 'prob': float(w.probability)})
            result['words'].append(wds[-1])
    result['segments'].append({'start': float(seg.start), 'end': float(seg.end),
                                'text': t, 'words': wds})
result['text'] = ' '.join(texts)

j = json.dumps(result, ensure_ascii=False)
if outfile:
    with open(outfile, 'w', encoding='utf-8') as f:
        f.write(j)
    print('OK')
else:
    sys.stdout.buffer.write(j.encode('utf-8'))
    sys.stdout.buffer.flush()
`;

// Filter HuggingFace noise from stderr
function _cleanErr(errStr) {
  const NOISE = ['UserWarning','huggingface_hub','HF_TOKEN','symlinks',
                 'cp1252','FutureWarning','TOKENIZERS','unauthenticated'];
  return errStr.split('\n')
    .filter(l => !NOISE.some(n => l.includes(n)))
    .join('\n').trim();
}

router.post('/', express.raw({ type: '*/*', limit: '500mb' }), async (req, res) => {
  const avail = await _checkAvail();
  if (!avail) {
    return res.json({ fallback: true, available: false,
      error: `faster-whisper not found. Run: ${PY} -m pip install faster-whisper`,
      text: '', segments: [], words: [] });
  }

  let tmpAudio = null, tmpScript = null, tmpOut = null;
  try {
    const ext = ((req.headers['x-filename'] || 'audio.webm').match(/\.\w+$/) || ['.webm'])[0];
    tmpAudio  = path.join(os.tmpdir(), `gm_audio_${Date.now()}${ext}`);
    tmpScript = path.join(os.tmpdir(), `gm_whisper_${Date.now()}.py`);
    tmpOut    = path.join(os.tmpdir(), `gm_result_${Date.now()}.json`);

    fs.writeFileSync(tmpAudio,  req.body);
    fs.writeFileSync(tmpScript, WHISPER_PY);

    const lang  = req.headers['x-language'] || 'te';
    const model = req.headers['x-model']    || 'base';

    const result = await new Promise((resolve, reject) => {
      const proc = spawn(PY, [tmpScript, tmpAudio, lang, model, tmpOut], {
        timeout: 180000,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
               HF_HUB_DISABLE_SYMLINKS_WARNING: '1', TOKENIZERS_PARALLELISM: 'false' }
      });
      const errBufs = [];
      proc.stderr.on('data', d => errBufs.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
      proc.on('close', code => {
        const errStr = Buffer.concat(errBufs).toString('utf8');
        if (code === 0) {
          // Read from output file (UTF-8 safe — avoids Windows cp1252)
          if (fs.existsSync(tmpOut)) {
            try {
              const json = fs.readFileSync(tmpOut, 'utf8');
              resolve(JSON.parse(json));
              return;
            } catch (e) { /* fall through */ }
          }
          reject(new Error('Output file missing or invalid JSON'));
        } else {
          reject(new Error(_cleanErr(errStr).slice(0, 500) || 'Whisper process failed'));
        }
      });
      proc.on('error', err => reject(new Error('spawn error: ' + err.message)));
    });

    res.json({
      text:       result.text || '',
      language:   result.language || lang,
      confidence: result.confidence || 0,
      duration:   result.duration   || 0,
      segments:   result.segments   || [],
      words:      result.words      || [],
      model,
      engine:     'faster-whisper',
      available:  true,
    });

  } catch (e) {
    console.error('[transcribe]', e.message);
    res.status(500).json({ fallback: true, available: true,
      error: e.message, text: '', segments: [], words: [] });
  } finally {
    [tmpAudio, tmpScript, tmpOut].forEach(p => {
      try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    });
  }
});

router.get('/status', async (req, res) => {
  const ok = await _checkAvail();
  res.json({ available: ok, engine: 'faster-whisper', python: PY,
             languages: ['te','sa','hi','ta','kn','ml','en'] });
});

module.exports = router;
