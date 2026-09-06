/**
 * GoMaa Raga Vidya — download.js
 *
 * URL download / extraction utility.
 *
 * Supports:
 *   1. YouTube URLs via yt-dlp
 *   2. Direct audio URLs (.mp3, .wav, .ogg, .m4a, .flac, .webm, .aac)
 *   3. Generic URLs via yt-dlp fallback
 *
 * YouTube behavior:
 *   - DO NOT perform a separate metadata probe first.
 *   - Directly ask yt-dlp to extract the best available audio.
 *   - This avoids the old 10-second ytdl-core / metadata fast-fail.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");

// -----------------------------------------------------------------------------
// Execute command with timeout
// -----------------------------------------------------------------------------

function execPromise(cmd, args, opts = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      shell: false,
      ...opts
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timeout = setTimeout(() => {
      killed = true;

      try {
        proc.kill("SIGTERM");
      } catch (e) {}

      reject(
        new Error(
          `Timed out after ${timeoutMs / 1000}s`
        )
      );
    }, timeoutMs);

    proc.stdout.on("data", d => {
      stdout += d.toString();
    });

    proc.stderr.on("data", d => {
      stderr += d.toString();
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);

      if (err.code === "ENOENT") {
        reject(
          new Error(
            "yt-dlp not found. Install yt-dlp and make sure it is available in PATH."
          )
        );
      } else {
        reject(
          new Error(
            `yt-dlp spawn error: ${err.message}`
          )
        );
      }
    });

    proc.on("close", code => {
      clearTimeout(timeout);

      if (killed) return;

      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() ||
            `yt-dlp exited with code ${code}`
          )
        );
      } else {
        resolve(stdout);
      }
    });
  });
}

// -----------------------------------------------------------------------------
// Find yt-dlp
// -----------------------------------------------------------------------------

function findYtDlp() {
  const candidates =
    process.platform === "win32"
      ? [
          "yt-dlp.exe",
          "yt-dlp",
          path.join(process.cwd(), "yt-dlp.exe"),
          path.join(
            __dirname,
            "..",
            "..",
            "yt-dlp.exe"
          )
        ]
      : [
          "yt-dlp",
          path.join(
            process.cwd(),
            "yt-dlp"
          ),
          path.join(
            __dirname,
            "..",
            "..",
            "yt-dlp"
          )
        ];

  for (const c of candidates) {
    try {
      /*
       * If this is an explicit path, make sure
       * the file actually exists.
       *
       * If it is just "yt-dlp", allow PATH lookup.
       */
      if (c.includes(path.sep)) {
        if (fs.existsSync(c)) {
          return c;
        }
      } else {
        return c;
      }
    } catch (e) {}
  }

  return candidates[0];
}

// -----------------------------------------------------------------------------
// Detect YouTube URL
// -----------------------------------------------------------------------------

function isYouTubeUrl(url) {
  if (!url || typeof url !== "string") {
    return false;
  }

  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.toLowerCase();

    return (
      host === "youtube.com" ||
      host === "www.youtube.com" ||
      host === "m.youtube.com" ||
      host === "music.youtube.com" ||
      host === "youtu.be" ||
      host === "www.youtu.be"
    );
  } catch (e) {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Detect direct audio URL
// -----------------------------------------------------------------------------

function isDirectAudioUrl(url) {
  if (!url || typeof url !== "string") {
    return false;
  }

  return /\.(mp3|wav|flac|ogg|m4a|webm|aac)(\?.*)?$/i.test(
    url
  );
}

// -----------------------------------------------------------------------------
// Download direct HTTP/HTTPS audio
// -----------------------------------------------------------------------------

function downloadDirect(url, outPath) {
  return new Promise((resolve, reject) => {
    let parsed;

    try {
      parsed = new URL(url);
    } catch (e) {
      reject(new Error("Invalid URL"));
      return;
    }

    const client =
      parsed.protocol === "https:"
        ? https
        : http;

    const req = client.get(
      parsed,
      {
        timeout: 30000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 GoMaa-Raga-Vidya"
        }
      },
      (res) => {
        // ---------------------------------------------------------------
        // Redirect
        // ---------------------------------------------------------------

        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();

          const redirected =
            new URL(
              res.headers.location,
              parsed
            ).toString();

          return downloadDirect(
            redirected,
            outPath
          )
            .then(resolve)
            .catch(reject);
        }

        // ---------------------------------------------------------------
        // HTTP error
        // ---------------------------------------------------------------

        if (res.statusCode !== 200) {
          res.resume();

          reject(
            new Error(
              `HTTP ${res.statusCode}`
            )
          );

          return;
        }

        // ---------------------------------------------------------------
        // Save file
        // ---------------------------------------------------------------

        const file =
          fs.createWriteStream(outPath);

        let finished = false;

        const fail = (err) => {
          if (finished) return;

          finished = true;

          try {
            file.destroy();
          } catch (e) {}

          try {
            if (fs.existsSync(outPath)) {
              fs.unlinkSync(outPath);
            }
          } catch (e) {}

          reject(err);
        };

        res.on("error", fail);

        file.on("error", fail);

        file.on("finish", () => {
          file.close(() => {
            if (finished) return;

            finished = true;

            try {
              const stat =
                fs.statSync(outPath);

              if (!stat.size) {
                try {
                  fs.unlinkSync(outPath);
                } catch (e) {}

                reject(
                  new Error(
                    "Downloaded audio file is empty."
                  )
                );

                return;
              }

              resolve(outPath);
            } catch (err) {
              reject(err);
            }
          });
        });

        res.pipe(file);
      }
    );

    req.on("error", reject);

    req.on("timeout", () => {
      req.destroy();

      reject(
        new Error(
          "Request timeout"
        )
      );
    });
  });
}

// -----------------------------------------------------------------------------
// Download/extract from URL
// -----------------------------------------------------------------------------

async function downloadFromUrl(url, outDir) {
  if (
    !url ||
    typeof url !== "string"
  ) {
    throw new Error(
      "URL is required."
    );
  }

  if (!outDir) {
    throw new Error(
      "Output directory is required."
    );
  }

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(
      outDir,
      {
        recursive: true
      }
    );
  }

  // ===========================================================================
  // Direct audio URL
  // ===========================================================================

  if (isDirectAudioUrl(url)) {
    console.log(
      `[GoMaa] Direct audio URL detected: ${url}`
    );

    const id =
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

    let ext = ".mp3";

    try {
      ext =
        path.extname(
          new URL(url).pathname
        ) || ".mp3";

      if (
        !/^\.(mp3|wav|flac|ogg|m4a|webm|aac)$/i.test(
          ext
        )
      ) {
        ext = ".mp3";
      }
    } catch (e) {}

    const outPath =
      path.join(
        outDir,
        `${id}${ext}`
      );

    await downloadDirect(
      url,
      outPath
    );

    const title =
      path.basename(
        outPath,
        ext
      ) || "audio";

    return {
      filePath: outPath,
      originalName: `${title}${ext}`,
      title,
      sourceUrl: url,
      youtubeMetadata: {
        title: "",
        description: "",
        uploader: "",
        duration: 0,
        url
      }
    };
  }

  // ===========================================================================
  // YouTube URL
  //
  // IMPORTANT FIX:
  //
  // The previous implementation first did:
  //
  //   yt-dlp --dump-single-json --no-download
  //
  // with a 10-second timeout.
  //
  // That metadata probe was unnecessary and caused YouTube URLs to be
  // rejected before the actual extraction was attempted.
  //
  // We now go directly to yt-dlp audio extraction.
  // ===========================================================================

  if (isYouTubeUrl(url)) {
    console.log(
      `[GoMaa] YouTube URL detected: ${url}`
    );

    const ytdlp =
      findYtDlp();

    const id =
      `${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

    const outTemplate =
      path.join(
        outDir,
        `${id}.%(ext)s`
      );

    console.log(
      "[GoMaa] Extracting YouTube audio with yt-dlp..."
    );

    try {
      /*
       * Direct audio extraction.
       *
       * We deliberately do NOT run a metadata-only probe first.
       *
       * Prefer m4a/webm audio where available and let yt-dlp choose
       * the best available audio stream.
       */
      await execPromise(
        ytdlp,
        [
          "-f",
          "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",

          "--extract-audio",

          "--audio-format",
          "mp3",

          "--audio-quality",
          "0",

          "--no-playlist",

          "--no-warnings",

          "--newline",

          "-o",
          outTemplate,

          url
        ],
        {},
        300000
      );

    } catch (e) {
      console.error(
        "[GoMaa] YouTube extraction failed:",
        e.message
      );

      const message =
        String(e.message || "");

      if (
        /yt-dlp not found/i.test(
          message
        )
      ) {
        throw new Error(
          "yt-dlp is not installed or not available in PATH. " +
          'Run "yt-dlp --version" from the same terminal used to start the server.'
        );
      }

      if (
        /ffmpeg|ffprobe/i.test(
          message
        )
      ) {
        throw new Error(
          "FFmpeg/ffprobe is required for YouTube audio extraction. " +
          'Run "ffmpeg -version" and "ffprobe -version" to verify installation.'
        );
      }

      throw new Error(
        `YouTube audio extraction failed: ${message}`
      );
    }

    // -------------------------------------------------------------------------
    // Find resulting MP3
    // -------------------------------------------------------------------------

    const files =
      fs
        .readdirSync(outDir)
        .filter(
          f =>
            f.startsWith(id)
        );

    const mp3File =
      files.find(
        f =>
          f.toLowerCase()
            .endsWith(".mp3")
      ) ||
      files[0];

    if (!mp3File) {
      throw new Error(
        "YouTube download failed: no output audio file was created."
      );
    }

    const filePath =
      path.join(
        outDir,
        mp3File
      );

    if (!fs.existsSync(filePath)) {
      throw new Error(
        "YouTube download failed: output audio file does not exist."
      );
    }

    const stat =
      fs.statSync(
        filePath
      );

    if (!stat.size) {
      try {
        fs.unlinkSync(
          filePath
        );
      } catch (e) {}

      throw new Error(
        "YouTube extraction produced an empty audio file."
      );
    }

    // -------------------------------------------------------------------------
    // Get YouTube metadata AFTER successful extraction.
    //
    // This is informational only. Failure here must NOT cause the audio
    // extraction to fail.
    // -------------------------------------------------------------------------

    let meta = {};

    try {
      const metaJson =
        await execPromise(
          ytdlp,
          [
            "--dump-single-json",
            "--no-download",
            "--no-warnings",
            "--skip-download",
            url
          ],
          {},
          30000
        );

      const jsonLine =
        metaJson
          .split("\n")
          .find(
            l =>
              l.trim()
                .startsWith("{")
          );

      if (jsonLine) {
        meta =
          JSON.parse(
            jsonLine
          );
      }
    } catch (e) {
      console.warn(
        "[GoMaa] YouTube metadata unavailable; continuing with extracted audio."
      );
    }

    const title =
      meta.title ||
      path.basename(
        mp3File,
        ".mp3"
      ) ||
      "youtube_audio";

    console.log(
      `[GoMaa] YouTube audio extracted successfully: ${filePath}`
    );

    return {
      filePath,

      originalName:
        `${title}.mp3`,

      title,

      sourceUrl:
        url,

      youtubeMetadata: {
        title:
          meta.title || "",

        description:
          meta.description || "",

        uploader:
          meta.uploader ||
          meta.channel ||
          "",

        duration:
          meta.duration || 0,

        url
      }
    };
  }

  // ===========================================================================
  // Generic URL
  // ===========================================================================

  console.log(
    `[GoMaa] Generic URL, trying yt-dlp: ${url}`
  );

  const ytdlp =
    findYtDlp();

  const id =
    `${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

  const outTemplate =
    path.join(
      outDir,
      `${id}.%(ext)s`
    );

  await execPromise(
    ytdlp,
    [
      "-f",
      "bestaudio",

      "--extract-audio",

      "--audio-format",
      "mp3",

      "-o",
      outTemplate,

      "--no-warnings",

      "--no-playlist",

      url
    ],
    {},
    300000
  );

  const files =
    fs
      .readdirSync(outDir)
      .filter(
        f =>
          f.startsWith(id)
      );

  const mp3File =
    files.find(
      f =>
        f.toLowerCase()
          .endsWith(".mp3")
    ) ||
    files[0];

  if (!mp3File) {
    throw new Error(
      "Download failed: no output file."
    );
  }

  return {
    filePath:
      path.join(
        outDir,
        mp3File
      ),

    originalName:
      "audio.mp3",

    title:
      "audio",

    sourceUrl:
      url,

    youtubeMetadata: {
      title: "",
      description: "",
      uploader: "",
      duration: 0,
      url
    }
  };
}

// -----------------------------------------------------------------------------
// Export
// -----------------------------------------------------------------------------

module.exports = {
  downloadFromUrl,
  isYouTubeUrl,
  isDirectAudioUrl
};
