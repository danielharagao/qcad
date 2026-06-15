#!/usr/bin/env python3
"""Execute agent-authored drawing code against the Plan helper and load the
resulting DXF into the running QCAD.

Usage:
    qcad_run_plan.py <code_file> [<dxf_out>]

The code runs in a namespace where `plan` is a fresh Plan instance and `math`
is available. The script auto-saves (so the agent need not call plan.save()),
then opens the DXF in QCAD via the macOS `open` mechanism. Prints a status line:
    OK <dxf_path>
or
    ERROR <message>
"""
import os
import subprocess
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from qcad_plan_lib import Plan  # noqa: E402

QCAD_APP = os.environ.get("QCAD_APP", "/Applications/QCAD.app")


def main():
    args = [a for a in sys.argv[1:]]
    emit_json = "--emit-json" in args
    args = [a for a in args if a != "--emit-json"]
    if not args:
        print("ERROR missing code file")
        return 1
    code_file = args[0]
    if emit_json:
        out = args[1] if len(args) > 1 else os.path.join(
            os.path.expanduser("~"), ".qcad-agent", "agent_primitives.json")
    else:
        out = args[1] if len(args) > 1 else os.path.join(
            os.path.expanduser("~"), ".qcad-agent", "agent_draw.dxf")
    os.makedirs(os.path.dirname(out), exist_ok=True)

    with open(code_file, "r") as fh:
        code = fh.read()

    plan = Plan()
    ns = {"plan": plan, "Plan": Plan, "__name__": "__agent__"}
    try:
        import math
        ns["math"] = math
        exec(compile(code, "<agent_draw>", "exec"), ns)
    except Exception:
        print("ERROR " + "".join(traceback.format_exc()).strip().replace("\n", " | "))
        return 1

    # mode="add"/"replace": emit primitives JSON for live injection into QCAD.
    if emit_json:
        try:
            path = plan.to_json(out)
        except Exception as e:
            print(f"ERROR emit-json failed: {e}")
            return 1
        print(f"OK {path}")
        return 0

    # mode="new": write DXF and open it as a new document (best-effort, per OS).
    try:
        path = plan.save(out)
    except Exception as e:
        print(f"ERROR save failed: {e}")
        return 1
    try:
        if sys.platform == "darwin":
            subprocess.run(["open", "-a", QCAD_APP, path], check=False,
                           timeout=15, capture_output=True)
        elif os.name == "nt":
            os.startfile(path)  # opens with the file's default app (QCAD if associated)
        else:
            subprocess.run(["xdg-open", path], check=False,
                           timeout=15, capture_output=True)
    except Exception as e:
        print(f"OK {path} (saved, but auto-open failed: {e})")
        return 0
    print(f"OK {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
