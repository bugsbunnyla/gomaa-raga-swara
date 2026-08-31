"use strict";
/**
 * GoMaa Raga Vidya v4.0 — Fusion Engine
 */

function fuse(ragaFromFile, ragaFromScale, ragaFromFP, opts) {
  const compositionMatch = opts?.compositionMatch;
  if (compositionMatch) {
    return { ...compositionMatch, topCandidates: [] };
  }
  return ragaFromFile || ragaFromScale || ragaFromFP || {
    label: "Unknown", ragaNumber: 0, melakarta: "",
    aroha: "S R2 G3 M1 P D2 N3 S", avaroha: "S N3 D2 P M1 G3 R2 S",
    score: 0.5, confidence: 0.5, confidenceLabel: "low",
    detectionSource: "fallback", mood: "meditative", gamakas: ["kampita"],
    topCandidates: []
  };
}

function fuseInstruments(prev, features, opts) {
  return [{ name: "mixed", label: "Mixed / Ensemble", confidence: 0.5, family: "unknown", role: "unknown" }];
}

function extractMetadata(filePath, result, opts) {
  return { filePath, analyzedAt: Date.now() };
}

function logCycle(phase, data) {
  // No-op for production; can be enabled for debugging
}

module.exports = { fuse, fuseInstruments, extractMetadata, logCycle };
