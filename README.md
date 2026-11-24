# beatcut

Make viral-style short videos on the beat. Give it a song (a link or a file) and some photos or clips. beatcut finds
every beat and bar with [Beat This!](https://github.com/CPJKU/beat_this), the most accurate open beat tracker, cuts your
media exactly on them, and adds text that lands on the music.

There are two ways to use it, and both run entirely on your own computer:

- **In Claude Code**, as a plugin with two skills. Ask in plain words, for example *"make a 15-second reel from the
  photos in ~/Desktop/rome to this song: https://youtu.be/…, with the hook 'POV: you found the spot'"*.
- **In the browser**, at https://beatcut.tedkane.workers.dev (the website in `web/`). Drop a song and photos or clips, pick the pace, type your captions, then
  preview and export an MP4. Nothing is uploaded.

## Install the Claude Code plugin

In Claude Code:

```
/plugin marketplace add cosmic-chameleon/beatcut
/plugin install beatcut@beatcut
```

Then ask for a video. Claude asks the same four things as the website (the song, the photos and clips, how to cut,
and the text), all in one go, and makes it.

You also need **ffmpeg** (on a Mac: `brew install ffmpeg`) and **Python 3.10–3.14**. The first time you use it,
Claude runs a one-time setup of about 180 MB. It doesn't need PyTorch, because the beat model runs with ONNX Runtime.

| Skill | What it does |
|---|---|
| `beatcut` | Pulls images from an **are.na** channel, downloads the song or video with **yt-dlp** (YouTube, TikTok, Instagram, SoundCloud…), finds beats and downbeats, picks the strongest section, and cuts photos and clips on beats or bars with a zoom kick on each beat |
| `captions` | Adds animated text: **pop** (bold words that land one per beat, the viral look), **type** (a typewriter serif over a soft vignette) or **clean** (lines that fade up) |

### Or run the scripts yourself

```bash
cd skills/beatcut/scripts
sh setup.sh                                   # once
PY=~/.cache/beatcut/venv/bin/python
sh grab.sh "https://youtu.be/..." ~/beatcut-work/song             # yt-dlp -> song.wav
$PY beats.py ~/beatcut-work/song/song.wav beats.json             # Beat This! -> beats, bars, BPM, section map
$PY cut.py --song ~/beatcut-work/song/song.wav --beats beats.json \
           --media ~/Desktop/rome --bars 8 --every 2 --out reel.mp4
$PY ../../captions/scripts/captions.py reel.mp4 --text "POV: you found the spot" "Rome, 2am" --font "Anton" final.mp4

# a moodboard reel from an are.na channel: every beat, each image whole on white
$PY arena.py https://www.are.na/<user>/<channel> ~/beatcut-work/board
$PY cut.py --song ~/beatcut-work/song/song.wav --beats beats.json --media ~/beatcut-work/board \
           --bars 16 --every 1 --fit white --out board.mp4
```

`cut.py --shift -0.033` moves every cut a frame earlier, and `"nudge"` on a shot in an edit file moves just that cut.
`captions.py --font` takes any Google Fonts family by name. Add `-h` to any script to see its options. For a finer edit (shot lengths, clip in-points, slow motion), `cut.py` takes
a JSON edit file, and `captions.py` takes a cues file. Both formats are described in the scripts.

## The website

`web/` is a plain static site with no build step. It needs three files from CDNs: ONNX Runtime Web (cdnjs),
mp4-muxer (jsDelivr) and Google Fonts.

1. **Song**: drop an audio or video file. As soon as it's decoded, the site picks the **best part** from the loudness
   curve: a loud, steady stretch that comes right after a quieter dip (a drop after a build-up). Beat This! runs on that
   part first (on the GPU through WebGPU where available, otherwise WASM), so you can start in seconds. Then it runs on
   the whole song in the background, and the start stays at the best part. Cuts use a beat grid fitted to the beats
   around the edit, because songs and DJ mixes drift in tempo. Click the waveform to move the start (it snaps to the bar
   line).
2. **Photos & clips**: drop them in, or paste an **are.na channel** link (or plain image links) to pull images in.
   Drag to reorder, or *shuffle*.
3. **Cut**: how often to cut (every beat to every 2 bars), total length, format (9:16, 4:5, 1:1, 16:9), frame (fill and
   crop, or the whole image on white or black for the moodboard look) and the zoom on the beat. Below that is the **cut
   timeline**: the edit up close over its waveform, with a line for each cut. Drag a cut to move it (it snaps to quarter
   beats, or hold alt to move it freely). Click one and use ← → to move it a frame, or double-click it to put it back.
   *Earlier* / *later* move every cut a frame at once.
4. **Text**: one caption per line. Each one gets 1, 2 or 4 bars, and pop words land on the beats. The font can be
   **any Google Font**: type its name (Anton, Playfair Display…).
5. **Play** to preview, then **Export MP4**. It encodes in the browser with WebCodecs (H.264 + AAC).

**Try a demo** makes a drum loop and some colour cards in the browser, so you can try it without any files.
It works best in Chrome or Edge on a computer. Safari 17+ works, and Firefox can detect beats but not export yet.

Run it locally (then open http://localhost:8788; Ctrl+C stops it):

```bash
sh serve.sh
```

It has to be served this way. Opening `web/index.html` straight from Finder shows the page without its styling, and
beat detection won't run, because browsers block web workers and model files on `file://` pages.

### Put it on your Cloudflare

The site is plain files, so Cloudflare serves it free as **Workers static assets** (what Cloudflare Pages became).
`wrangler.toml` points at `web/`.

```bash
npx wrangler login       # once: opens the browser to sign in to Cloudflare
npx wrangler deploy      # uploads web/ and prints the address
```

Live at **https://beatcut.tedkane.workers.dev**. Run `npx wrangler deploy` again to update it. To use your own
domain, go to the Cloudflare dashboard → Workers & Pages → beatcut → Settings → Domains & Routes. The model file is
10.5 MB, under the 25 MB limit per file.

## How the beat detection is checked

Three versions of the same beat tracker live here, and they agree exactly on a test track (a 60-second excerpt of a mix:
146 of 146 beats and 39 of 39 downbeats, 0 ms apart):

- **PyTorch Beat This!** (`small0` checkpoint), the reference
- **the CLI** (`skills/beatcut/scripts/beats.py`): the same model exported to ONNX (`tools/export_onnx.py`; ONNX and
  PyTorch outputs agree to 0.00002), with the log-mel spectrogram rebuilt in numpy
- **the website** (`web/js/beat-worker.js`): the same ONNX file in ONNX Runtime Web (WebGPU and WASM give the same
  results). The log-mel is in JavaScript, plus a resampler tuned to match the `soxr` resampler that Beat This uses. The
  browser's own resampler differs enough to lose beats.

The web code started from Beat Lab (`stem-studio/public/beatlab`), an earlier client-side Beat This! test page.

Both the CLI and the site then fit a steady **grid** (tempo, phase, and where the 1 falls) to what Beat This heard, and
cut on that grid. This way, a missed or extra beat never makes a cut drift or skip. The CLI and the site fit the same
grid to 0.1 ms.

### Rebuilding the model

`web/models/beat_this_small0.onnx` and `mel_filterbank.bin` are generated, and the same two files are in
`skills/beatcut/models/`. To rebuild them, or to export the larger `final0` model (80 MB: fine for the CLI, but too
big for Pages), use Python with `beat_this`, `torch`, `onnx`, `onnxscript` and `onnxruntime`:

```bash
python tools/export_onnx.py small0            # writes web/models/; then copy both files to skills/beatcut/models/
```

## Repo layout

```
.claude-plugin/        plugin.json + marketplace.json (what /plugin install reads)
skills/beatcut/        SKILL.md, scripts (setup, grab, beats, cut), models
skills/captions/       SKILL.md, scripts (captions)
web/                   the website (Cloudflare serves this folder)
tools/export_onnx.py   PyTorch -> ONNX export, checked against PyTorch
wrangler.toml          Cloudflare config (static assets from web/)
```

## Music rights

A song from YouTube or TikTok is someone else's recording. Using it isn't cleared for ads or paid promotion, and
platforms may mute or block posts that use it. For paid work, use music you've licensed.

## Credits

Beat This!: Foscarin, Schlüter and Widmer, *"Beat this! Accurate beat tracking without DBN postprocessing"*, ISMIR 2024
([code](https://github.com/CPJKU/beat_this), MIT). ONNX Runtime (Microsoft, MIT). mp4-muxer (Vanilagy, MIT).
yt-dlp (Unlicense). Fonts: Montserrat and EB Garamond (SIL Open Font License). beatcut itself is MIT licensed.
