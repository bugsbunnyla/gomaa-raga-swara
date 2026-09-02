/**
 * GoMaa Raga Vidya — swaraEngine.js v4.0.2
 * Full-duration swara generation for all 6 Carnatic sections.
 */

const SWARA_MAP = {
  "s":0,"r1":1,"r2":2,"r3":3,"g1":1,"g2":2,"g3":3,
  "m1":4,"m2":5,"p":6,"d1":7,"d2":8,"d3":9,"n1":7,"n2":8,"n3":9,"s'":12
};

function parseSwaraLine(line) {
  if (!line) return [];
  return line.toLowerCase().split(/\s+/).map(s => SWARA_MAP[s]).filter(x => x !== undefined);
}

function semiToSwara(semi, arohaList) {
  // Map semitone to swara name based on aroha
  const map = {};
  arohaList.forEach((s, i) => {
    const names = Object.keys(SWARA_MAP).filter(k => SWARA_MAP[k] === s);
    if (names.length) map[s] = names[0].toUpperCase().replace("'","");
  });
  return map[semi] || "S";
}

function generatePattern(aro, ava, length, style = "straight") {
  const notes = [];
  const pool = [...aro, ...ava.slice(1, -1)];
  let idx = 0;
  let dir = 1;
  for (let i = 0; i < length; i++) {
    notes.push(pool[idx]);
    if (style === "jaaru") {
      idx += dir;
      if (idx >= pool.length - 1) { idx = pool.length - 1; dir = -1; }
      if (idx <= 0) { idx = 0; dir = 1; }
    } else if (style === "kampita") {
      notes.push(pool[idx]);
      idx = (idx + 1) % pool.length;
    } else {
      idx = (idx + 1) % pool.length;
    }
  }
  return notes;
}

function generateFullSwaras(opts) {
  const {
    raga, aroha, avaroha, tala, beatsPerCycle, bpm, duration, compositionMatch
  } = opts;

  const bpC = beatsPerCycle || 8;
  const tempo = bpm || 120;
  const secDur = duration ? duration / 6 : 60;

  const aro = parseSwaraLine(aroha);
  const ava = parseSwaraLine(avaroha);
  if (!aro.length) {
    return {
      aalapana: { swaras: "", duration: 0 },
      pallavi: { swaras: "", lyrics: "", duration: 0 },
      anupallavi: { swaras: "", lyrics: "", duration: 0 },
      charanam: { swaras: "", lyrics: "", duration: 0 },
      chittaswarams: { swaras: "", duration: 0 },
      manodharma: { swaras: "", duration: 0 },
      swaraLine: ""
    };
  }

  const lenAal = Math.max(16, Math.floor(secDur * tempo / 60));
  const lenPal = Math.max(16, Math.floor(secDur * tempo / 60));
  const lenAnu = Math.max(16, Math.floor(secDur * tempo / 60));
  const lenCha = Math.max(16, Math.floor(secDur * tempo / 60));
  const lenChi = Math.max(12, Math.floor(secDur * tempo / 120));
  const lenMan = Math.max(12, Math.floor(secDur * tempo / 120));

  const aalNotes = generatePattern(aro, ava, lenAal, "jaaru");
  const palNotes = generatePattern(aro, ava, lenPal, "straight");
  const anuNotes = generatePattern(aro, ava, lenAnu, "straight");
  const chaNotes = generatePattern(aro, ava, lenCha, "straight");
  const chiNotes = generatePattern(aro, ava, lenChi, "pratyahata");
  const manNotes = generatePattern(aro, ava, lenMan, "kampita");

  const toStr = (arr) => arr.map(s => semiToSwara(s, aro)).join(" ");

  const sahityam = compositionMatch?.sahityam || {};

  const result = {
    aalapana: {
      swaras: toStr(aalNotes),
      duration: Math.round(lenAal * 60 / tempo * 10) / 10,
      gamaka: "jaaru"
    },
    pallavi: {
      swaras: toStr(palNotes),
      lyrics: sahityam.pallavi || "",
      duration: Math.round(lenPal * 60 / tempo * 10) / 10
    },
    anupallavi: {
      swaras: toStr(anuNotes),
      lyrics: sahityam.anupallavi || "",
      duration: Math.round(lenAnu * 60 / tempo * 10) / 10
    },
    charanam: {
      swaras: toStr(chaNotes),
      lyrics: sahityam.charanam || "",
      duration: Math.round(lenCha * 60 / tempo * 10) / 10
    },
    chittaswarams: {
      swaras: toStr(chiNotes),
      duration: Math.round(lenChi * 60 / tempo * 10) / 10,
      gamaka: "pratyahata"
    },
    manodharma: {
      swaras: toStr(manNotes),
      duration: Math.round(lenMan * 60 / tempo * 10) / 10,
      gamaka: "kampita"
    },
    swaraLine: toStr([...palNotes, ...anuNotes, ...chaNotes])
  };

  console.log(`[GoMaa] Swara generation: Aalapana=${result.aalapana.duration}s, Pallavi=${result.pallavi.duration}s, Anupallavi=${result.anupallavi.duration}s, Charanam=${result.charanam.duration}s, Chitta=${result.chittaswarams.duration}s, Mano=${result.manodharma.duration}s`);
  return result;
}

module.exports = { generateFullSwaras, swaraToWestern: require("./scoreEngine").swaraToWestern };
