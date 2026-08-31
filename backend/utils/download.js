"use strict";
/**
 * GoMaa Raga Vidya v4.0 — URL Download Utility
 * Fixes:
 *   - Better yt-dlp error handling with informative messages
 *   - Fallback to yt-dlp with --no-check-certificate
 *   - Clear error messages for missing JS runtime
 *   - Support for playlist URLs by extracting single video
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function checkYtDlp() {
  try {
    const out = execSync("yt-dlp --version", { encoding: "utf8", timeout: 10000 });
    return out.trim();
  } catch (e) {
    return null;
  }
}

function getYtDlpErrorAdvice(stderr) {
  const msg = stderr || "";
  if (msg.includes("No supported JavaScript runtime")) {
    return "yt-dlp requires a JavaScript runtime (Node.js or Deno) to download from YouTube. " +
           "Install Node.js from https://nodejs.org or run: npm install -g yt-dlp";
  }
  if (msg.includes("503") || msg.includes("Service Unavailable")) {
    return "YouTube returned 503 Service Unavailable. This is usually temporary. " +
           "Try again in a few minutes, or the video may be restricted.";
  }
  if (msg.includes("Sign in to confirm")) {
    return "YouTube is requiring sign-in for this video. Try a different video URL.";
  }
  if (msg.includes("Private video")) {
    return "This YouTube video is private or unavailable.";
  }
  if (msg.includes("Video unavailable")) {
    return "This YouTube video is unavailable (may be deleted or region-blocked).";
  }
  if (msg.includes("not found") || msg.includes("command not found")) {
    return "yt-dlp is not installed. Install it with: pip install yt-dlp";
  }
  return msg.split("\n").slice(0, 3).join(" ");
}

async function downloadFromUrl(url, destDir) {
  const isYouTube = /youtube\.com|youtu\.be/.test(url);
  const fileName = `download_${Date.now()}.mp3`;
  const filePath = path.join(destDir, fileName);

  if (isYouTube) {
    const ytDlpVersion = checkYtDlp();
    if (!ytDlpVersion) {
      throw new Error("yt-dlp is not installed. Install it with: pip install yt-dlp");
    }

    // Clean the URL - extract just the video ID to avoid playlist issues
    let cleanUrl = url;
    const videoIdMatch = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
    if (videoIdMatch) {
      cleanUrl = `https://www.youtube.com/watch?v=${videoIdMatch[1]}`;
    }

    const attempts = [
      // Attempt 1: Standard download
      `yt-dlp -x --audio-format mp3 --audio-quality 0 --no-playlist -o "${filePath}" "${cleanUrl}"`,
      // Attempt 2: With no-check-certificate and geo-bypass
      `yt-dlp -x --audio-format mp3 --audio-quality 0 --no-playlist --no-check-certificate --geo-bypass -o "${filePath}" "${cleanUrl}"`,
      // Attempt 3: Force IPv4, ignore errors
      `yt-dlp -x --audio-format mp3 --audio-quality 0 --no-playlist --no-check-certificate --geo-bypass --force-ipv4 --ignore-errors -o "${filePath}" "${cleanUrl}"`
    ];

    let lastError = "";
    for (let i = 0; i < attempts.length; i++) {
      try {
        execSync(attempts[i], { timeout: 300000, stdio: "pipe" });
        // Verify file was created
        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1024) {
          return { filePath, originalName: "youtube_audio.mp3", sourceUrl: cleanUrl };
        }
      } catch (e) {
        lastError = e.stderr ? e.stderr.toString() : e.message;
        console.warn(`[GoMaa] yt-dlp attempt ${i + 1} failed:`, lastError.substring(0, 200));
        // Clean up partial file
        if (fs.existsSync(filePath)) {
          try { fs.unlinkSync(filePath); } catch (_) {}
        }
      }
    }

    const advice = getYtDlpErrorAdvice(lastError);
    throw new Error(`YouTube download failed after ${attempts.length} attempts. ${advice}`);
  } else {
    // Direct URL download using fetch
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength < 1024) throw new Error("Downloaded file is too small (likely not an audio file)");
      fs.writeFileSync(filePath, Buffer.from(buffer));
      return { filePath, originalName: path.basename(url).split("?")[0] || "download.mp3", sourceUrl: url };
    } catch (e) {
      throw new Error(`Direct download failed: ${e.message}`);
    }
  }
}

module.exports = { downloadFromUrl, checkYtDlp };
