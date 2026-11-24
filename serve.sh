#!/bin/sh
# Serve the website locally: open http://localhost:8788 (Ctrl+C to stop).
# It must be served, not opened as a file: browsers block the beat-detection worker and model on file:// pages.
cd "$(dirname "$0")/web" && echo "beatcut on http://localhost:${1:-8788}" && exec python3 -m http.server "${1:-8788}" --bind 127.0.0.1
