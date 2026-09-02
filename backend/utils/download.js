/**
 * GoMaa Raga Vidya — download.js v4.0.2-patch5
 * Fixes:
 *   1. YouTube URLs: fast-fail with clear message instead of 300s hang
 *   2. Direct audio URLs (.mp3, .wav, etc.): download without yt-dlp
 *   3. Non-YouTube video URLs: use yt-dlp normally
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");

function execPromise(cmd, args, opts = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { shell: false, ...opts });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timeout = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      reject(new Error(`Timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    proc.stdout.on("data", d => stdout += d.toString());
    proc.stderr.on("data", d => stderr += d.toString());
    proc.on("error", (err) => {
      clearTimeout(timeout);
      if (err.code === "ENOENT") reject(new Error(`yt-dlp not found`));
      else reject(new Error(`yt-dlp spawn error: ${err.message}`));
    });
    proc.on("close", code => {
      clearTimeout(timeout);
      if (killed) return;
      if (code !== 0) reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      else resolve(stdout);
    });
  });
}

function findYtDlp() {
  const candidates = process.platform === "win32"
    ? ["yt-dlp.exe", "yt-dlp", path.join(process.cwd(), "yt-dlp.exe"), path.join(__dirname, "..", "..", "yt-dlp.exe")]
    : ["yt-dlp", path.join(process.cwd(), "yt-dlp"), path.join(__dirname, "..", "..", "yt-dlp")];
  for (const c of candidates) {
    try { if (c.includes(path.sep)) { if (fs.existsSync(c)) return c; } else { return c; } } catch (e) {}
  }
  return candidates[0];
}

function isYouTubeUrl(url) {
  return /(?:youtube\.com|youtu\.be)/i.test(url);
}

function isDirectAudioUrl(url) {
  return /\.(mp3|wav|flac|ogg|m4a|webm|aac)(\?.*)?$/i.test(url);
}

function downloadDirect(url, outPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const req = client.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadDirect(res.headers.location, outPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const file = fs.createWriteStream(outPath);
      res.pipe(file);
      file.on("finish", () => { file.close(); resolve(outPath); });
      file.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
  });
}

async function downloadFromUrl(url, outDir) {
  // ── Direct audio URL: download straight away ──
  if (isDirectAudioUrl(url)) {
    console.log(`[GoMaa] Direct audio URL detected: ${url}`);
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ext = path.extname(new URL(url).pathname) || ".mp3";
    const outPath = path.join(outDir, `${id}${ext}`);
    await downloadDirect(url, outPath);
    const title = path.basename(new URL(url).pathname, ext) || "audio";
    return {
      filePath: outPath,
      originalName: `${title}${ext}`,
      title,
      sourceUrl: url,
      youtubeMetadata: { title: "", description: "", uploader: "", duration: 0, url }
    };
  }

  // ── YouTube URL: fast-fail with honest message ──
  if (isYouTubeUrl(url)) {
    console.log(`[GoMaa] YouTube URL detected: ${url}`);
    // Quick test: can yt-dlp even see this URL?
    try {
      const ytdlp = findYtDlp();
      await execPromise(ytdlp, ["--dump-single-json", "--no-download", "--no-warnings", url], {}, 10000);
    } catch (e) {
      console.error("[GoMaa] YouTube metadata test failed:", e.message);
      throw new Error(
        "YouTube is actively blocking automated downloads. " +
        "Please download the audio manually: run 'yt-dlp -x --audio-format mp3 \"" + url + "\"' " +
        "then upload the MP3 file here."
      );
    }
    // If metadata worked, proceed with download
    const ytdlp = findYtDlp();
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const outTemplate = path.join(outDir, `${id}.%(ext)s`);
    await execPromise(ytdlp, [
      "-f", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
      "--extract-audio", "--audio-format", "mp3", "--audio-quality", "0",
      "-o", outTemplate, "--no-warnings", "--newline", url
    ], {}, 300000);
    const files = fs.readdirSync(outDir).filter(f => f.startsWith(id));
    const mp3File = files.find(f => f.endsWith(".mp3")) || files[0];
    if (!mp3File) throw new Error("Download failed: no output file.");
    const filePath = path.join(outDir, mp3File);
    let meta = {};
    try {
      const metaJson = await execPromise(ytdlp, ["--dump-json", "--no-download", filePath], {}, 10000);
      const jsonLine = metaJson.split("\n").find(l => l.trim().startsWith("{"));
      if (jsonLine) meta = JSON.parse(jsonLine);
    } catch (e) {}
    const title = meta.title || path.basename(mp3File, ".mp3");
    return {
      filePath,
      originalName: `${title}.mp3`,
      title,
      sourceUrl: url,
      youtubeMetadata: {
        title: meta.title || "",
        description: meta.description || "",
        uploader: meta.uploader || meta.channel || "",
        duration: meta.duration || 0,
        url
      }
    };
  }

  // ── Generic URL: try yt-dlp as fallback ──
  console.log(`[GoMaa] Generic URL, trying yt-dlp: ${url}`);
  const ytdlp = findYtDlp();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outTemplate = path.join(outDir, `${id}.%(ext)s`);
  await execPromise(ytdlp, [
    "-f", "bestaudio",
    "--extract-audio", "--audio-format", "mp3",
    "-o", outTemplate, "--no-warnings", url
  ], {}, 300000);
  const files = fs.readdirSync(outDir).filter(f => f.startsWith(id));
  const mp3File = files.find(f => f.endsWith(".mp3")) || files[0];
  if (!mp3File) throw new Error("Download failed.");
  return {
    filePath: path.join(outDir, mp3File),
    originalName: "audio.mp3",
    title: "audio",
    sourceUrl: url,
    youtubeMetadata: { title: "", description: "", uploader: "", duration: 0, url }
  };
}

module.exports = { downloadFromUrl };
