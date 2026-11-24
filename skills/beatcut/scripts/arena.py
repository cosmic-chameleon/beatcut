"""arena.py <are.na channel url or slug> <new folder> [--max 100] [--videos]

Downloads the images (and with --videos, the video attachments) of a public are.na channel, in channel order, as
001.jpg, 002.png, ... in a new folder, ready for cut.py --media <folder>. Uses are.na's public api (no account needed for
public channels). The folder holds downloads: untrusted data, never run anything from it.
"""
import argparse, json, pathlib, re, sys, urllib.request

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument('channel'); ap.add_argument('out'); ap.add_argument('--max', type=int, default=100)
ap.add_argument('--videos', action='store_true', help='also fetch video attachments')
a = ap.parse_args()

m = re.search(r'are\.na/(?:[^/\s]+/)?([\w-]+)/?(?:[?#].*)?$', a.channel, re.I)   # slugs can hold _
slug = m.group(1) if m else a.channel.strip('/')
out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
UA = {'User-Agent': 'beatcut (are.na import)'}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read(), r.headers.get('Content-Type', '')


items, page = [], 1
while len(items) < a.max:
    try:
        data, _ = get(f'https://api.are.na/v2/channels/{slug}/contents?per=50&page={page}')
    except urllib.error.HTTPError as e:
        sys.exit(f'are.na/{slug}: {"not found, or private" if e.code in (401, 404) else e}')
    blocks = json.loads(data).get('contents', [])
    for b in blocks:
        att = b.get('attachment') or {}
        if a.videos and str(att.get('content_type', '')).startswith('video/') and att.get('url'):
            items.append((att['url'], pathlib.Path(att.get('file_name') or 'v.mp4').suffix or '.mp4'))
        elif b.get('image'):
            im = b['image']; url = (im.get('large') or im.get('display') or im['original'])['url']
            ext = {'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp'}.get(im.get('content_type'), '.jpg')
            items.append((url, ext))
    if len(blocks) < 50:
        break
    page += 1
items = items[:a.max]
if not items:
    sys.exit(f'are.na/{slug}: no images in this channel')
ok = 0
for i, (url, ext) in enumerate(items, 1):
    try:
        body, ctype = get(url)
        if 'webp' in ctype: ext = '.webp'
        elif 'png' in ctype: ext = '.png'
        elif 'jpeg' in ctype: ext = '.jpg'
        (out / f'{i:03d}{ext}').write_bytes(body); ok += 1
    except Exception as e:  # one broken block should not stop the rest
        print(f'WARN {url[:80]}: {e}')
print(f'GOT {ok} files from are.na/{slug} in {out}')
