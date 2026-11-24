// Export to MP4 in the browser with WebCodecs (H.264 + AAC, or Opus where AAC is missing) and mp4-muxer. Nothing is uploaded.
import { Muxer, ArrayBufferTarget } from 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.3/build/mp4-muxer.mjs';
import { drawFrame, shotAt } from './render.js';

export function canExport() { return 'VideoEncoder' in window && 'AudioEncoder' in window; }

async function pickVideoCodec(W, H, fps) {
  // High profile level 5.1 first (covers 1080x1920), then Main and Baseline
  for (const codec of ['avc1.640033', 'avc1.4d0033', 'avc1.42003e']) {
    const cfg = { codec, width: W, height: H, bitrate: 12e6, framerate: fps, avc: { format: 'avc' } };
    if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg;
  }
  throw new Error('this browser cannot encode h.264 video. try chrome or edge on a computer.');
}
async function pickAudioCodec(sampleRate) {
  for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const cfg = { codec, sampleRate, numberOfChannels: 2, bitrate: 192000 };
    if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { cfg, mux };
  }
  throw new Error('this browser cannot encode audio.');
}

/** The song from the edit's start, the length of the edit, with a short fade-out, as stereo at 48 kHz. */
async function songSegment(buffer, t0, dur, fade = 0.4) {
  const sr = 48000, ctx = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
  const src = ctx.createBufferSource(); src.buffer = buffer;
  const gain = ctx.createGain(); gain.gain.setValueAtTime(1, Math.max(0, dur - fade)); gain.gain.linearRampToValueAtTime(0, dur);
  src.connect(gain).connect(ctx.destination); src.start(0, t0, dur);
  return ctx.startRendering();
}

function seek(el, t) {
  return new Promise((resolve) => {
    if (Math.abs(el.currentTime - t) < 1e-4 && el.readyState >= 2) return resolve();
    const done = () => { el.removeEventListener('seeked', done); resolve(); };
    el.addEventListener('seeked', done); el.currentTime = t;
  });
}

export async function exportMp4({ plan, captions, opts, W, H, song, onProgress }) {
  const fps = plan.fps;
  const vcfg = await pickVideoCodec(W, H, fps);
  const audio = await songSegment(song, plan.t0, plan.duration);
  const { cfg: acfg, mux } = await pickAudioCodec(audio.sampleRate);
  const muxer = new Muxer({
    target: new ArrayBufferTarget(), fastStart: 'in-memory',
    video: { codec: 'avc', width: W, height: H, frameRate: fps },
    audio: { codec: mux, numberOfChannels: 2, sampleRate: audio.sampleRate },
  });
  let fail = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => { fail = e; } });
  venc.configure(vcfg);
  const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => { fail = e; } });
  aenc.configure(acfg);

  // audio: planar float32 in 1024-frame chunks
  const L = audio.getChannelData(0), R = audio.getChannelData(1), N = 1024;
  for (let i = 0; i < audio.length; i += N) {
    const n = Math.min(N, audio.length - i), data = new Float32Array(2 * n);
    data.set(L.subarray(i, i + n), 0); data.set(R.subarray(i, i + n), n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: audio.sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round(i / audio.sampleRate * 1e6), data });
    aenc.encode(ad); ad.close();
  }

  // video: every frame drawn exactly; clips are seeked to the frame's time
  const canvas = new OffscreenCanvas(W, H), ctx = canvas.getContext('2d');
  for (let f = 0; f < plan.frames; f++) {
    if (fail) throw fail;
    const t = f / fps, shot = shotAt(plan, t);
    if (shot.media.kind === 'video') {
      const el = shot.media.el, want = shot.in + (t - shot.start);
      await seek(el, Math.min(want, Math.max(0, el.duration - 0.04)));   // past the end: hold the last frame
    }
    drawFrame(ctx, W, H, t, plan, captions, opts);
    const vf = new VideoFrame(canvas, { timestamp: Math.round(f * 1e6 / fps), duration: Math.round(1e6 / fps) });
    venc.encode(vf, { keyFrame: f % (fps * 2) === 0 }); vf.close();
    if (venc.encodeQueueSize > 8) await new Promise((r) => venc.addEventListener('dequeue', r, { once: true }));
    if (f % 5 === 0) onProgress?.(f / plan.frames);
  }
  await venc.flush(); await aenc.flush();
  if (fail) throw fail;
  muxer.finalize();
  onProgress?.(1);
  return new Blob([muxer.target.buffer], { type: 'video/mp4' });
}
