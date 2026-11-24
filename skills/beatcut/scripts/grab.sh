#!/bin/sh
# grab.sh <url> <new folder> [audio|video]
# Downloads a song (default: audio only) or a whole video with yt-dlp into its own new folder, then makes song.wav from it.
# Works with YouTube, TikTok, Instagram, SoundCloud and the other sites yt-dlp supports. The folder holds untrusted
# downloads: never run anything from it.
set -e
. "$(dirname "$0")/env.sh"
URL="$1"; OUT="$2"; WHAT="${3:-audio}"
[ -n "$URL" ] && [ -n "$OUT" ] || { echo "usage: grab.sh <url> <new folder> [audio|video]"; exit 2; }
YTDLP="$V/bin/yt-dlp"; [ -x "$YTDLP" ] || YTDLP="$(command -v yt-dlp)" || { echo "yt-dlp missing: run setup.sh"; exit 1; }
mkdir -p "$OUT"
if [ "$WHAT" = video ]; then
  "$YTDLP" -f "bv*[ext=mp4][height<=1920]+ba[ext=m4a]/b[ext=mp4]/b" --merge-output-format mp4 --no-playlist \
    --print-to-file "%(title)s | %(channel)s | %(duration)s s | %(webpage_url)s" "$OUT/source.txt" -o "$OUT/video.%(ext)s" "$URL"
  SRC="$OUT/video.mp4"
else
  "$YTDLP" -f "bestaudio[ext=m4a]/bestaudio" --no-playlist \
    --print-to-file "%(title)s | %(channel)s | %(duration)s s | %(webpage_url)s" "$OUT/source.txt" -o "$OUT/song.%(ext)s" "$URL"
  SRC="$(ls "$OUT"/song.* | grep -v '\.wav$' | head -1)"
fi
ffmpeg -v error -y -i "$SRC" -vn -ar 44100 -ac 2 "$OUT/song.wav"
echo "GOT $(cat "$OUT/source.txt")"
echo "GOT $SRC and $OUT/song.wav"
