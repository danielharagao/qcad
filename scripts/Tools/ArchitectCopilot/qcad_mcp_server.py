#!/usr/bin/env python3
"""
stdio MCP server that exposes a single tool, `qcad_command`, to Claude Code.

The tool sends one command-line token to a running QCAD instance via a local
TCP socket (the QCAD Architect Copilot panel opens a listener on
127.0.0.1:QCAD_MCP_PORT when initialized) and returns the response.

QCAD must be running with the Architect Copilot panel open for the tool to
work. Otherwise the tool returns an `error: …` string and Claude can react.
"""
import json
import os
import socket
import subprocess
import sys
import tempfile

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp import Image

_HERE = os.path.dirname(os.path.abspath(__file__))

HOST = os.environ.get("QCAD_MCP_HOST", "127.0.0.1")
PORT = int(os.environ.get("QCAD_MCP_PORT", "54321"))
TIMEOUT = float(os.environ.get("QCAD_MCP_TIMEOUT", "30"))

mcp = FastMCP("qcad")


def _send(request: dict) -> dict:
    """Send one JSON-line request to QCAD and return the parsed reply."""
    with socket.create_connection((HOST, PORT), timeout=TIMEOUT) as s:
        s.sendall((json.dumps(request) + "\n").encode("utf-8"))
        buf = b""
        while b"\n" not in buf:
            chunk = s.recv(4096)
            if not chunk:
                break
            buf += chunk
    line = buf.split(b"\n", 1)[0]
    if not line:
        raise RuntimeError("empty response from QCAD")
    return json.loads(line.decode("utf-8"))


@mcp.tool()
def qcad_command(command: str) -> str:
    """Send one command-line token to QCAD.

    This is the same input the user can type at QCAD's bottom command line.
    Use it to invoke any QCAD action by name (e.g. "line", "circle",
    "rectangle", "zoomauto") or to provide a coordinate ("0,0", "@50,0",
    "@100<45") or a typed length ("25"). Send the empty string "" to press
    Enter / finish a multi-step command. Send "escape" to cancel the active
    action. The tool returns a short status string describing what QCAD did.
    """
    try:
        with socket.create_connection((HOST, PORT), timeout=TIMEOUT) as s:
            payload = (json.dumps({"command": command}) + "\n").encode("utf-8")
            s.sendall(payload)
            buf = b""
            while b"\n" not in buf:
                chunk = s.recv(4096)
                if not chunk:
                    break
                buf += chunk
        line = buf.split(b"\n", 1)[0]
        if not line:
            return "error: empty response from QCAD"
        try:
            resp = json.loads(line.decode("utf-8"))
            return resp.get("result", "error: response missing 'result'")
        except json.JSONDecodeError:
            return "error: bad JSON from QCAD: " + line.decode("utf-8", "replace")
    except (ConnectionRefusedError, socket.timeout) as e:
        return f"error: QCAD not reachable on {HOST}:{PORT} ({e})"
    except Exception as e:
        return f"error: {type(e).__name__}: {e}"


@mcp.tool()
def qcad_draw(code: str, mode: str = "add") -> str:
    """Build a precise technical drawing (e.g. an architectural floor plan) by
    running Python geometry code, then put it into QCAD.

    Use this — NOT a long series of qcad_command calls — whenever you need exact
    geometry, walls with real thickness, doors with swing arcs, windows,
    dimensions with numbers, or text labels.

    `mode` controls how the result enters QCAD:
      • "add"     (default) — ADD the new geometry to the CURRENTLY OPEN drawing,
                   preserving what is already there. One undo step. Use this to
                   build up or extend a drawing incrementally.
      • "replace" — clear the open drawing, then draw. Use when redoing from
                   scratch in the same document.
      • "new"     — open the drawing in a brand-new document tab.

    Your `code` runs with a ready `plan` object (a Plan instance) and `math`.
    Units are centimetres; angles are degrees CCW (0 = +x). Do NOT call
    plan.save(). After drawing, call qcad_view to SEE the result and fix issues.

    For mode="add", only emit the NEW elements — do not re-draw what already
    exists. Use qcad_view first if you need to see the current state.

    Plan API:
      plan.T_EXT, plan.T_INT                      # default wall thicknesses (20, 10)
      plan.wall((x1,y1),(x2,y2), t, openings)     # openings=[(center_from_p1, width), ...]
      plan.door((hx,hy), width, closed, open)     # closed/open leaf angles (differ by +/-90)
      plan.window((cx,cy), length, t, horizontal) # 3-line window symbol
      plan.label(text, (x,y), h=34)               # centered text
      plan.dim_h(x1, x2, y_meas, dy)              # horizontal dimension (dy outside building)
      plan.dim_v(y1, y2, x_meas, dx)              # vertical dimension (dx outside building)
      plan.line(p1,p2) / plan.rect(c1,c2) / plan.circle(c,r) / plan.arc(c,r,a0,a1)
      plan.ellipse(c, mx, my, ratio) / plan.polyline(points, close=False)
      plan.text(s,(x,y),h,rot,halign,valign)
      plan.fixture_toilet((x,y)) / fixture_sink / fixture_stove / fixture_bed((x,y))
      plan.perimeter(W,H,t,openings)            # rectangular shell, clean corners
      plan.walls_polyline(points, t, closed)    # L / U / courtyard shells (orthogonal)

    MATERIALS THE CAD-CORRECT WAY — organize by ELEMENT/MATERIAL on layers; draw
    entities ByLayer (they inherit the layer's colour + lineweight); show materials
    with hatch PATTERNS, not per-entity solid colours.
      • Standard layers exist: WALLS, DOORS, WINDOWS, FIX, TEXT, DIMS (elements) and
        PISO, MADEIRA, CONCRETO, VIDRO, AGUA, GRAMA, PEDRA (materials, each with a
        colour + lineweight + hatch pattern). Pass layer="MADEIRA" etc.
      • plan.surface(points, "wood"|"tile"|"water"|"grass"|"concrete"|"stone") fills
        an area with that MATERIAL'S texture (hatch) on its layer, ByLayer colour —
        e.g. plan.surface(deck_pts, "wood"); plan.surface(pool_pts, "water").
      • plan.layer(name, color=(r,g,b), lineweight=50, pattern="ANSI31") to define a
        new material/element layer (lineweight in 1/100 mm; 50 = 0.5 mm).
      • Prefer this over per-entity colour. Only pass color=(r,g,b) to a draw method
        for a one-off override; normally let it be ByLayer.
      • Low-level fills still exist: plan.fill/fill_rect(points, pattern=...) with
        ANSI31 (diagonal), ANSI37 (crosshatch), BRICK, EARTH, GRASS, NET.

    Use REALISTIC cm dimensions and respect ergonomics/clearances (door swing >=90,
    walk-through >=70, bed side >=60, kitchen triangle, bathroom clearances). Every
    room: a door; habitable rooms: a window. Add dim_h/dim_v for key sizes.

    Returns a status string; on error it includes the Python traceback so you
    can correct the code and call qcad_draw again.
    """
    runner = os.path.join(_HERE, "qcad_run_plan.py")
    mode = (mode or "add").lower()
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as tf:
            tf.write(code)
            code_path = tf.name
        env = {**os.environ, "QCAD_APP": os.environ.get("QCAD_APP", "/Applications/QCAD.app")}

        if mode == "new":
            proc = subprocess.run([sys.executable, runner, code_path],
                                  capture_output=True, text=True, timeout=60, env=env)
            out = (proc.stdout or "").strip()
            err = (proc.stderr or "").strip()
            if out.startswith("OK"):
                return out + " — opened as a new document. Call qcad_view to inspect."
            return out or ("error: " + err) or "error: unknown failure in qcad_draw"

        # add / replace: emit primitives, inject into the live document over TCP.
        json_path = os.path.join(os.path.expanduser("~"), ".qcad-agent", "agent_primitives.json")
        proc = subprocess.run([sys.executable, runner, "--emit-json", code_path, json_path],
                              capture_output=True, text=True, timeout=60, env=env)
        out = (proc.stdout or "").strip()
        err = (proc.stderr or "").strip()
        if not out.startswith("OK"):
            return out or ("error: " + err) or "error: failed to build geometry"
        try:
            resp = _send({"add_file": json_path, "replace": mode == "replace"})
        except (ConnectionRefusedError, socket.timeout) as e:
            return f"error: QCAD not reachable on {HOST}:{PORT} ({e})"
        result = resp.get("result", "")
        if str(result).startswith("error"):
            return result
        verb = "replaced drawing with" if mode == "replace" else "added"
        return f"ok: {verb} geometry ({result}). Call qcad_view to inspect."
    except subprocess.TimeoutExpired:
        return "error: qcad_draw timed out"
    except Exception as e:
        return f"error: {type(e).__name__}: {e}"
    finally:
        try:
            os.unlink(code_path)
        except Exception:
            pass


@mcp.tool()
def qcad_query(what: str = "layers") -> str:
    """Read back the LIVE QCAD document so you can self-verify without guessing.

    what="extents" → drawing bounding box {minx,miny,maxx,maxy,width,height}
    what="layers"  → each layer with its entity count and frozen state
    what="count"   → total entity count

    Use this to confirm sizes, check entities landed on the right layers, or see
    if the drawing is empty — instead of re-rendering blindly.
    """
    try:
        resp = _send({"query": what})
    except (ConnectionRefusedError, socket.timeout) as e:
        return f"error: QCAD not reachable on {HOST}:{PORT} ({e})"
    return json.dumps(resp)


@mcp.tool()
def qcad_erase(layer: str = "", ids: str = "") -> str:
    """Delete entities from the open drawing (one undo step). Provide either a
    `layer` name (erases everything on it) or a comma-separated list of entity
    `ids`. Lets you edit incrementally instead of redrawing everything."""
    spec = {}
    if layer:
        spec["layer"] = layer
    if ids:
        try:
            spec["ids"] = [int(x) for x in ids.replace(" ", "").split(",") if x]
        except ValueError:
            return "error: ids must be comma-separated integers"
    if not spec:
        return "error: provide layer= or ids="
    try:
        resp = _send({"erase": spec})
    except (ConnectionRefusedError, socket.timeout) as e:
        return f"error: QCAD not reachable on {HOST}:{PORT} ({e})"
    return resp.get("result", "error: no result")


@mcp.tool()
def qcad_undo(steps: int = 1) -> str:
    """Undo the last `steps` operations in QCAD (e.g. to roll back a bad edit)."""
    try:
        resp = _send({"undo": int(steps)})
    except (ConnectionRefusedError, socket.timeout) as e:
        return f"error: QCAD not reachable on {HOST}:{PORT} ({e})"
    return resp.get("result", "error: no result")


@mcp.tool()
def qcad_view() -> Image:
    """Render the current QCAD drawing and return it as an image so you can SEE it.

    Use this to look at what has been drawn — verify proportions, alignment, and
    that nothing is missing — and to self-correct after issuing draw commands.
    QCAD must be running with the Architect Copilot panel open. The render is
    off-screen (no window screenshot), framed to fit the whole drawing.
    """
    path = os.path.join(os.path.expanduser("~"), ".qcad-agent", "view.png")
    try:
        resp = _send({"capture": path})
    except (ConnectionRefusedError, socket.timeout) as e:
        raise RuntimeError(f"QCAD not reachable on {HOST}:{PORT} ({e})")
    out = resp.get("path") or resp.get("result", "")
    if not out or str(out).startswith("error:"):
        raise RuntimeError(str(out) or "capture failed")
    with open(out, "rb") as fh:
        data = fh.read()
    return Image(data=data, format="png")


if __name__ == "__main__":
    mcp.run()
