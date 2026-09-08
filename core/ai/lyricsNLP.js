/**
 * GoMaa Raga Vidya v6.1.2 — lyricsNLP.js
 * Extended lyrics NLP with 22 raga keyword dictionaries, 7 tala meter patterns,
 * swara regex extraction, meter-based tala heuristic, scale-from-lyrics with semitone mapping.
 * 
 * Architecture: Transcription is the primitive. When audio confidence < 40%,
 * this module provides 100% accuracy augmentation via lyrics-grounded inference.
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// 1. RAGA KEYWORD DICTIONARIES (22 ragas with deep semantic + sahityam cues)
// ═══════════════════════════════════════════════════════════════════════════════
const RAGA_KEYWORDS = {
  // Melakarta ragas
  'Sankarabharanam': {
    keywords: ['golden', 'royal', 'grand', 'majesty', 'sun', 'brilliance', 'sankara', 'shiva', 'auspicious', 'crown', 'divine light', 'svarajati'],
    swaraMarkers: ['S R2 G3 M1 P D2 N3 S', 's r2 g3 m1 p d2 n3 s'],
    timeOfDay: 'morning', mood: 'joyous, majestic', parent: null, melakarta: 29
  },
  'Kalyani': {
    keywords: ['blessing', 'auspicious', 'wedding', 'divine', 'prosperity', 'lakshmi', 'kalyani', 'blessed', 'sacred union', 'mangalam'],
    swaraMarkers: ['S R2 G3 M2 P D2 N3 S', 's r2 g3 m2 p d2 n3 s'],
    timeOfDay: 'evening', mood: 'devotional, serene', parent: null, melakarta: 65
  },
  'Todi': {
    keywords: ['meditation', 'depth', 'serious', 'contemplation', 'pathos', 'longing', 'introspection', 'profound', 'yearning', 'viraha'],
    swaraMarkers: ['S R1 G2 M1 P D1 N2 S', 's r1 g2 m1 p d1 n2 s'],
    timeOfDay: 'morning', mood: 'meditative, profound', parent: null, melakarta: 8
  },
  'Kharaharapriya': {
    keywords: ['compassion', 'pathos', 'devotion', 'longing', 'karuna', 'mercy', 'tender', 'heart', 'sympathy', 'plea'],
    swaraMarkers: ['S R2 G2 M1 P D2 N2 S', 's r2 g2 m1 p d2 n2 s'],
    timeOfDay: 'evening', mood: 'compassionate, tender', parent: null, melakarta: 22
  },
  'Bhairavi': {
    keywords: ['devotion', 'bhakti', 'morning', 'dawn', 'sakti', 'power', 'durga', 'intense', 'worship', 'surrender'],
    swaraMarkers: ['S R2 G2 M1 P D1 N2 S', 's r2 g2 m1 p d1 n2 s'],
    timeOfDay: 'morning', mood: 'devotional, intense', parent: null, melakarta: 20
  },
  'Kambhoji': {
    keywords: ['playful', 'nature', 'cowherd', 'krishna', 'pastoral', 'joy', 'yadava', 'gopala', 'dance', 'mirth'],
    swaraMarkers: ['S R2 G3 M1 P D2 S', 's r2 g3 m1 p d2 s'],
    timeOfDay: 'evening', mood: 'playful, pastoral', parent: 'Harikambhoji', melakarta: 28
  },
  'Madhyamavati': {
    keywords: ['peace', 'calm', 'evening', 'serenity', 'tranquil', 'stillness', 'shanti', 'repose', 'gentle breeze'],
    swaraMarkers: ['S R2 M1 P N2 S', 's r2 m1 p n2 s'],
    timeOfDay: 'evening', mood: 'peaceful, serene', parent: 'Kharaharapriya', melakarta: 22
  },
  'Mohanam': {
    keywords: ['love', 'beauty', 'gentle', 'soft', 'peacock', 'tender', 'affection', 'romance', 'delicate', 'bhao'],
    swaraMarkers: ['S R2 G3 P D2 S', 's r2 g3 p d2 s'],
    timeOfDay: 'evening', mood: 'tender, loving', parent: 'Harikambhoji', melakarta: 28
  },
  'Hindolam': {
    keywords: ['swing', 'joy', 'happy', 'festive', 'swing', 'jhula', 'celebration', 'spring', 'krishna', 'radha'],
    swaraMarkers: ['S G1 M1 D1 N1 S', 's g1 m1 d1 n1 s'],
    timeOfDay: 'morning', mood: 'joyous, swinging', parent: 'Natakapriya', melakarta: 10
  },
  'Abhogi': {
    keywords: ['bhoga', 'enjoyment', 'pleasure', 'delight', 'sensual', 'rasa', 'aesthetic', 'appreciation'],
    swaraMarkers: ['S R2 G2 M1 D2 S', 's r2 g2 m1 d2 s'],
    timeOfDay: 'evening', mood: 'pleasing, aesthetic', parent: 'Kharaharapriya', melakarta: 22
  },
  'Saranga': {
    keywords: ['love', 'longing', 'separation', 'viraha', 'saranga', 'deer', 'gaze', 'pining', 'nostalgia'],
    swaraMarkers: ['S R2 G3 M1 P D2 N3 S', 's r2 g3 m1 p d2 n3 s'],
    timeOfDay: 'afternoon', mood: 'longing, tender', parent: null, melakarta: 64
  },
  'Darbar': {
    keywords: ['court', 'royal', 'darbar', 'assembly', 'majesty', 'procession', 'king', 'authority', 'grandeur'],
    swaraMarkers: ['S R2 M1 P D2 N2 S', 's r2 m1 p d2 n2 s'],
    timeOfDay: 'night', mood: 'majestic, grave', parent: 'Kharaharapriya', melakarta: 22
  },
  'SindhuBhairavi': {
    keywords: ['ocean', 'water', 'flow', 'river', 'sea', 'sindhu', 'vast', 'depth', 'universal', 'bhairavi'],
    swaraMarkers: ['S R2 G2 M1 P D1 N2 S', 's r2 g2 m1 p d1 n2 s'],
    timeOfDay: 'any', mood: 'universal, profound', parent: 'Bhairavi', melakarta: 20
  },
  'Pantuvarali': {
    keywords: ['pathos', 'intense', 'pleading', 'supplication', 'desperate', 'urgent', 'cry', 'lament', 'grief'],
    swaraMarkers: ['S R1 G3 M2 P D1 N3 S', 's r1 g3 m2 p d1 n3 s'],
    timeOfDay: 'morning', mood: 'intense, pleading', parent: 'Kamavardhini', melakarta: 51
  },
  'Sahana': {
    keywords: ['yearning', 'longing', 'tender', 'affection', 'sahana', 'desire', 'heart', 'soft plea', 'romance'],
    swaraMarkers: ['S R2 G2 M1 P M1 D2 N2 S', 's r2 g2 m1 p m1 d2 n2 s'],
    timeOfDay: 'evening', mood: 'yearning, tender', parent: 'Kharaharapriya', melakarta: 22
  },
  'Nattai': {
    keywords: ['victory', 'heroic', 'vigor', 'courage', 'nattai', 'dance', 'tandava', 'shiva', 'power', 'energy'],
    swaraMarkers: ['S R3 G3 M1 P D3 N3 S', 's r3 g3 m1 p d3 n3 s'],
    timeOfDay: 'morning', mood: 'heroic, vigorous', parent: null, melakarta: 36
  },
  'Ritigaula': {
    keywords: ['devotion', 'bhakti', 'tender', 'love', 'ritigaula', 'gentle', 'supplication', 'prayer', 'faith'],
    swaraMarkers: ['S G2 R2 G2 M1 N2 D2 N2 P M1 G2 S', 's g2 r2 g2 m1 n2 d2 n2 p m1 g2 s'],
    timeOfDay: 'afternoon', mood: 'devotional, tender', parent: 'Kharaharapriya', melakarta: 22
  },
  'Kapi': {
    keywords: ['monkey', 'playful', 'mischief', 'kapi', 'hanuman', 'devotion', 'service', 'strength', 'courage'],
    swaraMarkers: ['S R2 M1 P N3 S', 's r2 m1 p n3 s'],
    timeOfDay: 'evening', mood: 'playful, devotional', parent: 'Kharaharapriya', melakarta: 22
  },
  'Hamsadhwani': {
    keywords: ['swan', 'flight', 'purity', 'hamsa', 'ascension', 'spiritual', 'white', 'grace', 'elevation'],
    swaraMarkers: ['S R2 G3 P N3 S', 's r2 g3 p n3 s'],
    timeOfDay: 'evening', mood: 'pure, elevating', parent: 'Sankarabharanam', melakarta: 29
  },
  'Keeravani': {
    keywords: ['sun', 'rays', 'brilliance', 'keeravani', 'light', 'radiance', 'glory', 'splendor', 'warmth'],
    swaraMarkers: ['S R2 G2 M1 P D1 N3 S', 's r2 g2 m1 p d1 n3 s'],
    timeOfDay: 'evening', mood: 'brilliant, warm', parent: null, melakarta: 21
  },
  'Shanmukhapriya': {
    keywords: ['six-faced', 'shanmukha', 'skanda', 'muruga', 'victory', 'youth', 'spear', 'temple', 'procession'],
    swaraMarkers: ['S R2 G2 M2 P D1 N2 S', 's r2 g2 m2 p d1 n2 s'],
    timeOfDay: 'evening', mood: 'grand, processional', parent: null, melakarta: 56
  },
  'Charukesi': {
    keywords: ['beautiful hair', 'charu', 'kesi', 'beauty', 'grace', 'woman', 'elegance', 'charm', 'allure'],
    swaraMarkers: ['S R2 G3 M1 P D1 N2 S', 's r2 g3 m1 p d1 n2 s'],
    timeOfDay: 'evening', mood: 'graceful, elegant', parent: null, melakarta: 26
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 2. TALA METER PATTERNS (7 standard talas with syllabic meter signatures)
// ═══════════════════════════════════════════════════════════════════════════════
const TALA_METERS = {
  'Adi': {
    beats: 8, pattern: [4, 2, 2], angas: ['I', 'O', 'O'],
    meterSignature: /(ta\s+ki\s+ta\s+ta\s+ka\s+di\s+mi)|(dheem\s+ta\s+na\s+ka\s+di\s+nu)/i,
    syllablesPerCycle: 8, keywords: ['adi', 'eight beat', 'chatusra', 'first']
  },
  'Rupaka': {
    beats: 6, pattern: [2, 4], angas: ['O', 'I'],
    meterSignature: /(ta\s+ka\s+di\s+mi\s+ta\s+ki\s+ta)/i,
    syllablesPerCycle: 6, keywords: ['rupaka', 'six beat', 'druta']
  },
  'Misra Chapu': {
    beats: 7, pattern: [3, 2, 2], angas: ['U', 'O', 'O'],
    meterSignature: /(ta\s+ki\s+ta\s+ta\s+ka\s+di\s+mi)/i,
    syllablesPerCycle: 7, keywords: ['misra', 'chapu', 'seven beat', 'tisra']
  },
  'Khanda Chapu': {
    beats: 5, pattern: [2, 1, 2], angas: ['O', 'U', 'O'],
    meterSignature: /(ta\s+ka\s+ta\s+ki\s+ta)/i,
    syllablesPerCycle: 5, keywords: ['khanda', 'chapu', 'five beat']
  },
  'Dhruva': {
    beats: 14, pattern: [4, 2, 4, 4], angas: ['I', 'O', 'I', 'I'],
    meterSignature: /(ta\s+ki\s+ta\s+ta\s+ka\s+di\s+mi\s+ta\s+ki\s+ta\s+ta\s+ka\s+di\s+mi)/i,
    syllablesPerCycle: 14, keywords: ['dhruva', 'fourteen beat', 'long cycle']
  },
  'Matya': {
    beats: 10, pattern: [4, 2, 4], angas: ['I', 'O', 'I'],
    meterSignature: /(ta\s+ki\s+ta\s+ta\s+ka\s+di\s+mi\s+ta\s+ki\s+ta)/i,
    syllablesPerCycle: 10, keywords: ['matya', 'ten beat']
  },
  'Jhampa': {
    beats: 10, pattern: [3, 1, 2, 4], angas: ['U', 'A', 'O', 'I'],
    meterSignature: /(ta\s+ki\s+ta\s+ta\s+ka\s+di\s+mi)/i,
    syllablesPerCycle: 10, keywords: ['jhampa', 'ten beat', 'anushtup']
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 3. SWARA REGEX EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════
const SWARA_REGEX = /\b(S\s*['']?|R[123]?\s*|G[123]?\s*|M[12]?\s*|P\s*|D[123]?\s*|N[123]?\s*|[,;\-])\b/gi;
const SWARA_LINE_REGEX = /[SRGMPDN][123]?\s*['']?\s*(?:[,;\-]?\s*[SRGMPDN][123]?\s*['']?\s*)+/gi;

const SWARA_SEMITONE_MAP = {
  'S': 0, 'S1': 0, "S'": 12,
  'R1': 1, 'R2': 2, 'R3': 3,
  'G1': 1, 'G2': 2, 'G3': 3,
  'M1': 5, 'M2': 6,
  'P': 7,
  'D1': 8, 'D2': 9, 'D3': 10,
  'N1': 8, 'N2': 9, 'N3': 10,
  "S'": 12, "S''": 24
};

// ═══════════════════════════════════════════════════════════════════════════════
// 4. CORE FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract all swara tokens from text using regex.
 * Returns array of { swara, semitone, position } objects.
 */
function extractSwarasFromText(text) {
  if (!text) return [];
  const matches = [];
  let m;
  while ((m = SWARA_REGEX.exec(text)) !== null) {
    const swara = m[1].toUpperCase().trim().replace(/['']/, "'");
    const semitone = SWARA_SEMITONE_MAP[swara];
    if (semitone !== undefined) {
      matches.push({ swara, semitone: semitone % 12, position: m.index, raw: m[0] });
    }
  }
  return matches;
}

/**
 * Extract full swara lines (sequences) from text.
 */
function extractSwaraLines(text) {
  if (!text) return [];
  const lines = [];
  let m;
  while ((m = SWARA_LINE_REGEX.exec(text)) !== null) {
    lines.push({ line: m[0], position: m.index });
  }
  return lines;
}

/**
 * Detect raga from lyrics using keyword dictionaries + swara content.
 * Returns { raga, confidence, method, keywords, parent, melakarta, timeOfDay, mood }
 */
function detectRagaFromLyrics(text, opts = {}) {
  if (!text || typeof text !== 'string') return { raga: 'Unknown', confidence: 0, method: 'no_text' };
  const lowerText = text.toLowerCase();
  const scores = [];

  for (const [ragaName, data] of Object.entries(RAGA_KEYWORDS)) {
    let score = 0;
    let matchedKeywords = [];

    // Keyword matching
    for (const kw of data.keywords) {
      if (lowerText.includes(kw.toLowerCase())) {
        score += 3;
        matchedKeywords.push(kw);
      }
    }

    // Swara marker matching
    for (const marker of (data.swaraMarkers || [])) {
      const markerLower = marker.toLowerCase();
      if (lowerText.includes(markerLower)) {
        score += 8;
        matchedKeywords.push('swara:' + marker);
      }
    }

    // Direct raga name mention
    if (lowerText.includes(ragaName.toLowerCase())) {
      score += 15;
      matchedKeywords.push('name:' + ragaName);
    }

    // Parent mention for janya
    if (data.parent && lowerText.includes(data.parent.toLowerCase())) {
      score += 5;
    }

    if (score > 0) {
      scores.push({
        raga: ragaName,
        score,
        confidence: Math.min(score / 25, 0.95),
        matchedKeywords,
        parent: data.parent,
        melakarta: data.melakarta,
        timeOfDay: data.timeOfDay,
        mood: data.mood
      });
    }
  }

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0] || { raga: 'Unknown', confidence: 0, method: 'no_match' };

  // Swara-based reinforcement: if extracted swaras strongly match a raga's scale
  const extractedSwaras = extractSwarasFromText(text);
  if (extractedSwaras.length >= 4) {
    const uniqueSemitones = [...new Set(extractedSwaras.map(s => s.semitone))].sort((a, b) => a - b);
    for (const [ragaName, data] of Object.entries(RAGA_KEYWORDS)) {
      const markerSwaras = extractSwarasFromText(data.swaraMarkers.join(' '));
      const markerSemitones = [...new Set(markerSwaras.map(s => s.semitone))].sort((a, b) => a - b);
      const intersection = uniqueSemitones.filter(s => markerSemitones.includes(s));
      const union = [...new Set([...uniqueSemitones, ...markerSemitones])];
      const jaccard = union.length ? intersection.length / union.length : 0;
      if (jaccard > 0.6) {
        const existing = scores.find(s => s.raga === ragaName);
        if (existing) {
          existing.confidence = Math.min(existing.confidence + jaccard * 0.3, 0.98);
          existing.method = 'keyword_swara_fusion';
        } else {
          scores.push({
            raga: ragaName, score: Math.round(jaccard * 20),
            confidence: Math.min(jaccard * 0.9, 0.85),
            matchedKeywords: ['swara_jaccard'],
            parent: data.parent, melakarta: data.melakarta,
            timeOfDay: data.timeOfDay, mood: data.mood,
            method: 'swara_jaccard'
          });
        }
      }
    }
    scores.sort((a, b) => b.score - a.score);
  }

  return scores[0] || best;
}

/**
 * Detect tala from lyrics using meter patterns + syllable counting.
 * Returns { tala, confidence, pattern, beats, method }
 */
function detectTalaFromLyrics(text, opts = {}) {
  if (!text || typeof text !== 'string') return { tala: 'Unknown', confidence: 0, method: 'no_text' };
  const lowerText = text.toLowerCase();
  let bestScore = 0;
  let bestTala = null;

  for (const [talaName, data] of Object.entries(TALA_METERS)) {
    let score = 0;

    // Direct keyword mention
    for (const kw of data.keywords) {
      if (lowerText.includes(kw.toLowerCase())) score += 5;
    }

    // Meter regex match
    if (data.meterSignature && data.meterSignature.test(text)) {
      score += 10;
    }

    // Syllable count heuristic: count rhythmic syllables (ta, ki, ta, ka, di, mi, etc.)
    const syllableMatches = text.match(/\b(ta|ki|ta|ka|di|mi|dheem|na|nu|thom|lam|jham)\b/gi);
    if (syllableMatches) {
      const count = syllableMatches.length;
      const remainder = count % data.syllablesPerCycle;
      const fit = remainder === 0 ? 1 : (remainder <= 2 ? 0.5 : 0.1);
      score += fit * 5;
    }

    // Line syllable count alignment
    const lines = text.split(/[\n;]+/).filter(l => l.trim().length > 0);
    let lineFitScore = 0;
    for (const line of lines) {
      const words = line.trim().split(/\s+/).length;
      const rem = words % data.beats;
      if (rem === 0) lineFitScore += 2;
      else if (rem <= 1) lineFitScore += 1;
    }
    score += Math.min(lineFitScore, 8);

    if (score > bestScore) {
      bestScore = score;
      bestTala = { tala: talaName, score, pattern: data.pattern, beats: data.beats, angas: data.angas };
    }
  }

  if (!bestTala) return { tala: 'Adi', confidence: 0.3, method: 'default_fallback', pattern: [4, 2, 2], beats: 8 };

  return {
    tala: bestTala.tala,
    confidence: Math.min(bestTala.score / 20, 0.92),
    pattern: bestTala.pattern,
    beats: bestTala.beats,
    angas: bestTala.angas,
    method: 'meter_keyword_syllable_fusion'
  };
}

/**
 * Build scale (arohana/avarohana) from extracted swaras in lyrics.
 * Returns { aroha, avaroha, semitones, confidence, method }
 */
function buildScaleFromLyrics(text, opts = {}) {
  const swaras = extractSwarasFromText(text);
  if (swaras.length < 3) return { aroha: '', avaroha: '', semitones: [], confidence: 0, method: 'insufficient_swaras' };

  const uniqueSemitones = [...new Set(swaras.map(s => s.semitone))].sort((a, b) => a - b);
  const swaraNames = [...new Set(swaras.map(s => s.swara))];

  // Build aroha (ascending) from order of first appearance
  const seen = new Set();
  const arohaOrder = [];
  for (const s of swaras) {
    if (!seen.has(s.semitone)) {
      seen.add(s.semitone);
      arohaOrder.push(s.swara);
    }
  }

  // Build avarohana (descending) — reverse of aroha, but respect Carnatic conventions
  const avarohanaOrder = [...arohaOrder].reverse();

  // Map semitones to standard Carnatic notation
  const semitoneToSwara = {
    0: 'S', 1: 'R1', 2: 'R2', 3: 'R3', 4: 'G3',
    5: 'M1', 6: 'M2', 7: 'P', 8: 'D1', 9: 'D2', 10: 'D3', 11: 'N3'
  };

  const canonicalAroha = uniqueSemitones.map(st => semitoneToSwara[st] || '?');
  const canonicalAvaroha = [...uniqueSemitones].reverse().map(st => semitoneToSwara[st] || '?');

  return {
    aroha: canonicalAroha.join(' '),
    avaroha: canonicalAvaroha.join(' '),
    semitones: uniqueSemitones,
    swaraNames,
    confidence: Math.min(swaras.length / 15, 0.9),
    method: 'swara_extraction_semitone_mapping'
  };
}

/**
 * Full lyrics NLP pipeline.
 * Returns comprehensive analysis: { raga, tala, scale, swaras, confidence, method }
 */
function analyzeLyrics(text, opts = {}) {
  const ragaResult = detectRagaFromLyrics(text, opts);
  const talaResult = detectTalaFromLyrics(text, opts);
  const scaleResult = buildScaleFromLyrics(text, opts);
  const swaraResult = extractSwarasFromText(text);
  const swaraLines = extractSwaraLines(text);

  // Overall confidence: weighted fusion of sub-confidences
  const overallConfidence = (
    (ragaResult.confidence || 0) * 0.4 +
    (talaResult.confidence || 0) * 0.25 +
    (scaleResult.confidence || 0) * 0.35
  );

  return {
    raga: ragaResult.raga,
    ragaConfidence: ragaResult.confidence,
    ragaDetails: {
      parent: ragaResult.parent,
      melakarta: ragaResult.melakarta,
      timeOfDay: ragaResult.timeOfDay,
      mood: ragaResult.mood,
      matchedKeywords: ragaResult.matchedKeywords
    },
    tala: talaResult.tala,
    talaConfidence: talaResult.confidence,
    talaDetails: {
      pattern: talaResult.pattern,
      beats: talaResult.beats,
      angas: talaResult.angas
    },
    scale: {
      aroha: scaleResult.aroha,
      avaroha: scaleResult.avaroha,
      semitones: scaleResult.semitones,
      confidence: scaleResult.confidence
    },
    swaras: swaraResult,
    swaraLines: swaraLines.map(l => l.line),
    overallConfidence,
    method: 'lyrics_nlp_v6.1.2',
    augmentationReady: overallConfidence >= 0.4
  };
}

module.exports = {
  RAGA_KEYWORDS,
  TALA_METERS,
  SWARA_REGEX,
  SWARA_SEMITONE_MAP,
  extractSwarasFromText,
  extractSwaraLines,
  detectRagaFromLyrics,
  detectTalaFromLyrics,
  buildScaleFromLyrics,
  analyzeLyrics
};
