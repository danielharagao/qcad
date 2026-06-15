"""Drawing helper library for the QCAD Architect Copilot agent.

Builds precise geometry (units: cm) for technical drawings — especially
architectural floor plans. The agent writes high-level code against the `Plan`
API; this module records neutral PRIMITIVES (lines/arcs/polylines/circles/
ellipses/text) which are then either:

  * written to DXF and opened as a new document (mode="new"), or
  * injected as real entities into the OPEN QCAD document (mode="add"/"replace"),
    preserving existing geometry and forming a single undo step.

Walls are collected as footprints and unioned into a clean poché outline at
output time, so corners and T-junctions form clean joints.

Typical use (the agent's code receives a ready `plan` object):

    plan.wall((0,10),(1000,10), plan.T_EXT, [(285,90),(470,120)])
    plan.door((240,20), 90, closed=0, open=90)
    plan.window((470,10), 120, plan.T_EXT, horizontal=True)
    plan.label("SALA", (285,250))
    plan.dim_h(0, 1000, 0, -180)

Angles are degrees CCW (0 = +x). Doors: `closed` is the leaf angle along the
wall, `open` the leaf angle when open; they differ by +/-90 and the 90-deg minor
swing arc is drawn automatically.
"""
import math

# Layer name -> ACI colour number / colour name (used by both DXF and live inject)
LAYER_COLORS = {
    "WALLS": ("white", 7),
    "DOORS": ("green", 3),
    "WINDOWS": ("blue", 5),
    "TEXT": ("yellow", 2),
    "DIMS": ("red", 1),
    "FIX": ("magenta", 6),
}


class Plan:
    T_EXT = 20.0    # default exterior wall thickness (cm)
    T_INT = 10.0    # default interior wall thickness (cm)

    def __init__(self):
        self._prims = []          # neutral primitive list
        self._wall_rects = []     # wall footprints, unioned at output
        self._walls_done = False
        self._tick = 16
        self._dtxt = 30
        # Layer registry: name -> [r,g,b]. Seeded with the built-in palette;
        # plan.layer() adds/overrides; any layer used by a primitive auto-registers.
        self._layers = {}
        for name, (cname, aci) in LAYER_COLORS.items():
            self._layers[name] = list({
                "WALLS": (255, 255, 255), "DOORS": (0, 200, 0),
                "WINDOWS": (60, 120, 255), "TEXT": (255, 220, 0),
                "DIMS": (255, 60, 60), "FIX": (230, 0, 230),
            }.get(name, (255, 255, 255)))

    def layer(self, name, color):
        """Define (or recolor) a named layer. color = (r,g,b) or '#rrggbb'.
        Then pass layer="<name>" to any draw method to put entities on it."""
        c = self._col(color)
        if c is not None:
            self._layers[name] = c

    def _register_layer(self, name):
        if name and name not in self._layers:
            self._layers[name] = [180, 180, 180]   # default gray for new layers

    # -- primitive recording --------------------------------------------
    def _add(self, prim):
        self._register_layer(prim.get("layer"))
        self._prims.append(prim)

    # -- walls -----------------------------------------------------------
    def _segments(self, p1, p2, t, openings):
        x1, y1 = p1
        x2, y2 = p2
        horizontal = abs(y2 - y1) < 1e-6
        length = (x2 - x1) if horizontal else (y2 - y1)
        sign = 1 if length >= 0 else -1
        L = abs(length)
        cuts = sorted((c - w / 2.0, c + w / 2.0) for c, w in openings)
        spans, pos = [], 0.0
        for a, b in cuts:
            if a > pos:
                spans.append((pos, a))
            pos = max(pos, b)
        if pos < L:
            spans.append((pos, L))
        rects = []
        for a, b in spans:
            if horizontal:
                xa, xb = x1 + sign * a, x1 + sign * b
                rects.append((min(xa, xb), y1 - t / 2.0, max(xa, xb), y1 + t / 2.0))
            else:
                ya, yb = y1 + sign * a, y1 + sign * b
                rects.append((x1 - t / 2.0, min(ya, yb), x1 + t / 2.0, max(ya, yb)))
        return rects

    def wall(self, p1, p2, t=None, openings=()):
        """Axis-aligned wall along centerline p1->p2 with thickness t. Footprints
        are collected and unioned at output time so corners/T-junctions are clean.
        `openings` = [(center_along, width), ...], center_along = distance from p1."""
        if t is None:
            t = self.T_INT
        self._wall_rects.extend(self._segments(p1, p2, t, list(openings)))

    def perimeter(self, w, h, t=None, openings=None, x0=0, y0=0):
        """Build the 4 exterior walls of a rectangular building with CLEAN corners.

        Outer footprint is x0..x0+w by y0..y0+h. Each wall runs the full length on
        its long axis and is inset by t/2 on its thickness axis, so adjacent walls
        overlap at the corners (the union then fills them with no gaps or steps).

        `openings` is a dict with optional keys "bottom"/"right"/"top"/"left",
        each a list of (center, width). `center` is measured along that wall from
        its start: bottom/top from x0 (x), left/right from y0 (y).
        """
        if t is None:
            t = self.T_EXT
        half = t / 2.0
        op = openings or {}
        self.wall((x0, y0 + half), (x0 + w, y0 + half), t, op.get("bottom", []))
        self.wall((x0 + w - half, y0), (x0 + w - half, y0 + h), t, op.get("right", []))
        self.wall((x0, y0 + h - half), (x0 + w, y0 + h - half), t, op.get("top", []))
        self.wall((x0 + half, y0), (x0 + half, y0 + h), t, op.get("left", []))

    def walls_polyline(self, points, t=None, closed=True):
        """Build walls along an ARBITRARY polyline (L-shaped, courtyard, etc.).
        `points` are centerline vertices; each segment becomes a thick wall, all
        unioned so corners are clean. closed=True joins last->first. No openings
        here — draw door/window symbols separately and leave gaps if needed."""
        if t is None:
            t = self.T_EXT
        pts = [list(p) for p in points]
        n = len(pts)
        if n < 2:
            return
        segs = n if closed else n - 1
        for i in range(segs):
            a = pts[i]
            b = pts[(i + 1) % n]
            # collect each segment as a wall (no openings); union handles joins
            self.wall((a[0], a[1]), (b[0], b[1]), t, [])

    def _finalize_walls(self):
        if self._walls_done or not self._wall_rects:
            self._walls_done = True
            return
        self._walls_done = True
        try:
            from shapely.geometry import box
            from shapely.ops import unary_union
        except Exception:
            for x1, y1, x2, y2 in self._wall_rects:
                self._add({"t": "poly", "pts": [[x1, y1], [x2, y1], [x2, y2], [x1, y2]],
                           "closed": True, "layer": "WALLS"})
            return

        def _ring(coords):
            pts = [(round(x, 3), round(y, 3)) for x, y in coords]
            if len(pts) > 1 and pts[0] == pts[-1]:
                pts = pts[:-1]
            out, n = [], len(pts)
            for i in range(n):
                ax, ay = pts[i - 1]
                bx, by = pts[i]
                cx, cy = pts[(i + 1) % n]
                if abs((bx - ax) * (cy - by) - (by - ay) * (cx - bx)) > 1e-6:
                    out.append([bx, by])
            return out or [list(p) for p in pts]

        polys = [box(min(a, c), min(b, d), max(a, c), max(b, d))
                 for a, b, c, d in self._wall_rects]
        u = unary_union(polys)
        geoms = list(u.geoms) if u.geom_type == "MultiPolygon" else [u]
        for poly in geoms:
            self._add({"t": "poly", "pts": _ring(poly.exterior.coords),
                       "closed": True, "layer": "WALLS"})
            for interior in poly.interiors:
                self._add({"t": "poly", "pts": _ring(interior.coords),
                           "closed": True, "layer": "WALLS"})

    # -- openings --------------------------------------------------------
    def door(self, hinge, width, closed, open):
        hx, hy = hinge
        lx = hx + width * math.cos(math.radians(open))
        ly = hy + width * math.sin(math.radians(open))
        self._add({"t": "line", "p1": [hx, hy], "p2": [lx, ly], "layer": "DOORS"})
        s, e = closed % 360, open % 360
        if abs((e - s) % 360 - 90) < 1e-6:
            a0, a1 = s, e
        else:
            a0, a1 = e, s
        self._add({"t": "arc", "c": [hx, hy], "r": width, "a0": a0, "a1": a1, "layer": "DOORS"})

    def window(self, center, length, t=None, horizontal=True):
        if t is None:
            t = self.T_EXT
        cx, cy = center
        if horizontal:
            x0, x1 = cx - length / 2.0, cx + length / 2.0
            for dy in (-t / 2.0, 0.0, t / 2.0):
                self._add({"t": "line", "p1": [x0, cy + dy], "p2": [x1, cy + dy], "layer": "WINDOWS"})
            self._add({"t": "line", "p1": [x0, cy - t / 2.0], "p2": [x0, cy + t / 2.0], "layer": "WINDOWS"})
            self._add({"t": "line", "p1": [x1, cy - t / 2.0], "p2": [x1, cy + t / 2.0], "layer": "WINDOWS"})
        else:
            y0, y1 = cy - length / 2.0, cy + length / 2.0
            for dx in (-t / 2.0, 0.0, t / 2.0):
                self._add({"t": "line", "p1": [cx + dx, y0], "p2": [cx + dx, y1], "layer": "WINDOWS"})
            self._add({"t": "line", "p1": [cx - t / 2.0, y0], "p2": [cx + t / 2.0, y0], "layer": "WINDOWS"})
            self._add({"t": "line", "p1": [cx - t / 2.0, y1], "p2": [cx + t / 2.0, y1], "layer": "WINDOWS"})

    # -- annotation ------------------------------------------------------
    def label(self, text, pos, h=34, layer="TEXT", color=None):
        self._add(self._maybe_color(
            {"t": "text", "s": text, "x": pos[0], "y": pos[1], "h": h, "rot": 0,
             "halign": "center", "valign": "middle", "layer": layer}, color))

    def _tickmark(self, x, y, ang):
        a = math.radians(ang)
        dx, dy = self._tick * math.cos(a), self._tick * math.sin(a)
        self._add({"t": "line", "p1": [x - dx, y - dy], "p2": [x + dx, y + dy], "layer": "DIMS"})

    def dim_h(self, x1, x2, y_meas, dy):
        """Horizontal dimension between x1,x2; witness from y_meas to line at y=dy
        (put dy outside the building, e.g. -180)."""
        self._add({"t": "line", "p1": [x1, y_meas], "p2": [x1, dy], "layer": "DIMS"})
        self._add({"t": "line", "p1": [x2, y_meas], "p2": [x2, dy], "layer": "DIMS"})
        self._add({"t": "line", "p1": [x1, dy], "p2": [x2, dy], "layer": "DIMS"})
        self._tickmark(x1, dy, 45)
        self._tickmark(x2, dy, 45)
        self._add({"t": "text", "s": str(int(round(abs(x2 - x1)))), "x": (x1 + x2) / 2.0,
                   "y": dy + 10, "h": self._dtxt, "rot": 0,
                   "halign": "center", "valign": "bottom", "layer": "DIMS"})

    def dim_v(self, y1, y2, x_meas, dx):
        """Vertical dimension between y1,y2; witness from x_meas to line at x=dx
        (put dx outside the building)."""
        self._add({"t": "line", "p1": [x_meas, y1], "p2": [dx, y1], "layer": "DIMS"})
        self._add({"t": "line", "p1": [x_meas, y2], "p2": [dx, y2], "layer": "DIMS"})
        self._add({"t": "line", "p1": [dx, y1], "p2": [dx, y2], "layer": "DIMS"})
        self._tickmark(dx, y1, 45)
        self._tickmark(dx, y2, 45)
        self._add({"t": "text", "s": str(int(round(abs(y2 - y1)))), "x": dx - 10,
                   "y": (y1 + y2) / 2.0, "h": self._dtxt, "rot": 90,
                   "halign": "center", "valign": "bottom", "layer": "DIMS"})

    # -- colour ----------------------------------------------------------
    @staticmethod
    def _col(color):
        """Normalise a colour to [r,g,b] (0-255), or None. Accepts (r,g,b),
        [r,g,b], or "#rrggbb"."""
        if color is None:
            return None
        if isinstance(color, str):
            s = color.lstrip("#")
            if len(s) == 6:
                return [int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)]
            return None
        try:
            return [int(color[0]), int(color[1]), int(color[2])]
        except Exception:
            return None

    def _maybe_color(self, prim, color):
        c = self._col(color)
        if c is not None:
            prim["color"] = c
        return prim

    # -- generic primitives (all accept an optional color=(r,g,b)) --------
    def line(self, p1, p2, layer="WALLS", color=None):
        self._add(self._maybe_color(
            {"t": "line", "p1": list(p1), "p2": list(p2), "layer": layer}, color))

    def rect(self, c1, c2, layer="WALLS", color=None):
        x1, y1 = c1
        x2, y2 = c2
        self._add(self._maybe_color(
            {"t": "poly", "pts": [[x1, y1], [x2, y1], [x2, y2], [x1, y2]],
             "closed": True, "layer": layer}, color))

    def circle(self, center, radius, layer="WALLS", color=None):
        self._add(self._maybe_color(
            {"t": "circle", "c": list(center), "r": radius, "layer": layer}, color))

    def arc(self, center, radius, start_deg, end_deg, layer="WALLS", color=None):
        self._add(self._maybe_color(
            {"t": "arc", "c": list(center), "r": radius,
             "a0": start_deg, "a1": end_deg, "layer": layer}, color))

    def ellipse(self, center, mx, my, ratio, layer="WALLS", color=None):
        self._add(self._maybe_color(
            {"t": "ellipse", "c": list(center), "mx": mx, "my": my,
             "ratio": ratio, "layer": layer}, color))

    def polyline(self, points, close=False, layer="WALLS", color=None):
        self._add(self._maybe_color(
            {"t": "poly", "pts": [list(p) for p in points],
             "closed": close, "layer": layer}, color))

    def text(self, s, pos, h=34, rot=0, halign="left", valign="bottom", layer="TEXT", color=None):
        self._add(self._maybe_color(
            {"t": "text", "s": s, "x": pos[0], "y": pos[1], "h": h, "rot": rot,
             "halign": halign, "valign": valign, "layer": layer}, color))

    # -- fill / hatch (texture) ------------------------------------------
    def fill(self, points, color=None, pattern="SOLID", angle=0, scale=1.0, layer="FILL"):
        """Fill a closed polygon. pattern="SOLID" = solid fill; a pattern name
        like "ANSI31" (diagonal), "ANSI37" (crosshatch), "BRICK", "EARTH",
        "GRASS" etc. = textured hatch. color is (r,g,b) for the fill colour."""
        prim = {"t": "hatch", "pts": [list(p) for p in points],
                "pattern": pattern, "solid": (pattern.upper() == "SOLID"),
                "angle": angle, "scale": scale, "layer": layer}
        self._add(self._maybe_color(prim, color))

    def fill_rect(self, c1, c2, color=None, pattern="SOLID", angle=0, scale=1.0, layer="FILL"):
        x1, y1 = c1
        x2, y2 = c2
        self.fill([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], color, pattern, angle, scale, layer)

    # -- fixtures (simple bathroom/kitchen symbols) ----------------------
    def fixture_toilet(self, pos, w=40, d=60, layer="FIX"):
        x, y = pos
        self.rect((x - w / 2, y), (x + w / 2, y + d * 0.25), layer)
        self.ellipse((x, y + d * 0.6), 0.0, d * 0.35, w / (d * 0.7), layer)

    def fixture_sink(self, pos, w=50, d=40, layer="FIX"):
        x, y = pos
        self.rect((x - w / 2, y), (x + w / 2, y + d), layer)
        self.ellipse((x, y + d / 2), w * 0.32, 0.0, 0.6, layer)

    def fixture_stove(self, pos, w=60, d=60, layer="FIX"):
        x, y = pos
        self.rect((x - w / 2, y), (x + w / 2, y + d), layer)
        for ox in (-1, 1):
            for oy in (1, 3):
                self.circle((x + ox * w * 0.22, y + oy * d * 0.25), w * 0.12, layer)

    def fixture_bed(self, pos, w=140, d=200, layer="FIX"):
        x, y = pos
        self.rect((x, y), (x + w, y + d), layer)
        self.rect((x + w * 0.08, y + d * 0.72), (x + w * 0.46, y + d * 0.95), layer)
        self.rect((x + w * 0.54, y + d * 0.72), (x + w * 0.92, y + d * 0.95), layer)

    # -- output ----------------------------------------------------------
    def primitives(self):
        self._finalize_walls()
        return self._prims

    def to_json(self, path):
        import json
        with open(path, "w") as fh:
            json.dump({"primitives": self.primitives(), "layers": self._layers}, fh)
        return path

    def save(self, path=None):
        """Build a DXF from the recorded primitives and save it."""
        import os
        import ezdxf
        from ezdxf.enums import TextEntityAlignment
        prims = self.primitives()
        doc = ezdxf.new("R2010", setup=True)
        msp = doc.modelspace()
        # Create every registered layer with its RGB colour (thawed, visible).
        for name, rgb in self._layers.items():
            lyr = doc.layers.get(name) if name in doc.layers else doc.layers.add(name)
            try:
                lyr.rgb = (int(rgb[0]), int(rgb[1]), int(rgb[2]))
                lyr.on()
                lyr.thaw()
            except Exception:
                pass
        halign_map = {"left": "LEFT", "center": "CENTER", "right": "RIGHT"}
        valign_map = {"bottom": "BOTTOM", "middle": "MIDDLE", "top": "TOP"}

        def attribs(p):
            a = {"layer": p.get("layer", "WALLS")}
            c = p.get("color")
            if c:
                a["true_color"] = (c[0] << 16) + (c[1] << 8) + c[2]
            return a

        for p in prims:
            t = p["t"]
            if t == "line":
                msp.add_line(p["p1"], p["p2"], dxfattribs=attribs(p))
            elif t == "arc":
                msp.add_arc(p["c"], p["r"], p["a0"], p["a1"], dxfattribs=attribs(p))
            elif t == "circle":
                msp.add_circle(p["c"], p["r"], dxfattribs=attribs(p))
            elif t == "ellipse":
                msp.add_ellipse(p["c"], major_axis=(p["mx"], p["my"]),
                                ratio=p["ratio"], dxfattribs=attribs(p))
            elif t == "poly":
                msp.add_lwpolyline(p["pts"], close=p.get("closed", False),
                                   dxfattribs=attribs(p))
            elif t == "text":
                align = getattr(TextEntityAlignment,
                                valign_map[p["valign"]] + "_" + halign_map[p["halign"]],
                                TextEntityAlignment.MIDDLE_CENTER)
                msp.add_text(p["s"], height=p["h"], rotation=p.get("rot", 0),
                             dxfattribs=attribs(p)).set_placement((p["x"], p["y"]), align=align)
            elif t == "hatch":
                ha = msp.add_hatch(dxfattribs=attribs(p))
                ha.paths.add_polyline_path(p["pts"], is_closed=True)
                if not p.get("solid", True):
                    try:
                        ha.set_pattern_fill(p.get("pattern", "ANSI31"),
                                            scale=p.get("scale", 1.0), angle=p.get("angle", 0))
                    except Exception:
                        pass
        if not path:
            path = os.path.join(os.path.expanduser("~"), ".qcad-agent", "agent_draw.dxf")
        doc.saveas(path)
        return path
