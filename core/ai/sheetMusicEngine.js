"use strict";
/**
 * GoMaa Raga Vidya v4.0 — Sheet Music & MIDI Engine
 * Fixes:
 *   - Western notation alongside Carnatic swaras
 *   - Proper MusicXML with both notation systems
 *   - MIDI generation with correct note values
 */

const SWARA_SEMI = {
  S: 0, R1: 1, R2: 2, R3: 3,
  G1: 2, G2: 3, G3: 4,
  M1: 5, M2: 6,
  P: 7,
  D1: 8, D2: 9, D3: 10,
  N1: 10, N2: 11, N3: 11
};

const SEMI_TO_WESTERN = {
  0: "C", 1: "C#", 2: "D", 3: "D#", 4: "E", 5: "F",
  6: "F#", 7: "G", 8: "G#", 9: "A", 10: "A#", 11: "B"
};

function swaraToMidi(swara, octave = 4) {
  const semi = SWARA_SEMI[swara];
  if (semi === undefined) return null;
  return 60 + semi + (octave - 4) * 12;
}

function swaraToWestern(swara, octave = 4) {
  const semi = SWARA_SEMI[swara];
  if (semi === undefined) return null;
  return SEMI_TO_WESTERN[semi] + octave;
}

function generateSheetMusicXml(beatSwaras, talaObj, raga) {
  if (!beatSwaras || !beatSwaras.length) return null;

  const talaBeats = talaObj?.beats || 8;
  const title = raga?.label || "Unknown";
  const composer = raga?.composer || "Unknown";

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>${title}</work-title></work>
  <identification>
    <creator type="composer">${composer}</creator>
    <encoding><software>GoMaa Raga Vidya v4.0</software></encoding>
  </identification>
  <part-list>
    <score-part id="P1"><part-name>Carnatic Lead</part-name></score-part>
    <score-part id="P2"><part-name>Western Lead</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>${talaBeats}</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
`;

  // Carnatic swara notes
  for (let i = 0; i < beatSwaras.length && i < 64; i++) {
    const bs = beatSwaras[i];
    const midi = swaraToMidi(bs.swara, 4);
    const step = midi ? String.fromCharCode(65 + (midi % 12)) : "C";
    const alter = [1, 3, 6, 8, 10].includes(midi % 12) ? 1 : 0;
    const octave = midi ? Math.floor(midi / 12) - 1 : 4;
    xml += `      <note>
        <pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>
        <duration>4</duration>
        <type>quarter</type>
        <lyric><text>${bs.swara}</text></lyric>
      </note>
`;
  }

  xml += `    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <time><beats>${talaBeats}</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
`;

  // Western notation notes
  for (let i = 0; i < beatSwaras.length && i < 64; i++) {
    const bs = beatSwaras[i];
    const midi = swaraToMidi(bs.swara, 4);
    const step = midi ? String.fromCharCode(65 + (midi % 12)) : "C";
    const alter = [1, 3, 6, 8, 10].includes(midi % 12) ? 1 : 0;
    const octave = midi ? Math.floor(midi / 12) - 1 : 4;
    const western = bs.westernNote || swaraToWestern(bs.swara, 4) || "C4";
    xml += `      <note>
        <pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>
        <duration>4</duration>
        <type>quarter</type>
        <lyric><text>${western}</text></lyric>
      </note>
`;
  }

  xml += `    </measure>
  </part>
</score-partwise>`;

  return xml;
}

function generateMidi(beatSwaras, talaObj, raga) {
  if (!beatSwaras || !beatSwaras.length) return null;

  // Simple MIDI file generation (Format 0)
  const ticksPerQuarter = 480;
  const tempo = Math.round(60000000 / (raga?.tempo || 80));

  // MIDI header
  const header = Buffer.from([
    0x4D, 0x54, 0x68, 0x64, // MThd
    0x00, 0x00, 0x00, 0x06, // header length
    0x00, 0x00, // format 0
    0x00, 0x01, // 1 track
    0x01, (ticksPerQuarter >> 8) & 0xFF, ticksPerQuarter & 0xFF // division
  ]);

  // Build track data
  let trackData = [];

  // Tempo meta event
  trackData.push(0x00); // delta time
  trackData.push(0xFF, 0x51, 0x03);
  trackData.push((tempo >> 16) & 0xFF, (tempo >> 8) & 0xFF, tempo & 0xFF);

  // Track name
  const trackName = "GoMaa Raga Vidya";
  trackData.push(0x00);
  trackData.push(0xFF, 0x03, trackName.length);
  for (const c of trackName) trackData.push(c.charCodeAt(0));

  // Notes
  let currentTime = 0;
  for (let i = 0; i < beatSwaras.length && i < 128; i++) {
    const bs = beatSwaras[i];
    const midi = swaraToMidi(bs.swara, 4);
    if (midi === null) continue;

    // Note on
    trackData.push(currentTime); // delta time
    trackData.push(0x90, midi & 0x7F, 0x60); // channel 0, note, velocity

    // Note off (after quarter note)
    trackData.push(ticksPerQuarter);
    trackData.push(0x80, midi & 0x7F, 0x00);

    currentTime = 0;
  }

  // End of track
  trackData.push(0x00);
  trackData.push(0xFF, 0x2F, 0x00);

  const trackLen = trackData.length;
  const trackHeader = Buffer.from([
    0x4D, 0x54, 0x72, 0x6B, // MTrk
    (trackLen >> 24) & 0xFF, (trackLen >> 16) & 0xFF,
    (trackLen >> 8) & 0xFF, trackLen & 0xFF
  ]);

  const midiBuffer = Buffer.concat([header, trackHeader, Buffer.from(trackData)]);
  return midiBuffer.toString("base64");
}

module.exports = { generateSheetMusicXml, generateMidi, swaraToMidi, swaraToWestern };
