#!/usr/bin/env bash
# Bootstrap the Python virtualenv used by the QCAD MCP companion.
#
# Creates ~/.qcad-agent/mcp-venv with the `mcp` package installed and prints
# the absolute path of the venv's python3 on the last stdout line so the
# Architect Copilot panel can record it.

set -euo pipefail

DEST="$HOME/.qcad-agent/mcp-venv"
mkdir -p "$(dirname "$DEST")"

PY3="$(command -v python3 || true)"
if [[ -z "$PY3" ]]; then
    echo "ERROR: python3 not found in PATH" >&2
    exit 1
fi

if [[ ! -x "$DEST/bin/python3" ]]; then
    echo "creating venv at $DEST"
    "$PY3" -m venv "$DEST"
fi

echo "upgrading pip"
"$DEST/bin/pip" install --quiet --upgrade pip

echo "installing mcp + ezdxf"
"$DEST/bin/pip" install --quiet 'mcp>=1.0' 'ezdxf>=1.1' 'shapely>=2.0'

# Final line is the python path (script consumers parse this).
echo "$DEST/bin/python3"
