"""captions.py <video> <cues.json> <out.mp4>
   captions.py <video> --text "POV: you found it" "the best pasta in Rome" --style pop <out.mp4>

Burns animated text into a video. The picture underneath and the audio are untouched (audio is copied).

Styles:
  pop    the viral look: bold caps, one word at a time, each word lands on a beat with a small bounce, the newest word in
         the accent colour, thick outline so it reads on anything
  type   typewriter: a serif typed out letter by letter with a blinking caret, over a soft dark vignette
  clean  whole lines fade up, white with a soft shadow

cues.json:
{
  "style": "pop",                     # default for every cue
  "accent": "#C8FF3D",               # colour of the newest word (pop)
  "y": 0.62,                          # vertical centre of the text, 0 top .. 1 bottom (keep clear of app buttons at the bottom)
  "size": 1.0,                        # text size multiplier
  "font": "Anton",                    # optional: any family from fonts.google.com, fetched once (also per cue)
  "cues": [
    {"text": "POV: you found the spot", "start": 0.0, "end": 2.6},
    {"text": "and it's only Tuesday", "bars": 2},          # no times: placed on the next bars (needs the video's .json from cut.py)
    {"text": "Rome, 2am", "style": "type", "start": 6.2, "end": 9.0}
  ]
}
Cues without "start" follow one another bar by bar ("bars": how many, default 1). Bar and beat times come from
<video>.json, which cut.py writes; for any other video pass --beats beats.json (from beats.py on the same video).
Without beat times, pop words come at an even pace.
"""
import argparse, json, math, os, pathlib, re, subprocess, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = pathlib.Path(os.environ.get('BEATCUT_FONTS', pathlib.Path.home() / '.cache/beatcut/fonts'))


GF_CACHE = FONTS / 'google'


def google_font(name, weight, italic=False):
    """Any family on fonts.google.com by name ("Anton", "Playfair Display"). Downloads the nearest weight it has once,
    into ~/.cache/beatcut/fonts/google, and returns the file. All Google Fonts are open-licence."""
    import ssl, urllib.request, urllib.error
    try:   # python.org builds on macOS have no CA certificates of their own
        import certifi; ctx = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        ctx = None
    near = sorted(range(100, 1000, 100), key=lambda w: (abs(w - weight), -w))
    for ital in ([1, 0] if italic else [0]):
        for w in near:
            f = GF_CACHE / f"{name.replace(' ', '')}-{w}{'i' if ital else ''}.ttf"
            if f.exists():
                return f
            fam = name.strip().replace(' ', '+') + (f':ital,wght@1,{w}' if ital else f':wght@{w}')
            try:   # with no browser user agent the css2 api answers with plain .ttf links
                with urllib.request.urlopen(f'https://fonts.googleapis.com/css2?family={fam}', timeout=30, context=ctx) as r:
                    css = r.read().decode()
            except urllib.error.HTTPError:
                continue   # that weight (or the family) does not exist
            url = re.search(r'url\((https://[^)]+)\)', css).group(1)
            with urllib.request.urlopen(url, timeout=60, context=ctx) as r:
                GF_CACHE.mkdir(parents=True, exist_ok=True); f.write_bytes(r.read())
            return f
    sys.exit(f'google font not found: {name!r} (use the exact name from fonts.google.com)')


def font(family, weight, px, italic=False, google=None):
    if google:
        return ImageFont.truetype(str(google_font(google, weight, italic)), int(px))
    name = {'sans': 'Montserrat', 'serif': 'EBGaramond'}[family] + ('-Italic' if italic else '') + '[wght].ttf'
    p = FONTS / name
    if not p.exists():
        sys.exit(f'font missing: {p} (run the beatcut setup.sh)')
    f = ImageFont.truetype(str(p), int(px))
    try:
        f.set_variation_by_axes([weight])
    except Exception:
        pass
    return f


def hexrgb(h):
    h = h.lstrip('#'); return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def probe(video):
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                        'stream=width,height,r_frame_rate:format=duration', '-of', 'json', str(video)],
                       capture_output=True, text=True, check=True)
    j = json.loads(r.stdout); s = j['streams'][0]
    n, d = s['r_frame_rate'].split('/')
    return int(s['width']), int(s['height']), float(n) / float(d), float(j['format']['duration'])


def ease_out_back(x):
    c = 1.9; x = min(max(x, 0), 1); return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2


# ── timing ──────────────────────────────────────────────────────────────────
def place(cues, meta, dur):
    bars = meta.get('bars') or []
    period = meta.get('period')
    t_bar = 0  # index into bars for the next auto-placed cue
    for c in cues:
        if 'start' in c:
            c.setdefault('end', c['start'] + 2.5)
            if bars:
                t_bar = next((i for i, b in enumerate(bars) if b >= c['end'] - 0.05), len(bars))
            continue
        nb = int(c.get('bars', 1))
        if bars and t_bar < len(bars):
            c['start'] = bars[t_bar] + 0.03
            c['end'] = (bars[t_bar + nb] if t_bar + nb < len(bars) else dur) - 0.05
            t_bar += nb
        else:
            prev = cues[cues.index(c) - 1]['end'] if cues.index(c) else 0.0
            c['start'] = prev + 0.05; c['end'] = min(dur, c['start'] + (4 * nb * period if period else 2.5))
    return [c for c in cues if c['start'] < dur]


def word_times(c, beats):
    words = c['text'].split()
    span = c['end'] - c['start']
    inside = [b for b in beats if c['start'] - 0.04 <= b < c['end'] - 0.2]
    if len(inside) >= len(words):
        # one word a beat; if there are many beats to spare, half-beats feel rushed, so whole beats it is
        return words, [max(c['start'], b) for b in inside[:len(words)]]
    if len(inside) >= 2 and len(inside) * 2 >= len(words):
        half = sorted(inside + [(a + b) / 2 for a, b in zip(inside, inside[1:])] + [inside[-1] + (inside[-1] - inside[-2]) / 2])
        return words, [max(c['start'], b) for b in half[:len(words)]]
    step = min(0.32, 0.7 * span / max(1, len(words)))
    return words, [c['start'] + i * step for i in range(len(words))]


# ── styles ──────────────────────────────────────────────────────────────────
class Pop:
    def __init__(self, c, W, H, cfg, beats):
        self.c = c; self.W, self.H = W, H
        px = 0.095 * W * cfg.get('size', 1) * c.get('size', 1)
        self.f = font('sans', 850, px, google=c.get('font', cfg.get('font')))
        self.stroke = max(2, int(px * 0.13))
        self.white = (255, 255, 255); self.accent = hexrgb(c.get('accent', cfg.get('accent', '#C8FF3D')))
        words, self.t = word_times(c, beats)
        self.words = [w.upper() if cfg.get('caps', True) else w for w in words]
        # lay out lines no wider than 86% of the frame
        space = self.f.getlength(' ')
        lines, cur, wid = [], [], 0
        for i, w in enumerate(self.words):
            lw = self.f.getlength(w)
            if cur and wid + space + lw > 0.86 * W:
                lines.append(cur); cur, wid = [], 0
            cur.append(i); wid += (space if len(cur) > 1 else 0) + lw
        if cur: lines.append(cur)
        asc, desc = self.f.getmetrics(); lh = (asc + desc) * 1.02
        y0 = cfg.get('y', 0.62) * H - lh * len(lines) / 2
        self.pos = {}
        for li, ln in enumerate(lines):
            tw = sum(self.f.getlength(self.words[i]) for i in ln) + space * (len(ln) - 1)
            x = (W - tw) / 2
            for i in ln:
                self.pos[i] = (x, y0 + li * lh); x += self.f.getlength(self.words[i]) + space
        self.cache = {}

    def word_img(self, i, color):
        k = (i, color)
        if k not in self.cache:
            w = self.words[i]; b = self.f.getbbox(w, stroke_width=self.stroke)
            im = Image.new('RGBA', (b[2] - b[0] + 4, b[3] - b[1] + 4), (0, 0, 0, 0))
            ImageDraw.Draw(im).text((2 - b[0], 2 - b[1]), w, font=self.f, fill=color + (255,),
                                    stroke_width=self.stroke, stroke_fill=(0, 0, 0, 255))
            self.cache[k] = (im, b)
        return self.cache[k]

    def draw(self, canvas, t):
        c = self.c
        fade = min(1, (c['end'] - t) / 0.12)
        shown = [i for i, ti in enumerate(self.t) if t >= ti]
        if not shown:
            return
        newest = shown[-1]
        for i in shown:
            age = t - self.t[i]
            im, b = self.word_img(i, self.accent if i == newest and age < 0.9 * (self.t[i + 1] - self.t[i] if i + 1 < len(self.t) else 9) else self.white)
            s = 0.55 + 0.45 * ease_out_back(age / 0.16)
            a = min(1, age / 0.05) * fade
            if s != 1:
                im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))), Image.BILINEAR)
            if a < 1:
                im = im.copy(); im.putalpha(im.getchannel('A').point(lambda v: int(v * a)))
            x, y = self.pos[i]
            ow, oh = self.word_img(i, self.white)[0].size
            canvas.alpha_composite(im, (int(x + b[0] - 2 + (ow - im.width) / 2), int(y + b[1] - 2 + (oh - im.height) / 2)))

    def key(self, t):
        shown = sum(t >= ti for ti in self.t)
        settled = all(t - ti > 0.2 for ti in self.t[:shown])
        return ('pop', shown, round(t, 3) if not settled or self.c['end'] - t < 0.13 else 0)


class Type:
    def __init__(self, c, W, H, cfg, beats):
        self.c = c; self.W, self.H = W, H
        px = 0.07 * W * cfg.get('size', 1) * c.get('size', 1)
        self.f = font('serif', 450, px, italic=c.get('italic', False), google=c.get('font', cfg.get('font')))
        self.color = hexrgb(c.get('color', cfg.get('color', '#F8F4EC')))
        self.cps = c.get('cps', 16)
        lines = c['text'].split('\n') if '\n' in c['text'] else self.wrap(c['text'], 0.8 * W)
        asc, desc = self.f.getmetrics(); lh = (asc + desc) * 1.12
        y0 = cfg.get('y', 0.62) * H - lh * len(lines) / 2
        self.lines = [(ln, (W - self.f.getlength(ln)) / 2, y0 + i * lh) for i, ln in enumerate(lines)]
        self.n = sum(len(ln) for ln in lines)
        # one soft warm vignette behind the block, reaching the frame edges
        yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
        cy = cfg.get('y', 0.62) * H
        r = np.sqrt(((xx - W / 2) / (0.75 * W)) ** 2 + ((yy - cy) / (0.32 * H)) ** 2)
        a = (np.clip(1 - r, 0, 1) ** 1.6 * 0.55 * 255).astype(np.uint8)
        v = np.zeros((H, W, 4), np.uint8); v[..., :3] = (18, 14, 10); v[..., 3] = a
        self.vig = Image.fromarray(v, 'RGBA')

    def wrap(self, text, maxw):
        out, cur = [], ''
        for w in text.split():
            if cur and self.f.getlength(cur + ' ' + w) > maxw:
                out.append(cur); cur = w
            else:
                cur = (cur + ' ' + w).strip()
        return out + ([cur] if cur else [])

    def chars(self, t):
        return min(self.n, int((t - self.c['start'] - 0.1) * self.cps)) if t > self.c['start'] + 0.1 else 0

    def draw(self, canvas, t):
        c = self.c
        a = min(1, (t - c['start']) / 0.35, (c['end'] - t) / 0.25)
        if a <= 0:
            return
        vig = self.vig if a >= 1 else Image.fromarray((np.asarray(self.vig) * [1, 1, 1, a]).astype(np.uint8), 'RGBA')
        canvas.alpha_composite(vig)
        d = ImageDraw.Draw(canvas)
        left = self.chars(t); col = self.color + (int(255 * a),)
        last = None
        for ln, x, y in self.lines:
            part = ln[:max(0, left)]; left -= len(ln)
            if part:
                d.text((x, y), part, font=self.f, fill=col); last = (x + self.f.getlength(part), y)
            if left < 0:
                break
        if last and (self.chars(t) < self.n or int(t * 2.2) % 2 == 0) and t - c['start'] < self.n / self.cps + 1.4:
            asc, desc = self.f.getmetrics()
            d.rectangle((last[0] + 4, last[1] + asc * 0.18, last[0] + 4 + max(2, asc // 14), last[1] + asc + desc * 0.3), fill=col)

    def key(self, t):
        c = self.c; fading = t - c['start'] < 0.35 or c['end'] - t < 0.25
        return ('type', self.chars(t), int(t * 2.2) % 2, round(t, 3) if fading else 0)


class Clean(Type):
    def __init__(self, c, W, H, cfg, beats):
        self.c = c; self.W, self.H = W, H
        px = 0.064 * W * cfg.get('size', 1) * c.get('size', 1)
        self.f = font('sans', 700, px, google=c.get('font', cfg.get('font')))
        self.color = hexrgb(c.get('color', cfg.get('color', '#FFFFFF')))
        lines = c['text'].split('\n') if '\n' in c['text'] else self.wrap(c['text'], 0.84 * W)
        asc, desc = self.f.getmetrics(); lh = (asc + desc) * 1.1
        y0 = cfg.get('y', 0.62) * H - lh * len(lines) / 2
        self.lines = [(ln, (W - self.f.getlength(ln)) / 2, y0 + i * lh) for i, ln in enumerate(lines)]
        im = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
        for ln, x, y in self.lines:
            d.text((x, y + px * 0.04), ln, font=self.f, fill=(0, 0, 0, 170))
        im = im.filter(ImageFilter.GaussianBlur(px * 0.08)); d = ImageDraw.Draw(im)
        for ln, x, y in self.lines:
            d.text((x, y), ln, font=self.f, fill=self.color + (255,))
        self.img = im

    def draw(self, canvas, t):
        a = min(1, (t - self.c['start']) / 0.25, (self.c['end'] - t) / 0.2)
        if a <= 0:
            return
        im = self.img
        if a < 1:
            im = im.copy(); im.putalpha(im.getchannel('A').point(lambda v: int(v * a)))
        dy = int((1 - a) * 0.012 * self.H) if t - self.c['start'] < 0.25 else 0
        canvas.alpha_composite(im, (0, dy))

    def key(self, t):
        c = self.c; return ('clean', round(t, 3) if t - c['start'] < 0.25 or c['end'] - t < 0.2 else 0)


STYLES = {'pop': Pop, 'type': Type, 'clean': Clean}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('video'); ap.add_argument('args', nargs='+', help='[cues.json] out.mp4')
    ap.add_argument('--text', nargs='+', help='one caption per argument, placed bar by bar')
    ap.add_argument('--style', choices=list(STYLES)); ap.add_argument('--bars', type=int, default=1, help='bars per --text caption')
    ap.add_argument('--beats', help='beats.json for this video, when it was not made by cut.py')
    ap.add_argument('--accent'); ap.add_argument('--y', type=float)
    ap.add_argument('--font', help='any Google Fonts family by name, e.g. "Anton" or "Playfair Display"')
    a = ap.parse_args()
    if a.text:
        cfg = {'cues': [{'text': t, 'bars': a.bars} for t in a.text]}; out = a.args[-1]
    else:
        if len(a.args) != 2:
            ap.error('give cues.json and out.mp4 (or --text ... out.mp4)')
        cfg = json.loads(pathlib.Path(a.args[0]).read_text()); out = a.args[1]
    if a.style: cfg['style'] = a.style
    if a.accent: cfg['accent'] = a.accent
    if a.font: cfg['font'] = a.font
    if a.y is not None: cfg['y'] = a.y
    W, H, fps, dur = probe(a.video)
    meta = {}
    mp = pathlib.Path(a.beats) if a.beats else pathlib.Path(str(a.video) + '.json')
    if mp.exists():
        meta = json.loads(mp.read_text())
        if 'grid' in meta and 'beats' in meta and 'cuts' not in meta:   # a beats.json from beats.py
            meta = {'beats': meta['grid'], 'bars': meta['bars'], 'period': meta['period']}
    cues = place([dict(c) for c in cfg['cues']], meta, dur)
    beats = meta.get('beats', [])
    layers = [STYLES[c.get('style', cfg.get('style', 'pop'))](c, W, H, cfg, beats) for c in cues]
    for c in cues:
        print(f"CUE {c['start']:6.2f}-{c['end']:6.2f}  {c.get('style', cfg.get('style', 'pop')):5s} {c['text']!r}")
    n = int(round(dur * fps))
    ff = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-i', str(a.video), '-f', 'rawvideo', '-pix_fmt', 'rgba',
                           '-s', f'{W}x{H}', '-r', f'{fps:.6f}', '-i', '-',
                           '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto:shortest=1,format=yuv420p[v]',
                           '-map', '[v]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
                           '-c:a', 'copy', '-movflags', '+faststart', str(out)], stdin=subprocess.PIPE)
    blank = bytes(W * H * 4); last_key, last = None, blank
    for f in range(n):
        t = f / fps
        live = [L for L in layers if L.c['start'] <= t < L.c['end']]
        k = tuple((id(L), L.key(t)) for L in live)
        if k != last_key:
            if live:
                cv = Image.new('RGBA', (W, H), (0, 0, 0, 0))
                for L in live:
                    L.draw(cv, t)
                last = cv.tobytes()
            else:
                last = blank
            last_key = k
        ff.stdin.write(last)
    ff.stdin.close()
    if ff.wait():
        sys.exit('ffmpeg failed')
    print(f'DONE {out}')


if __name__ == '__main__':
    main()
