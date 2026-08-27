'use strict';
const express = require('express');
const router = express.Router();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const multer = require('multer');

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 500 * 1024 * 1024 } });

const PY = process.platform === 'win32' ? 'python' : 'python3';

async function runTranscription(audioPath, lang = 'te', modelSize = 'base') {
  const tmpOut = path.join(os.tmpdir(), `gm_trans_${Date.now()}.json`);
  const script = `import sys, json, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
try:
    from faster_whisper import WhisperModel
except Exception as e:
    print(json.dumps({"error": str(e), "available": False}))
    sys.exit(1)
audio = sys.argv[1]; lang = sys.argv[2]; size = sys.argv[3]; outfile = sys.argv[4]
model = WhisperModel(size, device='cpu', compute_type='int8')
segs, info = model.transcribe(audio, language=lang, beam_size=5, vad_filter=True,
    vad_parameters=dict(min_silence_duration_ms=200, speech_pad_ms=100),
    word_timestamps=True, condition_on_previous_text=True, temperature=0.0,
    no_speech_threshold=0.3, log_prob_threshold=-0.6)
result = {'language': info.language, 'confidence': float(info.language_probability),
          'duration': float(info.duration), 'text': '', 'segments': [], 'words': [], 'available': True}
texts = []
for seg in segs:
    t = seg.text.strip(); texts.append(t); wds = []
    if hasattr(seg, 'words') and seg.words:
        for w in seg.words:
            wds.append({'word': w.word, 'start': float(w.start), 'end': float(w.end), 'prob': float(w.probability)})
            result['words'].append(wds[-1])
    result['segments'].append({'start': float(seg.start), 'end': float(seg.end), 'text': t, 'words': wds})
result['text'] = ' '.join(texts)
with open(outfile, 'w', encoding='utf-8') as f:
    f.write(json.dumps(result, ensure_ascii=False))
print('OK')`;
  const tmpScript = path.join(os.tmpdir(), `gm_transcribe_${Date.now()}.py`);
  fs.writeFileSync(tmpScript, script);
  return new Promise((resolve) => {
    const proc = spawn(PY, [tmpScript, audioPath, lang, modelSize, tmpOut], {
      timeout: 300000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
             HF_HUB_DISABLE_SYMLINKS_WARNING: '1', TOKENIZERS_PARALLELISM: 'false' }
    });
    let errBuf = [];
    proc.stderr.on('data', d => errBuf.push(d));
    proc.on('close', code => {
      try { fs.unlinkSync(tmpScript); } catch(_) {}
      if (code === 0 && fs.existsSync(tmpOut)) {
        try { const data = JSON.parse(fs.readFileSync(tmpOut, 'utf8')); fs.unlinkSync(tmpOut); resolve(data); return; } catch(e) {}
      }
      const errStr = Buffer.concat(errBuf).toString('utf8');
      fs.existsSync(tmpOut) && fs.unlinkSync(tmpOut);
      resolve({ available: false, error: errStr.slice(0, 500), text: '', segments: [], words: [] });
    });
  });
}

router.post('/', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const lang = req.headers['x-language'] || req.body?.language || 'te';
    const model = req.headers['x-model'] || req.body?.model || 'base';
    const result = await runTranscription(req.file.path, lang, model);
    setTimeout(() => { try { fs.unlinkSync(req.file.path); } catch(_) {} }, 60000);
    res.json(result);
  } catch (e) {
    console.error('transcribe:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/buffer', express.raw({ type: '*/*', limit: '500mb' }), async (req, res) => {
  try {
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'Empty buffer' });
    const id = require('crypto').randomBytes(8).toString('hex');
    const xfn = decodeURIComponent(req.headers['x-filename'] || 'recording.webm');
    const ext = (xfn.match(/\.(mp3|wav|ogg|flac|webm|m4a)$/i) || ['.webm'])[0];
    const fp = path.join(UPLOAD_DIR, `trans_${id}${ext}`);
    fs.writeFileSync(fp, req.body);
    const result = await runTranscription(fp, req.headers['x-language'] || 'te', req.headers['x-model'] || 'base');
    setTimeout(() => { try { fs.unlinkSync(fp); } catch(_) {} }, 60000);
    res.json(result);
  } catch (e) {
    console.error('transcribe/buffer:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
