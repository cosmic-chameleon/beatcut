# Sourced by the other scripts. One venv and one font folder, shared by the beatcut and captions skills.
HERE="$(cd "$(dirname "$0")" && pwd)"
V="${BEATCUT_VENV:-$HOME/.cache/beatcut/venv}"
FONTS="${BEATCUT_FONTS:-$HOME/.cache/beatcut/fonts}"
PY="$V/bin/python"
export BEATCUT_FONTS="$FONTS"
# python.org builds on macOS ship without CA certificates; use certifi's so yt-dlp and downloads work
if [ -x "$PY" ] && [ -z "$SSL_CERT_FILE" ]; then
  SSL_CERT_FILE="$("$PY" -c 'import certifi; print(certifi.where())' 2>/dev/null || true)"; export SSL_CERT_FILE
fi
