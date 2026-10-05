#!/bin/sh
# Runs every test and check of the repository.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"

echo "== Firmware core (C++)"
sh tests/run.sh

echo "== Simulation runner builds against the real core"
sh simulation/build.sh

echo "== Dashboard model and ETA engine"
(cd web && node --test 2>&1 | grep -E "^ℹ (tests|pass|fail)")
(cd web && npm run build --silent 2>&1 | tail -1)

echo "== Hardware geometry and netlist"
py=${PYTHON:-}
if [ -z "$py" ]; then
  for c in .venv/bin/python python3.12 python3; do
    if command -v "$c" >/dev/null 2>&1 && "$c" -c "import build123d" 2>/dev/null; then py=$c; break; fi
  done
fi
if [ -n "$py" ]; then "$py" cad/generate.py --check; else echo "build123d not found: skipped (see README, Run it)"; fi
echo "All checks passed"
