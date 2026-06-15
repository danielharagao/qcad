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

# CAD-correct layer system: layers are organized by ELEMENT / MATERIAL and carry
# colour + lineweight (1/100 mm) + an optional hatch PATTERN. Entities are drawn
# ByLayer (they inherit these) — you change a material by editing its layer, not
# entity-by-entity. Materials are conveyed by hatch PATTERN, not just by colour.
# Each def: name -> {color:[r,g,b], lw:<1/100mm>, pattern:<hatch or None>, scale}
LAYER_DEFS = {
    # element / annotation layers (line-work)
    "WALLS":   {"color": [255, 255, 255], "lw": 50},   # wall poché, thick
    "DOORS":   {"color": [0, 200, 0],     "lw": 25},
    "WINDOWS": {"color": [60, 140, 255],  "lw": 25},   # esquadrias
    "FIX":     {"color": [230, 0, 230],   "lw": 13},   # mobiliário
    "TEXT":    {"color": [255, 220, 0],   "lw": 0},
    "DIMS":    {"color": [255, 60, 60],   "lw": 9},
    "FILL":    {"color": [180, 180, 180], "lw": 0},
    # material/surface layers — native QCAD hatch patterns chosen to read as the
    # real material (parquet for wood, square tiles for floors, brick-stone, etc.)
    "PISO":     {"color": [170, 170, 170], "lw": 9,  "pattern": "NET",      "scale": 30},  # porcelanato (grade)
    "MADEIRA":  {"color": [170, 110, 60],  "lw": 13, "pattern": "AR-PARQ1", "scale": 1.6}, # parquet / deck
    "CONCRETO": {"color": [150, 150, 150], "lw": 18, "pattern": "ANSI31",   "scale": 14},
    "VIDRO":    {"color": [130, 200, 230], "lw": 13},
    "AGUA":     {"color": [60, 140, 230],  "lw": 13, "pattern": "ANSI37",   "scale": 20},  # piscina
    "GRAMA":    {"color": [90, 170, 90],   "lw": 9,  "pattern": "GRASS",    "scale": 12},
    "PEDRA":    {"color": [185, 180, 160], "lw": 13, "pattern": "BRSTONE",  "scale": 14},  # pedra
}
# Friendly aliases an LLM is likely to reach for -> canonical material layer
MATERIAL_ALIASES = {
    "TILE": "PISO", "FLOOR": "PISO", "PORCELANATO": "PISO", "PISO": "PISO",
    "WOOD": "MADEIRA", "DECK": "MADEIRA", "IPE": "MADEIRA", "MADEIRA": "MADEIRA",
    "CONCRETE": "CONCRETO", "CONCRETO": "CONCRETO",
    "GLASS": "VIDRO", "VIDRO": "VIDRO",
    "WATER": "AGUA", "POOL": "AGUA", "AGUA": "AGUA", "PISCINA": "AGUA",
    "GRASS": "GRAMA", "GARDEN": "GRAMA", "GRAMA": "GRAMA",
    "STONE": "PEDRA", "GRAVEL": "PEDRA", "PEDRA": "PEDRA",
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
        # Layer registry seeded with the standard element + material layers.
        self._layers = {}
        for name, d in LAYER_DEFS.items():
            self._layers[name] = {
                "color": list(d["color"]), "lw": d.get("lw", 13),
                "pattern": d.get("pattern"), "scale": d.get("scale", 1)}

    def layer(self, name, color=None, lineweight=None, pattern=None, scale=None):
        """Define/edit a layer (the CAD-correct unit of material/element). Entities
        on it inherit its color+lineweight (ByLayer). color=(r,g,b)/'#rrggbb',
        lineweight in 1/100 mm (e.g. 50=0.5mm), pattern=hatch name for surfaces."""
        d = self._layers.get(name, {"color": [180, 180, 180], "lw": 13,
                                     "pattern": None, "scale": 1})
        c = self._col(color)
        if c is not None:
            d["color"] = c
        if lineweight is not None:
            d["lw"] = lineweight
        if pattern is not None:
            d["pattern"] = pattern
        if scale is not None:
            d["scale"] = scale
        self._layers[name] = d

    def _mat(self, material):
        """Resolve a friendly material name to a canonical material layer."""
        key = str(material).upper()
        return MATERIAL_ALIASES.get(key, key)

    def surface(self, points, material, layer=None, pattern=None, scale=None):
        """Fill a closed area with a MATERIAL — drawn as that material's hatch
        pattern (texture) on its material layer, ByLayer colour. e.g.
        plan.surface(room_pts, "wood") / plan.surface(pool_pts, "water").
        Override the texture with any of QCAD's 127 patterns via pattern=
        (e.g. pattern="HEXAGONS"); list them with the qcad_patterns tool."""
        lname = layer or self._mat(material)
        d = self._layers.get(lname, {})
        pat = pattern or d.get("pattern")
        prim = {"t": "hatch", "pts": [list(p) for p in points],
                "pattern": pat or "SOLID", "solid": (pat is None),
                "angle": 0, "scale": (scale if scale is not None else d.get("scale", 1)),
                "layer": lname}
        self._add(prim)

    def _register_layer(self, name):
        if name and name not in self._layers:
            self._layers[name] = {"color": [180, 180, 180], "lw": 13,
                                  "pattern": None, "scale": 1}

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

    def fixture_sofa(self, pos, w=210, d=90, layer="FIX"):
        """3-seat sofa, seat side facing +y (up). pos = bottom-left corner."""
        x, y = pos
        self.rect((x, y), (x + w, y + d), layer)                 # outline
        self.rect((x, y + d * 0.78), (x + w, y + d), layer)      # backrest (at top)
        self.rect((x, y), (x + d * 0.16, y + d), layer)          # left arm
        self.rect((x + w - d * 0.16, y), (x + w, y + d), layer)  # right arm
        for k in (1, 2):
            self.line((x + w * k / 3.0, y), (x + w * k / 3.0, y + d * 0.78), layer)

    def fixture_table(self, pos, w=160, d=90, seats=6, layer="FIX"):
        """Dining table with chairs around the long sides. pos=bottom-left."""
        x, y = pos
        self.rect((x, y), (x + w, y + d), layer)
        per = max(1, seats // 2)
        cw = 45
        for i in range(per):
            cx = x + (i + 0.5) * w / per - cw / 2
            self.rect((cx, y - 50), (cx + cw, y - 8), layer)         # chair below
            self.rect((cx, y + d + 8), (cx + cw, y + d + 50), layer)  # chair above

    def fixture_wardrobe(self, pos, w=180, d=60, layer="FIX"):
        x, y = pos
        self.rect((x, y), (x + w, y + d), layer)
        doors = max(2, int(round(w / 50.0)))
        for i in range(1, doors):
            self.line((x + w * i / doors, y), (x + w * i / doors, y + d), layer)

    def fixture_fridge(self, pos, w=70, d=70, layer="FIX"):
        x, y = pos
        self.rect((x, y), (x + w, y + d), layer)
        self.line((x, y + d * 0.6), (x + w, y + d * 0.6), layer)
        self.circle((x + w * 0.85, y + d * 0.78), w * 0.04, layer)

    def fixture_shower(self, pos, w=90, d=90, layer="FIX"):
        x, y = pos
        self.rect((x, y), (x + w, y + d), layer)
        self.line((x, y), (x + w, y + d), layer)              # drain cross
        self.line((x + w, y), (x, y + d), layer)
        self.circle((x + w / 2, y + d / 2), w * 0.06, layer)  # drain

    def fixture_bathtub(self, pos, w=170, d=75, layer="FIX"):
        x, y = pos
        self.rect((x, y), (x + w, y + d), layer)
        self.rect((x + 8, y + 8), (x + w - 35, y + d - 8), layer)   # basin
        self.circle((x + w - 18, y + d / 2), 5, layer)              # tap

    def fixture_stairs(self, pos, w=110, d=260, steps=12, layer="FIX"):
        x, y = pos
        self.rect((x, y), (x + w, y + d), layer)
        for i in range(1, steps):
            self.line((x, y + d * i / steps), (x + w, y + d * i / steps), layer)
        self.line((x + w / 2, y), (x + w / 2, y + d), layer)        # walk line

    def fixture_car(self, pos, w=180, d=450, layer="FIX"):
        x, y = pos
        self.polyline([[x + 20, y], [x + w - 20, y], [x + w, y + 60],
                       [x + w, y + d - 90], [x + w - 25, y + d],
                       [x + 25, y + d], [x, y + d - 90], [x, y + 60]],
                      close=True, layer=layer)
        self.rect((x + 25, y + d * 0.55), (x + w - 25, y + d * 0.85), layer)  # cabin

    def fixture_plant(self, pos, r=35, layer="GRAMA"):
        x, y = pos
        self.circle((x, y), r, layer)
        self.circle((x, y), r * 0.6, layer)

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
        # Create every registered layer with its colour + lineweight (thawed).
        # Entities are ByLayer, so this is what defines each material's look.
        for name, d in self._layers.items():
            rgb = d.get("color", [255, 255, 255])
            lyr = doc.layers.get(name) if name in doc.layers else doc.layers.add(name)
            try:
                lyr.rgb = (int(rgb[0]), int(rgb[1]), int(rgb[2]))
                lyr.dxf.lineweight = int(d.get("lw", 13))   # 1/100 mm
                lyr.on()
                lyr.thaw()
            except Exception:
                pass
        halign_map = {"left": "LEFT", "center": "CENTER", "right": "RIGHT"}
        valign_map = {"bottom": "BOTTOM", "middle": "MIDDLE", "top": "TOP"}

        def attribs(p):
            # ByLayer by default (no explicit colour) — only override when the
            # primitive carries its own colour.
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
