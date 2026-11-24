#!/usr/bin/env bash
# Soundscape Loudness Panel - install (first run) and start.
# Usage: ./run.sh [folder-with-audio]   (tip: drag the folder onto the Terminal window)
set -euo pipefail
ARGS=()
for a in "$@"; do
  if [[ "$a" != -* && -e "$a" ]]; then a="$(cd "$a" && pwd)"; fi
  ARGS+=("$a")
done
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"
if ! command -v "$PY" >/dev/null; then echo "python3 (>=3.9) is required"; exit 1; fi
if [[ ! -x .venv/bin/python ]]; then
  echo "Creating virtual environment…"
  "$PY" -m venv .venv
fi
if [[ ! -f .venv/.installed || requirements.txt -nt .venv/.installed ]]; then
  echo "Installing dependencies…"
  .venv/bin/python -m pip install -q --upgrade pip
  .venv/bin/python -m pip install -q -r requirements.txt
  touch .venv/.installed
fi
exec .venv/bin/python -m app.server ${ARGS[@]+"${ARGS[@]}"}
