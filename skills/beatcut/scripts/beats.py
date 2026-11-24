"""beats.py <song or video> <out.json> [--bpm 140] [--model path.onnx]

Finds every beat and downbeat with Beat This! (CPJKU's neural beat tracker), run through ONNX Runtime so it needs no PyTorch.
It is the same model file and the same maths as the website (web/js/beatthis.js), so the two agree.

It writes:
  beats / downbeats   what Beat This heard (seconds)
  bpm, period         the tempo, fitted to the beats (or --bpm)
  grid / bars         a steady beat grid and bar lines fitted to what it heard; cut on these, they never drift or skip
  sections            one line per 8 bars with loudness and how much of the beat was heard, to spot quiet or drumless parts
"""
import argparse, json, os, pathlib, subprocess, sys
import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
SR, N_FFT, HOP, N_MELS, FPS, CHUNK, BORDER = 22050, 1024, 441, 128, 50, 1500, 6


def find_model(name='beat_this_small0.onnx'):
    for d in (os.environ.get('BEATCUT_MODELS'), HERE.parent / 'models', HERE.parent.parent.parent / 'web' / 'models'):
        if d and (pathlib.Path(d) / name).exists():
            return pathlib.Path(d) / name
    sys.exit(f'cannot find {name}: set BEATCUT_MODELS to the folder that holds it')


def load_audio(path):
    """Any audio or video file -> mono float32 at 22050 Hz. ffmpeg decodes at the file's own rate, soxr resamples (as Beat This does)."""
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels',
                            '-of', 'csv=p=0', str(path)], capture_output=True, text=True)
    if not probe.stdout.strip():
        sys.exit(f'{path}: no audio stream')
    sr, ch = (int(v) for v in probe.stdout.strip().split(',')[:2])
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-vn', '-f', 'f32le', '-'],
                         capture_output=True, check=True).stdout
    # the plain mean of the channels, as Beat This does (ffmpeg's own downmix weights them differently)
    x = np.frombuffer(raw, dtype='<f4').astype(np.float64).reshape(-1, ch).mean(1)
    if sr != SR:
        import soxr
        x = soxr.resample(x, sr, SR)
    return x.astype(np.float32)


def log_mel(x, fb):
    """beat_this/preprocessing.py LogMelSpect: centred STFT (reflect pad), periodic Hann, |X| / sqrt(n_fft), slaney mel, log1p(1000 m)."""
    pad = N_FFT // 2
    xp = np.pad(x, pad, mode='reflect')
    frames = 1 + len(x) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(frames)[:, None]
    win = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)).astype(np.float32)
    out = np.empty((frames, N_MELS), np.float32)
    for s in range(0, frames, 2048):   # in blocks, to keep memory small on long songs
        mag = np.abs(np.fft.rfft(xp[idx[s:s + 2048]] * win, axis=1)) / np.sqrt(N_FFT)
        out[s:s + 2048] = np.log1p(1000 * (mag.astype(np.float32) @ fb))
    return out


def logits(mel, session):
    """beat_this/inference.py split_predict_aggregate: 1500-frame windows, 6-frame borders, keep_first."""
    n = len(mel)
    starts = list(range(-BORDER, n - BORDER, CHUNK - 2 * BORDER))
    if n > CHUNK - 2 * BORDER:
        starts[-1] = n - (CHUNK - BORDER)
    beat = np.full(n, -1000, np.float32); down = beat.copy(); done = np.zeros(n, bool)
    for st in starts:
        lo, hi = max(st, 0), min(st + CHUNK, n)
        left, right = max(0, -st), max(0, min(BORDER, st + CHUNK - n))
        chunk = np.pad(mel[lo:hi], ((left, right), (0, 0)))[None]
        b, d = session.run(None, {'spect': chunk})
        b, d = b[0], d[0]
        # drop the borders, then keep the first prediction made for each frame
        k = np.arange(len(b)); f = st + k
        keep = (k >= BORDER) & (k < len(b) - BORDER) & (f >= 0) & (f < n)
        keep &= ~done[np.clip(f, 0, n - 1)]
        beat[f[keep]] = b[keep]; down[f[keep]] = d[keep]; done[f[keep]] = True
    return beat, down


def peaks(lg):
    """Postprocessor 'minimal': local maxima over +-3 frames with logit > 0; peaks one frame apart are merged."""
    pad = np.pad(lg, 3, constant_values=-np.inf)
    win = np.lib.stride_tricks.sliding_window_view(pad, 7).max(1)
    p = np.flatnonzero((lg == win) & (lg > 0)).astype(float)
    out, i = [], 0
    while i < len(p):
        if i + 1 < len(p) and p[i + 1] - p[i] <= 1:
            out.append((p[i] + p[i + 1]) / 2); i += 2
        else:
            out.append(p[i]); i += 1
    return np.array(out) / FPS


def detect(x, model=None):
    import onnxruntime as ort
    mdir = pathlib.Path(model).parent if model else find_model().parent
    fb = np.fromfile(mdir / 'mel_filterbank.bin', dtype='<f4').reshape(513, N_MELS)
    sess = ort.InferenceSession(str(model or find_model()), providers=['CPUExecutionProvider'])
    b, d = logits(log_mel(x, fb), sess)
    beats, downs = peaks(b), peaks(d)
    # downbeats snap to the nearest beat (as Beat This does)
    if len(beats):
        downs = np.unique(beats[np.abs(beats[None, :] - downs[:, None]).argmin(1)]) if len(downs) else downs
    return beats, downs


def fit_grid(beats, downs, dur, bpm=None):
    """A steady grid: tempo from the common beat gap (refined), phase from the beats themselves, bar lines from the downbeats."""
    if len(beats) < 4:
        return None
    d = np.diff(beats)
    if bpm:
        period = 60 / bpm
    else:
        # the most common gap, counted in Beat This's own 20 ms frames (bins on frame counts, so no gap sits on a bin edge),
        # then the mean of the gaps near it
        k = np.round(d / 0.02).astype(int); k = k[(k >= 10) & (k <= 75)]
        m = 0.02 * np.bincount(k).argmax() if len(k) else float(np.median(d))
        near = d[np.abs(d - m) < 0.05]; period = float(near.mean()) if len(near) else m
        if period > 0.75:
            period /= 2   # a half-time reading: count the faster pulse
        # refine twice: a least-squares line through the beats that sit on the grid
        for _ in range(2):
            idx = np.round((beats - beats[0]) / period); ok = np.abs(beats - beats[0] - idx * period) < 0.07
            if ok.sum() > 8:
                period = float(np.polyfit(idx[ok], beats[ok], 1)[0])
    # phase: circular mean of every beat's offset from the grid
    ph = np.angle(np.exp(2j * np.pi * beats / period).mean()) / (2 * np.pi) * period % period
    grid = np.arange(ph, dur, period)
    # which beat of 4 is the one: vote with the downbeats
    if len(downs):
        k = np.round((downs - ph) / period).astype(int) % 4
        one = int(np.bincount(k, minlength=4).argmax())
    else:
        one = 0
    bars = grid[one::4]
    return {'bpm': round(60 / period, 3), 'period': period, 'grid': [round(float(t), 4) for t in grid],
            'bars': [round(float(t), 4) for t in bars], 'one': one}


def sections(x, beats, bars, period):
    out = []
    for i in range(0, len(bars), 8):
        t0 = bars[i]; t1 = bars[i + 8] if i + 8 < len(bars) else t0 + 32 * period
        seg = x[int(t0 * SR):int(t1 * SR)]
        if len(seg) < SR * 0.5:
            break
        db = 20 * np.log10(np.sqrt((seg.astype(np.float64) ** 2).mean()) + 1e-9)
        heard = ((beats >= t0) & (beats < t1)).sum() / max(1, round((t1 - t0) / period))
        out.append({'t': round(float(t0), 3), 'bar': i, 'db': round(float(db), 1), 'beat_heard': round(float(min(1, heard)), 2)})
    if out:
        loud = np.median([s['db'] for s in out])
        for s in out:
            s['flag'] = ' '.join(w for w, c in (('quiet', s['db'] < loud - 10), ('weak-beat', s['beat_heard'] < 0.6)) if c)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('src'); ap.add_argument('out'); ap.add_argument('--bpm', type=float); ap.add_argument('--model')
    a = ap.parse_args()
    x = load_audio(a.src); dur = len(x) / SR
    beats, downs = detect(x, a.model)
    g = fit_grid(beats, downs, dur, a.bpm)
    if not g:
        sys.exit('Beat This heard almost no beats in this audio')
    out = {'src': str(a.src), 'duration': round(dur, 3), 'bpm': g['bpm'], 'period': g['period'],
           'beats': [round(float(t), 4) for t in beats], 'downbeats': [round(float(t), 4) for t in downs],
           'grid': g['grid'], 'bars': g['bars'], 'sections': sections(x, beats, g['bars'], g['period'])}
    pathlib.Path(a.out).write_text(json.dumps(out))
    print(f"BEATS {len(beats)} beats, {len(downs)} downbeats, {g['bpm']:.2f} BPM ({'given' if a.bpm else 'fitted'}), "
          f"{len(g['bars'])} bars, {dur:.1f} s")
    for s in out['sections']:
        m, sec = divmod(s['t'], 60)
        print(f"MAP {int(m)}:{sec:05.2f}  bar {s['bar']:3d}  {s['db']:6.1f} dB  beat {100 * s['beat_heard']:3.0f}%  {s['flag']}")


if __name__ == '__main__':
    main()
