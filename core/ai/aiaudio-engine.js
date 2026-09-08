/**
 * GoMaa Raga Vidya v6.1.2 — aiaudio-engine.js
 * AI Audio Synthesis Engine with 7 voice profiles, vibrato/formant synthesis,
 * and proper Standard MIDI File (SMF) generation.
 * 
 * Voice Profiles:
 *   Divine Female, Divine Male, Celestial Flute, Veena Goddess,
 *   Human Female, Human Male, Child Angel
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════════
// 1. VOICE PROFILE DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════════
const VOICE_PROFILES = {
  'Divine Female': {
    category: 'Divine',
    baseFreqMultiplier: 1.0,
    vibrato: { rate: 5.5, depth: 12, delay: 0.08 },      // Hz, cents, seconds
    formant: { f1: 850, f2: 1220, f3: 2860, bw: 80 },     // Formant frequencies (Hz)
    envelope: { attack: 0.08, decay: 0.15, sustain: 0.7, release: 0.4 },
    timbre: 'sine+triangle',                               // Oscillator mix
    reverb: { wet: 0.35, decay: 2.5 },
    description: 'Ethereal soprano with celestial vibrato and luminous formants'
  },
  'Divine Male': {
    category: 'Divine',
    baseFreqMultiplier: 0.5,
    vibrato: { rate: 4.2, depth: 8, delay: 0.12 },
    formant: { f1: 600, f2: 1040, f3: 2650, bw: 90 },
    envelope: { attack: 0.1, decay: 0.2, sustain: 0.75, release: 0.5 },
    timbre: 'sawtooth+sine',
    reverb: { wet: 0.4, decay: 3.0 },
    description: 'Resonant tenor-bass with sacred depth and temple reverb'
  },
  'Celestial Flute': {
    category: 'Classical Instruments',
    baseFreqMultiplier: 1.0,
    vibrato: { rate: 6.0, depth: 18, delay: 0.03 },       // Strong breath vibrato
    formant: { f1: 1200, f2: 2800, f3: 3800, bw: 120 },   // Pipe resonances
    envelope: { attack: 0.02, decay: 0.1, sustain: 0.85, release: 0.15 },
    timbre: 'triangle+sine',
    reverb: { wet: 0.25, decay: 1.8 },
    description: 'Bansuri-style flute with breathy attack and meend-capable portamento'
  },
  'Veena Goddess': {
    category: 'Classical Instruments',
    baseFreqMultiplier: 0.5,
    vibrato: { rate: 3.8, depth: 6, delay: 0.15 },        // Subtle jaru
    formant: { f1: 450, f2: 1100, f3: 2400, bw: 60 },     // Plucked string resonances
    envelope: { attack: 0.005, decay: 0.4, sustain: 0.3, release: 0.6 },
    timbre: 'sawtooth+triangle',
    reverb: { wet: 0.3, decay: 2.2 },
    description: 'Saraswati veena with plucked decay, sympathetic drone, and jaru slides'
  },
  'Human Female': {
    category: 'Human',
    baseFreqMultiplier: 1.0,
    vibrato: { rate: 5.0, depth: 10, delay: 0.1 },
    formant: { f1: 800, f2: 1150, f3: 2800, bw: 85 },
    envelope: { attack: 0.06, decay: 0.12, sustain: 0.72, release: 0.35 },
    timbre: 'sine+triangle',
    reverb: { wet: 0.2, decay: 1.5 },
    description: 'Natural female voice with realistic vibrato and room ambience'
  },
  'Human Male': {
    category: 'Human',
    baseFreqMultiplier: 0.5,
    vibrato: { rate: 4.0, depth: 7, delay: 0.15 },
    formant: { f1: 550, f2: 950, f3: 2500, bw: 95 },
    envelope: { attack: 0.08, decay: 0.18, sustain: 0.78, release: 0.45 },
    timbre: 'sawtooth+sine',
    reverb: { wet: 0.2, decay: 1.6 },
    description: 'Natural male voice with warm chest resonance and subtle vibrato'
  },
  'Child Angel': {
    category: 'Divine',
    baseFreqMultiplier: 1.5,
    vibrato: { rate: 6.5, depth: 15, delay: 0.05 },
    formant: { f1: 1000, f2: 1600, f3: 3200, bw: 70 },
    envelope: { attack: 0.04, decay: 0.1, sustain: 0.68, release: 0.3 },
    timbre: 'sine',
    reverb: { wet: 0.45, decay: 3.5 },
    description: 'Pure child voice with angelic shimmer and cathedral reverb'
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// 2. SWARA TO FREQUENCY + MIDI NOTE MAPPING
// ═══════════════════════════════════════════════════════════════════════════════
const SWARA_FREQ_MAP = {
  'S': 261.63, 'R1': 277.18, 'R2': 293.66, 'R3': 311.13,
  'G1': 277.18, 'G2': 293.66, 'G3': 329.63,
  'M1': 349.23, 'M2': 369.99,
  'P': 392.00,
  'D1': 415.30, 'D2': 440.00, 'D3': 466.16,
  'N1': 415.30, 'N2': 440.00, 'N3': 493.88,
  "S'": 523.25, ',': 0, '-': 0, 'rest': 0
};

const SWARA_MIDI_MAP = {
  'S': 60, 'R1': 61, 'R2': 62, 'R3': 63,
  'G1': 61, 'G2': 62, 'G3': 64,
  'M1': 65, 'M2': 66,
  'P': 67,
  'D1': 68, 'D2': 69, 'D3': 70,
  'N1': 68, 'N2': 69, 'N3': 71,
  "S'": 72, ',': 0, '-': 0, 'rest': 0
};

// ═══════════════════════════════════════════════════════════════════════════════
// 3. MIDI SMF GENERATION (Standard MIDI File Format 0)
// ═══════════════════════════════════════════════════════════════════════════════

function writeMidiVarLen(value) {
  let buffer = [];
  let v = value;
  buffer.push(v & 0x7F);
  while ((v >>= 7) > 0) {
    buffer.unshift((v & 0x7F) | 0x80);
  }
  return Buffer.from(buffer);
}

function generateSMF(notes, opts = {}) {
  const {
    tempo = 120,
    ticksPerQuarter = 480,
    ragaName = 'Unknown',
    talaName = 'Adi',
    voiceName = 'Divine Female'
  } = opts;

  // MIDI Header
  const header = Buffer.from([
    0x4D, 0x54, 0x68, 0x64, // MThd
    0x00, 0x00, 0x00, 0x06, // chunk length = 6
    0x00, 0x00,              // format 0
    0x00, 0x01,              // 1 track
    0x01, 0xE0               // 480 ticks per quarter
  ]);

  // Build track events
  const events = [];

  // Track name meta event
  const trackName = `GoMaa-${ragaName}-${talaName}`;
  events.push({ delta: 0, data: Buffer.from([0xFF, 0x03, trackName.length, ...Buffer.from(trackName, 'ascii')]) });

  // Tempo meta event (microseconds per quarter)
  const usPerQuarter = Math.round(60000000 / tempo);
  events.push({ delta: 0, data: Buffer.from([0xFF, 0x51, 0x03, (usPerQuarter >> 16) & 0xFF, (usPerQuarter >> 8) & 0xFF, usPerQuarter & 0xFF]) });

  // Time signature (4/4 default, adaptable to tala)
  let numerator = 4, denominator = 2; // 2^2 = 4
  if (talaName === 'Adi') { numerator = 8; denominator = 3; } // 8/8
  else if (talaName === 'Rupaka') { numerator = 3; denominator = 2; }
  else if (talaName === 'Misra Chapu') { numerator = 7; denominator = 3; }
  else if (talaName === 'Khanda Chapu') { numerator = 5; denominator = 3; }
  events.push({ delta: 0, data: Buffer.from([0xFF, 0x58, 0x04, numerator, denominator, 0x18, 0x08]) });

  // Key signature (C default — Carnatic is shruti-relative)
  events.push({ delta: 0, data: Buffer.from([0xFF, 0x59, 0x02, 0x00, 0x00]) });

  // Program change (voice selection)
  const programMap = {
    'Divine Female': 91, 'Divine Male': 91,      // Choir Aahs
    'Celestial Flute': 73,                        // Flute
    'Veena Goddess': 105,                         // Sitar
    'Human Female': 85, 'Human Male': 85,        // Lead 6 (Voice)
    'Child Angel': 91                             // Choir Aahs
  };
  events.push({ delta: 0, data: Buffer.from([0xC0, programMap[voiceName] || 91]) });

  // Note events
  let currentTick = 0;
  const noteDurationTicks = Math.round(ticksPerQuarter * 0.5); // default eighth note

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const midiNote = SWARA_MIDI_MAP[note.swara] || 0;
    if (midiNote === 0) {
      currentTick += noteDurationTicks;
      continue;
    }

    const velocity = note.velocity || 80;
    const duration = Math.round((note.duration || 0.5) * ticksPerQuarter * 2);
    const delta = i === 0 ? 0 : 0; // all notes relative to previous

    // Note On
    events.push({ delta: 0, data: Buffer.from([0x90, midiNote, velocity]) });
    // Note Off (after duration)
    events.push({ delta: duration, data: Buffer.from([0x80, midiNote, 0]) });
  }

  // End of track
  events.push({ delta: 0, data: Buffer.from([0xFF, 0x2F, 0x00]) });

  // Build track chunk
  let trackData = Buffer.alloc(0);
  let runningDelta = 0;
  for (const ev of events) {
    const varLen = writeMidiVarLen(ev.delta);
    trackData = Buffer.concat([trackData, varLen, ev.data]);
  }

  const trackHeader = Buffer.from([
    0x4D, 0x54, 0x72, 0x6B, // MTrk
    (trackData.length >> 24) & 0xFF,
    (trackData.length >> 16) & 0xFF,
    (trackData.length >> 8) & 0xFF,
    trackData.length & 0xFF
  ]);

  return Buffer.concat([header, trackHeader, trackData]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. AUDIO COMPOSITION JSON GENERATOR (for frontend Web Audio API)
// ═══════════════════════════════════════════════════════════════════════════════

function generateAudioComposition(swaraResult, raga, tala, voiceName, lyrics, opts = {}) {
  const profile = VOICE_PROFILES[voiceName] || VOICE_PROFILES['Divine Female'];
  const tempo = opts.tempo || 120;
  const baseFreq = opts.baseFreq || 261.63;
  const notes = (swaraResult.swaras || []).map((s, i) => {
    const freq = SWARA_FREQ_MAP[s] || 0;
    const adjustedFreq = freq > 0 ? freq * profile.baseFreqMultiplier : 0;
    return {
      swara: s,
      freq: adjustedFreq,
      time: i * (60 / tempo),
      duration: 0.5,
      velocity: 80,
      instrument: voiceName,
      gamaka: swaraResult.gamakas?.[i] || 'sustain',
      vibrato: profile.vibrato,
      formant: profile.formant,
      envelope: profile.envelope,
      timbre: profile.timbre,
      reverb: profile.reverb
    };
  });

  return {
    version: 'v6.1.2',
    raga: raga?.name || 'Unknown',
    tala,
    tempo,
    voice: voiceName,
    voiceProfile: profile,
    notes,
    background: {
      type: 'tanpura-drone',
      baseFreq: baseFreq / 2,
      harmonics: [1, 2, 3, 4],
      volume: 0.12,
      instrument: 'Tanpura'
    },
    mridangam: {
      type: 'rhythm-track',
      tala,
      tempo,
      volume: 0.18,
      pattern: generateMridangamPattern(tala)
    },
    lyrics: lyrics || ''
  };
}

function generateMridangamPattern(tala) {
  const patterns = {
    'Adi': [
      { beat: 0, sound: 'tha', accent: true },
      { beat: 1, sound: 'ki', accent: false },
      { beat: 2, sound: 'ta', accent: false },
      { beat: 3, sound: 'tha', accent: true },
      { beat: 4, sound: 'ka', accent: false },
      { beat: 5, sound: 'di', accent: false },
      { beat: 6, sound: 'mi', accent: false },
      { beat: 7, sound: 'tha', accent: true }
    ],
    'Rupaka': [
      { beat: 0, sound: 'tha', accent: true },
      { beat: 1, sound: 'ka', accent: false },
      { beat: 2, sound: 'di', accent: false },
      { beat: 3, sound: 'mi', accent: false },
      { beat: 4, sound: 'tha', accent: true },
      { beat: 5, sound: 'ki', accent: false }
    ],
    'Misra Chapu': [
      { beat: 0, sound: 'tha', accent: true },
      { beat: 1, sound: 'ki', accent: false },
      { beat: 2, sound: 'ta', accent: false },
      { beat: 3, sound: 'tha', accent: true },
      { beat: 4, sound: 'ka', accent: false },
      { beat: 5, sound: 'di', accent: false },
      { beat: 6, sound: 'mi', accent: false }
    ],
    'Khanda Chapu': [
      { beat: 0, sound: 'tha', accent: true },
      { beat: 1, sound: 'ka', accent: false },
      { beat: 2, sound: 'tha', accent: true },
      { beat: 3, sound: 'ki', accent: false },
      { beat: 4, sound: 'ta', accent: false }
    ]
  };
  return patterns[tala] || patterns['Adi'];
}

// ═══════════════════════════════════════════════════════════════════════════════
// 5. EXPORT
// ═══════════════════════════════════════════════════════════════════════════════
module.exports = {
  VOICE_PROFILES,
  SWARA_FREQ_MAP,
  SWARA_MIDI_MAP,
  generateSMF,
  generateAudioComposition,
  generateMridangamPattern
};
