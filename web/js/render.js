// Draws one frame of the edit on a canvas: the shot (cover-cropped, beat zoom kick, slow push-in on photos) and captions.
// The preview and the export both use it, so what you see is what you get. Caption styles match skills/captions.
import { wordTimes } from './timeline.js';

export const STYLES = { pop: 'Pop: word by word on the beat', type: 'Typewriter', clean: 'Clean' };

export function shotAt(plan, t) {
  const f = Math.floor(t * plan.fps + 1e-6);
  let lo = 0, hi = plan.shots.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (plan.shots[mid].f0 <= f) lo = mid; else hi = mid - 1; }
  return plan.shots[lo];
}

/** Zoom at time t: a kick that decays from every beat, twice as hard on the 1; photos also push in over their shot. */
function zoomAt(plan, shot, t, opts) {
  let z = 1;
  if (opts.pulse) {
    const since = t - plan.beats.reduce((last, b) => (b <= t + 1e-6 ? b : last), 0);
    const beatIdx = plan.g0 + Math.round((t - since) / plan.period);
    const isOne = ((beatIdx - plan.one) % 4 + 4) % 4 === 0;
    z += opts.pulse * (isOne ? 2 : 1) * Math.exp(-since / 0.09);
  }
  if (opts.zoom && shot.media.kind === 'image') z += opts.zoom * (t - shot.start) / Math.max(0.01, shot.end - shot.start);
  return z;
}

export function drawFrame(ctx, W, H, t, plan, captions, opts) {
  const contain = opts.fit === 'white' || opts.fit === 'black';
  ctx.fillStyle = opts.fit === 'white' ? '#fff' : '#000'; ctx.fillRect(0, 0, W, H);
  if (!plan.shots.length) return;
  const shot = shotAt(plan, t), m = shot.media;
  const src = m.kind === 'image' ? m.bitmap : m.el;
  const sw = m.kind === 'image' ? src.width : src.videoWidth, sh = m.kind === 'image' ? src.height : src.videoHeight;
  if (sw && sh) {
    // fill: crop to cover the frame. whole image: fit inside a margin, the moodboard look
    const z = zoomAt(plan, shot, t, opts), s = (contain ? Math.min(0.84 * W / sw, 0.84 * H / sh) : Math.max(W / sw, H / sh)) * z;
    const dw = sw * s, dh = sh * s;
    ctx.drawImage(src, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  for (const c of captions) if (t >= c.start && t < c.end) drawCaption(ctx, W, H, t, c, plan, opts);
}

// ── captions ──────────────────────────────────────────────────────────────
const easeOutBack = (x) => { const c = 1.9; x = Math.min(Math.max(x, 0), 1); return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; };

function wrap(ctx, words, maxW) {
  const lines = []; let cur = [];
  for (const w of words) {
    const test = [...cur, w].join(' ');
    if (cur.length && ctx.measureText(test).width > maxW) { lines.push(cur); cur = [w]; } else cur.push(w);
  }
  if (cur.length) lines.push(cur);
  return lines;
}

function drawCaption(ctx, W, H, t, c, plan, opts) {
  const style = c.style ?? opts.style ?? 'pop', y = (opts.y ?? 0.62) * H, size = opts.size ?? 1;
  ctx.save();
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  if (style === 'pop') {
    const px = 0.095 * W * size;
    ctx.font = `850 ${px}px Montserrat`;
    const words = c.text.toUpperCase().split(/\s+/).filter(Boolean);
    if (!c._t) c._t = wordTimes(c, plan.beats);
    const lines = wrap(ctx, words, 0.86 * W), lh = px * 1.12, space = ctx.measureText(' ').width;
    const fade = Math.min(1, (c.end - t) / 0.12);
    let shown = 0; for (const ti of c._t) if (t >= ti) shown++;
    let wi = 0;
    ctx.lineJoin = 'round'; ctx.lineWidth = px * 0.26; ctx.strokeStyle = '#000';
    lines.forEach((ln, li) => {
      const tw = ln.reduce((a, w) => a + ctx.measureText(w).width, 0) + space * (ln.length - 1);
      let x = (W - tw) / 2; const by = y - (lh * lines.length) / 2 + li * lh + px * 0.82;
      for (const w of ln) {
        const ww = ctx.measureText(w).width;
        if (wi < shown) {
          const age = t - c._t[wi], next = c._t[wi + 1] ?? Infinity;
          const s = 0.55 + 0.45 * easeOutBack(age / 0.16);
          ctx.globalAlpha = Math.min(1, age / 0.05) * fade;
          ctx.save(); ctx.translate(x + ww / 2, by - px * 0.35); ctx.scale(s, s); ctx.translate(-ww / 2, px * 0.35);
          ctx.strokeText(w, 0, 0);
          ctx.fillStyle = wi === shown - 1 && t < next - 0.1 * (next - c._t[wi]) ? (opts.accent ?? '#C8FF3D') : '#fff';
          ctx.fillText(w, 0, 0); ctx.restore();
        }
        x += ww + space; wi++;
      }
    });
  } else if (style === 'type') {
    const px = 0.07 * W * size, cps = 16;
    ctx.font = `450 ${px}px "EB Garamond"`;
    const lines = c.text.includes('\n') ? c.text.split('\n') : wrap(ctx, c.text.split(/\s+/), 0.8 * W).map((l) => l.join(' '));
    const a = Math.min(1, (t - c.start) / 0.35, (c.end - t) / 0.25);
    // one broad warm vignette centred on the text, reaching the frame edges
    ctx.save(); ctx.globalAlpha = Math.max(0, a); ctx.translate(W / 2, y); ctx.scale(0.75 * W, 0.32 * H);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, 'rgba(18,14,10,0.55)'); g.addColorStop(0.5, 'rgba(18,14,10,0.25)'); g.addColorStop(1, 'rgba(18,14,10,0)');
    ctx.fillStyle = g; ctx.fillRect(-1, -1, 2, 2); ctx.restore();
    const n = lines.reduce((s, l) => s + l.length, 0);
    let left = t > c.start + 0.1 ? Math.min(n, Math.floor((t - c.start - 0.1) * cps)) : 0;
    const lh = px * 1.3; let last = null;
    ctx.fillStyle = `rgba(248,244,236,${Math.max(0, a)})`;
    lines.forEach((ln, i) => {
      const x = (W - ctx.measureText(ln).width) / 2, by = y - (lh * lines.length) / 2 + i * lh + px * 0.9;
      const part = ln.slice(0, Math.max(0, left)); left -= ln.length;
      if (part) { ctx.fillText(part, x, by); last = [x + ctx.measureText(part).width, by]; }
    });
    const typing = (t - c.start - 0.1) * cps < n;
    if (last && (typing || Math.floor(t * 2.2) % 2 === 0) && t - c.start < n / cps + 1.4) ctx.fillRect(last[0] + 4, last[1] - px * 0.72, Math.max(2, px / 16), px * 0.9);
  } else {
    const px = 0.064 * W * size;
    ctx.font = `700 ${px}px Montserrat`;
    const lines = c.text.includes('\n') ? c.text.split('\n') : wrap(ctx, c.text.split(/\s+/), 0.84 * W).map((l) => l.join(' '));
    const a = Math.max(0, Math.min(1, (t - c.start) / 0.25, (c.end - t) / 0.2));
    const dy = t - c.start < 0.25 ? (1 - a) * 0.012 * H : 0, lh = px * 1.25;
    ctx.globalAlpha = a; ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.65)'; ctx.shadowBlur = px * 0.3; ctx.shadowOffsetY = px * 0.04;
    lines.forEach((ln, i) => ctx.fillText(ln, (W - ctx.measureText(ln).width) / 2, y - (lh * lines.length) / 2 + i * lh + px * 0.9 + dy));
  }
  ctx.restore();
}
