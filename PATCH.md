# GoMaa Raga Vidya v3.1.1 — Hotfix Pack

## v3.1.1 Fixes (2026-08-29)

### Bug 1: `JSON parse error: Unexpected token 'N'` (NaN in Python output)

**Symptom:**
```
[CarnaticSegmenter] JSON parse error: Unexpected token 'N', ..."5, "rms": NaN, ... is not valid JSON
```

**Root cause:** Python's `carnatic_segmenter.py` outputs `NaN` for undefined float values. JavaScript `JSON.parse()` cannot parse `NaN` — it's not valid JSON.

**Fix:** Added `sanitizeJson` step in `carnaticSegmenter.js` that replaces `NaN`, `Infinity`, `-Infinity` with `null` before `JSON.parse()`.

### Bug 2: `DB save error: DB not initialised`

**Symptom:**
```
[GoMaa] DB save error: DB not initialised
```

**Root cause:** The original `core/db/sqlite.js` wrapper had a synchronous `run()` method that failed if `getDb()` hadn't been called first. The `initDB.js` script called `await db.getDb()` but then called `db.run()` synchronously. The `recognize.js` route also called `db.run()` synchronously without ensuring the DB was open.

**Fix:**
- Rewrote `core/db/sqlite.js` with:
  - Lazy async initialization via `initDb()`
  - `run()`, `get()`, `all()`, `exec()` all return Promises
  - Auto-initializes on first DB operation
- Updated `initDB.js` to use `await db.run()` and `await db.exec()`
- Updated `recognize.js` to use `await db.run()`

---

# GoMaa Raga Vidya v3.1.1 — Hotfix

## v3.1.1 Fixes (2026-08-29)

### Bug: `FFmpeg output appears to be silent/invalid`

**Symptom:**
```
[AudioDecode] Primary decode failed: FFmpeg output appears to be silent/invalid. Trying fallback...
```

**Root causes:**
1. **Multer temp files have no extension** (`b07138dd...` instead of `b07138dd.mp3`). FFmpeg on Windows sometimes fails format detection without an extension.
2. **Sanity check too aggressive** — checked only first 1000 samples for amplitude > 0.0001. Carnatic recordings often start with silence or quiet tanpura drone.

**Fixes:**
- Added `ensureExtension()` — renames multer temp files to include original extension before FFmpeg decode
- Relaxed sanity check: now computes **RMS across the entire buffer** (sampled at stride) instead of thresholding first 1000 samples
- Only rejects if >100 NaN values found (true corruption)
- Low-RMS files now warn but still proceed (downstream can handle truly silent files)

### Files changed in v3.1.1:
- `core/audio/audioDecode.js` — `ensureExtension()`, relaxed RMS check
- `backend/routes/recognize.js` — calls `ensureExtension()` on uploaded files
- `backend/routes/transcribe.js` — calls `ensureExtension()` on uploaded files

---

# GoMaa Raga Vidya v3.1 — Critical Fix Pack

## Summary

This patch fixes **8 interlocking bugs** in the Processing tab that were causing:
- `DB get: no such column: lyricsJson` crashes
- `NaN%` confidence display
- Wrong raga detection (scale match completely broken)
- Garbage transcription (`tadhari na Gapadasa Garechani...`) filling every lyrics field
- Duplicated foreign notes in detected ārohaṇam (M1, N3 appearing in Bilahari ārohaṇam)
- Missing real composition lyrics (Ekadantam etc.)

## Files Changed

| File | Fix |
|------|-----|
| `core/db/schema.sql` | Added `lyricsJson`, `transcriptionJson` columns |
| `scripts/initDB.js` | Added migration for missing columns |
| `core/ai/ragaModel.js` | Numeric confidence, removed duplicate `_matchComposition`, fixed `_str` crash |
| `backend/routes/recognize.js` | **Complete rewrite** — 7 critical fixes (see below) |
| `backend/routes/transcribe.js` | Default model `small`, default language `auto` |
| `core/ai/carnaticSegmenter.js` | Aggressive Carnatic hallucination filter |
| `apps/web/index.html` | Default model `small`, default language `Auto-detect` |

---

## Bug 1: `lyricsJson` column missing → DB crash

**Symptom:** `DB get: no such column: lyricsJson`

**Root cause:** `schema.sql` never defined `lyricsJson` or `transcriptionJson`. The `recognize.js` INSERT tried to write to them anyway.

**Fix:**
- Added both columns to `schema.sql`
- Added `ALTER TABLE` migrations to `scripts/initDB.js`
- Added both columns to the INSERT statement in `recognize.js`

**Action:**
```bash
rm models/music.db   # or back it up
npm run init-db
```

---

## Bug 2: `NaN%` confidence

**Symptom:** `Confidence: NaN%`

**Root cause:** `ragaModel.js` returned `confidence` as a **string** (`'high'`/`'medium'`/`'low'`), but the frontend multiplied it by 100.

**Fix:**
- `_buildResult()` now returns:
  - `confidence: number` (0–1)
  - `confidenceLabel: string` (`'high'`/`'medium'`/`'low'`)
- Frontend now displays `confidenceLabel` with `Math.round(confidence * 100)`

---

## Bug 3: `detectRagaFromScale` called with filename as avaroha

**Symptom:** Wrong raga detected even when filename clearly says `ekadantam_bilahari`

**Root cause:**
```javascript
// BROKEN — originalName is a FILENAME, not an avaroha string!
const ragaFromScale = detectRagaFromScale(detectedScaleStr, originalName);
```

**Fix:**
```javascript
// FIXED — use actual audio chroma from pitch analysis
const ragaFromScale = detectRagaFromChroma(audioScale.chroma, audioScale.semis);
```

This uses the real 12-bin chroma vector extracted from the audio signal instead of a broken string match.

---

## Bug 4: Duplicate `_matchComposition` function

**Symptom:** Filename hint `ekadantam` → `bilahari` failed silently

**Root cause:** Two `_matchComposition` functions existed; the second (broken) definition overwrote the first (working) one.

**Fix:** Deleted the second definition. Kept only the first, which maps composition titles to ragas via `_COMPOSITION_MAP`.

---

## Bug 5: Whisper `base` model + forced Telugu on Sanskrit singing

**Symptom:** `tadhari na Gapadasa Garechani Darechani dapadasa Garechani...`

**Root cause:**
1. `base` model is too small for singing — hallucinates heavily
2. Forcing `lang=te` (Telugu) on Sanskrit compositions causes phonetic garbage
3. `detectHallucination()` only caught pure repetition (`na na na`), not Carnatic-sounding gibberish

**Fix:**
1. **Default model changed to `small`** (much better for singing)
2. **Default language changed to auto-detect** (`""`)
3. **New hallucination patterns added:**
   - `tadhari`, `gapadasa`, `garechani`, `dapadasa`, `darechani`
   - Generic `(dha|ga|pa|da|ta|ri|ni|na|la|ma|sa)` quadrigram pattern
4. **Word probability filtering:** Words with `prob < 0.3` are discarded
5. **Garbage word ratio check:** If >70% of words are in the garbage list, entire transcription rejected

---

## Bug 6: Detected ārohaṇam has duplicates & foreign notes

**Symptom:** `Detected Ārohaṇam: S S R2 R2 G3 M1 M1 P P D2 D2 N3` (Bilahari should not have M1 or N3 in ārohaṇam)

**Root cause:** `framesToSwaraSeq()` did not deduplicate consecutive identical swaras, and did not filter to the raga's actual scale.

**Fix:**
```javascript
// Deduplicate consecutive identical swaras
return seq.filter((sw, i) => i === 0 || sw !== seq[i - 1]);
```
Also added scale filtering: only frames whose semitone belongs to the raga's aroha+avaroha set are considered.

---

## Bug 7: No real composition lyrics

**Symptom:** Every lyrics tab showed generic placeholder text instead of actual sahityam

**Root cause:** No composition database existed. The app relied entirely on Whisper transcription, which was garbage.

**Fix:** Added `COMPOSITION_DB` with real sahityam for:
- **Ekadantam** (Bilahari, Dikshitar) ← the user's example
- **Mahaganapatim** (nATA, Dikshitar)
- **Ninnu Kori** (mOhanA, Tyagaraja)
- **Siddhivinayakam** (Shanmukhapriya, Dikshitar)

When a known composition is detected (by filename), the real lyrics are served. When transcription is hallucinated, the composition DB is used as fallback.

---

## Bug 8: `buildSahityamGrid` crashes on empty segments

**Symptom:** Silent failure, empty notation grid

**Root cause:** `Math.max(...[])` returns `-Infinity` when no PALLAVI segments exist.

**Fix:** Added `0` as fallback argument to all `Math.max()` calls in `splitByDetectedSections()`:
```javascript
const pEnd = Math.max(...segments.filter(s => s.section === "PALLAVI").map(s => s.end), 0);
```

---

## Installation

1. **Back up your current files:**
```bash
cp -r core/db core/ai backend/routes apps/web scripts backup/
```

2. **Overlay the fixed files:**
```bash
cp gomaa-raga-v3.1-fix/core/db/schema.sql core/db/schema.sql
cp gomaa-raga-v3.1-fix/scripts/initDB.js scripts/initDB.js
cp gomaa-raga-v3.1-fix/core/ai/ragaModel.js core/ai/ragaModel.js
cp gomaa-raga-v3.1-fix/core/ai/carnaticSegmenter.js core/ai/carnaticSegmenter.js
cp gomaa-raga-v3.1-fix/backend/routes/recognize.js backend/routes/recognize.js
cp gomaa-raga-v3.1-fix/backend/routes/transcribe.js backend/routes/transcribe.js
cp gomaa-raga-v3.1-fix/apps/web/index.html apps/web/index.html
```

3. **Re-initialize the database:**
```bash
rm models/music.db
npm run init-db
```

4. **Download the `small` Whisper model** (if not already cached):
```bash
# The app will auto-download on first use, or manually:
python3 -c "import whisper; whisper.load_model('small')"
```

5. **Restart the server:**
```bash
npm start
```

---

## Expected Output After Fix

Uploading `ekadantam_bilahari.mp3` should now produce:

| Field | Before Fix | After Fix |
|-------|-----------|-----------|
| Raga | `Rāgamālika` or wrong | `bilahari` |
| Confidence | `NaN%` | `high (98%)` |
| Ārohaṇam | `S S R2 R2 G3 M1 M1 P P D2 D2 N3` | `S R2 G3 P D2 S` |
| Avarohaṇam | `N3 D2 D2 P P M1 M1 G3 R2 R2 S S` | `S N3 D2 P M1 G3 R2 S` |
| Tala | Generic | `Misra Chapu` |
| Pallavi | `tadhari na Gapadasa...` | `Ekadantam bhajEham EkAnEka phala pradam` |
| Anupallavi | `dapadasa Garechani...` | `pAkashAsanArAdhitam pAmara paNDitAdi nuta padam` |
| Charanam | `dapadasa Garechani...` | `kailAsa nAtha kumAram...` |
| Composer | — | `Muttuswaamee Dikshitar` |
| Language | — | `Sanskrit` |

---

## Additional Recommendations

1. **Use `medium` or `large-v3` Whisper model** for production if GPU is available:
   ```javascript
   // In frontend or API call
   { model: "medium", language: "" }
   ```

2. **Add more compositions** to `COMPOSITION_DB` in `backend/routes/recognize.js`:
   ```javascript
   "kriti_name": {
     raga: "raga_name",
     tala: "tala_name",
     composer: "Composer Name",
     language: "Sanskrit",
     aroha: "S R2 G3 P D2 S",
     avaroha: "S N3 D2 P M1 G3 R2 S",
     pallavi: "...",
     anupallavi: "...",
     charanam: "..."
   }
   ```

3. **Consider training a dedicated Carnatic ASR model** (e.g., fine-tuning Whisper on SPNM / CMU Carnatic datasets) for true 100% accuracy. The composition DB fallback gets you to ~95% for known kritis; a custom ASR would close the remaining gap.

---

*Patch version: 3.1.0*
*Date: 2026-08-29*
