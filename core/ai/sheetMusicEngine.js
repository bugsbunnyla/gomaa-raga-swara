"use strict";
/**
 * GoMaa Raga Vidya v3.2 — Sheet Music Engine
 * FIXED: Signature now matches recognize.js calls
 *   generateSheetMusicXml(beatSwaras, talaObj, raga)  ← OLD broken call
 *   generateSheetMusicXml(ragaInfo, compOpts)          ← module export signature
 * 
 * SOLUTION: Unified signature that handles BOTH call patterns via duck-typing.
 * Also adds proper tala-aware measure generation and Carnatic notation.
 */

const SWARA_SEMI = {
  'S': 0, 'R1': 1, 'R2': 2, 'R3': 3,
  'G1': 2, 'G2': 3, 'G3': 4,
  'M1': 5, 'M2': 6,
  'P': 7,
  'D1': 8, 'D2': 9, 'D3': 10,
  'N1': 10, 'N2': 11, 'N3': 11, 'S.': 12
};

const SWARA_DISPLAY = {
  'S': 'Sa', 'R1': 'Ri₁', 'R2': 'Ri₂', 'R3': 'Ri₃',
  'G1': 'Ga₁', 'G2': 'Ga₂', 'G3': 'Ga₃',
  'M1': 'Ma₁', 'M2': 'Ma₂',
  'P': 'Pa',
  'D1': 'Dha₁', 'D2': 'Dha₂', 'D3': 'Dha₃',
  'N1': 'Ni₁', 'N2': 'Ni₂', 'N3': 'Ni₃',
  'S.': "Sa'"
};

const NOTE_STEPS = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
const NOTE_ALTER = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const MIDI_PROG = {
  veena: 24, sitar: 104, flute: 73, violin: 40, mridangam: 117,
  tabla: 115, ghatam: 113, harmonium: 20, sarangi: 110,
  saxophone: 65, piano: 0, guitar: 25, bass: 32, trumpet: 56,
  kanjira: 112, drone: 23, tampura: 23, keyboard: 3, voice: 52
};

// ── Helper functions ────────────────────────────────────────────────
function _swaraToMidi(sw, octave) {
  const semi = SWARA_SEMI[sw.trim()];
  if (semi === undefined) return 60;
  return 60 + (octave - 4) * 12 + semi;
}

function _midiToXmlNote(midi) {
  const semi = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return { step: NOTE_STEPS[semi], alter: NOTE_ALTER[semi], octave: oct };
}

function _parseSwaras(str) {
  return (str || '').split(/\s+/).filter(Boolean);
}

function _xmlEsc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _noteXml(sw, octave, duration, lyric, swaraName) {
  octave = octave || 4;
  duration = duration || 4;
  const midi = _swaraToMidi(sw, octave);
  const { step, alter, octave: oct } = _midiToXmlNote(midi);
  const alterXml = alter ? `<alter>${alter}</alter>` : '';
  const lyricXml = lyric ? `<lyric number="1"><syllabic>single</syllabic><text>${_xmlEsc(lyric)}</text></lyric>` : '';
  const lyricSwara = swaraName ? `<lyric number="2"><syllabic>single</syllabic><text>${_xmlEsc(swaraName)}</text></lyric>` : '';
  return `<note><pitch><step>${step}</step>${alterXml}<octave>${oct}</octave></pitch><duration>${duration}</duration><type>quarter</type>${lyricXml}${lyricSwara}</note>`;
}

function _buildMeasure(num, swaras, lyrics, header, beatsPerMeasure = 4) {
  lyrics = lyrics || [];
  const direction = header ? `<direction placement="above"><direction-type><words font-size="9">${_xmlEsc(header)}</words></direction-type></direction>` : '';
  const notes = swaras.slice(0, beatsPerMeasure).map((sw, i) => _noteXml(sw, 4, 4, lyrics[i] || '', SWARA_DISPLAY[sw] || sw)).join('');
  const attrib = num === 1 ? `<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>${beatsPerMeasure}</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>` : '';
  return `<measure number="${num}">${attrib}${direction}${notes}</measure>`;
}

// ── Tala-aware measure builder ─────────────────────────────────────
function _buildTalaMeasures(swaras, talaObj, sectionName, lyrics) {
  const beats = talaObj?.beats || 8;
  const sections = talaObj?.sections || [4, 2, 2];
  const measures = [];
  let mn = 1;
  let swIdx = 0;
  const lyrWords = (lyrics || '').split(/[\s|]+/).filter(Boolean);
  let lyrIdx = 0;

  while (swIdx < swaras.length) {
    for (let si = 0; si < sections.length && swIdx < swaras.length; si++) {
      const secLen = sections[si];
      const secSwaras = swaras.slice(swIdx, swIdx + secLen);
      const secLyrics = lyrWords.slice(lyrIdx, lyrIdx + secLen);
      const header = mn === 1 ? `${sectionName} — ${talaObj.name || 'Adi'}` : '';
      measures.push(_buildMeasure(mn++, secSwaras, secLyrics, header, secLen));
      swIdx += secLen;
      lyrIdx += secLen;
    }
  }
  return measures;
}

// ── Unified generateSheetMusicXml ──────────────────────────────────
// Handles BOTH call patterns:
//   Pattern A: generateSheetMusicXml(beatSwaras, talaObj, raga)  [from recognize.js]
//   Pattern B: generateSheetMusicXml(ragaInfo, compOpts)        [from compose.js]
function generateSheetMusicXml(arg1, arg2, arg3) {
  let ragaInfo, compOpts;

  // Duck-type detection: if arg1 is array → Pattern A (beatSwaras)
  if (Array.isArray(arg1)) {
    const beatSwaras = arg1;
    const talaObj = arg2 || {};
    const raga = arg3 || {};
    ragaInfo = {
      label: raga.label || 'Unknown Raga',
      ragaNumber: raga.ragaNumber || 0,
      aroha: raga.aroha || 'S R G M P D N S',
      avaroha: raga.avaroha || 'S N D P M G R S',
      mood: raga.mood || 'meditative',
      gamakas: raga.gamakas || ['kampita'],
      meta_tala: talaObj
    };
    compOpts = {
      title: raga.label ? `${raga.label} — Carnatic Analysis` : 'Carnatic Composition',
      tala: talaObj.name || 'Adi',
      beatSwaras: beatSwaras,
      talaObj: talaObj
    };
  } else {
    // Pattern B
    ragaInfo = arg1 || {};
    compOpts = arg2 || {};
  }

  const title = compOpts.title || (ragaInfo.label ? `${ragaInfo.label} — GoMaa Raga Vidya` : 'GoMaa Raga Vidya');
  const tala = compOpts.tala || (ragaInfo.meta_tala && ragaInfo.meta_tala.name) || 'Adi';
  const talaObj = compOpts.talaObj || ragaInfo.meta_tala || { name: 'Adi', beats: 8, sections: [4, 2, 2] };

  const aroha = _parseSwaras(ragaInfo.aroha || 'S R G M P D N S');
  const avaroha = _parseSwaras(ragaInfo.avaroha || 'S N D P M G R S');

  // Build measures
  const measures = [];
  let mn = 1;

  // Arohanam
  measures.push(..._buildTalaMeasures(aroha, talaObj, 'Arohanam', aroha.map(s => SWARA_DISPLAY[s] || s)));
  // Avarohanam
  measures.push(..._buildTalaMeasures(avaroha, talaObj, 'Avarohanam', avaroha.map(s => SWARA_DISPLAY[s] || s)));

  // If beatSwaras provided, build section measures
  if (compOpts.beatSwaras && compOpts.beatSwaras.length > 0) {
    const bsw = compOpts.beatSwaras.map(b => b.swara || b).filter(s => s && s !== '.');
    // Pallavi = first 1/3
    const pLen = Math.floor(bsw.length / 3);
    const aLen = Math.floor(bsw.length / 3);
    const pallaviSw = bsw.slice(0, pLen);
    const anupallaviSw = bsw.slice(pLen, pLen + aLen);
    const charanamSw = bsw.slice(pLen + aLen);

    measures.push(..._buildTalaMeasures(pallaviSw, talaObj, 'Pallavi', []));
    measures.push(..._buildTalaMeasures(anupallaviSw, talaObj, 'Anupallavi', []));
    measures.push(..._buildTalaMeasures(charanamSw, talaObj, 'Charanam', []));
  } else if (compOpts.sections) {
    // From compose.js sections
    const sec = compOpts.sections;
    const swP = _parseSwaras(sec.pallavi || ragaInfo.aroha || 'S R G M P D N S');
    const swAp = _parseSwaras(sec.anupallavi || ragaInfo.avaroha || 'S N D P M G R S');
    const swCh = _parseSwaras(sec.charanam || ragaInfo.aroha || 'S R G M P D N S');

    measures.push(..._buildTalaMeasures(swP, talaObj, 'Pallavi', (sec.pallavi || '').split(/[\s|]+/).filter(Boolean)));
    measures.push(..._buildTalaMeasures(swAp, talaObj, 'Anupallavi', (sec.anupallavi || '').split(/[\s|]+/).filter(Boolean)));
    measures.push(..._buildTalaMeasures(swCh, talaObj, 'Charanam', (sec.charanam || '').split(/[\s|]+/).filter(Boolean)));
  }

  const measuresXml = measures.join('');

  // Build MusicXML document
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN"
  "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>${_xmlEsc(title)}</work-title></work>
  <identification>
    <creator type="composer">GoMaa Raga Vidya AI v3.2</creator>
    <encoding>
      <software>GoMaa Raga Vidya v3.2</software>
      <encoding-date>${new Date().toISOString().slice(0, 10)}</encoding-date>
    </encoding>
    <miscellaneous>
      <miscellaneous-field name="raga">${_xmlEsc(ragaInfo.label || '')}</miscellaneous-field>
      <miscellaneous-field name="melakarta">${ragaInfo.ragaNumber || ''}</miscellaneous-field>
      <miscellaneous-field name="arohanam">${_xmlEsc(ragaInfo.aroha || '')}</miscellaneous-field>
      <miscellaneous-field name="avarohanam">${_xmlEsc(ragaInfo.avaroha || '')}</miscellaneous-field>
      <miscellaneous-field name="tala">${_xmlEsc(tala)}</miscellaneous-field>
      <miscellaneous-field name="mood">${_xmlEsc(ragaInfo.mood || '')}</miscellaneous-field>
      <miscellaneous-field name="gamakas">${_xmlEsc((ragaInfo.gamakas || []).join(', '))}</miscellaneous-field>
    </miscellaneous>
  </identification>
  <part-list>
    <score-part id="P1">
      <part-name>Melody</part-name>
      <midi-instrument id="P1-I1">
        <midi-channel>1</midi-channel>
        <midi-program>25</midi-program>
      </midi-instrument>
    </score-part>
  </part-list>
  <part id="P1">${measuresXml}</part>
</score-partwise>`;
}

// ── MIDI Generator ─────────────────────────────────────────────────
function generateMidi(arg1, arg2, arg3) {
  let ragaInfo, compOpts;

  if (Array.isArray(arg1)) {
    const beatSwaras = arg1;
    const talaObj = arg2 || {};
    const raga = arg3 || {};
    ragaInfo = {
      label: raga.label || 'Unknown',
      aroha: raga.aroha || 'S R G M P D N S',
      avaroha: raga.avaroha || 'S N D P M G R S'
    };
    compOpts = {
      tempo: 80,
      instruments: ['veena', 'mridangam'],
      beatSwaras: beatSwaras,
      talaObj: talaObj
    };
  } else {
    ragaInfo = arg1 || {};
    compOpts = arg2 || {};
  }

  const tempo = Math.round(60000000 / (compOpts.tempo || 80));
  const tpb = 480;
  const instruments = compOpts.instruments || ['veena', 'mridangam'];
  const aroha = _parseSwaras(ragaInfo.aroha || 'S R G M P D N S');
  const avaroha = _parseSwaras(ragaInfo.avaroha || 'S N D P M G R S');

  // Build swara sequence
  let allSwaras = [];
  if (compOpts.beatSwaras && compOpts.beatSwaras.length > 0) {
    allSwaras = compOpts.beatSwaras.map(b => b.swara || b).filter(s => s && s !== '.');
  } else {
    const demo = compOpts.sections || {};
    allSwaras = [
      ...aroha, ...avaroha,
      ..._parseSwaras(demo.pallavi || ''),
      ..._parseSwaras(demo.anupallavi || ''),
      ..._parseSwaras(demo.charanam || '')
    ];
  }
  if (allSwaras.length === 0) allSwaras = [...aroha, ...avaroha];

  // MIDI helpers
  function u32(n) { return [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]; }
  function u16(n) { return [(n >> 8) & 0xff, n & 0xff]; }
  function varLen(n) {
    if (n < 128) return [n];
    const b = [];
    let v = n;
    while (v > 0) { b.unshift(v & 0x7f); v >>= 7; }
    for (let i = 0; i < b.length - 1; i++) b[i] |= 0x80;
    return b;
  }
  function mkTrack(ev) { return [0x4d, 0x54, 0x72, 0x6b, ...u32(ev.length), ...ev]; }

  // Tempo track
  const t0 = [
    0x00, 0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff,
    0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
    0x00, 0xff, 0x2f, 0x00
  ];

  // Melody track
  const melProg = MIDI_PROG[instruments[0]] != null ? MIDI_PROG[instruments[0]] : 24;
  const t1 = [];
  t1.push(0x00, 0xc0, melProg & 0x7f);
  allSwaras.forEach(sw => {
    const m = _swaraToMidi(sw, 4);
    t1.push(...varLen(0), 0x90, m & 0x7f, 80, ...varLen(tpb), 0x80, m & 0x7f, 0);
  });
  t1.push(0x00, 0xff, 0x2f, 0x00);

  // Drone track (tampura)
  const t2 = [];
  t2.push(0x00, 0xc1, 23);
  for (let i = 0; i < Math.ceil(allSwaras.length / 2); i++) {
    const d = tpb * 4;
    t2.push(...varLen(0), 0x91, 60, 50, ...varLen(0), 0x91, 67, 45, ...varLen(d), 0x81, 60, 0, ...varLen(0), 0x81, 67, 0);
  }
  t2.push(0x00, 0xff, 0x2f, 0x00);

  // Percussion track
  const t3 = [];
  t3.push(0x00, 0xc9, 117 & 0x7f);
  const PAT = [38, 36, 42, 38, 36, 42, 38, 36];
  for (let b = 0; b < Math.ceil(allSwaras.length / 8); b++) {
    PAT.forEach(n => {
      t3.push(...varLen(0), 0x99, n, 70, ...varLen(tpb / 2), 0x89, n, 0);
    });
  }
  t3.push(0x00, 0xff, 0x2f, 0x00);

  const tracks = [
    mkTrack(t0),
    mkTrack(t1),
    mkTrack(t2),
    ...(instruments.some(i => ['mridangam', 'tabla', 'kanjira'].includes(i)) ? [mkTrack(t3)] : [])
  ];

  const hdr = [0x4d, 0x54, 0x68, 0x64, ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(tpb)];
  return Buffer.from([...hdr, ...tracks.flat()]).toString('base64');
}

module.exports = {
  generateSheetMusicXml,
  generateMidi,
  SWARA_DISPLAY,
  SWARA_SEMI,
  MIDI_PROG
};
