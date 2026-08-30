/**
 * GoMaa Raga Vidya v3.2.1 — Fusion Engine with Cycle Detection Logging
 * FIXED: Added composition-match source (reliability 0.99)
 */

const fs = require('fs');
const path = require('path');
const LOG_DIR = path.join(__dirname, '../../logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch(e) {}

const CYCLE_LOG = path.join(LOG_DIR, 'cycle_detection.log');
const FUSION_LOG = path.join(LOG_DIR, 'fusion_results.log');

function logCycle(event, data) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  try { fs.appendFileSync(CYCLE_LOG, JSON.stringify(entry) + '\n'); } catch(e) {}
}

function logFusion(sources, result) {
  const entry = {
    timestamp: new Date().toISOString(),
    sources: {
      composition: { label: sources.composition?.label, score: sources.composition?.score },
      file: { label: sources.file?.label, score: sources.file?.score },
      scale: { label: sources.scale?.label, score: sources.scale?.score },
      fp: { label: sources.fp?.label, score: sources.fp?.score }
    },
    result: { label: result.label, score: result.score, confidence: result.confidence, source: result.detectionSource }
  };
  try { fs.appendFileSync(FUSION_LOG, JSON.stringify(entry) + '\n'); } catch(e) {}
}

const SOURCE_RELIABILITY = {
  'composition-match': 0.99,
  'composition-name': 0.98, 'id3-metadata': 0.95, 'filename': 0.92,
  'audio-chroma': 0.88, 'pcm-scale': 0.85, 'scale-input': 0.82,
  'chroma-fallback': 0.50, 'hash': 0.35
};

const CONFUSION_PAIRS = [
  ['bilahari','mohanam'], ['kalyaani','mechakalyani'],
  ['shankarabharanam','dheerasankarabharanam'],
  ['bhairavi','anandabhairavi'], ['harikamboji','kambhoji'],
  ['todi','hanumatodi'], ['nATA','chalanata'], ['kharaharapriya','abheri']
];

function checkConfusion(a, b) {
  const x = (a||'').toLowerCase().replace(/[^a-z]/g,'');
  const y = (b||'').toLowerCase().replace(/[^a-z]/g,'');
  return CONFUSION_PAIRS.some(([p,q]) => (x===p&&y===q)||(x===q&&y===p));
}

function calibrateConfidence(raw, rel) { return Math.min(1.0, Math.max(0, (raw||0)*rel)); }

function fuse(ragaFromFile, ragaFromScale, ragaFromFP, opts={}) {
  const sources = {
    composition: opts?.compositionMatch || null,
    file: ragaFromFile, scale: ragaFromScale, fp: ragaFromFP
  };

  // If composition match exists, it overrides everything
  if (sources.composition && sources.composition.label) {
    const result = {
      label: sources.composition.label,
      score: 0.99,
      confidence: 0.99,
      confidenceLabel: 'high',
      ragaNumber: sources.composition.ragaNumber || 0,
      chakra: sources.composition.chakra || '',
      aroha: sources.composition.aroha || 'S R G M P D N S',
      avaroha: sources.composition.avaroha || 'S N D P M G R S',
      mood: sources.composition.mood || 'meditative',
      gamakas: sources.composition.gamakas || ['kampita'],
      detectionSource: 'composition-match',
      topCandidates: []
    };
    // Still get top candidates from other sources for reference
    const otherSources = { file: ragaFromFile, scale: ragaFromScale, fp: ragaFromFP };
    const candidates = [];
    for (const [srcName, srcData] of Object.entries(otherSources)) {
      if (!srcData?.label) continue;
      const rel = SOURCE_RELIABILITY[srcData.detectionSource] || 0.5;
      candidates.push({ label: srcData.label, score: calibrateConfidence(srcData.score, rel), source: srcName });
    }
    candidates.sort((a,b)=>b.score-a.score);
    result.topCandidates = candidates.slice(0,5).map(c=>({name:c.label, score:+c.score.toFixed(3), source:c.source}));
    logFusion(sources, result);
    logCycle('fusion_override', { reason: 'composition_match', raga: result.label });
    return result;
  }

  const candidates = [];
  const sourceMap = new Map();

  for (const [srcName, srcData] of Object.entries(sources)) {
    if (!srcData?.label) continue;
    const rel = SOURCE_RELIABILITY[srcData.detectionSource] || 0.5;
    const calScore = calibrateConfidence(srcData.score, rel);
    candidates.push({
      label: srcData.label, score: calScore, rawScore: srcData.score,
      source: srcName, detectionSource: srcData.detectionSource,
      ragaNumber: srcData.ragaNumber, chakra: srcData.chakra,
      aroha: srcData.aroha, avaroha: srcData.avaroha,
      mood: srcData.mood, gamakas: srcData.gamakas,
      topCandidates: srcData.topCandidates || []
    });
    if (!sourceMap.has(srcData.label)) sourceMap.set(srcData.label, []);
    sourceMap.get(srcData.label).push({ source: srcName, score: calScore });
  }

  if (!candidates.length) {
    const fb = { label:'Unknown', score:0, confidence:0, confidenceLabel:'low', ragaNumber:0,
      chakra:'', aroha:'S R G M P D N S', avaroha:'S N D P M G R S',
      mood:'meditative', gamakas:['kampita'], detectionSource:'none', topCandidates:[] };
    logFusion(sources, fb); logCycle('fusion_fallback',{reason:'no_valid_sources'}); return fb;
  }

  for (const c of candidates) {
    const agreeing = sourceMap.get(c.label) || [];
    c.fusedScore = c.score + (agreeing.length>1 ? 0.15*(agreeing.length-1) : 0);
  }
  candidates.sort((a,b)=>b.fusedScore-a.fusedScore);
  const best = candidates[0];

  let penalty = 0;
  if (candidates.length>1 && checkConfusion(best.label, candidates[1].label)) {
    penalty = 0.15;
    logCycle('confusion_detected',{primary:best.label, secondary:candidates[1].label, penalty});
  }
  const finalConf = Math.min(1.0, best.fusedScore - penalty);
  const result = {
    label: best.label, score: +best.fusedScore.toFixed(3),
    confidence: +finalConf.toFixed(3),
    confidenceLabel: finalConf>0.80?'high':finalConf>0.55?'medium':'low',
    ragaNumber: best.ragaNumber||0, chakra: best.chakra||'',
    aroha: best.aroha||'S R G M P D N S', avaroha: best.avaroha||'S N D P M G R S',
    mood: best.mood||'meditative', gamakas: best.gamakas||['kampita'],
    detectionSource: `fusion:${best.source}`,
    topCandidates: candidates.slice(0,5).map(c=>({name:c.label, score:+c.fusedScore.toFixed(3), source:c.source, aroha:c.aroha}))
  };
  logFusion(sources, result);
  logCycle('fusion_complete',{candidateCount:candidates.length, bestLabel:best.label, finalScore:result.score});
  return result;
}

function fuseInstruments(detectedInstruments, spectralFeatures, opts={}) {
  const { lowRatio=0, midRatio=0, highRatio=0, zcr=0, spectralCentroid=0, spectralRolloff=0, spectralFlux=0 } = spectralFeatures||{};
  const instruments = [];
  const logData = { spectralFeatures, detected: [] };

  if (lowRatio>0.45 && spectralFlux>0.3) {
    const sc = Math.min(0.95, lowRatio*0.8+spectralFlux*0.3);
    instruments.push({name:'mridangam', label:'Mridangam', confidence:+sc.toFixed(3), family:'percussion', role:'tala-keeper'});
    logData.detected.push({name:'mridangam', score:sc, reason:'low_transient'});
  }
  if (lowRatio>0.4 && spectralCentroid>800 && spectralCentroid<2500) {
    const sc = Math.min(0.88, lowRatio*0.7+(spectralCentroid/2000)*0.3);
    instruments.push({name:'tabla', label:'Tabla', confidence:+sc.toFixed(3), family:'percussion', role:'tala-keeper'});
    logData.detected.push({name:'tabla', score:sc, reason:'mid_low_transient'});
  }
  if (midRatio>0.5 && highRatio<0.25 && zcr<0.06 && spectralCentroid>400 && spectralCentroid<1800) {
    const sc = Math.min(0.92, midRatio*0.7+(1-zcr*5)*0.3);
    instruments.push({name:'veena', label:'Veena', confidence:+sc.toFixed(3), family:'string', role:'melody'});
    logData.detected.push({name:'veena', score:sc, reason:'sustained_mid_harmonic'});
  }
  if (midRatio>0.45 && highRatio>0.15 && zcr<0.08 && spectralCentroid>1000) {
    const sc = Math.min(0.88, midRatio*0.5+highRatio*0.3+(spectralCentroid/3000)*0.2);
    instruments.push({name:'violin', label:'Violin', confidence:+sc.toFixed(3), family:'string', role:'melody'});
    logData.detected.push({name:'violin', score:sc, reason:'high_harmonic_sustain'});
  }
  if (highRatio>0.35 && zcr>0.12 && spectralCentroid>1500 && spectralCentroid<4000) {
    const sc = Math.min(0.90, highRatio*0.6+zcr*2.0+(spectralCentroid/4000)*0.2);
    instruments.push({name:'flute', label:'Flute / Bansuri', confidence:+sc.toFixed(3), family:'wind', role:'melody'});
    logData.detected.push({name:'flute', score:sc, reason:'high_zcr_breath'});
  }
  if (midRatio>0.4 && lowRatio<0.35 && zcr>0.04 && zcr<0.15 && spectralCentroid>600 && spectralCentroid<2500) {
    const sc = Math.min(0.85, midRatio*0.6+(1-Math.abs(zcr-0.08)*10)*0.3);
    instruments.push({name:'voice', label:'Vocal', confidence:+sc.toFixed(3), family:'vocal', role:'lead'});
    logData.detected.push({name:'voice', score:sc, reason:'formant_mid_range'});
  }
  if (midRatio>0.5 && spectralCentroid>700 && spectralCentroid<1500 && spectralFlux>0.25) {
    const sc = Math.min(0.80, midRatio*0.6+spectralFlux*0.3);
    instruments.push({name:'ghatam', label:'Ghatam', confidence:+sc.toFixed(3), family:'percussion', role:'rhythm'});
    logData.detected.push({name:'ghatam', score:sc, reason:'clay_pot_resonance'});
  }
  if (midRatio>0.55 && zcr<0.04 && spectralRolloff>0.3) {
    const sc = Math.min(0.82, midRatio*0.7+spectralRolloff*0.3);
    instruments.push({name:'harmonium', label:'Harmonium', confidence:+sc.toFixed(3), family:'reed', role:'melody/drone'});
    logData.detected.push({name:'harmonium', score:sc, reason:'sustained_reed_harmonic'});
  }
  if (lowRatio>0.5 && zcr<0.02 && spectralFlux<0.1) {
    const sc = Math.min(0.90, lowRatio*0.7+(1-spectralFlux*5)*0.3);
    instruments.push({name:'tampura', label:'Tampura / Drone', confidence:+sc.toFixed(3), family:'plucked', role:'drone'});
    logData.detected.push({name:'tampura', score:sc, reason:'sustained_bass_drone'});
  }
  if (!instruments.length) {
    instruments.push({name:'mixed', label:'Mixed / Ensemble', confidence:0.5, family:'unknown', role:'unknown'});
    logData.detected.push({name:'mixed', score:0.5, reason:'no_strong_indicators'});
  }
  instruments.sort((a,b)=>b.confidence-a.confidence);
  logCycle('instrument_fusion', logData);
  return instruments;
}

function extractMetadata(filePath, audioResult, opts={}) {
  const baseName = require('path').basename(filePath||'', require('path').extname(filePath||''));
  const meta = {
    fileName: baseName, detectedAt: new Date().toISOString(), processingVersion:'3.2.1',
    audio: { duration: audioResult?.duration||0, sampleRate: audioResult?.sampleRate||22050, channels: audioResult?.channels||1 },
    analysis: { raga: audioResult?.raga||'unknown', tala: audioResult?.tala||'unknown', tempo: audioResult?.tempo||0, confidence: audioResult?.confidence||0 },
    tags: []
  };
  if (audioResult?.raga) meta.tags.push(`raga:${audioResult.raga}`);
  if (audioResult?.tala) meta.tags.push(`tala:${audioResult.tala}`);
  if (audioResult?.composer) meta.tags.push(`composer:${audioResult.composer}`);
  if ((audioResult?.instruments||[]).some(i=>i.name==='voice')) meta.tags.push('vocal');
  if ((audioResult?.instruments||[]).some(i=>i.family==='percussion')) meta.tags.push('percussion');
  logCycle('metadata_extracted', meta);
  return meta;
}

module.exports = { fuse, fuseInstruments, extractMetadata, logCycle, logFusion, SOURCE_RELIABILITY, CONFUSION_PAIRS };
