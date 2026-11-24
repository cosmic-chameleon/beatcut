// The beat grid, the shot plan and caption timing. Same rules as skills/beatcut/scripts/beats.py and cut.py.

/** A steady grid fitted to what Beat This heard: tempo from the common gap, phase from every beat, bar lines from downbeats. */
export function fitGrid(beats, downbeats, duration, from = 0) {
  if (beats.length < 4) return null;
  const d = beats.slice(1).map((b, i) => b - beats[i]);
  // the most common gap, counted in Beat This's own 20 ms frames (so no gap sits on a bin edge), then the mean of gaps near it
  const counts = new Map();
  for (const x of d) { const k = Math.round(x / 0.02); if (k >= 10 && k <= 75) counts.set(k, (counts.get(k) ?? 0) + 1); }
  let mk = 0, mc = -1; for (const [k, c] of [...counts].sort((p, q) => p[0] - q[0])) if (c > mc) { mk = k; mc = c; }
  const m = mc > 0 ? 0.02 * mk : [...d].sort((p, q) => p - q)[d.length >> 1];
  const near = d.filter((g) => Math.abs(g - m) < 0.05);
  let period = near.length ? near.reduce((p, q) => p + q, 0) / near.length : m;
  if (period > 0.75) period /= 2;
  // refine twice: a least-squares line through the beats that sit on the grid
  for (let pass = 0; pass < 2; pass++) {
    const idx = [], ts = [];
    for (const b of beats) { const i = Math.round((b - beats[0]) / period); if (Math.abs(b - beats[0] - i * period) < 0.07) { idx.push(i); ts.push(b); } }
    if (idx.length > 8) {
      const n = idx.length, mi = idx.reduce((p, q) => p + q) / n, mt = ts.reduce((p, q) => p + q) / n;
      let num = 0, den = 0; for (let k = 0; k < n; k++) { num += (idx[k] - mi) * (ts[k] - mt); den += (idx[k] - mi) ** 2; }
      if (den > 0) period = num / den;
    }
  }
  // phase: circular mean of every beat's offset
  let sx = 0, sy = 0; for (const b of beats) { const a = 2 * Math.PI * b / period; sx += Math.cos(a); sy += Math.sin(a); }
  const ph = (((Math.atan2(sy, sx) / (2 * Math.PI)) * period) % period + period) % period;
  // the grid covers [from, duration): only the part of the song that was analysed
  const n0 = Math.max(0, Math.ceil((from - ph) / period - 1e-9));
  const grid = []; for (let n = n0; ph + n * period < duration; n++) grid.push(ph + n * period);
  // which beat of 4 is the 1: vote with the downbeats
  const votes = [0, 0, 0, 0];
  for (const t of downbeats) votes[((Math.round((t - ph) / period) % 4) + 4) % 4]++;
  const one = (((votes.indexOf(Math.max(...votes)) - n0) % 4) + 4) % 4;   // as an index into grid
  const bars = grid.filter((_, i) => i % 4 === one);
  return { bpm: 60 / period, period, grid, bars, one };
}

/**
 * The best part of a song to cut to, from its loudness alone (fast, before any beat detection): a loud, steady stretch,
 * preferably one that starts right after a quieter dip (a drop after a build-up or break), with no breakdown inside it.
 * Returns { a, b, drop, why }: analyse [a, b]; the edit should start at the bar line nearest `drop`.
 */
export function bestPart(mono, sampleRate, length) {
  const hop = 0.25, n = Math.floor(mono.length / sampleRate / hop), dur = mono.length / sampleRate;
  if (dur <= length + 4) return { a: 0, b: dur, drop: 0, why: 'the whole song' };
  // loudness envelope (dB) every 0.25 s, smoothed over 2 s
  const env = new Float32Array(n), step = Math.max(1, Math.floor(hop * sampleRate / 2000));
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * hop * sampleRate), b = Math.floor((i + 1) * hop * sampleRate);
    let s = 0, c = 0; for (let k = a; k < b; k += step) { s += mono[k] * mono[k]; c++; }
    env[i] = 10 * Math.log10(s / c + 1e-12);
  }
  const E = new Float32Array(n), w = 4;
  for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) { s += env[k]; c++; } E[i] = s / c; }
  const pre = new Float64Array(n + 1); for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + E[i];
  const mean = (i, j) => { i = Math.max(0, i); j = Math.min(n, j); return j > i ? (pre[j] - pre[i]) / (j - i) : -120; };
  const sorted = [...E].sort((p, q) => p - q), med = sorted[n >> 1], top = sorted[Math.floor(n * 0.95)];
  const L = Math.round(length / hop);
  let best = { score: -Infinity, i: 0, rise: 0 };
  for (let i = Math.round(2 / hop); i + L <= n; i++) {
    const loud = mean(i, i + L);
    const rise = mean(i, i + 12) - mean(i - 24, i);   // the first 3 s against the 6 s before: a drop scores high
    let quiet = 0; for (let k = i; k < i + L; k++) if (E[k] < top - 12) quiet++;   // breakdowns inside the part
    const score = loud + 0.6 * Math.max(0, Math.min(rise, 12)) - 14 * quiet / L - (loud < med ? 6 : 0);
    if (score > best.score) best = { score, i, rise };
  }
  const drop = best.i * hop, a = Math.max(0, drop - 2), b = Math.min(dur, drop + length);
  return { a, b, drop, why: best.rise > 3 ? 'loud, right after a build-up' : 'the loudest steady stretch' };
}

/** Loudness and how much of the beat was heard per 8 bars, to find the chorus/drop and flag quiet or drumless parts. */
export function sections(mono, sampleRate, beats, g) {
  const out = [];
  for (let i = 0; i < g.bars.length; i += 8) {
    const t0 = g.bars[i], t1 = g.bars[i + 8] ?? t0 + 32 * g.period;
    const a = Math.floor(t0 * sampleRate), b = Math.min(mono.length, Math.floor(t1 * sampleRate));
    if (b - a < sampleRate * 0.5) break;
    let s = 0; for (let k = a; k < b; k += 4) s += mono[k] * mono[k];
    const db = 10 * Math.log10(s / ((b - a) / 4) + 1e-18);
    const heard = Math.min(1, beats.filter((x) => x >= t0 && x < t1).length / Math.max(1, Math.round((t1 - t0) / g.period)));
    out.push({ t: t0, t1, bar: i, db, heard });
  }
  const sorted = out.map((s) => s.db).sort((a, b) => a - b), loud = sorted[sorted.length >> 1] ?? 0;
  for (const s of out) { s.quiet = s.db < loud - 10; s.weak = s.heard < 0.6; }
  // the strongest section: loudest with the beat clearly heard
  const good = out.filter((s) => !s.quiet && !s.weak);
  const best = (good.length ? good : out).reduce((a, b) => (b.db > a.db ? b : a), out[0]);
  return { list: out, best };
}

/**
 * The edit: shots on the grid from the bar line at/after `start`, `nBeats` long, `every` beats a shot (media looped).
 * Times are inside the new video (0 = the edit's first frame).
 */
export function planEdit({ g, start, nBeats, every, media, fps }) {
  const t0 = g.bars.find((b) => b >= start - 0.02) ?? g.bars[g.bars.length - 1];
  const g0 = g.grid.reduce((bi, t, i) => (Math.abs(t - t0) < Math.abs(g.grid[bi] - t0) ? i : bi), 0);
  nBeats = Math.max(1, Math.min(nBeats, g.grid.length - 1 - g0));
  const shots = [], resume = new Map();
  let k = 0, i = 0;
  while (k < nBeats && media.length) {
    const m = media[i % media.length]; i++;
    const nb = Math.min(every, nBeats - k);
    const f0 = Math.round((g.grid[g0 + k] - t0) * fps), f1 = Math.round((g.grid[g0 + k + nb] - t0) * fps);
    const shot = { media: m, f0, frames: f1 - f0, start: f0 / fps, end: f1 / fps, beat0: g0 + k };
    if (m.kind === 'video') {   // a clip used again carries on where it stopped
      let tin = resume.get(m) ?? 0; if (tin >= m.duration - 0.2) tin = 0;
      shot.in = tin; resume.set(m, tin + shot.frames / fps);
    }
    shots.push(shot); k += nb;
  }
  const frames = shots.length ? shots[shots.length - 1].f0 + shots[shots.length - 1].frames : 0;
  const beats = [], bars = [];
  for (let j = 0; j <= nBeats; j++) { const t = g.grid[g0 + j] - t0; beats.push(t); if ((g0 + j - g.one) % 4 === 0) bars.push(t); }
  return { t0, g0, nBeats, shots, frames, duration: frames / fps, beats, bars, fps, period: g.period, one: g.one };
}

/** Hand-tuned cuts: move every cut by `shift` seconds and cut i (the start of shot i) by `nudge[i]` more. Cuts stay in
 *  order with at least 2 frames per shot; the first shot still starts at 0 and the edit keeps its length. */
export function retime(plan, shift = 0, nudge = {}) {
  const { fps, shots } = plan, total = plan.frames;
  const cuts = shots.map((s, i) => (i ? Math.round((s.start + shift + (nudge[i] ?? 0)) * fps) : 0));
  for (let i = 1; i < cuts.length; i++) cuts[i] = Math.max(cuts[i], cuts[i - 1] + 2);
  for (let i = cuts.length - 1; i >= 1; i--) cuts[i] = Math.min(cuts[i], (i + 1 < cuts.length ? cuts[i + 1] : total) - 2);
  const resume = new Map();
  const out = shots.map((s, i) => {
    const f0 = Math.max(0, cuts[i]), f1 = i + 1 < cuts.length ? cuts[i + 1] : total;
    const shot = { ...s, f0, frames: f1 - f0, start: f0 / fps, end: f1 / fps, planned: s.start };
    if (s.media.kind === 'video') {
      let tin = resume.get(s.media) ?? 0; if (tin >= s.media.duration - 0.2) tin = 0;
      shot.in = tin; resume.set(s.media, tin + shot.frames / fps);
    }
    return shot;
  });
  return { ...plan, shots: out, shift };
}

/** Captions: one per `barsEach` bars from the first bar, words of a pop caption on the beats inside it. */
export function placeCaptions(lines, plan, barsEach) {
  const out = []; let b = 0;
  for (const text of lines) {
    if (b >= plan.bars.length - 1 && out.length) break;
    const start = (plan.bars[b] ?? 0) + 0.03;
    const end = (plan.bars[b + barsEach] ?? plan.duration) - 0.05;
    if (start >= plan.duration) break;
    out.push({ text, start, end: Math.min(end, plan.duration) });
    b += barsEach;
  }
  return out;
}

export function wordTimes(c, beats) {
  const words = c.text.split(/\s+/).filter(Boolean);
  const inside = beats.filter((b) => b >= c.start - 0.04 && b < c.end - 0.2);
  if (inside.length >= words.length) return words.map((_, i) => Math.max(c.start, inside[i]));
  if (inside.length >= 2 && inside.length * 2 >= words.length) {
    const p = inside[1] - inside[0], half = [];
    for (const b of inside) half.push(b, b + p / 2);
    return words.map((_, i) => Math.max(c.start, half[i]));
  }
  const step = Math.min(0.32, (0.7 * (c.end - c.start)) / Math.max(1, words.length));
  return words.map((_, i) => c.start + i * step);
}
