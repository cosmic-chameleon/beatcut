// A demo you can try without any files: a 124 BPM drum-and-bass loop synthesised in the browser, and six colour cards.
export async function demoSong(actx, bpm = 124, bars = 24) {
  const sr = 44100, beat = 60 / bpm, dur = bars * 4 * beat + 1;
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
  const out = ctx.createDynamicsCompressor(); out.connect(ctx.destination);
  const noise = ctx.createBuffer(1, sr, sr); { const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
  const kick = (t, v = 1) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g).connect(out); o.start(t); o.stop(t + 0.4);
  };
  const hit = (t, freq, len, v, type = 'highpass') => {
    const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = noise; f.type = type; f.frequency.value = freq;
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    s.connect(f).connect(g).connect(out); s.start(t, Math.random() * 0.5); s.stop(t + len + 0.02);
  };
  const bass = (t, note, len) => {
    const o = ctx.createOscillator(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    o.type = 'sawtooth'; o.frequency.value = 55 * 2 ** (note / 12); f.type = 'lowpass'; f.frequency.value = 420;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.22, t + 0.01); g.gain.setTargetAtTime(0.0001, t + len * 0.7, 0.03);
    o.connect(f).connect(g).connect(out); o.start(t); o.stop(t + len);
  };
  const line = [0, 0, 3, 5, 7, 7, 5, 3];
  for (let b = 0; b < bars; b++) {
    const intro = b < 4;
    for (let k = 0; k < 4; k++) {
      const t = 0.5 + (b * 4 + k) * beat;
      if (!intro || k === 0) kick(t, k === 0 ? 1 : 0.8);
      if (!intro && (k === 1 || k === 3)) hit(t, 1800, 0.18, 0.5, 'bandpass');
      hit(t, 7000, 0.04, 0.18); hit(t + beat / 2, 7000, 0.04, 0.12);
      if (!intro) bass(t + beat / 2, line[(b % 2) * 4 + k], beat / 2);
    }
  }
  return ctx.startRendering();
}

export async function demoImages() {
  const cards = [['#ff5a36', 'golden hour'], ['#2b59ff', 'the drive'], ['#c8ff3d', 'the spot'], ['#ff3d9a', 'late dinner'], ['#13c2a3', 'the swim'], ['#f2b705', 'one more']];
  const out = [];
  for (const [col, word] of cards) {
    const c = new OffscreenCanvas(1200, 1600), x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 1200, 1600); g.addColorStop(0, col); g.addColorStop(1, '#111');
    x.fillStyle = g; x.fillRect(0, 0, 1200, 1600);
    x.strokeStyle = 'rgba(255,255,255,0.16)'; x.lineWidth = 3;
    for (let i = 1; i < 12; i++) { x.beginPath(); x.arc(600, 800, i * 70, 0, Math.PI * 2); x.stroke(); }
    x.fillStyle = 'rgba(255,255,255,0.9)'; x.font = '800 110px Montserrat, system-ui, sans-serif'; x.textAlign = 'center';
    x.fillText(word, 600, 830);
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    out.push({ kind: 'image', name: `${word}.jpg`, bitmap: await createImageBitmap(c), thumb: URL.createObjectURL(blob) });
  }
  return out;
}
