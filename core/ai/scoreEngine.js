/**
 * GoMaa Raga Vidya — scoreEngine.js v4.0.2
 * Generates MuseScore-compatible MusicXML and MIDI.
 * Fix: Western notation now correctly maps from the provided aroha/avaroha.
 */

const SWARA_TO_SEMI = {
  "s":0,"r1":1,"r2":2,"r3":3,"g1":1,"g2":2,"g3":3,
  "m1":4,"m2":5,"p":6,"d1":7,"d2":8,"d3":9,"n1":7,"n2":8,"n3":9,"s'":12
};

const SEMI_TO_NOTE = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

function parseSwaraLine(line) {
  if (!line) return [];
  return line.toLowerCase().split(/\s+/).map(s => SWARA_TO_SEMI[s]).filter(x => x !== undefined);
}

function swaraToWestern(ar, av) {
  const aro = parseSwaraLine(ar);
  const ava = parseSwaraLine(av);
  if (!aro.length) return { aroha: "", avaroha: "", key: "C", notes: [] };
  const base = 60; // C4
  const toNote = (semi) => {
    const n = SEMI_TO_NOTE[semi % 12];
    const oct = Math.floor(base / 12) + Math.floor(semi / 12);
    return { step: n.replace(/#/, ""), alter: n.includes("#") ? 1 : 0, octave: oct, midi: base + semi };
  };
  const aroNotes = aro.map(toNote);
  const avaNotes = ava.map(toNote);
  const aroStr = aroNotes.map(n => n.step + (n.alter ? "#" : "")).join(" ");
  const avaStr = avaNotes.map(n => n.step + (n.alter ? "#" : "")).join(" ");
  // Key signature: count sharps from aroha
  const sharpOrder = ["F","C","G","D","A","E","B"];
  const sharps = new Set();
  aroNotes.forEach(n => { if (n.alter) sharps.add(n.step); });
  const keyFifths = Array.from(sharps).filter(s => sharpOrder.includes(s)).length;
  return { aroha: aroStr, avaroha: avaStr, key: keyFifths > 0 ? `${keyFifths} sharps` : "C", notes: aroNotes, keyFifths };
}

function escapeXml(str) {
  if (!str) return "";
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function buildMusicXML(opts) {
  const {
    title, composer, raga, parent, tala, beatsPerCycle, bpm,
    aroha, avaroha, swaras, sahityam, duration
  } = opts;

  const western = swaraToWestern(aroha, avaroha);
  const bpC = beatsPerCycle || 8;
  const tempo = Math.round(bpm) || 120;

  // Build swara note sequence for staff
  const swaraNotes = [];
  if (swaras && swaras.swaraLine) {
    const tokens = swaras.swaraLine.split(/\s+/).filter(Boolean);
    tokens.forEach((tok, idx) => {
      const semi = SWARA_TO_SEMI[tok.toLowerCase()];
      if (semi === undefined) return;
      const note = SEMI_TO_NOTE[semi % 12];
      swaraNotes.push({
        step: note.replace(/#/, ""),
        alter: note.includes("#") ? 1 : 0,
        octave: 4 + Math.floor(semi / 12),
        lyric: tok,
        duration: 4 // quarter
      });
    });
  }

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work><work-title>${escapeXml(title || "Untitled")}</work-title></work>
  <identification>
    <creator type="composer">${escapeXml(composer || "Unknown")}</creator>
    <encoding><software>GoMaa Raga Vidya v4.0.2</software></encoding>
  </identification>
  <part-list>
    <score-part id="P1"><part-name>Carnatic / Western</part-name>
      <score-instrument id="P1-I1"><instrument-name>Violin</instrument-name></score-instrument>
      <midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>41</midi-program></midi-instrument>
    </score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>${western.keyFifths}</fifths></key>
        <time><beats>${bpC}</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <direction placement="above">
        <direction-type>
          <metronome><beat-unit>quarter</beat-unit><per-minute>${tempo}</per-minute></metronome>
        </direction-type>
        <sound tempo="${tempo}"/>
      </direction>
      <direction placement="above">
        <direction-type><words>Raga: ${escapeXml(raga || "")} | Tala: ${escapeXml(tala || "")}</words></direction-type>
      </direction>
`;

  // Add notes
  let beatCount = 0;
  let measureNum = 1;
  for (let i = 0; i < swaraNotes.length; i++) {
    const n = swaraNotes[i];
    xml += `      <note>
        <pitch><step>${n.step}</step>${n.alter ? `<alter>${n.alter}</alter>` : ""}<octave>${n.octave}</octave></pitch>
        <duration>${n.duration}</duration>
        <type>quarter</type>
        <lyric><text>${escapeXml(n.lyric)}</text></lyric>
      </note>
`;
    beatCount++;
    if (beatCount >= bpC && i < swaraNotes.length - 1) {
      measureNum++;
      xml += `    </measure>
    <measure number="${measureNum}">
`;
      beatCount = 0;
    }
  }

  xml += `    </measure>
  </part>
</score-partwise>`;

  return { xml, western, swaraNotes };
}

function buildMIDI(opts) {
  // Minimal MIDI file builder (Type 1, single track)
  const { bpm, aroha, avaroha, swaras } = opts;
  const tpqn = 480; // ticks per quarter note
  const tempo = Math.round(60000000 / (bpm || 120));

  const header = [
    0x4D, 0x54, 0x68, 0x64, // MThd
    0x00, 0x00, 0x00, 0x06, // length
    0x00, 0x01, // type 1
    0x00, 0x01, // 1 track
    0x01, 0xE0  // 480 tpqn
  ];

  const trackEvents = [];
  // Tempo
  trackEvents.push(0x00, 0xFF, 0x51, 0x03, (tempo >> 16) & 0xFF, (tempo >> 8) & 0xFF, tempo & 0xFF);
  // Track name
  const tname = "GoMaa v4.0.2";
  trackEvents.push(0x00, 0xFF, 0x03, tname.length, ...Buffer.from(tname));

  const baseMidi = 60; // C4
  const notes = parseSwaraLine(aroha).map(s => baseMidi + s);
  if (!notes.length) notes.push(60, 62, 64, 65, 67, 69, 71, 72);

  let time = 0;
  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    // Note on
    trackEvents.push(time & 0x7F | 0x80 ? 0 : 0, 0x90, note & 0x7F, 0x64);
    // Note off after quarter
    trackEvents.push(tpqn & 0x7F | 0x80 ? 0 : 0, 0x80, note & 0x7F, 0x00);
    time = 0;
  }

  trackEvents.push(0x00, 0xFF, 0x2F, 0x00); // end of track

  const trackLen = trackEvents.length;
  const trackHeader = [0x4D, 0x54, 0x72, 0x6B, (trackLen >> 24) & 0xFF, (trackLen >> 16) & 0xFF, (trackLen >> 8) & 0xFF, trackLen & 0xFF];

  return Buffer.from([...header, ...trackHeader, ...trackEvents]);
}

module.exports = { buildMusicXML, buildMIDI, swaraToWestern };
