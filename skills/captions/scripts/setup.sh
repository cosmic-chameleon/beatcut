#!/bin/sh
# One-time setup for beatcut (about 180 MB, no PyTorch): a Python venv with ONNX Runtime, numpy, soxr, Pillow and yt-dlp,
# plus two open-licence fonts (Montserrat, EB Garamond) for captions. ffmpeg must already be installed (brew install ffmpeg).
# Safe to run again: it only fills in what is missing.
set -e
. "$(dirname "$0")/env.sh"
command -v ffmpeg >/dev/null || { echo "ffmpeg is missing: install it first (macOS: brew install ffmpeg)"; exit 1; }
# ONNX Runtime has wheels for Python 3.10-3.14: use the newest of those that is installed
PY="$BEATCUT_PYTHON"
for v in 3.14 3.13 3.12 3.11 3.10; do [ -n "$PY" ] && break; PY="$(command -v python$v || true)"; done
if [ -z "$PY" ] && python3 -c 'import sys; sys.exit(not ((3,10) <= sys.version_info[:2] <= (3,14)))' 2>/dev/null; then PY=python3; fi
[ -n "$PY" ] || { echo "needs Python 3.10-3.14 (ONNX Runtime has no wheels for others yet). macOS: brew install python@3.13"; exit 1; }
if [ ! -x "$V/bin/python" ]; then "$PY" -m venv "$V"; fi
"$V/bin/pip" install -q --upgrade pip
"$V/bin/pip" install -q numpy onnxruntime soxr pillow yt-dlp certifi
mkdir -p "$FONTS"
GF=https://raw.githubusercontent.com/google/fonts/main/ofl
for f in "montserrat/Montserrat%5Bwght%5D.ttf" "montserrat/Montserrat-Italic%5Bwght%5D.ttf" \
         "ebgaramond/EBGaramond%5Bwght%5D.ttf" "ebgaramond/EBGaramond-Italic%5Bwght%5D.ttf"; do
  name=$(basename "$f" | sed 's/%5B/[/; s/%5D/]/')
  [ -s "$FONTS/$name" ] || curl -fsSL "$GF/$f" -o "$FONTS/$name"
done
"$V/bin/python" -c "import onnxruntime, numpy, soxr, PIL; print('beatcut ready: onnxruntime', onnxruntime.__version__)"
