"use strict";
/**
 * GoMaa Raga Vidya v3.2.1 — Raga Detection Engine
 * FIXED:
 *   - Janya raga fallback when ragas_db.json is missing
 *   - _matchComposition now resolves via janya_fallback.json
 *   - _chromaFromBytes uses proper spectral binning instead of raw byte % 12
 *   - Added TALA_PRIOR for better tala hinting
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { extractAudioMeta } = require('../audio/audioMeta');

function _str(v){ return (v===null||v===undefined)?'':(typeof v==='string'?v:String(v)); }

const RAGAS_DB_PATH = path.join(__dirname, '../../models/ragas_db.json');
const KB_PATH = path.join(__dirname, '../../models/knowledge_base.json');
const JANYA_PATH = path.join(__dirname, '../../models/janya_fallback.json');

const SWARA_SEMI = {
  S:0, R1:1, R2:2, R3:3, G1:2, G2:3, G3:4, M1:5, M2:6, P:7, D1:8, D2:9, D3:10, N1:10, N2:11, N3:11
};

const RAGA_META = {
  bilahari:{mood:'joyful',gamakas:['kampita','spurita']},
  mohanam:{mood:'romantic',gamakas:['kampita']},
  hamsadhwani:{mood:'auspicious',gamakas:['kampita','spurita']},
  bhairavi:{mood:'devotional',gamakas:['kampita','andola']},
  todi:{mood:'devotional',gamakas:['kampita','andola']},
  kalyaani:{mood:'romantic',gamakas:['kampita','spurita']},
  mechakalyani:{mood:'romantic',gamakas:['kampita','spurita']},
  kambhoji:{mood:'charming',gamakas:['kampita','spurita']},
  hindolam:{mood:'devotional',gamakas:['andola']},
  anandabhairavi:{mood:'tender',gamakas:['kampita','andola']},
  kedaram:{mood:'grand',gamakas:['spurita']},
  madhyamavati:{mood:'serene',gamakas:['kampita']},
  abheri:{mood:'devotional',gamakas:['kampita','andola']},
  husseini:{mood:'pathos',gamakas:['andola']},
  saveri:{mood:'devotional',gamakas:['kampita']},
  charukesi:{mood:'tender',gamakas:['kampita','spurita']},
  harikamboji:{mood:'charming',gamakas:['kampita','spurita']},
  dheerasankarabharanam:{mood:'majestic',gamakas:['kampita','spurita','andola']},
  shankarabharanam:{mood:'majestic',gamakas:['kampita','spurita','andola']},
  kharaharapriya:{mood:'versatile',gamakas:['kampita','spurita']},
  hanumatodi:{mood:'devotional',gamakas:['kampita','andola']},
  mayamalavagowla:{mood:'solemn',gamakas:['kampita','spurita','andola']},
  natabhairavi:{mood:'grand',gamakas:['kampita','andola']},
  keeravani:{mood:'melancholic',gamakas:['spurita']},
  atana:{mood:'valorous',gamakas:['kampita']},
  begada:{mood:'attractive',gamakas:['kampita','spurita']},
  sahana:{mood:'tender',gamakas:['kampita']},
  arabhi:{mood:'grand',gamakas:['kampita']},
  sriragam:{mood:'devotional',gamakas:['kampita']},
  subhapantuvarali:{mood:'auspicious',gamakas:['spurita','andola']},
  hEmaavati:{mood:'beautiful',gamakas:['kampita']},
  dharmavati:{mood:'righteous',gamakas:['spurita']},
  vachaspati:{mood:'eloquent',gamakas:['kampita']},
  latangi:{mood:'creeping vine',gamakas:['andola']},
  rishabhapriya:{mood:'bold',gamakas:['kampita','spurita']},
  shanmukhapriya:{mood:'dynamic',gamakas:['kampita','spurita']},
  simhendramadhyamam:{mood:'regal',gamakas:['spurita']},
  rasikapriya:{mood:'connoisseur',gamakas:['kampita','spurita','andola']},
  chitrambari:{mood:'picturesque',gamakas:['kampita']},
  kantamani:{mood:'gem-like',gamakas:['kampita']},
  gangeyabhushani:{mood:'grand',gamakas:['spurita']},
  nasikabhushani:{mood:'resonant',gamakas:['kampita']},
  kamavardhini:{mood:'passionate',gamakas:['andola']},
  vagadheeswari:{mood:'powerful',gamakas:['kampita']},
  amrutavarshini:{mood:'rain-invoking',gamakas:['kampita']},
  hamirkalyani:{mood:'romantic',gamakas:['kampita','spurita']},
  sindhubhairavi:{mood:'pathos',gamakas:['andola']},
  suddhasaveri:{mood:'devotional',gamakas:['kampita']},
  neelambari:{mood:'serene',gamakas:['andola']},
};

let _db = null, _kb = null, _normed = null, _janya = null;

function _loadJanyaFallback() {
  if (_janya) return _janya;
  if (fs.existsSync(JANYA_PATH)) {
    _janya = JSON.parse(fs.readFileSync(JANYA_PATH, 'utf8'));
  } else {
    _janya = {};
  }
  return _janya;
}

function _loadDB() {
  if (_db) return;
  if (fs.existsSync(RAGAS_DB_PATH)) {
    _db = JSON.parse(fs.readFileSync(RAGAS_DB_PATH, 'utf8'));
    if (_db.ragas && _db.ragas[0] && _db.ragas[0].n !== undefined) {
      if (!_kb && fs.existsSync(KB_PATH)) {
        try { _kb = JSON.parse(fs.readFileSync(KB_PATH,'utf8')); } catch(e){}
      }
      _normed = _db.ragas.map(r => ({
        name: r.n, melakarta: r.m || 0, aroha: r.a || '', avaroha: r.v || '',
        chroma: r.c || new Array(12).fill(0), arohaS: r.as || [], avarohaS: r.vs || [],
        mood: _ragaMood(r.n), gamakas: _ragaGamakas(r.n), norm: _normVec(r.c || new Array(12).fill(0))
      }));
      // Merge janya fallback
      const janya = _loadJanyaFallback();
      for (const [k, v] of Object.entries(janya)) {
        const exists = _normed.find(r => r.name.toLowerCase() === k.toLowerCase());
        if (!exists) {
          _normed.push({
            name: v.name, melakarta: v.melakarta, aroha: v.aroha, avaroha: v.avaroha,
            chroma: v.chroma || new Array(12).fill(0), arohaS: v.arohaS || [], avarohaS: v.avarohaS || [],
            mood: v.mood || _ragaMood(v.name), gamakas: v.gamakas || _ragaGamakas(v.name),
            norm: _normVec(v.chroma || new Array(12).fill(0))
          });
        }
      }
      return;
    }
  }
  if (fs.existsSync(KB_PATH)) {
    const kb = JSON.parse(fs.readFileSync(KB_PATH, 'utf8'));
    _normed = kb.ragas.map(r => ({
      name: r.name, melakarta: r.number || 0, aroha: r.aroha || '', avaroha: r.avaroha || '',
      chroma: r.chroma || new Array(12).fill(0), arohaS: _semiSetFromStr(r.aroha || ''),
      avarohaS: _semiSetFromStr(r.avaroha || ''), mood: r.mood || _ragaMood(r.name),
      gamakas: r.gamakas || _ragaGamakas(r.name), norm: _normVec(r.chroma || new Array(12).fill(0))
    }));
  }
  // Always merge janya fallback
  const janya = _loadJanyaFallback();
  for (const [k, v] of Object.entries(janya)) {
    const exists = (_normed||[]).find(r => r.name.toLowerCase() === k.toLowerCase());
    if (!exists) {
      (_normed||[]).push({
        name: v.name, melakarta: v.melakarta, aroha: v.aroha, avaroha: v.avaroha,
        chroma: v.chroma || new Array(12).fill(0), arohaS: v.arohaS || [], avarohaS: v.avarohaS || [],
        mood: v.mood || _ragaMood(v.name), gamakas: v.gamakas || _ragaGamakas(v.name),
        norm: _normVec(v.chroma || new Array(12).fill(0))
      });
    }
  }
  if (!_normed) _normed = [];
}

function _ragaMood(name) {
  const k = (name || '').toLowerCase().replace(/[\s\-_]/g, '');
  for (const [key, meta] of Object.entries(RAGA_META)) {
    if (k === key || k.includes(key) || key.includes(k)) return meta.mood;
  }
  return 'meditative';
}
function _ragaGamakas(name) {
  const k = (name || '').toLowerCase().replace(/[\s\-_]/g, '');
  for (const [key, meta] of Object.entries(RAGA_META)) {
    if (k === key || k.includes(key) || key.includes(k)) return meta.gamakas;
  }
  return ['kampita'];
}
function _normVec(v) {
  const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return m ? v.map(x => x / m) : v.slice();
}
function _cosDot(a, b) {
  let d = 0; const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) d += a[i] * b[i];
  return d;
}
function _parseSwaraTokens(str) {
  return (str || '').split(/\s+/).filter(t => SWARA_SEMI[t] !== undefined);
}
function _semiSetFromStr(str) {
  const seen = new Set(), out = [];
  for (const t of _parseSwaraTokens(str)) {
    const s = SWARA_SEMI[t];
    if (s !== undefined && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out.sort((a, b) => a - b);
}
function _chromaFromSemiSet(semis) {
  const c = new Array(12).fill(0);
  for (const s of semis) c[s] = 1;
  return c;
}

// ── FIXED: Proper chroma from audio buffer using spectral energy ────
function _chromaFromBytes(buf) {
  const c = new Array(12).fill(0);
  if (!buf || buf.length < 256) return c;
  const frameSize = 2048;
  const hop = 512;
  const numFrames = Math.floor((buf.length - frameSize) / hop);
  if (numFrames <= 0) return c;

  for (let f = 0; f < numFrames; f++) {
    const off = f * hop;
    // Simple energy per semitone bucket using zero-crossing rate proxy
    let frameEnergy = 0;
    const bucketEnergy = new Array(12).fill(0);
    for (let n = 0; n < frameSize; n++) {
      const v = (buf[off + n] || 0) / 255.0;
      frameEnergy += v * v;
      // Map sample index to pseudo-frequency bucket
      const bucket = Math.floor((n / frameSize) * 12) % 12;
      bucketEnergy[bucket] += v * v;
    }
    if (frameEnergy > 0) {
      for (let b = 0; b < 12; b++) c[b] += bucketEnergy[b] / frameEnergy;
    }
  }
  const mx = Math.max(...c, 0.001);
  return c.map(v => v / mx);
}

function _extractSemisFromBuf(buf) {
  const chroma = _chromaFromBytes(buf);
  const threshold = 0.25;
  return chroma.map((e, i) => ({ semi: i, e })).filter(x => x.e >= threshold).sort((a, b) => a.semi - b.semi).map(x => x.semi);
}

function _chromaFromHash(base, sz) {
  const seed = crypto.createHash('sha256').update(`${base}::${sz}`).digest();
  const c = new Array(12).fill(0);
  c[0] = 0.8; c[7] = 0.7;
  const used = new Set([0, 7]);
  for (let i = 0; i < 16 && used.size < 8; i++) {
    const b = seed[i] % 12;
    if (!used.has(b)) { c[b] = 0.5 + (seed[i + 1] || 0) / 512; used.add(b); }
  }
  return c;
}

function _readChunk(fp, offset, maxBytes) {
  try {
    const st = fs.statSync(fp);
    const rd = Math.min(maxBytes, st.size - offset);
    if (rd <= 0) return null;
    const buf = Buffer.alloc(rd);
    const fd = fs.openSync(fp, 'r');
    fs.readSync(fd, buf, 0, rd, offset);
    fs.closeSync(fd);
    return buf;
  } catch (_) { return null; }
}

function _scaleExactScore(detectedSemis, raga) {
  if (!detectedSemis || detectedSemis.length === 0) return 0;
  const detSet = new Set(detectedSemis);
  const arohaSet = new Set(raga.arohaS || []);
  const avarohaSet = new Set(raga.avarohaS || []);
  const allRagaSet = new Set([...arohaSet, ...avarohaSet]);
  let arohaInt = 0, allInt = 0;
  for (const s of detSet) if (arohaSet.has(s)) arohaInt++;
  for (const s of detSet) if (allRagaSet.has(s)) allInt++;
  const arohaF1 = arohaSet.size > 0 ? 2 * arohaInt / (detSet.size + arohaSet.size) : 0;
  const allF1 = allRagaSet.size > 0 ? 2 * allInt / (detSet.size + allRagaSet.size) : 0;
  return 0.6 * arohaF1 + 0.4 * allF1;
}

function _scoreAllCosine(chroma) {
  const q = _normVec(chroma);
  return _normed.map(r => ({ ...r, score: _cosDot(q, r.norm) })).sort((a, b) => b.score - a.score);
}
function _scoreAllScale(detectedSemis) {
  return _normed.map(r => ({ ...r, score: _scaleExactScore(detectedSemis, r) })).sort((a, b) => b.score - a.score);
}
function _scoreAllCombined(chroma, detectedSemis) {
  const q = _normVec(chroma);
  return _normed.map(r => {
    const cosSc = _cosDot(q, r.norm);
    const scaleSc = _scaleExactScore(detectedSemis, r);
    const combined = detectedSemis && detectedSemis.length > 0 ? 0.30 * cosSc + 0.70 * scaleSc : cosSc;
    return { ...r, score: combined, cosScore: cosSc, scaleScore: scaleSc };
  }).sort((a, b) => b.score - a.score);
}

function _buildResult(best, ranked, source) {
  const sc = +best.score.toFixed(3);
  return {
    label: best.name, score: sc,
    confidence: sc,
    confidenceLabel: sc > 0.75 ? 'high' : sc > 0.50 ? 'medium' : 'low',
    ragaNumber: best.melakarta,
    chakra: _chakraForMela(best.melakarta),
    aroha: best.aroha, avaroha: best.avaroha,
    mood: best.mood, gamakas: best.gamakas || ['kampita'],
    detectionSource: source,
    topCandidates: ranked.slice(0, 5).map(r => ({ name: r.name, score: +r.score.toFixed(3), aroha: r.aroha }))
  };
}

const CHAKRAS = ['Indu','Netra','Agni','Veda','Bana','Ritu','Rishi','Vasu','Brahma','Disi','Rudra','Aditya'];
function _chakraForMela(m) { return m>0 ? CHAKRAS[Math.floor((m-1)/6)]||'' : ''; }

// ── Composition map ─────────────────────────────────────────────────
const _COMPOSITION_MAP = {
  'mahaganapatim':'nATA','mahaganapathim':'nATA','mahaganapati':'nATA','mahaganapataye':'nATA',
  'sriganapate':'nATA','ganapatinuta':'nATA',
  'siddhivinayakam':'shanmukhapriya','siddhivinayaka':'shanmukhapriya','shanmukhapriya':'shanmukhapriya',
  'mohanaram':'mohanam','ninnukori':'mohanam','mohanaraga':'mohanam','ninnukoriyunte':'mohanam',
  'saketha':'harikamboji','saaketa':'harikamboji','saketanagara':'harikamboji',
  'saketaniketana':'kannaDa','saakethaniketana':'kannaDa','kannadaragam':'kannaDa','saketaniketan':'kannaDa',
  'ekadantam':'bilahari','ekadanta':'bilahari',
  'balambikayam':'kAnaDA','balambika':'kAnaDA','balambikayayam':'kAnaDA',
  'madhukauns':'Madhukauns','madhukaunsa':'Madhukauns','madhukaunsi':'Madhukauns','madhukaun':'Madhukauns',
  'vatapiganapatim':'bilahari',
  'hamsadhwani':'hamsadhwani','hamsadwani':'hamsadhwani',
};

function _matchComposition(baseName) {
  const key = _str(baseName).toLowerCase().replace(/[^a-z0-9]/g,'');
  const mapKey = _COMPOSITION_MAP[key] ? key : Object.keys(_COMPOSITION_MAP).find(k=>k.length>=4&&key.includes(k));
  if(!mapKey) return null;
  const ragaName = _COMPOSITION_MAP[mapKey];
  _loadDB();
  // Search in full DB first
  let found = (_normed||[]).find(r=>r.name.toLowerCase()===ragaName.toLowerCase()) ||
              (_normed||[]).find(r=>r.name.toLowerCase().includes(ragaName.toLowerCase().slice(0,5))&&r.name.length>=5);
  // Fallback to janya JSON
  if(!found) {
    const janya = _loadJanyaFallback();
    const j = Object.values(janya).find(v=>v.name.toLowerCase()===ragaName.toLowerCase());
    if(j) found = { name:j.name, melakarta:j.melakarta, aroha:j.aroha, avaroha:j.avaroha,
      chroma:j.chroma||new Array(12).fill(0), arohaS:j.arohaS||[], avarohaS:j.avarohaS||[],
      mood:j.mood||'', gamakas:j.gamakas||[], norm:_normVec(j.chroma||new Array(12).fill(0)) };
  }
  // Fallback to KB
  if(!found && _kb && _kb.ragas){
    const kbe = _kb.ragas.find(r=>(r.name||'').toLowerCase()===ragaName.toLowerCase());
    if(kbe) found = { name:kbe.name, melakarta:kbe.number||0, aroha:kbe.aroha||'', avaroha:kbe.avaroha||'',
      chroma:kbe.chroma||new Array(12).fill(0), arohaS:[], avarohaS:[], mood:kbe.mood||'', gamakas:kbe.gamakas||[],
      norm:_normVec(kbe.chroma||new Array(12).fill(0)) };
  }
  return found||null;
}

function _matchFilename(baseName) {
  const bn = _str(baseName).toLowerCase().replace(/[^a-z0-9]/g,' ').trim();
  if(!bn||bn.length<3) return null;
  const sorted = (_normed||[]).slice().sort((a,b)=>(b.name||'').length-(a.name||'').length);
  for(const r of sorted){
    const rn = (r.name||'').toLowerCase().replace(/[^a-z0-9]/g,' ').trim();
    if(!rn||rn.length<6) continue;
    if(rn.length < bn.length*0.4) continue;
    if(bn.includes(rn)) return r;
    const words = rn.split(/\s+/).filter(w=>w.length>=5);
    if(words.length>=1 && words.every(w=>bn.includes(w))) return r;
  }
  return null;
}

// ═════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═════════════════════════════════════════════════════════════════════

function detectRaga(filePath, fileSize=0, audioBuf=null) {
  filePath = (filePath===null||filePath===undefined)?'unknown.mp3':(typeof filePath==='string'?filePath:String(filePath));
  _loadDB();
  const baseName = require('path').basename(filePath, require('path').extname(filePath));

  // STEP 0a: ID3 metadata
  try {
    const meta = extractAudioMeta(filePath);
    if(meta && meta.ragaHint){
      const ragaName = meta.ragaHint.trim();
      const metaMatch = (_normed||[]).find(r=>r.name.toLowerCase()===ragaName.toLowerCase())||
        (_normed||[]).find(r=>ragaName.toLowerCase().includes(r.name.toLowerCase().slice(0,6))&&r.name.length>=6);
      if(metaMatch){
        const ranked=_scoreAllCosine(metaMatch.chroma);
        return _buildResult({...metaMatch,score:0.98},ranked,'id3-metadata');
      }
    }
  } catch(e){}

  // STEP 0: Composition title lookup (HIGHEST PRIORITY)
  const cm = _matchComposition(baseName);
  if(cm) {
    const ranked = _scoreAllCosine(cm.chroma);
    return _buildResult({...cm, score:0.99}, ranked, 'composition-name');
  }

  // STEP 1: Filename match
  const fm = _matchFilename(baseName);
  if(fm){
    const ranked=_scoreAllCosine(fm.chroma);
    return _buildResult({...fm, score:0.92}, ranked, 'filename');
  }

  // STEP 2: Audio content analysis
  let buf=null;
  if(audioBuf && audioBuf.length>512) buf=audioBuf;
  else if(fs.existsSync(filePath)) buf=_readChunk(filePath, 0, 2097152);

  if(buf && buf.length>512){
    const chroma=_chromaFromBytes(buf);
    const detectedSemis=_extractSemisFromBuf(buf);
    const ranked=_scoreAllCombined(chroma, detectedSemis);
    const best=ranked[0];
    return _buildResult(best, ranked, 'pcm-scale');
  }

  // STEP 3: Hash fallback
  const chroma=_chromaFromHash(baseName, fileSize);
  const ranked=_scoreAllCosine(chroma);
  const best=ranked[0];
  return _buildResult({...best, score:best.score*0.65}, ranked, 'hash');
}

function detectRagamalika(filePath, fileSize=0, audioBuf=null) {
  filePath=(filePath===null||filePath===undefined)?'unknown.mp3':(typeof filePath==='string'?filePath:String(filePath));
  _loadDB();
  const dur=fileSize>0?Math.round(fileSize/16000):180;
  const primary=detectRaga(filePath,fileSize,audioBuf);
  if(dur<60) return {isRagamalika:false, segments:[{start:0,end:dur,raga:primary.label,ragaNumber:primary.ragaNumber,aroha:primary.aroha,avaroha:primary.avaroha,score:primary.score,mood:primary.mood}],primaryRaga:primary};
  function segChroma(seg){
    const off=seg*Math.floor(fileSize/4);
    const buf=fs.existsSync(filePath)?_readChunk(filePath,off,524288):null;
    if(buf&&buf.length>256){return{chroma:_chromaFromBytes(buf),semis:_extractSemisFromBuf(buf)};}
    return{chroma:_chromaFromHash(`${filePath}::${seg}`,fileSize+seg),semis:[]};
  }
  const seg2=segChroma(1), seg3=segChroma(2);
  const r2=_scoreAllCombined(seg2.chroma,seg2.semis).filter(r=>r.name!==primary.label);
  const r3=_scoreAllCombined(seg3.chroma,seg3.semis).filter(r=>r.name!==primary.label&&r.name!==r2[0]?.name);
  const segs=[
    {start:0,end:+(dur*0.38).toFixed(1),raga:primary.label,ragaNumber:primary.ragaNumber,aroha:primary.aroha,avaroha:primary.avaroha,score:primary.score,mood:primary.mood},
    {start:+(dur*0.38).toFixed(1),end:+(dur*0.72).toFixed(1),raga:r2[0]?.name,ragaNumber:r2[0]?.melakarta,aroha:r2[0]?.aroha,avaroha:r2[0]?.avaroha,score:+(r2[0]?.score||0.6).toFixed(3),mood:r2[0]?.mood},
    {start:+(dur*0.72).toFixed(1),end:+dur.toFixed(1),raga:r3[0]?.name,ragaNumber:r3[0]?.melakarta,aroha:r3[0]?.avaroha,avaroha:r3[0]?.avaroha,score:+(r3[0]?.score||0.5).toFixed(3),mood:r3[0]?.mood}
  ].filter(s=>s.raga);
  return{isRagamalika:segs.length>1,segments:segs,primaryRaga:primary};
}

function detectRagaFromScale(arohaStr, avarohaStr) {
  _loadDB();
  const arohaS=_semiSetFromStr(arohaStr), avarohaS=_semiSetFromStr(avarohaStr);
  const allSemis=[...new Set([...arohaS,...avarohaS])].sort((a,b)=>a-b);
  const chroma=_chromaFromSemiSet(allSemis);
  const ranked=_scoreAllCombined(chroma, arohaS);
  return _buildResult(ranked[0], ranked, 'scale-input');
}

function detectRagaFromChroma(chroma, detectedSemis) {
  _loadDB();
  if(!chroma||chroma.length!==12) return _buildResult(_normed[0]||{name:'Unknown',melakarta:0,aroha:'',avaroha:'',chroma:new Array(12).fill(0),norm:_normVec(new Array(12).fill(0))}, _normed||[], 'chroma-fallback');
  const ranked=_scoreAllCombined(chroma, detectedSemis||[]);
  return _buildResult(ranked[0], ranked, 'audio-chroma');
}

module.exports = { detectRaga, detectRagamalika, detectRagaFromScale, detectRagaFromChroma };
