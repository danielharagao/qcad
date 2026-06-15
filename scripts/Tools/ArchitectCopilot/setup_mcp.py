#!/usr/bin/env python3
"""Cross-platform bootstrap for the QCAD MCP companion virtualenv.

Creates ~/.qcad-agent/mcp-venv and installs mcp, ezdxf and shapely. Prints the
absolute path of the venv's python on the last stdout line so the Architect
Copilot panel can record it. Works on macOS, Linux and Windows.
"""
import os
import subprocess
import sys
import venv

DEST = os.path.join(os.path.expanduser("~"), ".qcad-agent", "mcp-venv")


def venv_python(d):
    candidates = [
        os.path.join(d, "Scripts", "python.exe"),   # Windows
        os.path.join(d, "bin", "python3"),           # macOS / Linux
        os.path.join(d, "bin", "python"),
    ]
    for p in candidates:
        if os.path.exists(p):
            return p
    return candidates[0] if os.name == "nt" else candidates[1]


def main():
    os.makedirs(os.path.dirname(DEST), exist_ok=True)
    if not os.path.exists(venv_python(DEST)):
        print("creating venv at", DEST)
        venv.EnvBuilder(with_pip=True).create(DEST)

    py = venv_python(DEST)
    print("upgrading pip")
    subprocess.run([py, "-m", "pip", "install", "--quiet", "--upgrade", "pip"],
                   check=False)
    print("installing mcp + ezdxf + shapely")
    subprocess.run([py, "-m", "pip", "install", "--quiet",
                    "mcp>=1.0", "ezdxf>=1.1", "shapely>=2.0"], check=True)

    # Final line is the venv python path (consumers parse this).
    print(py)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as e:
        print("ERROR pip failed:", e, file=sys.stderr)
        sys.exit(1)
