# 🎵 GoMaa Raga Vidya v4.0

**Carnatic Music Analysis & Raga Recognition Engine**

> Complete v4.0 rewrite with audio-powered swara extraction, western notation, section-wise mapping, and restored Compose/Saved Sessions tabs.

---

## 🚀 Quick Start

```bash
# 1. Clone and enter
cd gomaa-raga-vidya

# 2. Install Node dependencies
npm install

# 3. Install Python dependencies (for Whisper transcription)
pip install openai-whisper yt-dlp

# 4. Install FFmpeg (required for audio decoding)
# macOS: brew install ffmpeg
# Ubuntu: sudo apt-get install ffmpeg
# Windows: choco install ffmpeg

# 5. Initialize database
npm run init-db

# 6. Start server
npm start

# 7. Open http://localhost:3000
```

---

## 🔧 v4.0 Critical Fixes

| Issue | Fix |
|-------|-----|
| **Lost swaramu/sahityamu processing** | Every segment now extracts swaras from actual audio pitch frames |
| **No western notation** | Full western note mapping (C, C#, D, etc.) alongside Carnatic swaras |
| **Missing pallavi/anupallavi/charanam swaras** | Section-wise `sectionSwaraMap` with audio-extracted swaras for each section |
| **Aalapana had no swaras** | `aalapanaBlocks` array with time ranges + extracted swaras + western notes |
| **Hardcoded lyrics only** | Audio transcription is PRIMARY; composition DB only enhances when transcription is clean |
| **Compose tab missing** | Full Compose tab restored with raga/tala/section inputs + MusicXML/MIDI generation |
| **Saved sessions lost** | New `/api/analyses` + `/api/analysis/:id` endpoints; Saved tab with refresh/load |
| **Async DB crashes** | `sqlite.js` fully promisified with `run/get/all/close` |
| **Hallucination not caught** | `detectHallucination()` filters garbage transcription before DB save |

---

## 📁 File Structure

```
gomaa-raga-vidya/
├── backend/
│   ├── server.js              # Express server + API routes
│   ├── routes/
│   │   ├── recognize.js       # MAIN: audio analysis pipeline (v4.0)
│   │   └── compose.js         # Composition generation
│   └── utils/
│       └── download.js        # YouTube/external URL download
├── core/
│   ├── ai/
│   │   ├── carnaticSegmenter.js   # Audio segmentation + swara mapping
│   │   ├── sheetMusicEngine.js    # MusicXML + MIDI generation
│   │   ├── ragaModel.js           # Raga detection
│   │   ├── fusionEngine.js        # Multi-source fusion
│   │   ├── audioEmbedding.js      # Audio embeddings
│   │   └── transcribe.py          # Whisper transcription script
│   ├── audio/
│   │   ├── audioDecode.js     # FFmpeg audio decoding
│   │   └── fingerprint.js     # Audio fingerprinting
│   └── db/
│       └── sqlite.js          # Async SQLite wrapper
├── apps/
│   └── web/
│       └── index.html         # Frontend (v4.0 with Compose + Saved tabs)
├── scripts/
│   └── initDB.js              # Database initialization
├── models/                    # Data files (raga_db.json, tala_db.json, etc.)
└── package.json
```

---

## 🎼 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `POST /api/recognize` | multipart | Analyze audio file, URL, or recording |
| `POST /api/compose` | JSON | Generate new composition |
| `GET /api/analyses` | — | List all saved analyses |
| `GET /api/analysis/:id` | — | Load single analysis by ID |
| `GET /api/sheet/:id` | — | Download MusicXML |
| `GET /api/midi/:id` | — | Download MIDI |
| `GET /api/health` | — | Health check |

---

## 📊 Response Fields (v4.0 New)

```json
{
  "sectionSwaraMap": {
    "pallavi": {
      "swaras": "S R2 G3 P D2 S N3 D2 P...",
      "westernNotes": "C D E G A C B A G...",
      "lyrics": "Ekadantam bhajEham...",
      "lyricsTelugu": "ఏకదంతం భజేహం..."
    },
    "anupallavi": { ... },
    "charanam": { ... }
  },
  "aalapanaBlocks": [
    {
      "section": "Aalapana",
      "start": 0.0,
      "end": 6.0,
      "swaras": "S R2 G3 P D2 S...",
      "westernNotes": "C D E G A C...",
      "type": "ALAPANA"
    }
  ],
  "swaraFrames": [
    { "time": 0.000, "swara": "S", "westernNote": "C", "freq": 261.63, "gamaka": "attack" }
  ],
  "westernNotes": "C D E G A C B A G...",
  "lyrics": { "source": "audio_transcription+composition_db", ... }
}
```

---

## 📝 License

MIT
