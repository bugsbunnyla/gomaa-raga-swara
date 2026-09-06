const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { generateSegmentSwaras } = require('../swaragen');

// -----------------------------------------------------------------------------
// URL downloader
//
// IMPORTANT:
// This is the existing downloader in backend/utils/download.js.
// YouTube extraction is handled there with yt-dlp.
// -----------------------------------------------------------------------------

const {
  downloadFromUrl
} = require('../utils/download');

// -----------------------------------------------------------------------------
// Live recording normalization via ffmpeg
// -----------------------------------------------------------------------------

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

  /*
   * This tracks files created by downloadFromUrl().
   *
   * Uploaded files are NOT automatically deleted here because
   * the existing application may have its own upload lifecycle.
   */
  let downloadedPath = null;

  try {
    const uploadedFile =
      getUploadedFile(req);

    const hasFile =
      !!uploadedFile;

    const url =
      typeof req.body?.url === 'string'
        ? req.body.url.trim()
        : '';

    let filename = 'unknown';
    let source = 'unknown';

    // =========================================================================
    // URL HANDLING
    // =========================================================================

    if (url && !hasFile) {
      console.log(
        '[GoMaa] URL provided:',
        url
      );

      /*
       * IMPORTANT YOUTUBE FIX
       *
       * Previously this route:
       *
       *   1. detected YouTube
       *   2. ran ytdl-core metadata probe
       *   3. rejected the request
       *
       * It now delegates ALL URL downloading to the existing
       * backend/utils/download.js utility.
       *
       * That utility handles:
       *
       *   YouTube URL
       *       ↓
       *   yt-dlp
       *       ↓
       *   MP3
       *
       * and:
       *
       *   direct audio URL
       *       ↓
       *   HTTP/HTTPS download
       *       ↓
       *   local audio file
       */

      try {
        const tempDir =
          path.join(
            __dirname,
            '..',
            '..',
            'temp'
          );

        if (!fs.existsSync(tempDir)) {
          fs.mkdirSync(
            tempDir,
            {
              recursive: true
            }
          );
        }

        const downloaded =
          await downloadFromUrl(
            url,
            tempDir
          );

        if (
          !downloaded ||
          !downloaded.filePath
        ) {
          throw new Error(
            'URL downloader did not return an audio file.'
          );
        }

        inputPath =
          downloaded.filePath;

        downloadedPath =
          downloaded.filePath;

        filename =
          downloaded.originalName ||
          path.basename(
            downloaded.filePath
          ) ||
          'audio';

        /*
         * Preserve the existing source semantics:
         *
         * YouTube and direct URL both come through the URL downloader,
         * so the recognition result continues to identify the input
         * as a URL source.
         */
        source = 'url';

        console.log(
          '[GoMaa] URL audio ready:',
          inputPath
        );

        /*
         * If YouTube metadata is available, use the YouTube title
         * as the filename/title input where possible.
         *
         * The analysis pipeline remains unchanged.
         */
        if (
          downloaded.youtubeMetadata &&
          downloaded.youtubeMetadata.title
        ) {
          filename =
            downloaded.originalName ||
            `${downloaded.youtubeMetadata.title}.mp3`;
        }

      } catch (downloadErr) {
        console.error(
          '[GoMaa] URL download/extraction failed:',
          downloadErr.message
        );

        return res.status(400).json({
          error:
            downloadErr.message ||
            'Unable to download or extract audio from URL.'
        });
      }
    }

    // =========================================================================
    // FILE UPLOAD HANDLING
    // =========================================================================

    if (hasFile) {
      inputPath =
        uploadedFile.path;

      filename =
        uploadedFile.originalname ||
        path.basename(
          uploadedFile.path
        ) ||
        'upload';

      source =
        'upload';

      if (
        !inputPath ||
        !fs.existsSync(inputPath)
      ) {
        return res.status(400).json({
          error:
            'Uploaded audio file could not be found.'
        });
      }
    }

    // =========================================================================
    // NO INPUT
    // =========================================================================

    if (!inputPath) {
      return res.status(400).json({
        error:
          'No file or valid URL provided.'
      });
    }

    console.log(
      `[GoMaa v4.0.3] Analysing: ${filename} (source: ${source})`
    );

    // =========================================================================
    // NORMALIZE LIVE RECORDINGS / WEBM TO 16KHZ WAV FOR WHISPER
    // =========================================================================

    const lowerFilename =
      filename.toLowerCase();

    if (
      ffmpeg &&
      ffmpegStatic &&
      (
        lowerFilename.includes(
          'live_recording'
        ) ||
        lowerFilename.endsWith(
          '.webm'
        )
      )
    ) {
      normalizedPath =
        inputPath.replace(
          /\.[^.]+$/i,
          '_16k.wav'
        );

      try {
        await normalizeLiveRecording(
          inputPath,
          normalizedPath
        );

        inputPath =
          normalizedPath;

        console.log(
          '[GoMaa] Live recording normalized to:',
          inputPath
        );

      } catch (normErr) {
        console.warn(
          '[GoMaa] Normalization failed, using original:',
          normErr.message
        );

        normalizedPath =
          null;
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

      /*
       * Preserve the existing response shape.
       *
       * For URL inputs this remains the original URL, as before.
       */
      audioUrl:
        source === 'url'
          ? url
          : undefined
    };

    // ------------------------------------------------------------------
    // DB SAVE
    // ------------------------------------------------------------------

    try {
      const dbPath =
        path.join(
          __dirname,
          '..',
          '..',
          'models',
          'music.db'
        );

      // Correct project-root-relative import.
      const sqliteModule =
        require('../../core/db/sqlite');

      const db =
        typeof sqliteModule === 'function'
          ? sqliteModule(dbPath)
          : sqliteModule;

      const id =
        `${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 11)}`;

      const insert =
        db.prepare(`
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

      const result =
        insert.run(
          id,
          filename,
          filename,
          analysisResult.compositionId || null,
          analysisResult.title || null,
          analysisResult.raga || null,
          analysisResult.tala || null,
          analysisResult.composer || null,
          Number(
            analysisResult.duration
          ) || 0,
          JSON.stringify(
            analysisResult.sahityam || {}
          )
        );

      // Supports both synchronous DBs (better-sqlite3)
      // and Promise-returning wrappers.
      if (
        result &&
        typeof result.then === 'function'
      ) {
        await result;
      }

      console.log(
        `[GoMaa v4.0.3] Saved to DB: ${id}`
      );

      if (
        typeof db.close === 'function'
      ) {
        db.close();
      }

    } catch (dbErr) {
      // DB failure should not prevent recognition response.
      console.error(
        '[GoMaa] DB save failed (non-fatal):',
        dbErr
      );
    }

    return res.json(
      analysisResult
    );

  } catch (err) {
    console.error(
      '[GoMaa] Recognize error:',
      err
    );

    return res.status(500).json({
      error:
        err.message ||
        'Audio recognition failed.'
    });

  } finally {
    // -------------------------------------------------------------------------
    // Remove generated normalized WAV.
    // -------------------------------------------------------------------------

    if (
      normalizedPath &&
      fs.existsSync(normalizedPath)
    ) {
      try {
        fs.unlinkSync(
          normalizedPath
        );
      } catch (cleanupErr) {
        console.warn(
          '[GoMaa] Could not remove normalized file:',
          cleanupErr.message
        );
      }
    }

    // -------------------------------------------------------------------------
    // Remove downloaded URL audio.
    //
    // Only files created by downloadFromUrl() are removed here.
    // Uploaded files are left alone.
    // -------------------------------------------------------------------------

    if (
      downloadedPath &&
      downloadedPath !== normalizedPath &&
      fs.existsSync(downloadedPath)
    ) {
      try {
        fs.unlinkSync(
          downloadedPath
        );

        console.log(
          '[GoMaa] Removed temporary downloaded audio:',
          downloadedPath
        );

      } catch (cleanupErr) {
        console.warn(
          '[GoMaa] Could not remove downloaded audio:',
          cleanupErr.message
        );
      }
    }
  }
});

module.exports = router;
