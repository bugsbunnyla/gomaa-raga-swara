#!/usr/bin/env python3
"""
Carnatic Segmenter v5.0 — Audio-Aware Phrase Segmentation + Complete Telugu Transliteration
"""

import sys, json, os, struct, tempfile, re

try:
    import numpy as np
    from scipy.ndimage import gaussian_filter1d
    from scipy.signal import find_peaks
    from scipy.fft import rfft, rfftfreq
    HAS_NUMPY = True
except ImportError as e:
    HAS_NUMPY = False
    print(json.dumps({
        "error": "numpy/scipy not installed: " + str(e),
        "segments": [],
        "install_cmd": "pip install numpy scipy"
    }))
    sys.exit(1)

# ── Complete Transliteration Tables ─────────────────────────────────────
SCRIPTS = {
    "telugu": {
        "a": "\u0c05", "\u0101": "\u0c06", "i": "\u0c07", "\u012b": "\u0c08",
        "u": "\u0c09", "\u016b": "\u0c0a", "\u1e5b": "\u0c0b", "e": "\u0c0e",
        "\u0113": "\u0c0f", "ai": "\u0c10", "o": "\u0c12", "\u014d": "\u0c13",
        "au": "\u0c14", "\u1e43": "\u0c02", "\u1e25": "\u0c03",
        "\u0101_sign": "\u0c3e", "i_sign": "\u0c3f", "\u012b_sign": "\u0c40",
        "u_sign": "\u0c41", "\u016b_sign": "\u0c42", "e_sign": "\u0c47",
        "\u0113_sign": "\u0c47", "ai_sign": "\u0c48", "o_sign": "\u0c4b",
        "\u014d_sign": "\u0c4b", "au_sign": "\u0c4c",
        "k": "\u0c15", "kh": "\u0c16", "g": "\u0c17", "gh": "\u0c18", "\u1e45": "\u0c19",
        "c": "\u0c1a", "ch": "\u0c1b", "j": "\u0c1c", "jh": "\u0c1d", "\u00f1": "\u0c1e",
        "\u1e6d": "\u0c1f", "\u1e6dh": "\u0c20", "\u1e0d": "\u0c21", "\u1e0dh": "\u0c22", "\u1e47": "\u0c23",
        "t": "\u0c24", "th": "\u0c25", "d": "\u0c26", "dh": "\u0c27", "n": "\u0c28",
        "p": "\u0c2a", "ph": "\u0c2b", "b": "\u0c2c", "bh": "\u0c2d", "m": "\u0c2e",
        "y": "\u0c2f", "r": "\u0c30", "l": "\u0c32", "v": "\u0c35",
        "\u015b": "\u0c36", "\u1e63": "\u0c37", "s": "\u0c38", "h": "\u0c39",
        "k\u1e63": "\u0c15\u0c4d\u0c37", "j\u00f1": "\u0c1c\u0c4d\u0c1e",
        "tr": "\u0c24\u0c4d\u0c30", "\u015br": "\u0c36\u0c4d\u0c30",
        "br": "\u0c2c\u0c4d\u0c30", "pr": "\u0c2a\u0c4d\u0c30",
        "kr": "\u0c15\u0c4d\u0c30", "gr": "\u0c17\u0c4d\u0c30",
        "dr": "\u0c26\u0c4d\u0c30", "vr": "\u0c35\u0c4d\u0c30",
        "mr": "\u0c2e\u0c4d\u0c30", "nr": "\u0c28\u0c4d\u0c30",
        "yr": "\u0c2f\u0c4d\u0c30", "lr": "\u0c32\u0c4d\u0c30",
        "cr": "\u0c1a\u0c4d\u0c30", "jr": "\u0c1c\u0c4d\u0c30",
        "phr": "\u0c2b\u0c4d\u0c30", "bhr": "\u0c2d\u0c4d\u0c30",
        "\u1e6dr": "\u0c1f\u0c4d\u0c30", "\u1e0dr": "\u0c21\u0c4d\u0c30",
        "\u1e47r": "\u0c23\u0c4d\u0c30", "thr": "\u0c25\u0c4d\u0c30",
        "dhr": "\u0c27\u0c4d\u0c30", "sr": "\u0c38\u0c4d\u0c30",
        "hr": "\u0c39\u0c4d\u0c30", "\u1e63r": "\u0c37\u0c4d\u0c30",
        "ky": "\u0c15\u0c4d\u0c2f", "gy": "\u0c17\u0c4d\u0c2f",
        "cy": "\u0c1a\u0c4d\u0c2f", "jy": "\u0c1c\u0c4d\u0c2f",
        "ty": "\u0c24\u0c4d\u0c2f", "dy": "\u0c26\u0c4d\u0c2f",
        "ny": "\u0c28\u0c4d\u0c2f", "py": "\u0c2a\u0c4d\u0c2f",
        "by": "\u0c2c\u0c4d\u0c2f", "my": "\u0c2e\u0c4d\u0c2f",
        "vy": "\u0c35\u0c4d\u0c2f", "ly": "\u0c32\u0c4d\u0c2f",
        "sy": "\u0c38\u0c4d\u0c2f", "hy": "\u0c39\u0c4d\u0c2f",
        "ry": "\u0c30\u0c4d\u0c2f", "\u015by": "\u0c36\u0c4d\u0c2f",
        "\u1e63y": "\u0c37\u0c4d\u0c2f", "khy": "\u0c16\u0c4d\u0c2f",
        "ghy": "\u0c18\u0c4d\u0c2f", "thy": "\u0c25\u0c4d\u0c2f",
        "dhy": "\u0c27\u0c4d\u0c2f", "phy": "\u0c2b\u0c4d\u0c2f",
        "bhy": "\u0c2d\u0c4d\u0c2f",
        "tv": "\u0c24\u0c4d\u0c35", "dv": "\u0c26\u0c4d\u0c35",
        "sv": "\u0c38\u0c4d\u0c35", "nv": "\u0c28\u0c4d\u0c35",
        "rv": "\u0c30\u0c4d\u0c35", "lv": "\u0c32\u0c4d\u0c35",
        "yv": "\u0c2f\u0c4d\u0c35", "mv": "\u0c2e\u0c4d\u0c35",
        "pv": "\u0c2a\u0c4d\u0c35", "bv": "\u0c2c\u0c4d\u0c35",
        "kv": "\u0c15\u0c4d\u0c35", "gv": "\u0c17\u0c4d\u0c35",
        "hv": "\u0c39\u0c4d\u0c35", "\u015bv": "\u0c36\u0c4d\u0c35",
        "\u1e63v": "\u0c37\u0c4d\u0c35", "cv": "\u0c1a\u0c4d\u0c35",
        "jv": "\u0c1c\u0c4d\u0c35",
        "kty": "\u0c15\u0c4d\u0c24\u0c4d\u0c2f", "ktv": "\u0c15\u0c4d\u0c24\u0c4d\u0c35",
        "dvy": "\u0c26\u0c4d\u0c35\u0c4d\u0c2f", "ndr": "\u0c28\u0c4d\u0c26\u0c4d\u0c30",
        "ntr": "\u0c28\u0c4d\u0c24\u0c4d\u0c30", "rty": "\u0c30\u0c4d\u0c24\u0c4d\u0c2f",
        "rtr": "\u0c30\u0c4d\u0c24\u0c4d\u0c30", "rdr": "\u0c30\u0c4d\u0c26\u0c4d\u0c30",
        "rdy": "\u0c30\u0c4d\u0c26\u0c4d\u0c2f", "stry": "\u0c38\u0c4d\u0c24\u0c4d\u0c30\u0c4d\u0c2f",
        "sthy": "\u0c38\u0c4d\u0c25\u0c4d\u0c2f", "skr": "\u0c38\u0c4d\u0c15\u0c4d\u0c30",
        "skhy": "\u0c38\u0c4d\u0c16\u0c4d\u0c2f", "spr": "\u0c38\u0c4d\u0c2a\u0c4d\u0c30",
        "sphr": "\u0c38\u0c4d\u0c2b\u0c4d\u0c30", "smr": "\u0c38\u0c4d\u0c2e\u0c4d\u0c30",
        "snr": "\u0c38\u0c4d\u0c28\u0c4d\u0c30", "syr": "\u0c38\u0c4d\u0c2f\u0c4d\u0c30",
        "shr": "\u0c38\u0c4d\u0c39\u0c4d\u0c30", "shv": "\u0c38\u0c4d\u0c39\u0c4d\u0c35",
        "shy": "\u0c38\u0c4d\u0c39\u0c4d\u0c2f", "\u015b\u1e63": "\u0c36\u0c4d\u0c37",
    },
}

VOWELS = ['ai', 'au', '\u0101', '\u012b', '\u016b', '\u1e5b', '\u0113', '\u014d', 'e', 'o', 'a', 'i', 'u', '\u1e43', '\u1e25']
IAST_CLEAN_RE = re.compile(r'[^\w\s\u0101\u012b\u016b\u1e5b\u1e43\u1e25\u1e45\u00f1\u1e47\u1e6d\u1e0d\u015b\u1e63\u1e3a\u1e5f\u0113\u014d]')
TELUGU_RE = re.compile(r'[\u0c00-\u0c7f]')


def transliterate(iast, script="telugu"):
    if script == "iast" or not iast:
        return iast
    if script == "telugu" and TELUGU_RE.search(iast):
        return iast
    m = SCRIPTS.get(script, {})
    text = IAST_CLEAN_RE.sub(' ', iast.lower()).strip()
    out = []
    i, n = 0, len(text)
    multi_keys = sorted([k for k in m if len(k) > 1 and '_sign' not in k], key=len, reverse=True)
    single_keys = sorted([k for k in m if len(k) == 1 and '_sign' not in k], key=len, reverse=True)
    while i < n:
        if text[i] == ' ':
            out.append(' '); i += 1; continue
        cons = ''
        for c in multi_keys:
            if text[i:i + len(c)] == c:
                cons = c; i += len(c); break
        if not cons:
            for c in single_keys:
                if text[i:i + len(c)] == c:
                    cons = c; i += len(c); break
        vowel = ''
        for v in VOWELS:
            if text[i:i + len(v)] == v:
                vowel = v; i += len(v); break
        if cons and not vowel:
            vowel = 'a'
        if not cons and not vowel:
            i += 1; continue
        if not cons:
            out.append(m.get(vowel, vowel))
        else:
            base = m.get(cons, cons)
            out.append(base if vowel == 'a' else base + m.get(vowel + '_sign', ''))
    return ''.join(out)


# ── Audio Analysis ──────────────────────────────────────────────────────
def load_pcm(path, sr_expected=22050):
    with open(path, 'rb') as f:
        raw = f.read()
    fmt = len(raw) // 4
    y = np.frombuffer(raw[:fmt*4], dtype=np.float32).copy()
    return y


def compute_spectral_flux(y, sr, n_fft=4096, hop_length=512):
    num_frames = (len(y) - n_fft) // hop_length + 1
    log_spec = np.zeros((n_fft // 2 + 1, num_frames))
    hanning = np.hanning(n_fft)
    for i in range(num_frames):
        frame = y[i * hop_length: i * hop_length + n_fft] * hanning
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
    rms = np.sqrt(np.mean(seg ** 2))

    frame_len = 2048
    hop = 512
    nf = (len(seg) - frame_len) // hop + 1
    if nf < 2:
        return None

    pitches = []
    voicing = []
    for i in range(nf):
        frame = np.clip(seg[i * hop: i * hop + frame_len], -0.3, 0.3)
        corr = np.correlate(frame, frame, mode='full')
        corr = corr[len(corr) // 2:]
        min_lag = int(sr / 800)
        max_lag = int(sr / 80)
        if max_lag >= len(corr):
            max_lag = len(corr) - 1
        if max_lag > min_lag:
            search = corr[min_lag:max_lag]
            if len(search) > 0:
                peak = np.argmax(search) + min_lag
                if corr[0] > 0 and corr[peak] / corr[0] > 0.25:
                    pitches.append(sr / peak)
                    voicing.append(corr[peak] / corr[0])

    voiced_p = np.array(pitches) if pitches else np.array([])
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
        frame = seg[i * hop: i * hop + frame_len]
        zcrs.append(float(np.sum(np.abs(np.diff(np.sign(frame)))) / (2 * len(frame))))
    zcr_mean = float(np.mean(zcrs)) if zcrs else 0

    cents = []
    for i in range(nf):
        frame = seg[i * hop: i * hop + frame_len] * np.hanning(frame_len)
        spec = np.abs(rfft(frame))
        freqs = rfftfreq(frame_len, 1 / sr)
        if np.sum(spec) > 0:
            cents.append(float(np.sum(freqs * spec) / np.sum(spec)))
    cent_mean = float(np.mean(cents)) if cents else 0

    frame_rms = []
    for i in range(nf):
        frame = seg[i * hop: i * hop + frame_len]
        frame_rms.append(float(np.sqrt(np.mean(frame ** 2))))

    energy_mean = float(np.mean(frame_rms)) if frame_rms else 0
    energy_std = float(np.std(frame_rms)) if len(frame_rms) > 1 else 0
    energy_entropy = 0
    if len(frame_rms) > 0 and np.sum(frame_rms) > 0:
        p = np.array(frame_rms) / np.sum(frame_rms)
        energy_entropy = float(-np.sum(p * np.log(p + 1e-10)))

    quality = 0.0
    if voicing_ratio > 0.3 and pitch_mean > 80 and pitch_std < 80:
        quality = 0.7
    if stepwise > 0.3 and gamaka > 0.15:
        quality += 0.2
    if rms > 0.01:
        quality += 0.1
    quality = min(1.0, quality)

    return {
        'start': start, 'end': end, 'dur': dur, 'rms': float(rms),
        'pitchMean': pitch_mean, 'pitchStd': pitch_std,
        'pitchRange': pitch_range, 'voicingRatio': voicing_ratio,
        'stepwise': stepwise, 'gamaka': gamaka,
        'zcr': zcr_mean, 'centroid': cent_mean,
        'energyMean': energy_mean, 'energyStd': energy_std,
        'energyEntropy': energy_entropy,
        'quality': round(quality, 3)
    }


def detect_phrase_boundaries(flux, hop_length, sr, min_phrase_dur=1.0):
    flux_smooth = gaussian_filter1d(flux, sigma=2)
    min_dist = int(min_phrase_dur * sr / hop_length)
    height = float(np.percentile(flux_smooth, 55))
    prominence = float(np.std(flux_smooth) * 0.12)
    peaks, _ = find_peaks(flux_smooth, height=height, distance=min_dist, prominence=prominence)
    return (peaks * hop_length / sr).tolist()


def build_segments(y, sr, boundaries):
    segs = []
    for i in range(len(boundaries) - 1):
        feats = get_seg_features(y, sr, boundaries[i], boundaries[i + 1])
        if feats and feats['dur'] >= 0.5:
            segs.append(feats)
    return segs


def refine_segments(y, sr, segments):
    merged = []
    for seg in segments:
        if seg['dur'] < 1.2 and merged:
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
        if d > 12:
            n = max(2, int(d / 6))
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
        if 60 <= pos <= 120:
            p_end = pos
            break
    for pos, gap in gaps:
        if 120 <= pos <= 240 and pos > p_end + 15:
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
        qual = seg.get('quality', 0)

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


def analyze_carnatic_audio(pcm_path, sr, total_dur, options=None):
    options = options or {}
    y = load_pcm(pcm_path, sr)
    flux, hop = compute_spectral_flux(y, sr)
    boundaries = [0.0] + detect_phrase_boundaries(flux, hop, sr) + [total_dur]
    raw_segments = build_segments(y, sr, boundaries)
    segments = refine_segments(y, sr, raw_segments)
    detect_sections(segments, total_dur, options.get('pallaviEnd', 90), options.get('anupallaviEnd', 180))
    classify_segments(segments)
    return segments


# ── CLI ─────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: carnatic_segmenter.py <pcm_file> [json_args]"}))
        sys.exit(1)

    pcm_file = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    total_dur = args.get('totalDuration', 0)
    options = args.get('options', {})
    script = args.get('script', 'telugu')

    try:
        segments = analyze_carnatic_audio(pcm_file, 22050, total_dur, options)
        print(json.dumps({"segments": segments, "ok": True}, ensure_ascii=False))
    except Exception as e:
        import traceback
        print(json.dumps({"error": str(e), "trace": traceback.format_exc(), "segments": []}))
