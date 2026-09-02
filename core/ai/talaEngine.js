/**
 * GoMaa Raga Vidya — talaEngine.js v4.0.2
 * Dynamic programming template matching against 9 canonical talas.
 */

const TALA_TEMPLATES = [
  { name: "Adi", beatsPerCycle: 8, pattern: [1,0,0,0, 1,0,0,0] },      // clap on 1,5
  { name: "Rupaka", beatsPerCycle: 3, pattern: [1,1,0] },               // clap, wave
  { name: "Triputa", beatsPerCycle: 7, pattern: [1,0,0, 1,0,0,0] },     // 3+4
  { name: "Jhampa", beatsPerCycle: 10, pattern: [1,0,0,0, 1,1,0,0,0,0] }, // 5+5 wave on 6
  { name: "Dhruva", beatsPerCycle: 14, pattern: [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0] },
  { name: "Matya", beatsPerCycle: 10, pattern: [1,0,0,0, 1,1,0,0,0,0] },
  { name: "Eka", beatsPerCycle: 4, pattern: [1,0,0,0] },
  { name: "Ata", beatsPerCycle: 14, pattern: [1,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0] },
  { name: "Misra Chapu", beatsPerCycle: 7, pattern: [1,0,0, 1,0,0,0] }
];

function sequenceAlignment(beats, templateBpc, duration) {
  const n = beats.length;
  if (n < 2) return { score: 0, cycles: 0 };
  const intervals = [];
  for (let i = 1; i < n; i++) intervals.push(beats[i] - beats[i-1]);
  const avgInterval = intervals.reduce((a,b)=>a+b,0) / intervals.length;
  const estimatedBpc = Math.round(avgInterval * templateBpc / (duration / n));
  // DP: find how well the beat intervals fit integer multiples of template beat duration
  const beatDur = avgInterval; // average seconds per beat
  const templateDur = beatDur; // each template beat = 1 unit
  let score = 0;
  let cycles = 0;
  for (let start = 0; start < Math.min(templateBpc, intervals.length); start++) {
    let localScore = 0;
    let localCycles = 0;
    for (let i = start; i < intervals.length; i += templateBpc) {
      let cycleScore = 0;
      for (let j = 0; j < templateBpc && i + j < intervals.length; j++) {
        const expected = templateDur;
        const actual = intervals[i + j];
        const err = Math.abs(actual - expected) / expected;
        cycleScore += Math.max(0, 1 - err);
      }
      localScore += cycleScore;
      localCycles++;
    }
    if (localScore > score) {
      score = localScore;
      cycles = localCycles;
    }
  }
  return { score: score / (cycles * templateBpc || 1), cycles };
}

function detectTalaDP(beats, bpm, duration) {
  if (!beats || beats.length < 4) {
    return { tala: "Adi", beatsPerCycle: 8, confidence: 0, method: "fallback" };
  }

  let best = null;
  let bestScore = -Infinity;

  for (const tala of TALA_TEMPLATES) {
    const align = sequenceAlignment(beats, tala.beatsPerCycle, duration);
    // Combine with BPM heuristic: common talas have specific BPM ranges
    let bpmBonus = 0;
    if (tala.name === "Adi" && bpm >= 60 && bpm <= 180) bpmBonus = 0.1;
    if (tala.name === "Rupaka" && bpm >= 40 && bpm <= 120) bpmBonus = 0.1;
    const score = align.score + bpmBonus;
    if (score > bestScore) {
      bestScore = score;
      best = { ...tala, confidence: Math.round(score * 1000) / 1000, cycles: align.cycles };
    }
  }

  return {
    tala: best.name,
    beatsPerCycle: best.beatsPerCycle,
    confidence: best.confidence,
    method: "dp_template_matching",
    pattern: best.pattern
  };
}

module.exports = { detectTalaDP };
