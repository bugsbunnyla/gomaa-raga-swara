function generateSegmentSwaras(audioDuration, composition, raga, pitchData) {
  const segments = [];
  const structure = composition.structure || {
    aalapana: 0.15, pallavi: 0.15, anupallavi: 0.15,
    charanam1: 0.15, charanam2: 0.15, charanam3: 0.15,
    chittaswaram: 0.05, manodharma: 0.05
  };
  let cumulative = 0;
  const boundaries = {};
  const totalRatio = Object.values(structure).reduce((a, b) => a + b, 0);

  for (const [section, ratio] of Object.entries(structure)) {
    const duration = (ratio / totalRatio) * audioDuration;
    boundaries[section] = { start: cumulative, end: cumulative + duration };
    cumulative += duration;
  }

  for (const [section, bounds] of Object.entries(boundaries)) {
    const hint = composition.swara_hints?.[section]
              || composition.swara_hints?.['default']
              || raga.arohana?.join(' ')
              || '';

    const sliceStart = Math.floor((bounds.start / audioDuration) * pitchData.length);
    const sliceEnd = Math.floor((bounds.end / audioDuration) * pitchData.length);
    const slicePitches = pitchData.slice(sliceStart, sliceEnd).filter(p => p > 0);
    const quantized = quantizeToRaga(slicePitches, raga.frequency_map || {});

    segments.push({
      name: section,
      startTime: bounds.start,
      endTime: bounds.end,
      swaras: hint,
      quantized: quantized,
      sahityam: composition.sahityam?.[section] || ''
    });
  }

  return segments;
}

function quantizeToRaga(pitches, freqMap) {
  if (!freqMap || Object.keys(freqMap).length === 0) {
    return pitches.map(p => ({ note: '?', freq: p, detected: p }));
  }
  const notes = Object.entries(freqMap);
  return pitches.map(p => {
    let closest = notes[0];
    let minDiff = Infinity;
    for (const [note, freq] of notes) {
      for (let oct = -2; oct <= 2; oct++) {
        const f = freq * Math.pow(2, oct);
        const diff = Math.abs(p - f);
        if (diff < minDiff) {
          minDiff = diff;
          closest = [note, f];
        }
      }
    }
    if (minDiff / closest[1] < 0.05) {
      return { note: closest[0], freq: closest[1], detected: p };
    }
    return { note: '?', freq: p, detected: p };
  });
}

module.exports = { generateSegmentSwaras, quantizeToRaga };
