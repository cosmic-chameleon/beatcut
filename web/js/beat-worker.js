// Beat This! in the browser: resample -> log-mel -> ONNX model in 1500-frame windows -> peak picking.
// Ported from Beat Lab (stem-studio/public/beatlab), and the same maths as skills/beatcut/scripts/beats.py, which matches the
// PyTorch reference exactly. Runs in a module worker so the page stays responsive.
import * as ort from 'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.30.0/ort.webgpu.bundle.min.mjs';

ort.env.wasm.wasmPaths = 'https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.30.0/';
ort.env.logLevel = 'error';   // its warnings about shape ops placed on the CPU are expected
const SR = 22050, N_FFT = 1024, HOP = 441, N_MELS = 128, FPS = 50, CHUNK = 1500, BORDER = 6;
const MODEL = new URL('../models/beat_this_small0.onnx', import.meta.url).href;
const FILTERBANK = new URL('../models/mel_filterbank.bin', import.meta.url).href;

let session = null, backend = null, filterbank = null;
const say = (msg, progress) => postMessage({ type: 'progress', msg, progress });

async function load(prefer) {
  if (session) return;
  const want = prefer ? [prefer] : self.navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
  for (const b of want) {
    try {
      say(`loading beat this! (${b})…`, 0.02);
      session = await ort.InferenceSession.create(MODEL, { executionProviders: [b] });
      backend = b; break;
    } catch (e) { if (b === 'wasm') throw e; }
  }
  const r = await fetch(FILTERBANK);
  filterbank = new Float32Array(await r.arrayBuffer());   // [513 x 128], row = fft bin
}

/**
 * Kaiser-windowed sinc resampler tuned to track soxr's default (HQ) quality, which Beat This uses: passband to 91.3 % and
 * stopband at 100 % of the output Nyquist (cutoff in the middle, 0.9565), 96 zero crossings, beta 12.9. It is within 0.06 %
 * of soxr, and gives Beat This!'s exact beats on the test track; Beat Lab's shorter filter (0.95, 32, 12) was ~2 % off and
 * lost a beat and two downbeats. Rational rates (44.1k, 48k -> 22.05k) use exact precomputed phases: one multiply a tap.
 */
function resample(x, srIn, srOut, zeroCrossings = 96, beta = 12.9) {
  if (srIn === srOut) return x;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a), g = gcd(srIn, srOut), P = srOut / g;   // P distinct phases
  const ratio = srOut / srIn, cutoff = Math.min(1, ratio) * 0.9565, half = Math.ceil(zeroCrossings / cutoff), taps = 2 * half + 1;
  const i0 = (z) => { let s = 1, t = 1; for (let k = 1; k < 80; k++) { t *= (z / (2 * k)) ** 2; s += t; if (t < 1e-14 * s) break; } return s; };
  const i0b = i0(beta), exact = P <= 2048, NP = exact ? P : 512;
  const table = new Float32Array((NP + 1) * taps);
  for (let p = 0; p <= NP; p++) for (let k = 0; k < taps; k++) {
    const t = k - half - p / NP, u = t / half; if (Math.abs(u) > 1) continue;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * cutoff * t) / (Math.PI * cutoff * t);
    table[p * taps + k] = cutoff * sinc * i0(beta * Math.sqrt(1 - u * u)) / i0b;
  }
  const n = x.length, y = new Float32Array(Math.ceil(n * ratio));
  for (let i = 0; i < y.length; i++) {
    let c, r0, r1 = -1, a = 0;
    if (exact) { const num = i * (srIn / g); c = Math.floor(num / P); r0 = (num - c * P) * taps; }   // phase = (i*srIn mod srOut)/g
    else { const tIn = i / ratio; c = Math.floor(tIn); const pf = (tIn - c) * NP, p = Math.floor(pf); a = pf - p; r0 = p * taps; r1 = r0 + taps; }
    const start = c - half, k0 = Math.max(0, -start), k1 = Math.min(taps, n - start);
    let acc = 0;
    if (r1 < 0) for (let k = k0; k < k1; k++) acc += x[start + k] * table[r0 + k];
    else for (let k = k0; k < k1; k++) acc += x[start + k] * (table[r0 + k] * (1 - a) + table[r1 + k] * a);
    y[i] = acc;
    if ((i & 0x3ffff) === 0) say('preparing audio…', 0.05 + 0.15 * i / y.length);
  }
  return y;
}

function fftTables(n) {
  const rev = new Uint32Array(n), bits = Math.log2(n);
  for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
  return { rev, cos, sin };
}
function fft(re, im, n, t) {
  for (let i = 0; i < n; i++) { const j = t.rev[i]; if (j > i) { let x = re[i]; re[i] = re[j]; re[j] = x; x = im[i]; im[i] = im[j]; im[j] = x; } }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) for (let k = 0; k < half; k++) {
      const c = t.cos[k * step], s = t.sin[k * step], a = i + k, b = a + half;
      const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
      re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
    }
  }
}
/** beat_this LogMelSpect: centred STFT with reflect padding, periodic Hann, |X|/sqrt(n_fft), slaney mel, log1p(1000 m). */
function logMel(x) {
  const t = fftTables(N_FFT), fb = filterbank, pad = N_FFT >> 1, frames = 1 + Math.floor(x.length / HOP);
  const win = new Float32Array(N_FFT); for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N_FFT);
  const mel = new Float32Array(frames * N_MELS), re = new Float32Array(N_FFT), im = new Float32Array(N_FFT), mag = new Float32Array(513);
  const norm = 1 / Math.sqrt(N_FFT);
  for (let f = 0; f < frames; f++) {
    const start = f * HOP - pad;
    for (let i = 0; i < N_FFT; i++) {
      let idx = start + i; if (idx < 0) idx = -idx; else if (idx >= x.length) idx = 2 * x.length - idx - 2;
      re[i] = (idx >= 0 && idx < x.length ? x[idx] : 0) * win[i]; im[i] = 0;
    }
    fft(re, im, N_FFT, t);
    for (let k = 0; k <= 512; k++) mag[k] = Math.hypot(re[k], im[k]) * norm;
    const row = f * N_MELS;
    for (let m = 0; m < N_MELS; m++) { let acc = 0; for (let k = 0; k <= 512; k++) acc += mag[k] * fb[k * N_MELS + m]; mel[row + m] = Math.log1p(1000 * acc); }
    if ((f & 1023) === 0) say('listening…', 0.2 + 0.2 * f / frames);
  }
  return { mel, frames };
}

/** split_predict_aggregate: windows of 1500 frames, 6-frame borders dropped, the first prediction for a frame kept. */
async function logits(mel, frames) {
  const starts = [];
  for (let s = -BORDER; s < frames - BORDER; s += CHUNK - 2 * BORDER) starts.push(s);
  if (frames > CHUNK - 2 * BORDER) starts[starts.length - 1] = frames - (CHUNK - BORDER);
  const beat = new Float32Array(frames).fill(-1000), down = new Float32Array(frames).fill(-1000), done = new Uint8Array(frames);
  for (let w = 0; w < starts.length; w++) {
    const st = starts[w], lo = Math.max(st, 0), hi = Math.min(st + CHUNK, frames);
    const left = Math.max(0, -st), right = Math.max(0, Math.min(BORDER, st + CHUNK - frames));
    const T = left + (hi - lo) + right, chunk = new Float32Array(T * N_MELS);
    chunk.set(mel.subarray(lo * N_MELS, hi * N_MELS), left * N_MELS);
    say(`finding beats (${backend}), window ${w + 1} of ${starts.length}`, 0.4 + 0.55 * w / starts.length);
    const out = await session.run({ spect: new ort.Tensor('float32', chunk, [1, T, N_MELS]) });
    const b = out.beat.data, d = out.downbeat.data;
    for (let k = BORDER; k < T - BORDER; k++) {
      const f = st + k; if (f < 0 || f >= frames || done[f]) continue;
      done[f] = 1; beat[f] = b[k]; down[f] = d[k];
    }
  }
  return { beat, down };
}

/** Postprocessor 'minimal': local maxima within +-3 frames with logit > 0; peaks one frame apart merged. */
function peaks(lg) {
  const p = [], n = lg.length;
  for (let f = 0; f < n; f++) {
    const v = lg[f]; if (v <= 0) continue;
    let max = true; for (let k = Math.max(0, f - 3); k <= Math.min(n - 1, f + 3); k++) if (lg[k] > v) { max = false; break; }
    if (max) p.push(f);
  }
  const out = [];
  for (let k = 0; k < p.length; k++) { if (k + 1 < p.length && p[k + 1] - p[k] <= 1) { out.push((p[k] + p[k + 1]) / 2); k++; } else out.push(p[k]); }
  return out.map((f) => f / FPS);
}

onmessage = async (e) => {
  try {
    const { channels, sampleRate, backend: prefer } = e.data;
    const t0 = performance.now();
    await load(prefer);
    const tl = performance.now();
    // mono = plain mean of the channels, as Beat This does
    const n = channels[0].length, mono = new Float32Array(n);
    for (const c of channels) for (let i = 0; i < n; i++) mono[i] += c[i] / channels.length;
    say('preparing audio…', 0.05);
    const x = resample(mono, sampleRate, SR); const tr = performance.now();
    const { mel, frames } = logMel(x); const tm = performance.now();
    const { beat, down } = await logits(mel, frames); const tn = performance.now();
    const stages = { load: Math.round(tl - t0), resample: Math.round(tr - tl), mel: Math.round(tm - tr), model: Math.round(tn - tm) };
    const beats = peaks(beat);
    const downbeats = [...new Set(peaks(down).map((t) => beats.reduce((best, b) => Math.abs(b - t) < Math.abs(best - t) ? b : best, beats[0] ?? t)))];
    postMessage({ type: 'done', beats, downbeats, backend, ms: Math.round(performance.now() - t0), stages });
  } catch (err) {
    postMessage({ type: 'error', msg: String(err?.message ?? err) });
  }
};
