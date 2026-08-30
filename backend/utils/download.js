"use strict";
/**
 * GoMaa Download Utilities v3.1
 * Supports: YouTube (yt-dlp), generic HTTP/HTTPS URLs
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const crypto = require("crypto");

const UPLOAD_DIR = path.join(__dirname, "../../uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const YT_HOSTS = ["youtube.com", "www.youtube.com", "youtu.be", "youtube-nocookie.com", "m.youtube.com", "music.youtube.com"];
const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Accept": "audio/*,video/*,*/*;q=0.8",
  "Accept-Encoding": "identity",
  "Cache-Control": "no-cache",
  "Referer": "https://www.youtube.com/"
};

function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    return YT_HOSTS.includes(host);
  } catch (_) {
    return false;
  }
}

function extractYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.slice(1).split("?")[0];
    }
    return u.searchParams.get("v") || u.searchParams.get("vi");
  } catch (_) {
    return null;
  }
}

function findYtdlp() {
  const candidates = process.platform === "win32"
    ? ["yt-dlp.exe", "yt-dlp", "youtube-dl.exe", "youtube-dl"]
    : ["yt-dlp", "youtube-dl", "yt-dlp.exe"];
  for (const bin of candidates) {
    try {
      const { execSync } = require("child_process");
      execSync(`"${bin}" --version`, { stdio: "ignore", timeout: 5000 });
      return bin;
    } catch (_) {}
  }
  return null;
}

/**
 * Download audio from YouTube using yt-dlp
 */
function downloadYouTube(url, outputDir = UPLOAD_DIR) {
  return new Promise((resolve, reject) => {
    const ytdlp = findYtdlp();
    if (!ytdlp) {
      return reject(new Error("yt-dlp not found. Install it: pip install yt-dlp"));
    }

    const videoId = extractYouTubeId(url);
    if (!videoId) {
      return reject(new Error("Could not extract YouTube video ID"));
    }

    const outputPath = path.join(outputDir, `${videoId}.mp3`);

    // Skip if already cached (less than 1 hour old)
    if (fs.existsSync(outputPath)) {
      const stat = fs.statSync(outputPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < 60 * 60 * 1000) {
        console.log(`[Download] Using cached YouTube audio: ${outputPath}`);
        return resolve({ filePath: outputPath, originalName: `${videoId}.mp3`, sourceUrl: url, cached: true });
      }
    }

    console.log(`[Download] Starting yt-dlp for: ${url}`);

    const args = [
      "--no-playlist",
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", "0",     // best
      "--output", outputPath,
      "--no-warnings",
      "--no-check-certificates",
      "--user-agent", FETCH_HEADERS["User-Agent"],
      "--add-header", `Referer:${FETCH_HEADERS.Referer}`,
      url
    ];

    const proc = spawn(ytdlp, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: 300000  // 5 minutes
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", d => stdout += d.toString());
    proc.stderr.on("data", d => stderr += d.toString());

    proc.on("close", (code) => {
      if (code !== 0) {
        // Sometimes yt-dlp returns non-zero but file exists
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1024) {
          console.warn(`[Download] yt-dlp exited ${code} but file exists. Using it.`);
          return resolve({ filePath: outputPath, originalName: `${videoId}.mp3`, sourceUrl: url, cached: false });
        }
        return reject(new Error(`yt-dlp failed (code ${code}): ${stderr.slice(0, 500)}`));
      }
      if (!fs.existsSync(outputPath)) {
        return reject(new Error("yt-dlp did not produce output file"));
      }
      console.log(`[Download] YouTube audio saved: ${outputPath}`);
      resolve({ filePath: outputPath, originalName: `${videoId}.mp3`, sourceUrl: url, cached: false });
    });

    proc.on("error", (err) => {
      reject(new Error(`yt-dlp spawn error: ${err.message}`));
    });
  });
}

/**
 * Download audio from a generic HTTP/HTTPS URL
 */
function downloadGenericUrl(url, outputDir = UPLOAD_DIR) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const ext = path.extname(urlObj.pathname) || ".mp3";
    const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
    const outputPath = path.join(outputDir, `url_${hash}${ext}`);

    // Skip if cached
    if (fs.existsSync(outputPath)) {
      const stat = fs.statSync(outputPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < 60 * 60 * 1000) {
        console.log(`[Download] Using cached URL: ${outputPath}`);
        return resolve({ filePath: outputPath, originalName: path.basename(urlObj.pathname) || `download${ext}`, sourceUrl: url, cached: true });
      }
    }

    console.log(`[Download] Fetching generic URL: ${url}`);

    const client = urlObj.protocol === "https:" ? https : http;
    const req = client.get(url, { headers: FETCH_HEADERS, timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        return downloadGenericUrl(res.headers.location, outputDir).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
      }

      const file = fs.createWriteStream(outputPath);
      let totalBytes = 0;
      const MAX_BYTES = 200 * 1024 * 1024; // 200MB limit

      res.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BYTES) {
          file.destroy();
          fs.unlinkSync(outputPath);
          reject(new Error("Download too large (>200MB)"));
        }
      });

      res.pipe(file);
      file.on("finish", () => {
        file.close();
        if (fs.statSync(outputPath).size < 1024) {
          fs.unlinkSync(outputPath);
          return reject(new Error("Downloaded file is too small (<1KB)"));
        }
        console.log(`[Download] Saved ${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(2)} MB to ${outputPath}`);
        resolve({
          filePath: outputPath,
          originalName: path.basename(urlObj.pathname) || `download${ext}`,
          sourceUrl: url,
          cached: false
        });
      });

      file.on("error", (err) => {
        fs.unlinkSync(outputPath).catch(() => {});
        reject(new Error(`File write error: ${err.message}`));
      });
    });

    req.on("error", (err) => {
      reject(new Error(`Download request failed: ${err.message}`));
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Download timed out after 60s"));
    });
  });
}

/**
 * Unified download handler
 */
async function downloadFromUrl(url, outputDir = UPLOAD_DIR) {
  if (isYouTubeUrl(url)) {
    return downloadYouTube(url, outputDir);
  }
  return downloadGenericUrl(url, outputDir);
}

module.exports = {
  downloadFromUrl,
  downloadYouTube,
  downloadGenericUrl,
  isYouTubeUrl,
  extractYouTubeId,
  findYtdlp,
  YT_HOSTS
};
