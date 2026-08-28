#!/usr/bin/env python3
"""
GoMaa Unified Audio Processor v3.0
Handles: pitch extraction, chroma computation, carnatic segmentation
Reads any audio format via ffmpeg, outputs structured JSON.
"""

import sys, json, os, subprocess, tempfile, struct, traceback

try:
    import numpy as np
    from scipy.ndimage import gaussian_filter1d
    from scipy.signal import find_peaks
    from scipy.fft import rfft, rfftfreq
    HAS_NUMPY = True
except ImportError as e:
    print(json.dumps({
        "error": "numpy/scipy not installed: " + str(e),
        "install_cmd": "pip install numpy scipy",
        "pitchFrames": [], "chroma": [0]*12, "segments": []
    }))
    sys.exit(1)

SR = 22050
HOP = 512
WIN = 2048
MIN_F = 80
MAX_F = 1200

def load_audio_any(path):
    """Convert any audio to mono float32 @ 22050 Hz using ffmpeg."""
    with tempfile.NamedTemporaryFile(suffix='.raw', delete=False) as f:
        pcm_path = f.name
    r = subprocess.run([
        "ffmpeg", "-y", "-i", path, "-ar", str(SR), "-ac", "1", "-f", "f32le", pcm_path
    ], capture_output=True)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg failed: " + r.stderr.decode('utf8', 'replace')[:500])
    with open(pcm_path, 'rb') as f:
        raw = f.read()
    os.unlink(pcm_path)
    n = len(raw) // 4
    return np.frombuffer(raw[:n*4], dtype=np.float32).copy()

def extract_pitch_frames(y):
    """Extract pitch per frame using autocorrelation (numpy vectorized)."""
    n_frames = (len(y) - WIN) // HOP
    min_lag = int(SR / MAX_F)
    max_lag = int(SR / MIN_F)
    frames = []

    # Process in batches for memory efficiency
    batch_size = 500
    for batch_start in range(0, n_frames, batch_size):
        batch_end = min(batch_start + batch_size, n_frames)
        for fi in range(batch_start, batch_end):
            off = fi * HOP
            frame = y[off:off+WIN]
            rms = np.sqrt(np.mean(frame**2))
            if rms < 0.005:
                frames.append({"freq": 0, "midi": 0, "semi": -1, "confidence": 0, "rms": float(rms)})
                continue

            # Autocorrelation via FFT (much faster than direct loop)
            fft_frame = np.fft.rfft(frame, n=WIN*2)
            corr = np.fft.irfft(fft_frame * np.conj(fft_frame))[:WIN]

            search = corr[min_lag:max_lag]
            if len(search) == 0:
                frames.append({"freq": 0, "midi": 0, "semi": -1, "confidence": 0, "rms": float(rms)})
                continue

            peak = np.argmax(search) + min_lag
            if corr[0] > 0 and corr[peak] / corr[0] > 0.25:
                freq = float(SR / peak)
                midi = int(round(12 * np.log2(freq / 440) + 69))
                semi = ((midi - 60) % 12 + 12) % 12
                conf = float(min(1.0, rms * 10))
                frames.append({"freq": round(freq, 2), "midi": midi, "semi": semi, "confidence": conf, "rms": float(rms)})
            else:
                frames.append({"freq": 0, "midi": 0, "semi": -1, "confidence": 0, "rms": float(rms)})
    return frames

def compute_chroma(pitch_frames):
    """Build 12-bin chroma histogram from detected pitch frames."""
    chroma = np.zeros(12)
    for pf in pitch_frames:
        if pf["semi"] >= 0 and pf["confidence"] > 0.3:
            chroma[pf["semi"]] += pf["confidence"]
    mx = chroma.max()
    if mx > 0:
        chroma = chroma / mx
    return chroma.tolist()

def compute_detected_semis(pitch_frames):
    """Return list of detected semitone indices (top 7 by energy)."""
    energy = np.zeros(12)
    for pf in pitch_frames:
        if pf["semi"] >= 0 and pf["confidence"] > 0.3:
            energy[pf["semi"]] += pf["confidence"]
    # Threshold: keep semis with > 15% of max energy
    mx = energy.max()
    if mx == 0:
        return []
    semis = [i for i in range(12) if energy[i] / mx > 0.15]
    return semis

# ── Carnatic segmentation (from v2.3) ───────────────────────────────────
def compute_spectral_flux(y, sr, n_fft=4096, hop_length=512):
    num_frames = (len(y) - n_fft) // hop_length + 1
    log_spec = np.zeros((n_fft // 2 + 1, num_frames))
    hanning = np.hanning(n_fft)
    for i in range(num_frames):
        frame = y[i*hop_length:i*hop_length+n_fft] * hanning
        log_spec[:, i] = np.log1p(np.abs(rfft(frame)))
    flux = np.zeros(num_frames - 1)
    for i in range(1, num_frames):
        diff = log_spec[:, i] - log_spec[:, i - 1]
        flux[i - 1] = np.sum(np.maximum(0, diff) ** 2)
    return flux, hop_length

def get_seg_features(y, sr, start, end):
    ss, es = int(start * sr), int(end * sr)
    seg = y[ss:es]
    if len(seg) < 512:
        return None
    dur = end - start
    rms = float(np.sqrt(np.mean(seg**2)))

    frame_len, hop = 2048, 512
    nf = (len(seg) - frame_len) // hop + 1
    pitches, voicing = [], []

    for i in range(nf):
        frame = np.clip(seg[i*hop:i*hop+frame_len], -0.3, 0.3)
        corr = np.correlate(frame, frame, mode='full')
        corr = corr[len(corr)//2:]
        min_lag = int(sr / 800)
        max_lag = min(int(sr / 80), len(corr) - 1)
        if max_lag > min_lag:
            search = corr[min_lag:max_lag]
            if len(search) > 0:
                peak = np.argmax(search) + min_lag
                if corr[0] > 0 and corr[peak] / corr[0] > 0.25:
                    pitches.append(sr / peak)
                    voicing.append(corr[peak] / corr[0])

    voiced_p = np.array(pitches)
    pitch_mean = float(np.median(voiced_p)) if len(voiced_p) > 0 else 0
    pitch_std = float(np.std(voiced_p)) if len(voiced_p) > 5 else 0
    pitch_range = float(np.max(voiced_p) - np.min(voiced_p)) if len(voiced_p) > 5 else 0
    voicing_ratio = len(voiced_p) / nf if nf > 0 else 0

    stepwise = 0
    if len(voiced_p) > 10:
        diffs = np.diff(voiced_p)
        small_steps = np.sum((np.abs(diffs) < 30) & (np.abs(diffs) > 5))
        stepwise = float(small_steps / len(diffs)) if len(diffs) > 0 else 0

    gamaka = 0
    if len(voiced_p) > 10 and pitch_mean > 0:
        zc = np.sum(np.diff(np.sign(voiced_p - pitch_mean)) != 0)
        gamaka = float(zc / len(voiced_p))

    zcrs = []
    for i in range(nf):
        frame = seg[i*hop:i*hop+frame_len]
        zcrs.append(float(np.sum(np.abs(np.diff(np.sign(frame)))) / (2 * len(frame))))
    zcr_mean = float(np.mean(zcrs)) if zcrs else 0

    cents = []
    for i in range(nf):
        frame = seg[i*hop:i*hop+frame_len] * np.hanning(frame_len)
        spec = np.abs(rfft(frame))
        freqs = rfftfreq(frame_len, 1 / sr)
        if np.sum(spec) > 0:
            cents.append(float(np.sum(freqs * spec) / np.sum(spec)))
    cent_mean = float(np.mean(cents)) if cents else 0

    frame_rms = []
    for i in range(nf):
        frame = seg[i*hop:i*hop+frame_len]
        frame_rms.append(float(np.sqrt(np.mean(frame**2))))
    energy_mean = float(np.mean(frame_rms)) if frame_rms else 0
    energy_std = float(np.std(frame_rms)) if len(frame_rms) > 1 else 0
    energy_entropy = 0
    if len(frame_rms) > 0 and np.sum(frame_rms) > 0:
        p = np.array(frame_rms) / np.sum(frame_rms)
        energy_entropy = float(-np.sum(p * np.log(p + 1e-10)))

    return {
        'start': start, 'end': end, 'dur': dur, 'rms': rms,
        'pitchMean': pitch_mean, 'pitchStd': pitch_std,
        'pitchRange': pitch_range, 'voicingRatio': voicing_ratio,
        'stepwise': stepwise, 'gamaka': gamaka,
        'zcr': zcr_mean, 'centroid': cent_mean,
        'energyMean': energy_mean, 'energyStd': energy_std,
        'energyEntropy': energy_entropy
    }

def detect_phrase_boundaries(flux, hop_length, sr, min_phrase_dur=1.0):
    flux_smooth = gaussian_filter1d(flux, sigma=2)
    min_dist = int(min_phrase_dur * sr / hop_length)
    height = float(np.percentile(flux_smooth, 60))
    prominence = float(np.std(flux_smooth) * 0.15)
    peaks, _ = find_peaks(flux_smooth, height=height, distance=min_dist, prominence=prominence)
    return (peaks * hop_length / sr).tolist()

def build_segments(y, sr, boundaries):
    segs = []
    for i in range(len(boundaries) - 1):
        feats = get_seg_features(y, sr, boundaries[i], boundaries[i + 1])
        if feats and feats['dur'] >= 0.8:
            segs.append(feats)
    return segs

def refine_segments(y, sr, segments):
    merged = []
    for seg in segments:
        if seg['dur'] < 1.5 and merged:
            merged[-1]['end'] = seg['end']
            merged[-1]['dur'] = merged[-1]['end'] - merged[-1]['start']
            f = get_seg_features(y, sr, merged[-1]['start'], merged[-1]['end'])
            if f:
                merged[-1].update(f)
        else:
            merged.append(dict(seg))
    refined = []
    for seg in merged:
        d = seg['dur']
        if d > 10:
            n = max(2, int(d / 5))
            for i in range(n):
                s = seg['start'] + (d * i / n)
                e = seg['start'] + (d * (i + 1) / n)
                f = get_seg_features(y, sr, s, e)
                if f:
                    refined.append(f)
        else:
            refined.append(seg)
    return refined

def detect_sections(segments, total_dur, default_p_end=90.0, default_a_end=180.0):
    rms_vals = np.array([s['rms'] for s in segments])
    p20 = float(np.percentile(rms_vals, 20))
    vocal_candidates = [s for s in segments if s['voicingRatio'] > 0.15 or s['rms'] > p20]
    vocal_candidates.sort(key=lambda x: x['start'])
    gaps = []
    for i in range(len(vocal_candidates) - 1):
        gap = vocal_candidates[i + 1]['start'] - vocal_candidates[i]['end']
        if gap > 2.0:
            gaps.append((vocal_candidates[i]['end'], gap))
    p_end = default_p_end
    a_end = default_a_end
    for pos, gap in gaps:
        if 70 <= pos <= 110:
            p_end = pos
            break
    for pos, gap in gaps:
        if 150 <= pos <= 210 and pos > p_end + 20:
            a_end = pos
            break
    for seg in segments:
        if seg['start'] < p_end:
            seg['section'] = 'PALLAVI'
        elif seg['start'] < a_end:
            seg['section'] = 'ANUPALLAVI'
        else:
            seg['section'] = 'CHARANAM'

def classify_segments(segments):
    if len(segments) < 3:
        return
    rms_vals = np.array([s['rms'] for s in segments])
    energy_p10 = float(np.percentile(rms_vals, 10))
    energy_p25 = float(np.percentile(rms_vals, 25))
    for seg in segments:
        d = seg['dur']
        pr = seg['voicingRatio']
        ps = seg['pitchStd']
        z = seg['zcr']
        st = seg['stepwise']
        gm = seg['gamaka']
        rms = seg['rms']
        pm = seg['pitchMean']
        ee = seg['energyEntropy']
        has_clear_pitch = (pm > 80 and pr > 0.2) or (pm > 60 and pr > 0.35)
        is_alapana = False
        if rms < energy_p10 and pr < 0.15 and not has_clear_pitch and d > 2.5:
            is_alapana = True
        elif d > 12 and pr < 0.3 and rms < energy_p25 and not has_clear_pitch:
            is_alapana = True
        elif ee < 2.0 and d > 5 and pr < 0.15 and not has_clear_pitch:
            is_alapana = True
        if is_alapana:
            seg['type'] = 'ALAPANA'
            seg['annotation'] = ' melodic improvisation'
            continue
        if z > 0.14 and d < 5.0 and pr < 0.5 and not has_clear_pitch:
            seg['type'] = 'SOLKATTU'
            seg['annotation'] = ' rhythmic syllables'
            continue
        if st > 0.4 and ps > 40 and pr > 0.5 and pm > 80:
            seg['type'] = 'SWARA'
            seg['annotation'] = ' kalpana swaras'
            continue
        if gm > 0.28 and ps > 30 and pr > 0.45 and pm > 80:
            seg['type'] = 'GAMAKA'
            seg['annotation'] = ' ornamented sahitya'
            continue
        if pr > 0.15 or rms > energy_p25 * 0.7 or has_clear_pitch:
            seg['type'] = 'SAHITYA'
            seg['annotation'] = ''
        else:
            seg['type'] = 'ALAPANA'
            seg['annotation'] = ' instrumental interlude'

def analyze_carnatic_audio(y, sr, total_dur, options=None):
    options = options or {}
    flux, hop = compute_spectral_flux(y, sr)
    boundaries = [0.0] + detect_phrase_boundaries(flux, hop, sr) + [total_dur]
    raw_segments = build_segments(y, sr, boundaries)
    segments = refine_segments(y, sr, raw_segments)
    detect_sections(segments, total_dur, options.get('pallaviEnd', 90), options.get('anupallaviEnd', 180))
    classify_segments(segments)
    return segments

# ── Main ────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: unified_processor.py <audio_file> [json_args]"}))
        sys.exit(1)

    audio_file = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    options = args.get('options', {})

    try:
        y = load_audio_any(audio_file)
        total_dur = len(y) / SR

        # 1. Extract pitch frames
        pitch_frames = extract_pitch_frames(y)

        # 2. Compute chroma from pitch frames
        chroma = compute_chroma(pitch_frames)
        detected_semis = compute_detected_semis(pitch_frames)

        # 3. Carnatic segmentation
        segments = analyze_carnatic_audio(y, SR, total_dur, options)

        result = {
            "ok": True,
            "duration": total_dur,
            "sampleRate": SR,
            "pitchFrames": pitch_frames,
            "chroma": chroma,
            "detectedSemis": detected_semis,
            "segments": segments
        }
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({
            "error": str(e),
            "trace": traceback.format_exc(),
            "pitchFrames": [], "chroma": [0]*12, "segments": []
        }))
