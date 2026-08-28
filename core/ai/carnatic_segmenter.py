#!/usr/bin/env python3
"""
Carnatic Segmenter v2.3 — Audio-Aware Phrase Segmentation
Python backend (numpy/scipy) called from Node.js via subprocess.
Reads mono 16-bit PCM @ 22050 Hz from stdin as raw bytes, writes JSON to stdout.
"""

import sys, json, os, struct, tempfile

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

# ── Transliteration ─────────────────────────────────────────────────────
SCRIPTS = {
    "telugu": {
        "a": "\u0c05", "\u0101": "\u0c06", "i": "\u0c07", "\u012b": "\u0c08",
        "u": "\u0c09", "\u016b": "\u0c0a", "\u1e5b": "\u0c0b", "e": "\u0c0e",
        "ai": "\u0c10", "o": "\u0c12", "au": "\u0c14", "\u1e43": "\u0c02", "\u1e25": "\u0c03",
        "\u0101_sign": "\u0c3e", "i_sign": "\u0c3f", "\u012b_sign": "\u0c40",
        "u_sign": "\u0c41", "\u016b_sign": "\u0c42", "e_sign": "\u0c47",
        "ai_sign": "\u0c48", "o_sign": "\u0c4b", "au_sign": "\u0c4c",
        "k": "\u0c15", "kh": "\u0c16", "g": "\u0c17", "gh": "\u0c18", "\u1e45": "\u0c19",
        "c": "\u0c1a", "ch": "\u0c1b", "j": "\u0c1c", "jh": "\u0c1d", "\u00f1": "\u0c1e",
        "\u1e6d": "\u0c1f", "\u1e6dh": "\u0c20", "\u1e0d": "\u0c21", "\u1e0dh": "\u0c22", "\u1e47": "\u0c23",
        "t": "\u0c24", "th": "\u0c25", "d": "\u0c26", "dh": "\u0c27", "n": "\u0c28",
        "p": "\u0c2a", "ph": "\u0c2b", "b": "\u0c2c", "bh": "\u0c2d", "m": "\u0c2e",
        "y": "\u0c2f", "r": "\u0c30", "l": "\u0c32", "v": "\u0c35",
        "\u015b": "\u0c36", "\u1e63": "\u0c37", "s": "\u0c38", "h": "\u0c39",
        "k\u1e63": "\u0c15\u0c4d\u0c37", "j\u00f1": "\u0c1c\u0c4d\u0c1e",
        "tr": "\u0c24\u0c4d\u0c30", "\u015br": "\u0c36\u0c4d\u0c30",
    },
    "devanagari": {
        "a": "\u0905", "\u0101": "\u0906", "i": "\u0907", "\u012b": "\u0908",
        "u": "\u0909", "\u016b": "\u090a", "\u1e5b": "\u090b", "e": "\u090f",
        "ai": "\u0910", "o": "\u0913", "au": "\u0914", "\u1e43": "\u0902", "\u1e25": "\u0903",
        "\u0101_sign": "\u093e", "i_sign": "\u093f", "\u012b_sign": "\u0940",
        "u_sign": "\u0941", "\u016b_sign": "\u0942", "e_sign": "\u0947",
        "ai_sign": "\u0948", "o_sign": "\u094b", "au_sign": "\u094c",
        "k": "\u0915", "kh": "\u0916", "g": "\u0917", "gh": "\u0918", "\u1e45": "\u0919",
        "c": "\u091a", "ch": "\u091b", "j": "\u091c", "jh": "\u091d", "\u00f1": "\u091e",
        "\u1e6d": "\u091f", "\u1e6dh": "\u0920", "\u1e0d": "\u0921", "\u1e0dh": "\u0922", "\u1e47": "\u0923",
        "t": "\u0924", "th": "\u0925", "d": "\u0926", "dh": "\u0927", "n": "\u0928",
        "p": "\u092a", "ph": "\u092b", "b": "\u092c", "bh": "\u092d", "m": "\u092e",
        "y": "\u092f", "r": "\u0930", "l": "\u0932", "v": "\u0935",
        "\u015b": "\u0936", "\u1e63": "\u0937", "s": "\u0938", "h": "\u0939",
        "k\u1e63": "\u0915\u094d\u0937", "j\u00f1": "\u091c\u094d\u091e",
        "tr": "\u0924\u094d\u0930", "\u015br": "\u0936\u094d\u0930",
    },
    "kannada": {
        "a": "\u0c85", "\u0101": "\u0c86", "i": "\u0c87", "\u012b": "\u0c88",
        "u": "\u0c89", "\u016b": "\u0c8a", "\u1e5b": "\u0c8b", "e": "\u0c8e",
        "ai": "\u0c90", "o": "\u0c92", "au": "\u0c94", "\u1e43": "\u0c82", "\u1e25": "\u0c83",
        "\u0101_sign": "\u0cbe", "i_sign": "\u0cbf", "\u012b_sign": "\u0cc0",
        "u_sign": "\u0cc1", "\u016b_sign": "\u0cc2", "e_sign": "\u0cc7",
        "ai_sign": "\u0cc8", "o_sign": "\u0ccb", "au_sign": "\u0ccc",
        "k": "\u0c95", "kh": "\u0c96", "g": "\u0c97", "gh": "\u0c98", "\u1e45": "\u0c99",
        "c": "\u0c9a", "ch": "\u0c9b", "j": "\u0c9c", "jh": "\u0c9d", "\u00f1": "\u0c9e",
        "\u1e6d": "\u0c9f", "\u1e6dh": "\u0ca0", "\u1e0d": "\u0ca1", "\u1e0dh": "\u0ca2", "\u1e47": "\u0ca3",
        "t": "\u0ca4", "th": "\u0ca5", "d": "\u0ca6", "dh": "\u0ca7", "n": "\u0ca8",
        "p": "\u0caa", "ph": "\u0cab", "b": "\u0cac", "bh": "\u0cad", "m": "\u0cae",
        "y": "\u0caf", "r": "\u0cb0", "l": "\u0cb2", "v": "\u0cb5",
        "\u015b": "\u0cb6", "\u1e63": "\u0cb7", "s": "\u0cb8", "h": "\u0cb9",
        "k\u1e63": "\u0c95\u0ccd\u0cb7", "j\u00f1": "\u0c9c\u0ccd\u0c9e",
        "tr": "\u0ca4\u0ccd\u0cb0", "\u015br": "\u0cb6\u0ccd\u0cb0",
    },
    "tamil": {
        "a": "\u0b85", "\u0101": "\u0b86", "i": "\u0b87", "\u012b": "\u0b88",
        "u": "\u0b89", "\u016b": "\u0b8a", "e": "\u0b8e", "ai": "\u0b90",
        "o": "\u0b92", "au": "\u0b94", "\u1e43": "\u0bae\u0bcd", "\u1e25": "\u0b83",
        "\u0101_sign": "\u0bbe", "i_sign": "\u0bbf", "\u012b_sign": "\u0bc0",
        "u_sign": "\u0bc1", "\u016b_sign": "\u0bc2", "e_sign": "\u0bc7",
        "ai_sign": "\u0bc8", "o_sign": "\u0bcb", "au_sign": "\u0bcc",
        "k": "\u0b95", "kh": "\u0b95", "g": "\u0b95", "gh": "\u0b95", "\u1e45": "\u0b99",
        "c": "\u0b9a", "ch": "\u0b9a", "j": "\u0b9c", "jh": "\u0b9c", "\u00f1": "\u0b9e",
        "\u1e6d": "\u0b9f", "\u1e6dh": "\u0b9f", "\u1e0d": "\u0b9f", "\u1e0dh": "\u0b9f", "\u1e47": "\u0ba3",
        "t": "\u0ba4", "th": "\u0ba4", "d": "\u0ba4", "dh": "\u0ba4", "n": "\u0ba8",
        "p": "\u0baa", "ph": "\u0baa", "b": "\u0baa", "bh": "\u0baa", "m": "\u0bae",
        "y": "\u0baf", "r": "\u0bb0", "l": "\u0bb2", "v": "\u0bb5",
        "\u015b": "\u0bb6", "\u1e63": "\u0bb7", "s": "\u0bb8", "h": "\u0bb9",
        "k\u1e63": "\u0b95\u0bcd\u0bb7", "j\u00f1": "\u0b9c\u0bcd\u0b9e",
        "tr": "\u0ba4\u0bcd\u0bb0", "\u015br": "\u0bb6\u0ccd\u0bb0",
    },
    "malayalam": {
        "a": "\u0d05", "\u0101": "\u0d06", "i": "\u0d07", "\u012b": "\u0d08",
        "u": "\u0d09", "\u016b": "\u0d0a", "\u1e5b": "\u0d0b", "e": "\u0d0e",
        "ai": "\u0d10", "o": "\u0d12", "au": "\u0d14", "\u1e43": "\u0d02", "\u1e25": "\u0d03",
        "\u0101_sign": "\u0d3e", "i_sign": "\u0d3f", "\u012b_sign": "\u0d40",
        "u_sign": "\u0d41", "\u016b_sign": "\u0d42", "e_sign": "\u0d47",
        "ai_sign": "\u0d48", "o_sign": "\u0d4b", "au_sign": "\u0d57",
        "k": "\u0d15", "kh": "\u0d16", "g": "\u0d17", "gh": "\u0d18", "\u1e45": "\u0d19",
        "c": "\u0d1a", "ch": "\u0d1b", "j": "\u0d1c", "jh": "\u0d1d", "\u00f1": "\u0d1e",
        "\u1e6d": "\u0d1f", "\u1e6dh": "\u0d20", "\u1e0d": "\u0d21", "\u1e0dh": "\u0d22", "\u1e47": "\u0d23",
        "t": "\u0d24", "th": "\u0d25", "d": "\u0d26", "dh": "\u0d27", "n": "\u0d28",
        "p": "\u0d2a", "ph": "\u0d2b", "b": "\u0d2c", "bh": "\u0d2d", "m": "\u0d2e",
        "y": "\u0d2f", "r": "\u0d30", "l": "\u0d32", "v": "\u0d35",
        "\u015b": "\u0d36", "\u1e63": "\u0d37", "s": "\u0d38", "h": "\u0d39",
        "k\u1e63": "\u0d15\u0d4d\u0d37", "j\u00f1": "\u0d1c\u0d4d\u0d1e",
        "tr": "\u0d24\u0d4d\u0d30", "\u015br": "\u0d36\u0d4d\u0d30",
    },
}

VOWELS = ['ai', 'au', '\u0101', '\u012b', '\u016b', '\u1e5b', 'e', 'o', 'a', 'i', 'u', '\u1e43', '\u1e25']

import re

def transliterate(iast, script):
    if script == "iast" or not iast:
        return iast
    m = SCRIPTS.get(script, {})
    text = re.sub(r'[^\w\s\u0101\u012b\u016b\u1e5b\u1e43\u1e25\u1e45\u00f1\u1e47\u1e6d\u1e0d\u015b\u1e63\u1e3a\u1e5f]', ' ', iast.lower()).strip()
    out = []
    i, n = 0, len(text)
    while i < n:
        if text[i] == ' ':
            out.append(' ')
            i += 1
            continue
        cons = ''
        for c in sorted([k for k in m if len(k) > 1], key=len, reverse=True):
            if text[i:i + len(c)] == c:
                cons = c
                i += len(c)
                break
        if not cons:
            for c in sorted([k for k in m if len(k) == 1], key=len, reverse=True):
                if text[i:i + len(c)] == c:
                    cons = c
                    i += len(c)
                    break
        vowel = ''
        for v in VOWELS:
            if text[i:i + len(v)] == v:
                vowel = v
                i += len(v)
                break
        if cons and not vowel:
            vowel = 'a'
        if not cons and not vowel:
            i += 1
            continue
        if not cons:
            out.append(m.get(vowel, vowel))
        else:
            base = m.get(cons, cons)
            out.append(base if vowel == 'a' else base + m.get(vowel + '_sign', ''))
    return ''.join(out)


# ── Audio Analysis ──────────────────────────────────────────────────────
def load_pcm(path, sr_expected=22050):
    """Load raw float32 PCM from file (little-endian)."""
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

    return {
        'start': start, 'end': end, 'dur': dur, 'rms': float(rms),
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


def assign_sahitya(segments, kriti):
    for section in ['PALLAVI', 'ANUPALLAVI', 'CHARANAM']:
        sec_segs = [s for s in segments
                    if s.get('section') == section and s['type'] in ['SAHITYA', 'GAMAKA']]
        lines = kriti.get(section.lower(), [])
        if not lines:
            continue
        line_idx = 0
        prev_line = None
        repeat_count = 0
        for seg in sec_segs:
            current_line = lines[line_idx % len(lines)]
            seg['line'] = current_line
            if current_line == prev_line:
                repeat_count += 1
                if repeat_count >= 2:
                    seg['niraval'] = True
                    if not seg['annotation']:
                        seg['annotation'] = ' niraval'
            else:
                repeat_count = 0
                seg['niraval'] = False
            prev_line = current_line
            line_idx += 1

    for seg in segments:
        if 'line' not in seg:
            seg['line'] = ''
            seg['niraval'] = False


def analyze_carnatic_audio(pcm_path, sr, total_dur, kriti, options=None):
    options = options or {}
    y = load_pcm(pcm_path, sr)
    flux, hop = compute_spectral_flux(y, sr)
    boundaries = [0.0] + detect_phrase_boundaries(flux, hop, sr) + [total_dur]
    raw_segments = build_segments(y, sr, boundaries)
    segments = refine_segments(y, sr, raw_segments)
    detect_sections(segments, total_dur, options.get('pallaviEnd', 90), options.get('anupallaviEnd', 180))
    classify_segments(segments)
    assign_sahitya(segments, kriti)
    return segments


# ── CLI ─────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: carnatic_segmenter.py <pcm_file> [json_args]"}))
        sys.exit(1)

    pcm_file = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    total_dur = args.get('totalDuration', 0)
    kriti = args.get('kriti', {})
    options = args.get('options', {})
    script = args.get('script', 'telugu')

    try:
        segments = analyze_carnatic_audio(pcm_file, 22050, total_dur, kriti, options)
        # Add transliteration
        for seg in segments:
            if seg.get('line'):
                seg['lineScript'] = transliterate(seg['line'], script)
        print(json.dumps({"segments": segments, "ok": True}, ensure_ascii=False))
    except Exception as e:
        import traceback
        print(json.dumps({"error": str(e), "trace": traceback.format_exc(), "segments": []}))
