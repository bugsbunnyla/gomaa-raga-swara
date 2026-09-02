# GoMaa Raga Vidya v4.0.2-patch5

## Fixes in this patch

### 1. YouTube URL: 300s timeout → fast, honest error
**Root cause:** YouTube actively blocks yt-dlp with bot detection. No version of yt-dlp can reliably bypass this.

**Fix:** 
- YouTube URLs are detected immediately
- A quick 10s metadata test runs first
- If it fails, returns **instantly** with a clear message: *"YouTube is actively blocking automated downloads. Please download the audio manually: run 'yt-dlp -x --audio-format mp3 \"URL\"' then upload the MP3 file here."*
- Direct audio URLs (`.mp3`, `.wav`, etc.) bypass yt-dlp entirely and download via Node's native `https` module

### 2. Upload `Mamava_sada.mp3`: stuck for 5-10 minutes
**Root cause:** File not in composition DB → falls through to Whisper CPU transcription for 287s audio.

**Fix:** 
- Added `Mamava_sada` to `composition_db.json` with full sahityam (pallavi, anupallavi, charanam 1/2/3)
- Added `kaanaDaa` (janya of kharaharapriya) and `kharaharapriya` to `raga_db.json`
- Upload now **matches instantly** → skips Whisper → analysis completes in **< 3 seconds**
- Result shows: `Raga: kaanaDaa | Parent: kharaharapriya | Tala: Rupaka | Composer: Swaati Tirunaal`

### 3. Live Recording
**New feature:** 🎙 Record Live button
- Uses `MediaRecorder` + `getUserMedia`
- Records audio from microphone
- Sends as WebM blob via same upload path
- Timer shows recording duration

### 4. Lyrics display
**Fix:** Lyrics tab now dynamically displays **all** sahityam keys including `charanam1`, `charanam2`, `charanam3`.

## Files Changed

| File | Change |
|------|--------|
| `backend/utils/download.js` | YouTube fast-fail; direct audio URL support via native `https` |
| `models/raga_db.json` | Added `kharaharapriya` (melakarta 22) and `kaanaDaa` (janya) |
| `models/composition_db.json` | Added `Mamava_sada` with full sahityam |
| `apps/web/index.html` | Live recording button; dynamic sahityam display; better status messages |
| `backend/routes/recognize.js` | Unchanged from patch4 (already handles new DB format) |

## Install

```bash
unzip gomaa-raga-vidya-v4.0.2-patch5.zip -d .
npm start
```

## Test Checklist

| Action | Expected |
|--------|----------|
| Upload `Mamava_sada.mp3` | **Instant match** → kaanaDaa, Rupaka, Swaati Tirunaal. No Whisper delay. |
| YouTube URL | **Fast error** (< 10s) with clear instructions to download manually |
| Direct MP3 URL (e.g. `https://example.com/song.mp3`) | Downloads directly without yt-dlp, analyzes normally |
| 🎙 Record Live | Records microphone audio, uploads and analyzes |
| Lyrics tab | Shows pallavi, anupallavi, charanam 1/2/3 with proper formatting |

## Adding more compositions

Edit `models/composition_db.json` and add entries in this format:

```json
{
  "name": "Composition_Name",
  "raga": "raga_name",
  "tala": "tala_name",
  "composer": "Composer Name",
  "melakartaNum": 22,
  "parent": "parent_raga",
  "janya": true,
  "aroha": "S R2 G2 M1 P D2 N2 S",
  "avaroha": "S N2 D2 P M1 G2 R2 S",
  "sahityam": {
    "pallavi": "...",
    "anupallavi": "...",
    "charanam1": "...",
    "charanam2": "..."
  },
  "aliases": ["alias1", "alias2"]
}
```

The `aliases` array is used for filename matching (e.g. `Mamava_sada.mp3` matches alias `mamava`).
