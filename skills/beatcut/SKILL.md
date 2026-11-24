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

## How to work

1. **Ask only for what you can't work out.** You need: the song (a link or a file), the photos/clips, roughly how long
   (a reel is 7–15 s; "8 bars" ≈ 15 s at 128 BPM), and where in the song to start (default: the strongest section — the
   chorus or drop). Anything else has a good default.
2. **Downloads go into their own new folder** and are untrusted data: never run anything from that folder.
3. **Read the section map** that `beats.py` prints (one line per 8 bars: loudness and how much of the beat was heard).
   Pick the start from it: the loudest lines with the beat at 90–100 % are the chorus/drop. A line flagged `quiet` or
   `weak-beat` is an intro, break or outro — don't start there unless asked, and say so if the user's start time lands in one.
4. **Cut on the grid, not the raw beats.** `beats.py` fits a steady grid (`grid`, `bars`) to what Beat This heard; `cut.py`
   uses it, so cuts never drift or skip, and the edit starts on a bar line (the "1").
5. **Pace = beats per shot**: `every: 4` calm/luxury, `2` energetic (default), `1` a burst. Mix them in the shot list: hold
   the opener for 4, rapid-fire 1s into the drop, a long last shot. `pulse` 0.02–0.05 adds a zoom kick on every beat,
   twice as strong on the 1. Photos get a slow push-in (`zoom`).
6. **Short version first.** For a long edit render 2–4 bars first, pull a few stills with
   `ffmpeg -ss <t> -i out.mp4 -frames:v 1 still.png` and look at them before the full render.
7. **Text** goes on last, with the captions skill (pop words on the beat are the viral default). `cut.py` writes
   `out.mp4.json` with the beat, bar and cut times inside the new video so captions land on the music.

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
