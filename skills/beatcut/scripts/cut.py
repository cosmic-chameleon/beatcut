"""cut.py <edit.json> <out.mp4>          cut photos and clips on the beat, with the song underneath
   cut.py --song song.wav --beats beats.json --media a.jpg b.mp4 c/ --out out.mp4 [--start 30] [--bars 8] [--every 2]

The edit file (every field but "song", "beats" and "shots" is optional):
{
  "song": "song.wav", "beats": "beats.json",       # beats.json from beats.py
  "start": 30.0,          # seconds into the song; the edit starts on the first bar line at or after it
  "bars": 8,              # length in bars (or "seconds": 15, rounded to whole beats)
  "every": 2,             # default shot length in beats: 4 calm, 2 energetic, 1 a burst
  "size": [1080, 1920],   # 9:16 vertical (default); [1080, 1080] square; [1920, 1080] wide
  "fps": 30,
  "pulse": 0.03,          # zoom kick on every beat (0 = off), twice as strong on the 1 of each bar
  "zoom": 0.06,           # slow push-in on photos over their shot (0 = still)
  "fit": "cover",         # cover: fill the frame, cropping; white / black: the whole image inside a margin on that colour
  "fade": 0.4,            # music fade-out at the end, seconds
  "shots": [              # played in order, looped if the edit is longer
    {"src": "clips/a.mp4", "in": 3.2, "beats": 4},   # "in": where in the clip to start (default: where it last stopped)
    {"src": "photos/b.jpg"},
    {"src": "clips/c.mov", "in": 0, "beats": 1, "speed": 0.5}
  ]
}
Clips play at real speed (or "speed"); a clip too short for its slot holds its last frame. Each shot starts on an exact frame
of the beat grid, so cuts never drift. The clips' own sound is dropped: the song is the soundtrack.
"""
import argparse, json, math, os, pathlib, shutil, subprocess, sys, tempfile

IMG = {'.jpg', '.jpeg', '.png', '.webp', '.heic', '.bmp', '.tif', '.tiff'}
VID = {'.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.gif'}   # a gif plays as a clip (a still one holds)


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode:
        sys.exit(f"ffmpeg failed:\n{' '.join(map(str, cmd))}\n{r.stderr[-2000:]}")
    return r


def duration(path):
    r = run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)])
    try:
        return float(r.stdout.strip())
    except ValueError:
        return 0.0


def expand(media):
    out = []
    for m in media:
        p = pathlib.Path(m)
        if p.is_dir():
            out += sorted(q for q in p.iterdir() if q.suffix.lower() in IMG | VID)
        else:
            out.append(p)
    return [{'src': str(p)} for p in out]


def build(edit, out):
    base = pathlib.Path(edit.get('_dir', '.'))
    rel = lambda p: str(p if os.path.isabs(p) else base / p)
    beats = json.loads(pathlib.Path(rel(edit['beats'])).read_text())
    grid, bars, period = beats['grid'], beats['bars'], beats['period']
    # refit the grid to the beats around the edit only: songs and mixes drift in tempo, and a grid fitted to the whole
    # track can slide off the beat by the time it reaches the part being cut
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent)); import numpy as np; from beats import fit_grid
    s0 = float(edit.get('start', 0)); span = 4 * edit.get('bars', 8) * 0.75 + 10 if 'seconds' not in edit else edit['seconds'] + 10
    a, b = max(0.0, s0 - 8), min(beats['duration'], s0 + span)
    near = np.array([t for t in beats['beats'] if a <= t < b]); dn = np.array([t for t in beats['downbeats'] if a <= t < b])
    lg = fit_grid(near, dn, b, edit.get('bpm')) if len(near) >= 8 else None
    if lg:
        lg['grid'] = [t for t in lg['grid'] if t >= a]; lg['bars'] = [t for t in lg['bars'] if t >= a]
        if len(lg['bars']) >= 2:
            grid, bars, period = lg['grid'], lg['bars'], lg['period']
    W, H = edit.get('size', [1080, 1920]); fps = edit.get('fps', 30)
    every = edit.get('every', 2); pulse = edit.get('pulse', 0.03); zoom = edit.get('zoom', 0.06)
    shots = edit['shots']
    if not shots:
        sys.exit('no shots: give photos or clips')

    # the start: the first bar line at or after "start"
    start_req = float(edit.get('start', 0))
    t0 = next((b for b in bars if b >= start_req - 0.02), None)
    if t0 is None:
        sys.exit(f'no bar line after {start_req:.2f} s (the song is {beats["duration"]:.1f} s)')
    g0 = min(range(len(grid)), key=lambda i: abs(grid[i] - t0))
    if 'seconds' in edit:
        n_beats = max(1, round(edit['seconds'] / period))
    else:
        n_beats = 4 * edit.get('bars', 8)
    if g0 + n_beats >= len(grid):
        n_beats = len(grid) - 1 - g0
        print(f'WARN the song ends: the edit is {n_beats} beats long')
    one = grid.index(min(grid, key=lambda g: abs(g - bars[0])))   # grid index of a bar line

    # lay the shots on the grid
    plan, k, i = [], 0, 0
    while k < n_beats:
        s = dict(shots[i % len(shots)]); i += 1
        nb = min(int(s.get('beats', every)), n_beats - k)
        a_t, b_t = grid[g0 + k] - t0, grid[g0 + k + nb] - t0
        f0, f1 = round(a_t * fps), round(b_t * fps)
        plan.append({**s, 'f0': f0, 'frames': f1 - f0, 'beat0': g0 + k}); k += nb
    total = plan[-1]['f0'] + plan[-1]['frames']
    dur = total / fps
    print(f'CUT {len(plan)} shots over {n_beats} beats ({n_beats / 4:g} bars), {dur:.2f} s from {t0:.2f} s in the song, '
          f'{60 / period:.1f} BPM here, {W}x{H} @ {fps}')

    tmp = pathlib.Path(tempfile.mkdtemp(prefix='beatcut-'))
    try:
        parts = []; resume = {}   # a clip used again carries on where it stopped, unless its shot gives "in"
        for n, s in enumerate(plan):
            src = rel(s['src']); ext = pathlib.Path(src).suffix.lower(); nf = s['frames']
            # zoom: pulse decays from each beat; the 1 of a bar kicks twice as hard; photos also push in slowly
            off = (s['beat0'] - one) % 4   # this shot's first beat's position in the bar
            beat_t = f'mod(t,{period:.6f})'
            bar_on = f'eq(mod(floor(t/{period:.6f})+{off},4),0)'
            z = f'1+{pulse:.4f}*(1+{bar_on})*exp(-{beat_t}/0.09)' if pulse else '1'
            if ext in IMG:
                z += f'+{zoom:.4f}*t/{nf / fps:.4f}' if zoom else ''
                inp = ['-loop', '1', '-framerate', str(fps), '-i', src]
                pre = ''
            elif ext in VID:
                cdur = duration(src); sp = float(s.get('speed', 1))
                t_in = float(s['in']) if 'in' in s else resume.get(src, 0.0)
                if t_in >= cdur - 0.2:
                    t_in = 0.0
                resume[src] = t_in + nf / fps * sp
                inp = ['-ss', f'{t_in:.3f}', '-i', src]
                pre = (f'setpts=PTS/{sp},' if sp != 1 else '') + f'fps={fps},'
                need = nf / fps * sp
                if cdur - t_in < need - 0.05:
                    print(f'WARN {pathlib.Path(src).name}: {cdur - t_in:.2f} s from "in" but the slot needs {need:.2f} s; '
                          'it holds its last frame')
                pre += f'tpad=stop_mode=clone:stop_duration={nf / fps + 1:.3f},'
            else:
                sys.exit(f'{src}: not a photo or video')
            fit = edit.get('fit', 'cover')
            if fit in ('white', 'black'):   # the moodboard look: the whole image, 84 % of the frame, centred on a colour
                iw, ih = int(W * 0.84) // 2 * 2, int(H * 0.84) // 2 * 2
                frame = (f'scale={iw}:{ih}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:color={fit},setsar=1,')
            else:
                frame = f'scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1,'
            vf = (f'{pre}{frame}'
                  f"scale=w='2*trunc({W}*({z})/2)':h='2*trunc({H}*({z})/2)':eval=frame,"
                  f"crop={W}:{H}:'(iw-{W})/2':'(ih-{H})/2',format=yuv420p")
            part = tmp / f'{n:04d}.mp4'
            run(['ffmpeg', '-v', 'error', '-y', *inp, '-vf', vf, '-frames:v', str(nf), '-r', str(fps), '-an',
                 '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-video_track_timescale', str(fps * 1000), str(part)])
            parts.append(part)
            print(f'  {n + 1:3d}/{len(plan)}  {pathlib.Path(src).name:32.32s} {s["frames"]:4d} frames  '
                  f'{s["f0"] / fps:6.2f}-{(s["f0"] + s["frames"]) / fps:6.2f} s')
        (tmp / 'list.txt').write_text(''.join(f"file '{p}'\n" for p in parts))
        fade = float(edit.get('fade', 0.4))
        af = f'atrim=0:{dur:.4f},asetpts=PTS-STARTPTS' + (f',afade=t=out:st={max(0, dur - fade):.4f}:d={fade}' if fade else '')
        run(['ffmpeg', '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', str(tmp / 'list.txt'),
             '-ss', f'{t0:.4f}', '-i', rel(edit['song']), '-map', '0:v', '-map', '1:a', '-af', af,
             '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-t', f'{dur:.4f}', '-movflags', '+faststart', str(out)])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    # what was made, for captions.py: the cut times and beat times inside the new video
    meta = {'video': str(out), 'fps': fps, 'size': [W, H], 'duration': dur, 'song_start': t0, 'bpm': round(60 / period, 3),
            'period': period, 'beats': [round(grid[g0 + j] - t0, 4) for j in range(n_beats + 1)],
            'bars': [round(grid[g0 + j] - t0, 4) for j in range(n_beats + 1) if (g0 + j - one) % 4 == 0],
            'cuts': [round(s['f0'] / fps, 4) for s in plan]}
    pathlib.Path(str(out) + '.json').write_text(json.dumps(meta, indent=1))
    print(f'DONE {out} ({dur:.2f} s) and {out}.json (cut and beat times, for captions)')


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('edit', nargs='?'); ap.add_argument('out_pos', nargs='?')
    ap.add_argument('--song'); ap.add_argument('--beats'); ap.add_argument('--media', nargs='*'); ap.add_argument('--out')
    ap.add_argument('--start', type=float); ap.add_argument('--bars', type=int); ap.add_argument('--seconds', type=float)
    ap.add_argument('--every', type=int); ap.add_argument('--pulse', type=float); ap.add_argument('--zoom', type=float)
    ap.add_argument('--size', help='WxH, e.g. 1080x1920'); ap.add_argument('--fit', choices=['cover', 'white', 'black']); ap.add_argument('--fps', type=int)
    a = ap.parse_args()
    if a.edit:
        edit = json.loads(pathlib.Path(a.edit).read_text()); edit['_dir'] = str(pathlib.Path(a.edit).parent)
        out = a.out_pos or a.out
    else:
        if not (a.song and a.beats and a.media and a.out):
            ap.error('give an edit.json and an output, or --song --beats --media --out')
        edit = {'song': a.song, 'beats': a.beats, 'shots': expand(a.media)}; out = a.out
    for k in ('start', 'bars', 'seconds', 'every', 'pulse', 'zoom', 'fps', 'fit'):
        if getattr(a, k) is not None:
            edit[k] = getattr(a, k)
    if a.size:
        edit['size'] = [int(v) for v in a.size.lower().split('x')]
    if not out:
        ap.error('no output file')
    build(edit, out)


if __name__ == '__main__':
    main()
