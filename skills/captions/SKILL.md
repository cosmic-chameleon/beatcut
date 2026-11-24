---
name: captions
description: Add animated text to a video — viral word-by-word "pop" captions that land on the beat, typewriter text over a soft vignette, or clean fade-up titles — without touching the picture or the sound. Times text to the bars and beats of a beatcut edit automatically. Use when the user wants text, captions, a hook, titles, a POV line or a typewriter effect on a reel, TikTok, Short or promo.
---

# captions: text on the beat

`$PY scripts/captions.py <video> <cues.json> <out.mp4>` — or for a quick one,
`$PY scripts/captions.py <video> --text "first line" "second line" --style pop <out.mp4>`.

`PY=~/.cache/beatcut/venv/bin/python`; if it is missing run `sh scripts/setup.sh` (shared with the beatcut skill, ≈180 MB
once; it also fetches the fonts, Montserrat and EB Garamond, both open-licence). The audio is copied untouched.

## Styles

| style | looks like | use for |
|---|---|---|
| `pop` (default) | bold caps, one word per beat with a bounce, newest word in the accent colour, thick outline | hooks, POV lines, the viral look |
| `type` | serif typed letter by letter, blinking caret, soft dark vignette behind | luxury, travel, brand films, quotes |
| `clean` | white sans lines fade up with a soft shadow | subtitles, info, end cards |

## Writing good captions

- **Hook in the first second.** The first cue starts at 0 and says why to keep watching ("POV: …", "the spot no one
  tells you about", a question). 3–7 words a cue; a viewer reads about 3 words a second.
- **One idea per cue, one cue per 1–2 bars.** Cues without times are placed bar by bar (`"bars": 2` for a longer one) on
  the bar lines from `<video>.json`, which beatcut's `cut.py` writes. For another video, run beatcut's
  `beats.py` on it and pass `--beats beats.json`; or give each cue `start`/`end` in seconds.
- **Keep it in the safe zone** on 9:16: the default height `y: 0.62` sits above the app's caption and buttons. Use
  `y: 0.3` for top text. Never in the bottom 20 %.
- **Style mixing**: `pop` for the hook, `type` for a reflective line, `clean` for the end card / call to action.
- `"\n"` in a `type` or `clean` cue forces a line break ("Rome,\n2am").
- Check a still or two after rendering: `ffmpeg -ss 1.2 -i out.mp4 -frames:v 1 still.png`.

The cues file (all fields but `cues` optional):
```json
{
  "style": "pop", "accent": "#C8FF3D", "y": 0.62, "size": 1.0,
  "cues": [
    {"text": "POV: you found the spot", "bars": 2},
    {"text": "Rome,\n2am", "style": "type", "bars": 2},
    {"text": "save this for later", "style": "clean", "start": 9.1, "end": 11.0}
  ]
}
```
Per cue you can also set `size`, `color`, `accent`, `italic` (type) and `cps` (typing speed, letters a second).
