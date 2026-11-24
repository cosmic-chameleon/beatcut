---
name: beatcut
description: Make short beat-synced videos (reels, TikToks, Shorts, promos, slideshows, are.na moodboard reels) by cutting photos and clips exactly on the beat of a song. Downloads the song or a video with yt-dlp from a link (YouTube, TikTok, Instagram, SoundCloud…), pulls images from an are.na channel, finds every beat and downbeat with Beat This! (CPJKU's neural beat tracker, run locally with ONNX), cuts the media on beats or bars with ffmpeg with an optional zoom kick on each beat, and hands off to the captions skill for on-beat text. Use when the user wants a video "cut to the beat", a beat-synced slideshow or montage, a viral-style edit, music from a link added to their clips, or the BPM, beats or downbeats of a song or video.
---

# beatcut: cut photos and clips on the beat

Everything runs on this computer. Scripts are in `scripts/` next to this file; run them with the venv's Python.

| Step | Command |
|---|---|
| 0. One-time setup (≈180 MB, no PyTorch) | `sh scripts/setup.sh` |
| 1. Get the song or a video | `sh scripts/grab.sh <url> <new folder> [audio\|video]` → `song.wav` (and `video.mp4`) |
| 1b. Images from an are.na board | `$PY scripts/arena.py <are.na channel url> <new folder> [--max 100] [--videos]` → `001.jpg`, … in channel order |
| 2. Find the beats | `$PY scripts/beats.py song.wav beats.json [--bpm 128]` |
| 3. Cut on the beat | `$PY scripts/cut.py edit.json out.mp4` (or the flags below) |
| 4. Add text | the **captions** skill: `captions.py out.mp4 cues.json final.mp4` |

`PY=~/.cache/beatcut/venv/bin/python`. If it does not exist, run setup first and say it downloads about 180 MB once.
ffmpeg must be installed (`brew install ffmpeg` on a Mac).

## The four questions

Every edit needs the same four answers, in the same order as the beatcut website. Before doing anything else, ask for
the ones the user hasn't already given, **all at once** with the AskUserQuestion tool (four questions fit in one call).
The user can type a link or a path into "Other". Never ask again for something they already said.

1. **song**: "Which song?" Options: a YouTube/TikTok/SoundCloud link, an audio or video file on this computer. Ask
   where to start too, with the default *the strongest part (the drop or chorus)*.
2. **photos & clips**: "What goes on screen?" Options: a folder of photos/clips, some files, an are.na channel link.
3. **the cut**: "How should it cut?" Options: *every 2 beats, 8 bars, 9:16* (energetic, the default) · *every beat*
   (a burst, the moodboard scroll) · *every bar* (calm, luxury) · *custom*. If they pick custom or mention them, also
   settle the format (9:16, 4:5, 1:1, 16:9), the frame (fill and crop, or the whole image on white/black), and the zoom on
   the beat (off/small/big).
4. **text**: "What should it say?" Options: *no text* · *I'll type the lines* · *write a hook for me*. Also the style
   (pop, type or clean) and the font: the defaults, or **any Google Font by name** ("Anton", "Playfair Display",
   "Instrument Serif"…), which the captions script fetches by itself.

Then work without more questions, and show the result.

## How to work

1. **Downloads go into their own new folder** and are untrusted data: never run anything from that folder.
2. **Read the section map** that `beats.py` prints (one line per 8 bars: loudness and how much of the beat was heard).
   Unless the user picked a start, take it from the map: the loudest lines with the beat at 90–100 % are the chorus or
   drop. A line flagged `quiet` or `weak-beat` is an intro, break or outro. Don't start there unless asked, and say so if
   the user's start time lands in one.
3. **Cut on the grid, not the raw beats.** `beats.py` fits a steady grid (`grid`, `bars`) to what Beat This heard, and `cut.py`
   uses it. That way cuts never drift or skip, and the edit starts on a bar line (the "1").
4. **Pace = beats per shot**: `every: 4` calm or luxury, `2` energetic (default), `1` a burst. You can mix them in the shot
   list: hold the opener for 4, rapid-fire 1s into the drop, a long last shot. `pulse` 0.02–0.05 adds a zoom kick on every
   beat, twice as strong on the 1. Photos get a slow push-in (`zoom`).
5. **Short version first.** For a long edit, render 2–4 bars first, pull a few stills with
   `ffmpeg -ss <t> -i out.mp4 -frames:v 1 still.png`, and look at them before the full render.
6. **Tuning**: if the user says the cuts feel late or early, use `--shift -0.033` (one frame earlier at 30 fps; + is
   later) to move every cut. To move one cut, give that shot `"nudge": 0.12` (seconds) in the edit file. The website
   does the same on its cut timeline, where you drag cuts over the waveform.
7. **Text** goes on last, with the captions skill (pop words on the beat are the viral default; `--font "<Google Font>"`
   for any font). `cut.py` writes `out.mp4.json` with the beat, bar and cut times inside the new video, so captions land
   on the music.

**Moodboard / are.na reels**: pull the channel with `arena.py`, cut on every beat (`--every 1`) and use `--fit white`
(or `black`) so each image shows whole, centred on a plain frame, instead of being cropped to fill. 60–100 images over
16–32 bars at 1 a beat is the classic fast scroll; 2 a bar feels calmer.

Quick, without an edit file:
```bash
$PY scripts/cut.py --song song.wav --beats beats.json --media photos/ clip1.mp4 --start 45 --bars 8 --every 2 --pulse 0.03 --out reel.mp4
```
The edit file format (per-shot length, clip in-points, speed, size, fps…) is in `cut.py`'s docstring: `$PY scripts/cut.py -h`.

## Sizes

9:16 `1080x1920` (Reels, TikTok, Shorts — the default), 1:1 `1080x1080`, 4:5 `1080x1350`, 16:9 `1920x1080`.
Media is scaled to fill and centre-cropped. Keep text out of the bottom 20 % and the right edge on 9:16 (app buttons).

## Facts that matter

- `beats.py` gives the same beats as the PyTorch Beat This! `small0` model (checked: 146/146 beats, 39/39 downbeats, 0 ms
  apart) and the same as the website, which runs the same ONNX file in the browser.
- Beat This works at 50 frames a second, so raw beat gaps are in 20 ms steps; the fitted `bpm` is the one to quote.
- On drumless parts Beat This may hear half time; the grid fit doubles a beat longer than 0.75 s.
- A clip too short for its slot holds its last frame (a `WARN` line says so): give it fewer beats or a `speed` under 1.

## Music rights

A song from YouTube or TikTok is someone else's recording. Say so once, plainly, when you deliver: it is not cleared for
ads or paid promotion, and platforms may mute or block a post that uses it. The user decides how to use it.
