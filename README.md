# 🎼 GoMaa Raga Vidya v3

**Carnatic Music Analyzer** — Detect raga, tala, swara, transcribe lyrics, and generate sheet music from any audio or video file.

## What's Fixed in v3

| Issue | Fix |
|-------|-----|
| Audio pipeline broken | FFmpeg decodes ALL formats (MP3, MP4, WAV, FLAC, OGG, M4A, AVI, MOV, WEBM, MKV) to PCM before analysis |
| Wrong execution order | Raga detection now runs **after** pitch/scale/tala extraction, using actual audio content |
| Transcribe isolated | Transcription is now integrated into the main pipeline; results feed into lyrics & sahityam |
| Hop/skip/jump UI | New step-by-step wizard: Input → Processing → Results → Saved |
| No persistence | Full analysis JSON saved to SQLite; browse history in "Saved" tab |
| Sheet music empty | MusicXML & MIDI generated from detected swaras and raga scale |

## Prerequisites

- **Node.js** ≥ 16
- **FFmpeg** (`apt install ffmpeg` or `brew install ffmpeg`)
- **Python** ≥ 3.9 with `faster-whisper`
  ```bash
  pip install faster-whisper
  ```
- **yt-dlp** (optional, for YouTube URLs)
  ```bash
  pip install yt-dlp
  ```

## Quick Start

```bash
# 1. Install Node dependencies
npm install

# 2. Initialize database
npm run init-db

# 3. Start server
npm start

# 4. Open http://localhost:3000
```

## Execution Pipeline

1. **Input** — Upload file, live mic recording, YouTube URL, or direct audio URL
2. **Decode** — FFmpeg converts any audio/video format to mono 16-bit PCM @ 22050 Hz
3. **Analyze** — Pitch → Scale → Beat detection → Tala cycle detection
4. **Raga Detect** — Scale-based cosine match against 7599-raga DB + filename hint
5. **Transcribe** — faster-whisper (language-selectable, default Telugu)
6. **Aroha/Avaroha** — Extracted from actual pitch trajectory
7. **Swaras & Sahityam** — Frame-by-frame swara mapping with tala-aligned notation
8. **Lyrics** — Sectioned into pallavi / anupallavi / charanam with transcription
9. **Sheet Music** — MusicXML + MIDI with Carnatic & Western note display
10. **Save** — Full result stored in SQLite, viewable in "Saved" tab

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/recognize/upload` | Upload audio/video file |
| POST | `/api/recognize/buffer` | Raw audio buffer (live recording) |
| POST | `/api/recognize/url` | YouTube or direct audio URL |
| GET | `/api/analysis/:id` | Retrieve saved analysis by ID |
| GET | `/api/analyses` | List all saved analyses |
| GET | `/api/health` | Health check |
| GET | `/api/ragas` | List 72 melakarta ragas |

## Testing

```bash
npm test
```

## License

MIT
