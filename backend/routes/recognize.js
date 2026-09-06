const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { generateSegmentSwaras } = require('../swaragen');

// Try to load ytdl-core for YouTube detection (optional — graceful fallback)
let ytdl = null;
try {
  ytdl = require('ytdl-core');
} catch (e) {
  console.warn('[recognize] ytdl-core not installed. YouTube detection disabled.');
}

// Live recording normalization via ffmpeg
let ffmpeg = null;
let ffmpegStatic = null;

try {
  ffmpeg = require('fluent-ffmpeg');
  ffmpegStatic = require('ffmpeg-static');

  if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
  }
} catch (e) {
  console.warn(
    '[recognize] fluent-ffmpeg/ffmpeg-static not installed. ' +
    'Live recording normalization disabled.'
  );
}

/**
 * Normalize an audio recording to:
 * - WAV
 * - 16 kHz
 * - mono
 * - signed 16-bit PCM
 */
async function normalizeLiveRecording(inputPath, outputPath) {
  if (!ffmpeg || !ffmpegStatic) {
    throw new Error('FFmpeg is not available');
  }

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFrequency(16000)
      .audioChannels(1)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('end', () => resolve(outputPath))
      .on('error', reject)
      .save(outputPath);
  });
}

// Helper: detect YouTube URL
function isYouTubeUrl(url) {
  return /^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url);
}

// Helper: detect direct audio URL
function isDirectAudioUrl(url) {
  return /\.(mp3|wav|ogg|webm|m4a|flac)(\?.*)?$/i.test(url);
}

// Helper: quick YouTube metadata probe
async function probeYouTube(url) {
  return new Promise((resolve) => {
    if (!ytdl) {
      resolve({
        blocked: true,
        reason: 'ytdl-core not installed'
      });
      return;
    }

    const timeout = setTimeout(() => {
      resolve({
        blocked: true,
        reason: 'Timed out after 10s'
      });
    }, 10000);

    ytdl
      .getBasicInfo(url)
      .then(() => {
        clearTimeout(timeout);
        resolve({ blocked: false });
      })
      .catch((err) => {
        clearTimeout(timeout);
        resolve({
          blocked: true,
          reason: err.message || 'YouTube request failed'
        });
      });
  });
}

/**
 * Download a direct HTTP/HTTPS audio URL.
 *
 * Supports redirects and rejects non-2xx responses.
 */
function downloadUrl(url, destPath, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      reject(new Error('Too many redirects while downloading audio'));
      return;
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(url);
    } catch (err) {
      reject(new Error('Invalid audio URL'));
      return;
    }

    const protocol = parsedUrl.protocol.toLowerCase();

    if (protocol !== 'http:' && protocol !== 'https:') {
      reject(new Error('Only HTTP and HTTPS URLs are supported'));
      return;
    }

    const client = protocol === 'https:' ? https : http;

    const request = client.get(parsedUrl, (response) => {
      // Handle redirects.
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();

        const redirectedUrl = new URL(
          response.headers.location,
          parsedUrl
        ).toString();

        downloadUrl(
          redirectedUrl,
          destPath,
          redirectCount + 1
        )
          .then(resolve)
          .catch(reject);

        return;
      }

      if (
        !response.statusCode ||
        response.statusCode < 200 ||
        response.statusCode >= 300
      ) {
        response.resume();
        reject(
          new Error(`Audio download failed: HTTP ${response.statusCode}`)
        );
        return;
      }

      const file = fs.createWriteStream(destPath);

      file.on('error', (err) => {
        response.destroy();
        reject(err);
      });

      response.on('error', (err) => {
        file.destroy();
        reject(err);
      });

      file.on('finish', () => {
        file.close(() => resolve(destPath));
      });

      response.pipe(file);
    });

    request.setTimeout(30000, () => {
      request.destroy(new Error('Audio download timed out'));
    });

    request.on('error', reject);
  });
}

/**
 * Safely get the uploaded file from different multer configurations.
 */
function getUploadedFile(req) {
  if (req.file) {
    return req.file;
  }

  if (req.files?.audio) {
    if (Array.isArray(req.files.audio)) {
      return req.files.audio[0] || null;
    }

    // Some upload middleware configurations return a single object.
    return req.files.audio;
  }

  return null;
}

// ==================== MAIN RECOGNIZE HANDLER ====================

router.post('/', async (req, res) => {
  let inputPath = null;
  let normalizedPath = null;

  try {
    const uploadedFile = getUploadedFile(req);
    const hasFile = !!uploadedFile;

    const url =
      typeof req.body?.url === 'string'
        ? req.body.url.trim()
        : '';

    let filename = 'unknown';
    let source = 'unknown';

    // -------- URL handling --------
    if (url && !hasFile) {
      console.log('[GoMaa] URL provided:', url);

      // YouTube URL
      if (isYouTubeUrl(url)) {
        console.log('[GoMaa] YouTube URL detected:', url);

        const probe = await probeYouTube(url);

        if (probe.blocked) {
          console.log(
            '[GoMaa] YouTube metadata test failed:',
            probe.reason
          );

          return res.status(400).json({
            error:
              'YouTube is blocking automated downloads. ' +
              'Please download the audio manually with yt-dlp ' +
              `and upload the MP3 file here.`
          });
        }

        return res.status(400).json({
          error:
            'YouTube downloads are not supported directly. ' +
            'Please download the audio manually with yt-dlp ' +
            'and upload the MP3.'
        });
      }

      // Direct audio URL
      if (isDirectAudioUrl(url)) {
        console.log(
          '[GoMaa] Direct audio URL detected:',
          url
        );

        const tempDir = path.join(
          __dirname,
          '..',
          '..',
          'temp'
        );

        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(tempDir, { recursive: true });
        }

        let ext = '.mp3';

        try {
          const parsedUrl = new URL(url);
          ext =
            path.extname(parsedUrl.pathname) || '.mp3';

          // Prevent weird extensions from becoming filenames.
          if (!/^\.(mp3|wav|ogg|webm|m4a|flac)$/i.test(ext)) {
            ext = '.mp3';
          }
        } catch (err) {
          return res.status(400).json({
            error: 'Invalid audio URL.'
          });
        }

        inputPath = path.join(
          tempDir,
          `download_${Date.now()}_${Math.random()
            .toString(36)
            .slice(2, 8)}${ext}`
        );

        await downloadUrl(url, inputPath);

        filename = path.basename(inputPath);
        source = 'url';
      } else {
        return res.status(400).json({
          error:
            'Unsupported URL. Please provide a direct audio URL ' +
            '(.mp3, .wav, .ogg, .webm, .m4a, .flac) or upload a file.'
        });
      }
    }

    // -------- File upload handling --------
    if (hasFile) {
      inputPath = uploadedFile.path;

      filename =
        uploadedFile.originalname ||
        path.basename(uploadedFile.path) ||
        'upload';

      source = 'upload';

      if (!inputPath || !fs.existsSync(inputPath)) {
        return res.status(400).json({
          error: 'Uploaded audio file could not be found.'
        });
      }
    }

    if (!inputPath) {
      return res.status(400).json({
        error: 'No file or valid URL provided.'
      });
    }

    console.log(
      `[GoMaa v4.0.3] Analysing: ${filename} (source: ${source})`
    );

    // ------------------------------------------------------------------
    // Normalize live recordings / WebM to 16kHz WAV for Whisper
    // ------------------------------------------------------------------
    const lowerFilename = filename.toLowerCase();

    if (
      ffmpeg &&
      ffmpegStatic &&
      (
        lowerFilename.includes('live_recording') ||
        lowerFilename.endsWith('.webm')
      )
    ) {
      normalizedPath = inputPath.replace(
        /\.[^.]+$/i,
        '_16k.wav'
      );

      try {
        await normalizeLiveRecording(
          inputPath,
          normalizedPath
        );

        inputPath = normalizedPath;

        console.log(
          '[GoMaa] Live recording normalized to:',
          inputPath
        );
      } catch (normErr) {
        console.warn(
          '[GoMaa] Normalization failed, using original:',
          normErr.message
        );

        normalizedPath = null;
      }
    }

    // ------------------------------------------------------------------
    // EXISTING ANALYSIS PIPELINE
    // ------------------------------------------------------------------
    //
    // Replace this section with your real analysis:
    //
    // 1. Load audio
    // 2. YIN pitch detection
    // 3. Comb-filter beat detection
    // 4. Composition DB match
    // 5. generateSegmentSwaras(...)
    // 6. Build raga/tala/composer/segments/sahityam response
    //
    // ------------------------------------------------------------------

    const analysisResult = {
      success: true,
      title: filename,
      raga: 'Unknown',
      tala: 'Unknown',
      composer: 'Unknown',
      duration: 0,
      source,
      segments: [],
      sahityam: {},
      aroha: '',
      avaroha: '',
      audioUrl: source === 'url' ? url : undefined
    };

    // ------------------------------------------------------------------
    // DB SAVE
    // ------------------------------------------------------------------
    try {
      const dbPath = path.join(
        __dirname,
        '..',
        '..',
        'models',
        'music.db'
      );

      // Correct project-root-relative import.
      const sqliteModule = require('../../core/db/sqlite');

      const db =
        typeof sqliteModule === 'function'
          ? sqliteModule(dbPath)
          : sqliteModule;

      const id =
        `${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 11)}`;

      const insert = db.prepare(`
        INSERT INTO music (
          id,
          filename,
          originalName,
          compositionId,
          title,
          raga,
          tala,
          composer,
          duration,
          sahityam
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      /*
       * IMPORTANT:
       *
       * compositionId was previously receiving:
       *
       *   analysisResult.title
       *
       * That is incorrect unless your schema intentionally uses
       * the title as the composition ID.
       *
       * Use analysisResult.compositionId when available.
       */
      const result = insert.run(
        id,
        filename,
        filename,
        analysisResult.compositionId || null,
        analysisResult.title || null,
        analysisResult.raga || null,
        analysisResult.tala || null,
        analysisResult.composer || null,
        Number(analysisResult.duration) || 0,
        JSON.stringify(analysisResult.sahityam || {})
      );

      // Supports both synchronous DBs (better-sqlite3)
      // and Promise-returning wrappers.
      if (result && typeof result.then === 'function') {
        await result;
      }

      console.log(
        `[GoMaa v4.0.3] Saved to DB: ${id}`
      );

      if (typeof db.close === 'function') {
        db.close();
      }
    } catch (dbErr) {
      // DB failure should not prevent recognition response.
      console.error(
        '[GoMaa] DB save failed (non-fatal):',
        dbErr
      );
    }

    return res.json(analysisResult);
  } catch (err) {
    console.error(
      '[GoMaa] Recognize error:',
      err
    );

    return res.status(500).json({
      error: err.message || 'Audio recognition failed.'
    });
  } finally {
    // Remove generated normalized WAV.
    if (
      normalizedPath &&
      fs.existsSync(normalizedPath)
    ) {
      try {
        fs.unlinkSync(normalizedPath);
      } catch (cleanupErr) {
        console.warn(
          '[GoMaa] Could not remove normalized file:',
          cleanupErr.message
        );
      }
    }
  }
});

module.exports = router;
