'use strict';
/**
 * GoMaa Raga Vidya v3 — Test Suite
 * Run: npm test
 */

const fs     = require('fs');
const path   = require('path');
const http   = require('http');

let passed=0, failed=0, total=0;
const results=[];

function test(name, fn) {
  total++;
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { passed++; results.push({ name, ok:true }); process.stdout.write(`  ✅  ${name}\n`); })
              .catch(e => { failed++; results.push({ name, ok:false, error:e.message }); process.stdout.write(`  ❌  ${name}\n     ${e.message}\n`); });
    }
    passed++; results.push({ name, ok:true }); process.stdout.write(`  ✅  ${name}\n`);
  } catch(e) { failed++; results.push({ name, ok:false, error:e.message }); process.stdout.write(`  ❌  ${name}\n     ${e.message}\n`); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function assertEq(a,b,msg) { if (a!==b) throw new Error(`${msg||'Expected equal'}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); }

// ── 1. Knowledge Base ─────────────────────────────────────────────────
console.log('\n📚 1. Knowledge Base\n');

test('72 ragas present', () => {
  const kb = JSON.parse(fs.readFileSync(path.join(__dirname,'../models/knowledge_base.json'),'utf8'));
  assertEq(kb.ragas.length, 72, 'Raga count');
});

test('All ragas have required fields', () => {
  const kb = JSON.parse(fs.readFileSync(path.join(__dirname,'../models/knowledge_base.json'),'utf8'));
  const required = ['name','number','chakra','aroha','avaroha','chroma','mood','gamakas'];
  for (const r of kb.ragas) {
    for (const f of required) assert(r[f] !== undefined && r[f] !== null, `Raga #${r.number} missing field: ${f}`);
    assertEq(r.chroma.length, 12, `Raga ${r.name} chroma length`);
  }
});

// ── 2. Raga Detection ─────────────────────────────────────────────────
console.log('\n🎵 2. Raga Detection\n');

const { detectRaga, detectRagamalika, detectRagaFromScale } = require('../core/ai/ragaModel');

test('Filename hint: Hanumatodi → Hanumatodi', () => {
  const r = detectRaga('Hanumatodi_alapana.mp3', 800000);
  assertEq(r.label, 'Hanumatodi', 'Filename-based detection');
  assertEq(r.detectionSource, 'filename', 'Source should be filename');
});

test('Scale-based detection works', () => {
  const r = detectRagaFromScale('S R2 G3 M2 P D2 N3 S', '');
  assert(typeof r.label === 'string', 'Scale detection returns label');
  assert(r.score > 0, 'Scale detection has positive score');
});

test('Result has all required keys', () => {
  const r = detectRaga('/tmp/test.mp3', 400000);
  const keys = ['label','score','confidence','ragaNumber','chakra','aroha','avaroha','mood','gamakas','topCandidates','detectionSource'];
  for (const k of keys) assert(r[k] !== undefined, `Missing key: ${k}`);
});

// ── 3. Audio Decode ───────────────────────────────────────────────────
console.log('\n🔧 3. Audio Decode (FFmpeg)\n');

const { isFFmpegAvailable, readPCMFloats } = require('../core/audio/audioDecode');

test('FFmpeg availability check returns boolean', async () => {
  const avail = await isFFmpegAvailable();
  assert(typeof avail === 'boolean', 'isFFmpegAvailable returns boolean');
});

test('readPCMFloats throws on invalid WAV', () => {
  try { readPCMFloats('/dev/null'); assert(false, 'Should have thrown'); }
  catch(e) { assert(e.message.includes('Invalid') || e.message.includes('ENOENT'), 'Expected error'); }
});

// ── 4. Pitch & Scale Detection (module load) ──────────────────────────
console.log('\n🎹 4. Pitch & Scale Detection\n');

const recognizeModule = require('../backend/routes/recognize.js');
test('Recognize module loads without error', () => {
  assert(typeof recognizeModule === 'function' || typeof recognizeModule === 'object', 'Module loaded');
});

// ── 5. Sheet Music ────────────────────────────────────────────────────
console.log('\n🎼 5. Sheet Music & MIDI\n');

const { generateSheetMusicXml, generateMidi } = require('../core/ai/sheetMusicEngine');

test('MusicXML is valid XML structure', () => {
  const raga = { label:'Kalyani', ragaNumber:65, chakra:'Rudra',
    aroha:'S R2 G3 M2 P D2 N3 S', avaroha:'S N3 D2 P M2 G3 R2 S', mood:'romantic' };
  const xml = generateSheetMusicXml(raga);
  assert(xml.includes('<?xml'), 'Has XML declaration');
  assert(xml.includes('<score-partwise'), 'Is score-partwise MusicXML');
  assert(xml.includes('Kalyani'), 'Contains raga name');
  assert(xml.includes('<note>'), 'Contains at least one note');
});

test('MIDI base64 is valid', () => {
  const raga = { label:'Bhairavi', ragaNumber:20, aroha:'S R2 G2 M1 P D1 N2 S', avaroha:'S N2 D1 P M1 G2 R2 S' };
  const midi = generateMidi(raga);
  assert(typeof midi === 'string', 'MIDI is string');
  const buf = Buffer.from(midi, 'base64');
  assertEq(buf[0], 0x4d, 'MIDI header M');
  assertEq(buf[1], 0x54, 'MIDI header T');
  assertEq(buf[2], 0x68, 'MIDI header h');
  assertEq(buf[3], 0x64, 'MIDI header d');
});

// ── 6. Database ─────────────────────────────────────────────────────────
console.log('\n🗄️  6. Database\n');

const dbModule = require('../core/db/sqlite');

test('DB initializes without error', async () => {
  const d = await dbModule.getDb();
  assert(d, 'DB object returned');
});

test('DB schema: all tables exist', async () => {
  await dbModule.getDb();
  const tables = dbModule.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(r=>r.name);
  for (const t of ['music','fingerprint','edges','segments','compositions']) {
    assert(tables.includes(t), `Table ${t} missing. Found: ${tables.join(',')}`);
  }
});

test('DB stores analysisJson field', async () => {
  await dbModule.getDb();
  const id = 'test-json-' + Date.now();
  dbModule.run('INSERT OR REPLACE INTO music(id,title,analysisJson) VALUES(?,?,?)', [id, 'Test', '{"raga":"Kalyani"}']);
  const row = dbModule.get('SELECT analysisJson FROM music WHERE id=?', [id]);
  assert(row && row.analysisJson, 'analysisJson stored');
  const parsed = JSON.parse(row.analysisJson);
  assertEq(parsed.raga, 'Kalyani', 'JSON roundtrip works');
  dbModule.run('DELETE FROM music WHERE id=?', [id]);
});

// ── 7. API Routes (requires server) ────────────────────────────────────
console.log('\n🌐 7. API Routes\n');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch(e) { resolve({ status: res.statusCode, body: data }); } });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

const PORT = process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}`;

test('GET /api/health → 200', async () => {
  try {
    const r = await httpGet(`${BASE}/api/health`);
    assertEq(r.status, 200, 'Health check status');
    assert(r.body.status === 'ok', 'Status is ok');
    assert(r.body.version === '3.0.0', 'Version is 3.0.0');
  } catch(e) {
    if (e.message === 'timeout' || e.code === 'ECONNREFUSED') { console.log('     ⚠️  Server not running — skipping API tests'); return; }
    throw e;
  }
});

test('GET /api/analyses → array', async () => {
  try {
    const r = await httpGet(`${BASE}/api/analyses`);
    if (r.status === undefined) return;
    assertEq(r.status, 200, 'Analyses endpoint status');
    assert(Array.isArray(r.body), 'Returns array');
  } catch(e) {
    if (e.code === 'ECONNREFUSED' || e.message === 'timeout') return;
    throw e;
  }
});

// ── Summary ───────────────────────────────────────────────────────────
setTimeout(() => {
  const pending = total - passed - failed;
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  Results:  ${passed}/${total} passed`);
  if (failed > 0) console.log(`  Failed:   ${failed}`);
  if (pending > 0) console.log(`  Pending:  ${pending} (async)`);
  console.log(`${'─'.repeat(50)}\n`);
  if (failed > 0) {
    console.log('Failed tests:');
    results.filter(r=>!r.ok).forEach(r=>{ console.log(`  ❌ ${r.name}: ${r.error}`); });
    console.log('');
  }
  setTimeout(() => { if (failed > 0) process.exit(1); }, 500);
}, 200);
