#!/usr/bin/env python3
"""Minimal agent connector for QCAD-native tools.

This is intentionally thin:
- it does not rename QCAD actions into domain-specific wrappers;
- it does not interpret architecture concepts;
- it only connects an agent call to QCAD's own CLI/script entrypoints.

Input is JSON on stdin. Output is JSON on stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "agent" / "qcad-tools" / "generated" / "qcad-tools.json"


def load_catalog() -> dict[str, Any]:
    if not CATALOG.exists():
        raise FileNotFoundError(f"catalog not found: {CATALOG}; run extract_qcad_tools.py first")
    return json.loads(CATALOG.read_text(encoding="utf-8"))


def known_scripts(catalog: dict[str, Any]) -> set[str]:
    scripts = set()
    for section in ("actions", "scripts"):
        for item in catalog.get(section, []):
            script = item.get("scriptFile")
            if script:
                scripts.add(script)
    return scripts


def require_repo_relative_script(script_file: str, catalog: dict[str, Any]) -> Path:
    if script_file not in known_scripts(catalog):
        raise ValueError(f"not a QCAD catalog scriptFile: {script_file}")
    path = (ROOT / script_file).resolve()
    if not str(path).startswith(str(ROOT.resolve()) + os.sep):
        raise ValueError(f"scriptFile escapes repository: {script_file}")
    if not path.exists():
        raise FileNotFoundError(f"scriptFile not found: {script_file}")
    return path


def qcad_executable(request: dict[str, Any]) -> str:
    return str(request.get("qcad") or os.environ.get("QCAD_BIN") or "qcad")


def run_command(argv: list[str], timeout: int, env: dict[str, str] | None = None) -> dict[str, Any]:
    process = subprocess.run(
        argv,
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    return {
        "argv": argv,
        "returncode": process.returncode,
        "stdout": process.stdout,
        "stderr": process.stderr,
    }


def call_catalog(request: dict[str, Any]) -> dict[str, Any]:
    catalog = load_catalog()
    return {
        "schema": catalog["schema"],
        "cli": catalog.get("cli", []),
        "actions": catalog.get("actions", []),
        "scripts": catalog.get("scripts", []),
    }


def call_qcad_argv(request: dict[str, Any]) -> dict[str, Any]:
    argv = request.get("argv")
    if not isinstance(argv, list) or not all(isinstance(item, str) for item in argv):
        raise ValueError("argv must be a list of strings")
    timeout = int(request.get("timeout", 120))
    return run_command([qcad_executable(request), *argv], timeout)


def call_qcad_exec(request: dict[str, Any]) -> dict[str, Any]:
    catalog = load_catalog()
    script_file = str(request.get("scriptFile") or "")
    require_repo_relative_script(script_file, catalog)
    options = request.get("options") or []
    files = request.get("files") or []
    if not isinstance(options, list) or not all(isinstance(item, str) for item in options):
        raise ValueError("options must be a list of strings")
    if not isinstance(files, list) or not all(isinstance(item, str) for item in files):
        raise ValueError("files must be a list of strings")

    argv = [qcad_executable(request)]
    if request.get("noGui", True):
        argv.append("-no-gui")
    if request.get("quit", True):
        argv.append("-quit")
    argv.extend(files)
    argv.extend(["-exec", script_file])
    argv.extend(options)
    return run_command(argv, int(request.get("timeout", 120)))


def call_qcad_autostart(request: dict[str, Any]) -> dict[str, Any]:
    catalog = load_catalog()
    script_file = str(request.get("scriptFile") or "")
    require_repo_relative_script(script_file, catalog)
    options = request.get("options") or []
    if not isinstance(options, list) or not all(isinstance(item, str) for item in options):
        raise ValueError("options must be a list of strings")

    argv = [qcad_executable(request), "-autostart", script_file, *options]
    return run_command(argv, int(request.get("timeout", 120)))


CALLS = {
    "qcad.catalog": call_catalog,
    "qcad.argv": call_qcad_argv,
    "qcad -exec <script-file> [options]": call_qcad_exec,
    "qcad -autostart <script-file>": call_qcad_autostart,
}


def handle(request: dict[str, Any]) -> dict[str, Any]:
    call = request.get("call")
    if call not in CALLS:
        raise ValueError(f"unknown call: {call}; expected one of {sorted(CALLS)}")
    result = CALLS[call](request)
    return {"ok": True, "result": result}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    try:
        request = json.loads(sys.stdin.read() or "{}")
        response = handle(request)
    except Exception as exc:
        response = {"ok": False, "error": str(exc)}
    print(json.dumps(response, ensure_ascii=False, indent=2 if args.pretty else None))
    return 0 if response.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
