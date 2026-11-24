// beatcut web: song -> Beat This! beats -> photos/clips cut on the beat -> text -> preview -> MP4. All in the browser.
import { fitGrid, sections, planEdit, retime, placeCaptions, bestPart } from './timeline.js';
import { drawFrame, shotAt } from './render.js';
import { exportMp4, canExport } from './export.js';
import { demoSong, demoImages } from './demo.js';

const $ = (id) => document.getElementById(id);
const S = { song: null, songName: '', mono: null, beats: [], downbeats: [], g: null, sec: null, start: 0, media: [], plan: null, captions: [], playing: null, font: null, shift: 0, nudge: {}, pick: 0 };
const actx = new (window.AudioContext || window.webkitAudioContext)();
const worker = new Worker(new URL('./beat-worker.js', import.meta.url), { type: 'module' });
window.__beatcut = S;   // for poking at from the console

// ── 1. song ────────────────────────────────────────────────────────────────
function dropZone(el, input, onFiles) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); });
  input.addEventListener('change', () => { if (input.files.length) onFiles([...input.files]); input.value = ''; });
}
dropZone($('songDrop'), $('songFile'), (f) => loadSong(f[0]));

async function loadSong(file, name = file.name) {
  stop();
  $('songLabel').textContent = name;
  showStatus('beat', 'decoding…', 0.01);
  let buf;
  // decode at the file's own rate when it is a WAV (else 44.1 kHz): the browser's AudioContext would resample to its own
  // rate (often 48 kHz) and that second resample moves Beat This!'s results (Beat Lab found the same)
  try { const ab = await file.arrayBuffer(); buf = await new OfflineAudioContext(2, 1, wavRate(ab) ?? 44100).decodeAudioData(ab); }
  catch { return showStatus('beat', `could not read the sound in ${name}. try an mp3, wav, m4a or mp4.`, 0, true); }
  await useSong(buf, name);
}

function wavRate(ab) {
  const v = new DataView(ab);
  if (ab.byteLength < 36 || v.getUint32(0, false) !== 0x52494646 || v.getUint32(8, false) !== 0x57415645) return null;
  let o = 12; while (o + 8 <= ab.byteLength) { const id = v.getUint32(o, false), len = v.getUint32(o + 4, true); if (id === 0x666d7420) return v.getUint32(o + 12, true); o += 8 + len + (len & 1); }
  return null;
}

// How long a part to analyse: enough for the longest edit chosen (at a slowish 100 BPM) plus room to move the start.
const partLength = () => Math.max(40, 4 * +$('bars').value * 0.6 + 16);

function useSong(buf, name) {
  S.song = buf; S.songName = name; S.g = null; S.beats = []; S.downbeats = []; S.sec = null; S.plan = null; S.whole = false; S.nudge = {}; S.pick = 0; S.shift = 0;
  const n = buf.length; S.mono = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) S.mono[i] += d[i] / buf.numberOfChannels; }
  $('waveWrap').hidden = false;
  // 1. the best part from the loudness curve, analysed first so you can start straight away
  // 2. then the whole song, in a second worker in the background; the start chosen in step 1 stays
  const song = buf;
  return analyse(bestPart(S.mono, buf.sampleRate, partLength())).then(() => {
    if (S.song === song && !S.whole) analyse({ a: 0, b: buf.duration }, { background: true });
  });
}

/** Run Beat This! on part = { a, b, drop?, why? } of the song (seconds). Only the newest request's answer is used.
 *  background: the whole song after the best part, in its own worker, without the progress bar, keeping the start. */
let job = 0, bgJob = 0, bgWorker = null;
function analyse(part, { background = false } = {}) {
  const buf = S.song, sr = buf.sampleRate, id = background ? ++bgJob : ++job;
  part = { ...part, a: Math.max(0, part.a), b: Math.min(buf.duration, part.b) };
  const whole = part.a <= 0.01 && part.b >= buf.duration - 0.01;
  if (background) S.bg = true; else { S.part = part; S.analysing = true; drawWave(); }
  const i0 = Math.floor(part.a * sr), i1 = Math.ceil(part.b * sr), channels = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c).slice(i0, i1));
  const span = `${clock(part.a)}–${clock(part.b)}`;
  if (!background) showStatus('beat', `finding beats in ${span}…`, 0.02);
  const w = background ? (bgWorker ??= new Worker(new URL('./beat-worker.js', import.meta.url), { type: 'module' })) : worker;
  return new Promise((resolve) => {
    w.onmessage = (e) => {
      const m = e.data;
      if (id !== (background ? bgJob : job) || S.song !== buf) { if (m.type !== 'progress') { if (background) S.bg = false; resolve(); } return; }
      if (m.type === 'progress') {
        if (background) $('bgInfo').textContent = ` finding the rest of the song's beats… ${Math.round(100 * m.progress)}%`;
        else showStatus('beat', `${m.msg} (${span})`, m.progress);
        return;
      }
      if (background) { S.bg = false; $('bgInfo').textContent = ''; } else S.analysing = false;
      if (m.type === 'error') { if (!background) showStatus('beat', `beat detection failed: ${m.msg}`, 0, true); return resolve(); }
      const beats = m.beats.map((t) => t + part.a), downs = m.downbeats.map((t) => t + part.a);
      const g = fitGrid(beats, downs, part.b, part.a);
      if (!g || g.bars.length < 2) {
        if (!background) { showStatus('beat', 'beat this! heard almost no beat here. drag across a busier part of the waveform.', 0, true); drawWave(); }
        return resolve();
      }
      console.info('[beatcut] beat detection ms', m.stages, background ? '(whole song, background)' : '');
      S.beats = beats; S.downbeats = downs; S.stages = m.stages; S.g = g; S.whole = whole;
      S.sec = sections(S.mono, sr, beats, g);
      if (background) S.part = part;
      else S.start = part.drop ?? S.sec.best?.t ?? g.bars[0];
      $('bpm').textContent = `${g.bpm.toFixed(1)} bpm`;
      S.found = `${beats.length} beats, ${downs.length} downbeats, ${(m.ms / 1000).toFixed(1)} s on ${m.backend}`;
      $('partInfo').textContent = whole ? `whole song${background ? ', starting at the best part' : ''}. ${S.found}.` : `${span}${part.why ? `, ${part.why}` : ''}. ${S.found}.`;
      if (!background) $('beatStatus').hidden = true;
      if (background && S.playing) drawWave(); else rebuild();   // don't interrupt playback: the next rebuild picks it up
      resolve();
    };
    w.postMessage({ channels, sampleRate: sr, backend: new URLSearchParams(location.search).get('backend') }, channels.map((c) => c.buffer));
  });
}
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
$('bestPart').addEventListener('click', () => {
  if (!S.song) return;
  const best = bestPart(S.mono, S.song.sampleRate, partLength());
  if (S.whole) { S.start = best.drop; rebuild(); } else analyse(best);
});
$('wholeSong').addEventListener('click', () => { if (S.song) analyse({ a: 0, b: S.song.duration, why: '' }); });

function showStatus(which, msg, p, err = false) {
  $(`${which}Status`).hidden = false;
  $(`${which}Msg`).textContent = msg; $(`${which}Msg`).classList.toggle('error', err);
  $(`${which}Bar`).style.width = `${Math.round(100 * (p ?? 0))}%`;
}

// ── waveform with beats, downbeats and the chosen region ───────────────────
function drawWave() {
  const cv = $('wave'), dpr = devicePixelRatio || 1, W = cv.clientWidth, H = 132, WH = 108;   // WH: waveform height, the rest is the time axis
  cv.width = W * dpr; cv.height = H * dpr;
  const c = cv.getContext('2d'); c.scale(dpr, dpr); c.clearRect(0, 0, W, H);
  if (!S.mono) return;
  const dur = S.song.duration, x = (t) => (t / dur) * W, spp = S.mono.length / W, mid = 16 + (WH - 16) / 2, amp = (WH - 22) / 2;
  const inPart = (t) => !S.part || (t >= S.part.a && t < S.part.b);
  // the edit, tinted
  if (S.plan) { c.fillStyle = 'rgba(0,0,238,0.08)'; c.fillRect(x(S.plan.t0), 14, x(S.plan.t0 + S.plan.duration) - x(S.plan.t0), WH - 14); }
  if (drag?.moved) { c.fillStyle = 'rgba(0,0,238,0.14)'; c.fillRect(Math.min(drag.x0, drag.x1), 14, Math.abs(drag.x1 - drag.x0), WH - 14); }
  // the wave: peaks light, loudness (rms) dark; grey outside the analysed part
  for (let px = 0; px < W; px++) {
    let lo = 0, hi = 0, sq = 0, n = 0; const a = Math.floor(px * spp), b = Math.min(S.mono.length, Math.floor((px + 1) * spp));
    for (let i = a; i < b; i += 4) { const v = S.mono[i]; if (v < lo) lo = v; if (v > hi) hi = v; sq += v * v; n++; }
    const rms = Math.sqrt(sq / Math.max(1, n)), on = inPart((px + 0.5) / W * dur);
    c.fillStyle = on ? '#b9b9b9' : '#e4e4e4'; c.fillRect(px, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
    c.fillStyle = on ? '#111' : '#cfcfcf'; c.fillRect(px, mid - rms * amp * 1.4, 1, Math.max(1, rms * amp * 2.8));
  }
  // the analysed part: a bracket over it
  if (S.part) {
    const a = x(S.part.a), b = x(S.part.b);
    c.fillStyle = '#111'; c.fillRect(a, 8, b - a, 1); c.fillRect(a, 8, 1, 5); c.fillRect(b - 1, 8, 1, 5);
  }
  // bars and beats, thinned so they never turn into a comb: every bar, or every 4, or every 8 (a phrase)
  if (S.g) {
    const pxBar = x(4 * S.g.period), every = pxBar >= 7 ? 1 : pxBar * 4 >= 7 ? 4 : 8;
    if (x(S.g.period) >= 5) { c.fillStyle = 'rgba(0,0,0,0.35)'; for (const t of S.g.grid) c.fillRect(Math.round(x(t)), WH - 4, 1, 4); }
    S.g.bars.forEach((t, i) => {
      if (i % every) return;
      const phrase = i % 8 === 0;
      c.fillStyle = phrase ? '#0000ee' : 'rgba(0,0,238,0.5)'; c.fillRect(Math.round(x(t)), WH - (phrase ? 10 : 7), 1, phrase ? 10 : 7);
    });
  }
  // the start of the edit, labelled
  if (S.plan) {
    const sx = Math.round(x(S.plan.t0));
    c.fillStyle = '#0000ee'; c.fillRect(sx, 14, 1.5, WH - 14);
    c.font = '11px ui-monospace, Menlo, monospace'; c.textBaseline = 'top';
    const label = `start ${clock(S.plan.t0)}`, lw = c.measureText(label).width;
    c.fillText(label, sx + 4 + lw > W ? sx - lw - 4 : sx + 4, 15);
  }
  if (S.playing) { c.fillStyle = '#c00'; c.fillRect(x(S.plan.t0 + playTime()), 14, 1, WH - 14); }
  // time axis
  c.fillStyle = '#111'; c.fillRect(0, WH, W, 1);
  const stepT = [5, 10, 15, 30, 60, 120].find((st) => x(st) >= 46) ?? 300;
  c.font = '11px ui-monospace, Menlo, monospace'; c.textBaseline = 'top'; c.fillStyle = '#777';
  for (let t = 0; t <= dur; t += stepT) { const tx = Math.round(x(t)); c.fillRect(tx, WH, 1, 4); if (tx + 30 < W) c.fillText(clock(t), tx + 3, WH + 6); }
}
let drag = null;
const waveTime = (e) => { const r = $('wave').getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * S.song.duration; };
$('wave').addEventListener('pointerdown', (e) => {
  if (!S.song) return;
  const r = e.currentTarget.getBoundingClientRect();
  drag = { x0: e.clientX - r.left, x1: e.clientX - r.left, t0: waveTime(e), moved: false };
  e.currentTarget.setPointerCapture(e.pointerId);
});
$('wave').addEventListener('pointermove', (e) => {
  if (!drag) return;
  const r = e.currentTarget.getBoundingClientRect(); drag.x1 = e.clientX - r.left;
  if (Math.abs(drag.x1 - drag.x0) > 4) drag.moved = true;
  drawWave();
});
$('wave').addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag; drag = null; const t = waveTime(e);
  if (d.moved && S.whole) { S.start = Math.min(d.t0, t); rebuild(); }   // the whole song is known: the edit starts where you began
  else if (d.moved) {   // a dragged part: analyse it (at least 12 s)
    let a = Math.min(d.t0, t), b = Math.max(d.t0, t);
    if (b - a < 12) { const mid = (a + b) / 2; a = mid - 6; b = mid + 6; }
    analyse({ a, b, drop: a, why: 'your pick' });
  } else if (S.g && S.part && t >= S.part.a && t < S.part.b) {   // inside the analysed part: the edit starts here
    S.start = t; rebuild();
  } else {   // outside it: analyse a part from here
    analyse({ a: t - 2, b: t + partLength(), drop: t, why: 'your pick' });
  }
});
addEventListener('resize', () => { drawWave(); drawTimeline(); sizeView(); if (S.plan && !S.playing) drawAt(($('scrub').value / 1000) * S.plan.duration); });   // resizing a canvas clears it

$('beatsJson').addEventListener('click', () => {
  if (!S.g) return;
  const j = { src: S.songName, duration: S.song.duration, part: S.part && [S.part.a, S.part.b], bpm: S.g.bpm, period: S.g.period, beats: S.beats, downbeats: S.downbeats, grid: S.g.grid, bars: S.g.bars };
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(j)], { type: 'application/json' }));
  a.download = `${S.songName.replace(/\.[^.]+$/, '')}.beats.json`; a.click();
});

// ── 2. media ───────────────────────────────────────────────────────────────
dropZone($('mediaDrop'), $('mediaFile'), addMedia);
async function addMedia(files) {
  for (const f of files) {
    try {
      if (f.type.startsWith('video/')) {
        const el = document.createElement('video');
        el.muted = true; el.playsInline = true; el.preload = 'auto'; el.src = URL.createObjectURL(f);
        await new Promise((ok, bad) => { el.onloadeddata = ok; el.onerror = bad; });
        S.media.push({ kind: 'video', name: f.name, el, duration: el.duration, thumb: await videoThumb(el) });
      } else if (f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|avif)$/i.test(f.name)) {
        const raw = await createImageBitmap(f);
        const s = Math.min(1, 2400 / Math.max(raw.width, raw.height));   // keep memory sensible on huge photos
        const bitmap = s < 1 ? await createImageBitmap(raw, { resizeWidth: Math.round(raw.width * s), resizeHeight: Math.round(raw.height * s), resizeQuality: 'high' }) : raw;
        S.media.push({ kind: 'image', name: f.name, bitmap, thumb: URL.createObjectURL(f) });
      }
    } catch { /* not something we can show: skip it */ }
  }
  renderThumbs(); rebuild();
}

// ── media from a link: an are.na channel (public api, images and videos) or plain image links ──
$('fromForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('fromUrl').value.trim(); if (!text) return;
  const btn = e.submitter ?? $('fromForm').querySelector('button'); btn.disabled = true;
  try {
    const arena = text.match(/are\.na\/(?:[^/\s]+\/)?([\w-]+)\/?(?:[?#].*)?$/i) ?? (/^[a-z0-9]+(?:[-_][a-z0-9]+)+$/i.test(text) ? [null, text] : null);   // slugs can hold _ (ibz-pe7v3a_kkge)
    const urls = arena ? await arenaMedia(arena[1]) : text.split(/[\s,]+/).filter((u) => /^https?:\/\//.test(u)).map((url) => ({ url, name: url.split('/').pop().split('?')[0] || 'image' }));
    if (!urls.length) { $('mediaMsg').textContent = arena ? 'no images or videos in that channel.' : 'paste an are.na channel link, or links to images.'; return; }
    const files = []; let failed = 0;
    for (let i = 0; i < urls.length; i++) {
      $('mediaMsg').textContent = `fetching ${i + 1} of ${urls.length}…`;
      try {
        const r = await fetch(urls[i].url, { mode: 'cors' }); if (!r.ok) throw new Error(r.status);
        const blob = await r.blob();
        files.push(new File([blob], urls[i].name, { type: blob.type || urls[i].type || 'image/jpeg' }));
      } catch { failed++; }
    }
    await addMedia(files);
    $('mediaMsg').textContent = `added ${files.length}${arena ? ` from are.na/${arena[1]}` : ''}.` +
      (failed ? ` ${failed} could not be fetched (the site does not allow it; download them and drop them in instead).` : '');
    $('fromUrl').value = '';
  } catch (err) {
    $('mediaMsg').textContent = `could not read that: ${err.message ?? err}`;
  } finally { btn.disabled = false; }
});

/** Every image (and video) block of a public are.na channel, in channel order, up to 200. */
async function arenaMedia(slug) {
  const out = [];
  for (let page = 1; page <= 4 && out.length < 200; page++) {
    $('mediaMsg').textContent = `reading are.na/${slug}…`;
    const r = await fetch(`https://api.are.na/v2/channels/${encodeURIComponent(slug)}/contents?per=50&page=${page}`);
    if (r.status === 404 || r.status === 401) throw new Error('channel not found, or it is private');
    if (!r.ok) throw new Error(`are.na said ${r.status}`);
    const blocks = (await r.json()).contents ?? [];
    for (const b of blocks) {
      const att = b.attachment;
      if (att?.content_type?.startsWith('video/') && att.url) out.push({ url: att.url, name: att.file_name || `${b.id}.mp4`, type: att.content_type });
      else if (b.image) out.push({ url: (b.image.large ?? b.image.display ?? b.image.original).url, name: b.image.filename || `${b.id}.jpg`, type: b.image.content_type });
    }
    if (blocks.length < 50) break;
  }
  return out;
}
$('shuffle').addEventListener('click', () => { for (let i = S.media.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [S.media[i], S.media[j]] = [S.media[j], S.media[i]]; } renderThumbs(); rebuild(); });
$('clearMedia').addEventListener('click', () => { S.media = []; renderThumbs(); rebuild(); });

async function videoThumb(el) {
  el.currentTime = Math.min(0.1, el.duration / 2);
  await new Promise((r) => el.addEventListener('seeked', r, { once: true }));
  const c = document.createElement('canvas'); c.width = 160; c.height = 160;
  const s = Math.max(160 / el.videoWidth, 160 / el.videoHeight);
  c.getContext('2d').drawImage(el, (160 - el.videoWidth * s) / 2, (160 - el.videoHeight * s) / 2, el.videoWidth * s, el.videoHeight * s);
  return c.toDataURL('image/jpeg', 0.8);
}
let dragFrom = null;
function renderThumbs() {
  const ol = $('thumbs'); ol.innerHTML = ''; $('mediaTools').hidden = S.media.length < 2;
  S.media.forEach((m, i) => {
    const li = document.createElement('li'); li.draggable = true;
    li.innerHTML = `<img alt="" src="${m.thumb}"><span class="i">${i + 1}</span>${m.kind === 'video' ? `<span class="v">${m.duration.toFixed(1)} s</span>` : ''}<button class="x" title="Remove">×</button>`;
    li.querySelector('.x').onclick = () => { S.media.splice(i, 1); renderThumbs(); rebuild(); };
    li.addEventListener('dragstart', () => { dragFrom = i; li.classList.add('dragging'); });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => e.preventDefault());
    li.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); if (dragFrom == null || dragFrom === i) return; const [m2] = S.media.splice(dragFrom, 1); S.media.splice(i, 0, m2); dragFrom = null; renderThumbs(); rebuild(); });
    ol.appendChild(li);
  });
}

// ── 3 & 4. the edit and the text ───────────────────────────────────────────
const opts = () => ({ fit: $('fit').value, pulse: +$('pulse').value, zoom: 0.06, style: $('style').value, accent: $('accent').value, y: +$('ypos').value, font: S.font });
const size = () => $('format').value.split('x').map(Number);
for (const id of ['every', 'bars', 'format', 'fit', 'pulse', 'style', 'capBars', 'ypos', 'accent']) $(id).addEventListener('input', rebuild);
$('text').addEventListener('input', rebuild);

// any google font by name: fetch the weights it has (a family 404s on a weight it lacks), add them to the page
const fontCss = new Map();
async function googleFont(name) {
  if (!fontCss.has(name)) {
    const fam = encodeURIComponent(name).replace(/%20/g, '+');
    const css = (await Promise.all([300, 400, 500, 600, 700, 800, 900].map((w) =>
      fetch(`https://fonts.googleapis.com/css2?family=${fam}:wght@${w}&display=swap`).then((r) => (r.ok ? r.text() : '')).catch(() => ''))))
      .join('\n');
    if (!css) return false;
    const el = document.createElement('style'); el.textContent = css; document.head.appendChild(el);
    fontCss.set(name, true);
  }
  await Promise.all(['450', '700', '850'].map((w) => document.fonts.load(`${w} 40px "${name}"`)));
  return true;
}
async function loadFonts() {
  await document.fonts.load('850 40px Montserrat'); await document.fonts.load('450 40px "EB Garamond"');
  if (S.font) await googleFont(S.font);
}
$('font').addEventListener('change', async () => {
  const name = $('font').value.trim().replace(/\s+/g, ' ');
  if (!name) { S.font = null; $('fontMsg').textContent = ''; rebuild(); return; }
  $('fontMsg').textContent = `loading ${name}…`;
  if (await googleFont(name)) { S.font = name; $('fontMsg').textContent = ''; }
  else { S.font = null; $('fontMsg').textContent = `no google font called “${name}”. use the name as on fonts.google.com.`; }
  rebuild();
});

/** With the whole song analysed, cut on a grid fitted only to the beats around the edit: songs (and mixes) drift in tempo. */
function localGrid() {
  if (!S.whole || !S.beats.length) return;
  const len = 4 * +$('bars').value * 0.75 + 10, a = Math.max(0, S.start - 8), b = Math.min(S.song.duration, S.start + len);
  const g = fitGrid(S.beats.filter((t) => t >= a && t < b), S.downbeats.filter((t) => t >= a && t < b), b, a);
  if (g && g.bars.length >= 2) { S.g = g; $('bpm').textContent = `${g.bpm.toFixed(1)} bpm`; }
}

function rebuild() {
  stop();
  localGrid();
  if (S.g && S.media.length) {
    const want = 4 * +$('bars').value;
    const base = planEdit({ g: S.g, start: S.start, nBeats: want, every: +$('every').value, media: S.media, fps: 30 });
    const shape = `${base.t0}|${base.shots.map((sh) => sh.f0).join(',')}`;   // a different edit: hand-moved cuts no longer apply
    if (shape !== S.shape) { S.shape = shape; S.nudge = {}; S.pick = 0; }
    S.plan = retime(base, S.shift, S.nudge);
    const end = S.plan.t0 + want * S.g.period + 1;
    const longer = Math.min(S.song.duration, Math.max(end, S.part.a + partLength()));
    if (S.plan.nBeats < want && !S.analysing && !S.bg && longer > S.part.b + 0.5) {   // the part is too short for this edit: analyse more
      analyse({ ...S.part, b: longer, drop: S.plan.t0 }); return;
    }
    const lines = $('text').value.split('\n').map((l) => l.trim()).filter(Boolean);
    S.captions = placeCaptions(lines, S.plan, +$('capBars').value);
    const m = Math.floor(S.plan.t0 / 60), s = (S.plan.t0 % 60).toFixed(1).padStart(4, '0');
    $('editInfo').textContent = `${S.plan.shots.length} shots, ${S.plan.duration.toFixed(1)} s, from ${m}:${s} in the song (on the 1)`;
  } else {
    S.plan = null; S.captions = [];
    $('editInfo').textContent = S.g ? 'add photos or clips to see the cut.' : '';
  }
  $('play').disabled = $('export').disabled = !S.plan;
  $('empty').hidden = !!S.plan;
  $('tlBox').hidden = !S.plan;
  sizeView(); drawWave(); drawTimeline(); drawAt(0);
}

// ── the cut timeline: the edit up close, every cut a line you can move ────────────
const TL = { H: 118, top: 30, wave: 60 };   // thumbs strip above, waveform below
let tlDrag = null;
function tlView() {   // song time <-> canvas x, with a little air either side of the edit
  const W = $('tl').clientWidth, pad = 0.25, a = S.plan.t0 - pad, b = S.plan.t0 + S.plan.duration + pad;
  return { W, x: (t) => ((t - a) / (b - a)) * W, t: (px) => a + (px / W) * (b - a), a, b };
}
function drawTimeline(playT) {
  const cv = $('tl'); if (!S.plan || $('tlBox').hidden) return;
  const dpr = devicePixelRatio || 1, { W, x, a, b } = tlView(), H = TL.H, t0 = S.plan.t0;
  cv.width = W * dpr; cv.height = H * dpr;
  const c = cv.getContext('2d'); c.scale(dpr, dpr); c.clearRect(0, 0, W, H);
  // the music: peaks light, loudness dark, the same drawing as the big waveform
  const sr = S.song.sampleRate, mid = TL.top + 8 + TL.wave / 2, amp = TL.wave / 2;
  for (let px = 0; px < W; px++) {
    const i0 = Math.max(0, Math.floor((a + (px / W) * (b - a)) * sr)), i1 = Math.min(S.mono.length, Math.floor((a + ((px + 1) / W) * (b - a)) * sr));
    let lo = 0, hi = 0, sq = 0, n = 0;
    for (let i = i0; i < i1; i += 2) { const v = S.mono[i]; if (v < lo) lo = v; if (v > hi) hi = v; sq += v * v; n++; }
    const rms = Math.sqrt(sq / Math.max(1, n));
    c.fillStyle = '#c4c4c4'; c.fillRect(px, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
    c.fillStyle = '#111'; c.fillRect(px, mid - rms * amp * 1.4, 1, Math.max(1, rms * amp * 2.8));
  }
  // beats (short) and bars (tall), from the music, never moved
  for (const bt of S.plan.beats) {
    const isBar = S.plan.bars.some((br) => Math.abs(br - bt) < 1e-6), bx = Math.round(x(t0 + bt));
    c.fillStyle = isBar ? 'rgba(0,0,238,0.55)' : 'rgba(0,0,0,0.3)'; c.fillRect(bx, H - (isBar ? 12 : 6), 1, isBar ? 12 : 6);
  }
  // the shots: a strip of thumbnails, then one line per cut
  S.plan.shots.forEach((sh, i) => {
    const sx = x(t0 + sh.start), ex = x(t0 + sh.end), w = ex - sx, m = sh.media, src = m.kind === 'image' ? m.bitmap : m.el;
    c.fillStyle = i % 2 ? '#ececec' : '#f6f6f6'; c.fillRect(sx, 0, w, TL.top - 4);
    const sw = m.kind === 'image' ? src?.width : src?.videoWidth, shh = m.kind === 'image' ? src?.height : src?.videoHeight;
    if (sw && shh && w > 6) {   // a centre crop of the picture, as wide as the shot
      const th = TL.top - 6, tw = Math.min(w - 2, th * 1.6), r = Math.max(tw / sw, th / shh), cw = tw / r, ch = th / r;
      try { c.drawImage(src, (sw - cw) / 2, (shh - ch) / 2, cw, ch, sx + 1, 1, tw, th); } catch { /* a clip not ready yet */ }
    }
    if (!i) return;
    const moved = Math.abs(sh.start - sh.planned - S.shift) > 0.5 / S.plan.fps, picked = i === S.pick;
    c.fillStyle = picked ? '#c00' : moved ? '#0000ee' : '#111';
    c.fillRect(Math.round(sx), 0, picked ? 2 : 1.5, H);
    c.beginPath(); c.moveTo(sx - 4, 0); c.lineTo(sx + 5, 0); c.lineTo(sx + 0.5, 6); c.fill();   // a handle
  });
  if (playT != null) { c.fillStyle = '#c00'; c.globalAlpha = 0.6; c.fillRect(x(t0 + playT), 0, 1, H); c.globalAlpha = 1; }
  // what is moved
  const ms = Math.round(S.shift * 1000);
  $('shiftV').textContent = `${ms > 0 ? '+' : ''}${ms} ms`;
  const p = S.pick && S.plan.shots[S.pick];
  const own = p ? Math.round((p.start - p.planned - S.shift) * 1000) : 0;
  $('cutInfo').textContent = p ? `cut ${S.pick}: ${own > 0 ? '+' : ''}${own} ms on its own` : '';
  $('tlReset').hidden = !S.shift && !Object.keys(S.nudge).length;
}
function cutNear(px) {
  const { x } = tlView(); let best = 0, bd = 7;
  S.plan.shots.forEach((sh, i) => { const d = Math.abs(x(S.plan.t0 + sh.start) - px); if (i && d < bd) { bd = d; best = i; } });
  return best;
}
function setCut(i, editT, free) {   // move cut i to edit time editT, snapped to the nearest quarter beat unless free
  const sh = S.plan.shots[i];
  if (!free) {
    const q = S.plan.period / 4, b0 = S.plan.beats[0];
    editT = b0 + Math.round((editT - b0) / q) * q;
  }
  const base = sh.planned + S.shift, nd = editT - base;
  if (Math.abs(nd) < 0.5 / S.plan.fps) delete S.nudge[i]; else S.nudge[i] = nd;
  S.plan = retime({ ...S.plan, shots: S.plan.shots.map((s) => ({ ...s, start: s.planned, end: s.planned })) }, S.shift, S.nudge);
}
const tlX = (e) => e.clientX - $('tl').getBoundingClientRect().left;
$('tl').tabIndex = 0;
$('tl').addEventListener('pointerdown', (e) => {
  if (!S.plan) return;
  const i = cutNear(tlX(e));
  if (i) { stop(); S.pick = i; tlDrag = { i }; $('tl').setPointerCapture(e.pointerId); $('tl').focus(); }
  else { S.pick = 0; const t = Math.min(S.plan.duration - 1e-3, Math.max(0, tlView().t(tlX(e)) - S.plan.t0)); $('scrub').value = Math.round((t / S.plan.duration) * 1000); $('scrub').dispatchEvent(new Event('input')); }
  drawTimeline();
});
$('tl').addEventListener('pointermove', (e) => {
  if (!S.plan) return;
  if (!tlDrag) { $('tl').style.cursor = cutNear(tlX(e)) ? 'ew-resize' : 'default'; return; }
  setCut(tlDrag.i, tlView().t(tlX(e)) - S.plan.t0, e.altKey);
  drawTimeline(); drawAt(S.plan.shots[tlDrag.i].start);
});
$('tl').addEventListener('pointerup', () => { if (tlDrag) { tlDrag = null; rebuild(); } });
$('tl').addEventListener('dblclick', (e) => {
  const i = cutNear(tlX(e)); if (!i) return;
  delete S.nudge[i]; rebuild();
});
$('tl').addEventListener('keydown', (e) => {
  if (!S.plan || !S.pick || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
  e.preventDefault();
  const sh = S.plan.shots[S.pick]; setCut(S.pick, sh.start + (e.key === 'ArrowLeft' ? -1 : 1) / S.plan.fps, true);
  rebuild(); drawAt(S.plan.shots[S.pick].start);
});
const shiftAll = (frames) => { S.shift = Math.round((S.shift + frames / 30) * 30) / 30; rebuild(); };
$('shiftL').addEventListener('click', () => shiftAll(-1));
$('shiftR').addEventListener('click', () => shiftAll(1));
$('tlReset').addEventListener('click', () => { S.shift = 0; S.nudge = {}; S.pick = 0; rebuild(); });

// ── preview ────────────────────────────────────────────────────────────────
function sizeView() {
  const [W, H] = size(), cv = $('view');
  // the preview canvas draws at half resolution; the export draws at full size
  cv.width = W / 2; cv.height = H / 2;
  cv.style.aspectRatio = `${W} / ${H}`;
}
function drawAt(t) {
  if (!S.plan) return;
  const cv = $('view'), c = cv.getContext('2d'), [W, H] = size();
  c.save(); c.scale(cv.width / W, cv.height / H);
  drawFrame(c, W, H, t, S.plan, S.captions, opts());
  c.restore();
  $('clock').textContent = `${t.toFixed(1)} / ${S.plan.duration.toFixed(1)} s`;
  $('scrub').value = Math.round((t / S.plan.duration) * 1000);
}
$('scrub').addEventListener('input', async () => {
  if (!S.plan) return; stop();
  const t = ($('scrub').value / 1000) * S.plan.duration, shot = shotAt(S.plan, t);
  if (shot.media.kind === 'video') { shot.media.el.currentTime = shot.in + t - shot.start; await new Promise((r) => shot.media.el.addEventListener('seeked', r, { once: true })); }
  drawAt(t);
});
const playTime = () => (S.playing ? actx.currentTime - S.playing.at : 0);
$('play').addEventListener('click', () => (S.playing ? stop() : play()));
async function play() {
  if (!S.plan) return;
  await actx.resume();
  await loadFonts();
  const from = ($('scrub').value / 1000) * S.plan.duration;
  const src = actx.createBufferSource(); src.buffer = S.song; src.connect(actx.destination);
  src.start(actx.currentTime + 0.05, S.plan.t0 + from, S.plan.duration - from);
  S.playing = { src, at: actx.currentTime + 0.05 - from, shot: null };
  src.onended = () => { if (S.playing?.src === src) stop(); };
  $('play').textContent = 'stop';
  const tick = () => {
    if (!S.playing) return;
    const t = Math.max(0, playTime()), shot = shotAt(S.plan, t);
    if (shot !== S.playing.shot) {   // a new shot: start its clip at the right place
      if (S.playing.shot?.media.kind === 'video') S.playing.shot.media.el.pause();
      if (shot.media.kind === 'video') { shot.media.el.currentTime = shot.in + (t - shot.start); shot.media.el.play().catch(() => {}); }
      S.playing.shot = shot;
    }
    drawAt(Math.min(t, S.plan.duration - 1e-3)); drawWave(); drawTimeline(t);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
function stop() {
  if (!S.playing) return;
  const p = S.playing; S.playing = null;
  try { p.src.stop(); } catch { /* already stopped */ }
  if (p.shot?.media.kind === 'video') p.shot.media.el.pause();
  $('play').textContent = 'play'; drawWave(); drawTimeline();
}

// ── export ─────────────────────────────────────────────────────────────────
$('export').addEventListener('click', async () => {
  if (!S.plan) return;
  if (!canExport()) return showStatus('export', 'exporting needs webcodecs: use chrome, edge or safari 17+ on a computer.', 0, true);
  stop(); $('export').disabled = true; $('result').hidden = true;
  const [W, H] = size(), t0 = performance.now();
  try {
    await loadFonts();
    const blob = await exportMp4({ plan: S.plan, captions: S.captions, opts: opts(), W, H, song: S.song,
      onProgress: (p) => showStatus('export', `rendering… ${Math.round(p * 100)}%`, p) });
    const url = URL.createObjectURL(blob);
    $('resultVideo').src = url; $('download').href = url;
    $('download').download = `beatcut-${S.songName.replace(/\.[^.]+$/, '').slice(0, 40) || 'edit'}.mp4`;
    $('result').hidden = false;
    showStatus('export', `done: ${(blob.size / 1e6).toFixed(1)} mb in ${((performance.now() - t0) / 1000).toFixed(1)} s`, 1);
    window.__beatcut.lastExport = { size: blob.size, ms: performance.now() - t0, url };
  } catch (e) {
    showStatus('export', `export failed: ${e.message ?? e}`, 0, true);
  }
  $('export').disabled = false;
});

// ── demo: a made-up drum loop and colour cards, so anyone can try it without files ──
$('demo').addEventListener('click', async () => {
  $('demo').disabled = true;
  const buf = await demoSong(actx);
  if (!S.media.length) { S.media.push(...(await demoImages())); renderThumbs(); }
  if (!$('text').value.trim()) $('text').value = 'pov: your photos finally move\non the beat\nmade with beatcut';
  $('songLabel').textContent = 'demo beat, 124 bpm, made in your browser';
  await useSong(buf, 'demo-beat');
  $('demo').disabled = false;
});
