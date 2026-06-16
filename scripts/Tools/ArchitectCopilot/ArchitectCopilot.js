/**
 * Architect Copilot — chat panel with two modes:
 *
 *   • MODE_API: direct calls to api.anthropic.com using a saved ANTHROPIC API
 *     key (HTTP via QNetworkAccessManager, tool_use loop).
 *
 *   • MODE_OAUTH: shells out to the Claude Code CLI (`claude -p` headless)
 *     using a long-lived OAuth token from `claude setup-token`. The QCAD
 *     command processor is exposed to Claude as the MCP tool
 *     `mcp__qcad__qcad_command` via a small Python stdio MCP companion that
 *     talks back to QCAD on localhost TCP.
 *
 * Single generic tool either way: `qcad_command(command)` feeds one string to
 * QCAD's command processor (the same path used by the bottom command line).
 *
 * Files in this addon directory:
 *   ArchitectCopilot.js     this file
 *   qcad_mcp_server.py      stdio MCP server (FastMCP)
 *   setup_mcp.sh            creates ~/.qcad-agent/mcp-venv and installs `mcp`
 *
 * Persistent state (RSettings):
 *   ArchitectCopilot/Mode             "api" | "oauth"
 *   ArchitectCopilot/ApiKey           Anthropic API key
 *   ArchitectCopilot/OAuthToken       Claude Code OAuth token
 *   ArchitectCopilot/McpPython        absolute path to venv python3
 *   ArchitectCopilot/OAuthSessionId   last claude session id (for --resume)
 *
 * Logs all activity to ~/.qcad-agent/agent-bridge.log.
 */

include("scripts/EAction.js");
include("scripts/library.js");
include("scripts/simple_create.js");
include("scripts/simple.js");                                // addLine/addArc/startTransaction/...
include("scripts/File/BitmapExport/BitmapExportWorker.js");  // exportBitmap()

function ArchitectCopilot(guiAction) {
    EAction.call(this, guiAction);
}

ArchitectCopilot.prototype = new EAction();
ArchitectCopilot.includeBasePath = includeBasePath;

// ---------------------------------------------------------------------------
// Configuration.
ArchitectCopilot.API_URL = "https://api.anthropic.com/v1/messages";
ArchitectCopilot.API_VERSION = "2023-06-01";
ArchitectCopilot.MODEL = "claude-sonnet-4-6";
ArchitectCopilot.MAX_TOKENS = 4096;
ArchitectCopilot.MAX_TOOL_LOOPS = 24;

ArchitectCopilot.MODE_API = "api";
ArchitectCopilot.MODE_OAUTH = "oauth";

ArchitectCopilot.TCP_HOST = "127.0.0.1";
ArchitectCopilot.TCP_PORT = 54321;

// OAuth (PKCE) — same OAuth client as the `claude setup-token` CLI.
// The redirect_uri is locked to platform.claude.com (Anthropic-hosted), which
// renders the auth code on the page; the user copies it back into QCAD.
ArchitectCopilot.OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
ArchitectCopilot.OAUTH_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
ArchitectCopilot.OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
ArchitectCopilot.OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
ArchitectCopilot.OAUTH_SCOPE = "user:inference";

// Platform flag — drives all OS-specific paths/commands below.
ArchitectCopilot.IS_WIN = (RS.getSystemId() === "win");

// openssl: rely on PATH on Windows; absolute on macOS/Linux.
ArchitectCopilot.OPENSSL_BIN = ArchitectCopilot.IS_WIN ? "openssl" : "/usr/bin/openssl";

// Conventional location of the MCP companion venv (created by the bootstrap).
// On Windows the venv interpreter is Scripts\python.exe, elsewhere bin/python3.
ArchitectCopilot.DEFAULT_VENV_PYTHON = ArchitectCopilot.IS_WIN
    ? "/.qcad-agent/mcp-venv/Scripts/python.exe"
    : "/.qcad-agent/mcp-venv/bin/python3";

ArchitectCopilot.SYSTEM_PROMPT =
    "You are Architect Copilot, an AI assistant embedded inside QCAD (2D CAD software). "
    + "You drive QCAD through a single tool, `qcad_command`, that sends one string at a time "
    + "to QCAD's command processor (the same one the user types into at the bottom of the screen).\n\n"

    + "PROTOCOL — how `qcad_command` works:\n"
    + "  • Send a command name to start an action: \"line\", \"circle\", \"rectangle\", \"arc\", \"polyline\",\n"
    + "    \"point\", \"text\", \"move\", \"copy\", \"rotate\", \"scale\", \"mirror\", \"trim\", \"extend\",\n"
    + "    \"offset\", \"fillet\", \"chamfer\", \"erase\", \"undo\", \"redo\", \"save\", \"open\", \"new\",\n"
    + "    \"zoomauto\" (fit), \"zoomwindow\", \"selectall\", \"deselect\".\n"
    + "  • After a drawing command, send coordinates one at a time:\n"
    + "       - Absolute: \"100,50\"\n"
    + "       - Relative: \"@50,0\"   (delta from last point)\n"
    + "       - Polar:    \"@100<45\" (length<angle in degrees)\n"
    + "  • Send the empty string \"\" to finish a multi-point command (Enter / repeat).\n"
    + "  • Send \"escape\" or \"esc\" to cancel the active action.\n"
    + "  • An expression starting with \"=\" is evaluated as math (e.g. \"=10+5*2\").\n\n"

    + "TYPICAL FLOWS:\n"
    + "  Line from (0,0) to (100,0):\n"
    + "    qcad_command(\"line\"); qcad_command(\"0,0\"); qcad_command(\"100,0\"); qcad_command(\"\")\n\n"
    + "  Rectangle 100×60 at origin:\n"
    + "    qcad_command(\"rectangle\"); qcad_command(\"0,0\"); qcad_command(\"100,60\")\n\n"
    + "  Circle center (50,50) radius 25:\n"
    + "    qcad_command(\"circle\"); qcad_command(\"50,50\"); qcad_command(\"25\")\n\n"

    + "RULES:\n"
    + "  • Always call qcad_command(\"zoomauto\") after drawing something visible.\n"
    + "  • Coordinates are in drawing units (millimeters by default).\n"
    + "  • The tool result tells you what QCAD did. If you see \"error: …\", adjust and retry.\n"
    + "  • Chain many calls in one assistant turn — finish a whole shape rather than one\n"
    + "    call per turn.\n"
    + "  • If the user is just chatting, answer in text without calling the tool.\n\n"

    + "PRECISE DRAWINGS — use `qcad_draw` (PREFERRED for anything non-trivial):\n"
    + "  • For floor plans or any drawing needing exact geometry, wall thickness,\n"
    + "    doors with swing arcs, windows, dimensions with numbers, or text labels,\n"
    + "    DO NOT issue dozens of qcad_command calls. Call `qcad_draw` with Python\n"
    + "    geometry code instead. It is far more accurate.\n"
    + "  • Your code gets a ready `plan` object (units = cm, angles = degrees CCW,\n"
    + "    0 = +x). It is saved and loaded into QCAD automatically — do not call\n"
    + "    plan.save().\n"
    + "  • Plan API:\n"
    + "      plan.T_EXT (20), plan.T_INT (10)\n"
    + "      plan.wall((x1,y1),(x2,y2), t, openings)   openings=[(center_from_p1, width), ...]\n"
    + "      plan.door((hx,hy), width, closed, open)   closed/open leaf angles, differ by +/-90\n"
    + "      plan.window((cx,cy), length, t, horizontal)\n"
    + "      plan.label(text, (x,y), h=34)\n"
    + "      plan.dim_h(x1, x2, y_meas, dy)            dy OUTSIDE the building (e.g. -180)\n"
    + "      plan.dim_v(y1, y2, x_meas, dx)            dx OUTSIDE the building\n"
    + "      plan.line/rect/circle/arc/ellipse/polyline\n"
    + "      FIXTURES (parametric, on FIX): plan.fixture_toilet/sink/stove/fridge/\n"
    + "        bed/sofa/table(seats=)/wardrobe/shower/bathtub/stairs/car/plant — use\n"
    + "        these instead of bare rectangles to furnish rooms realistically.\n"
    + "  • MATERIALS & COLOR — the CAD-correct way (IMPORTANT): organize by ELEMENT/\n"
    + "    MATERIAL on layers and draw ByLayer (entities inherit the layer's colour +\n"
    + "    lineweight). Do NOT colour each entity or organize 'by colour' — that's wrong.\n"
    + "    Show materials with hatch PATTERNS (texture), not solid colour fills.\n"
    + "    - Standard layers: WALLS/DOORS/WINDOWS/FIX/TEXT/DIMS (elements) and the\n"
    + "      materials PISO, MADEIRA, CONCRETO, VIDRO, AGUA, GRAMA, PEDRA, MARMORE,\n"
    + "      GRANITO, CERAMICA, CARPETE, TIJOLO, TELHA, METAL, BRITA (each pre-set with\n"
    + "      a colour + lineweight + hatch). Put geometry on the right layer (layer=…).\n"
    + "    - BEST for rooms: plan.room(points, \"NAME\", \"material\") fills the floor with\n"
    + "      the material's texture, labels the name, AND stamps the area in m² — one\n"
    + "      call per room. e.g. plan.room(suite_pts, \"SUITE\", \"wood\").\n"
    + "    - plan.surface(points, material) just fills an area with a material's texture\n"
    + "      (no label). Material names: wood|tile|water|grass|concrete|stone|marble|\n"
    + "      granite|ceramic|carpet|brick|roof|metal|gravel (or any QCAD pattern via\n"
    + "      pattern=NAME). e.g. plan.surface(deck_pts, \"wood\"); plan.surface(pool,\"water\").\n"
    + "    - WALLS render as solid black POCHÉ (filled cut) automatically — the standard\n"
    + "      plan look. plan.poche(False) turns it off for an outline-only style.\n"
    + "    - plan.layer(name, color=(r,g,b), lineweight=50, pattern=\"ANSI31\",\n"
    + "      linetype=\"DASHED\") defines a layer (lineweight 1/100 mm; walls 50, fine 9).\n"
    + "    - Pass color=(r,g,b) to a draw call ONLY for a rare one-off override; default\n"
    + "      is ByLayer. Low-level plan.fill/fill_rect(points, pattern=…) still exist.\n"
    + "  • EXTERIOR WALLS — use plan.perimeter() for guaranteed clean corners:\n"
    + "        plan.perimeter(W, H, plan.T_EXT, {\n"
    + "            \"bottom\": [(250, 90)],   # (center_x, width) door/window openings\n"
    + "            \"right\":  [(200, 120)],  # (center_y, width)\n"
    + "            \"top\": [], \"left\": [] })\n"
    + "    This builds all 4 exterior walls with corners that fill cleanly (no gaps\n"
    + "    or steps). Outer footprint is 0..W by 0..H; inner faces at t and W-t/H-t.\n"
    + "  • If you build exterior walls MANUALLY instead, each wall must run the FULL\n"
    + "    length on its long axis and be inset by t/2 ONLY on its thickness axis, so\n"
    + "    adjacent walls OVERLAP at the corners. With h = plan.T_EXT/2:\n"
    + "        plan.wall((0, h),   (W, h),   plan.T_EXT, [...])   # bottom, full width\n"
    + "        plan.wall((W-h, 0), (W-h, H), plan.T_EXT, [...])   # right, full height\n"
    + "        plan.wall((0, H-h), (W, H-h), plan.T_EXT, [...])   # top\n"
    + "        plan.wall((h, 0),   (h, H),   plan.T_EXT, [...])   # left\n"
    + "    NEVER inset both endpoints (e.g. (h,h)->(W-h,h)) — that leaves a corner gap.\n"
    + "    Interior walls: run centerlines from one inner face to the other (x=t to\n"
    + "    x=W-t) so they butt cleanly. Openings go on the inner span, never at corners.\n"
    + "  • DOOR TIP: hinge sits at a door jamb; `closed` points along the wall toward\n"
    + "    the other jamb, `open` points 90 deg into the room the door swings into.\n"
    + "  • PLACEMENT — keep elements readable and realistic:\n"
    + "    - LABELS go in an EMPTY part of the room, never on top of furniture, walls,\n"
    + "      doors or dimensions. If furniture sits in the room center, offset the\n"
    + "      label toward a free corner. Scale label height to the room (~30-45 for\n"
    + "      rooms, smaller for tiny rooms like a bathroom). One label per room.\n"
    + "    - FURNITURE goes AGAINST walls, not floating: sofa back to a wall, bed\n"
    + "      headboard to a wall, kitchen counter/stove/sink along a wall, TV on a\n"
    + "      wall facing the sofa, toilet/sink against bathroom walls. Leave a\n"
    + "      clear gap (>=80) for circulation and never block a door's swing.\n"
    + "    - Keep every element inside its room's INNER faces (account for wall t),\n"
    + "      and don't let fixtures overlap each other.\n"
    + "  • INCREMENTAL EDITING — qcad_draw takes a `mode`:\n"
    + "      - mode=\"add\" (DEFAULT): ADDS your geometry to the drawing already open,\n"
    + "        keeping everything that's there. One undo step. Use this to extend or\n"
    + "        add to an existing drawing — emit ONLY the new elements, not the whole\n"
    + "        thing. Call qcad_view first if you need to see the current state/coords.\n"
    + "      - mode=\"replace\": clears the drawing, then draws (redo from scratch).\n"
    + "      - mode=\"new\": opens the drawing in a fresh document tab.\n"
    + "    So \"add a garage\" or \"put a table in the living room\" = qcad_draw(mode=\"add\")\n"
    + "    with just the new geometry. \"redo the whole plan\" = mode=\"replace\".\n"
    + "  • After qcad_draw, ALWAYS call qcad_view, check it, and if anything is wrong\n"
    + "    (overlaps, wrong swing, missing room) call qcad_draw again with fixed code.\n\n"

    + "REAL-WORLD DIMENSIONS (units are cm — use realistic sizes, never arbitrary):\n"
    + "  • Wall thickness: exterior 20, interior 10 (already the defaults).\n"
    + "  • Door openings: interior 70-80, main entrance 90, bathroom 60-70.\n"
    + "  • Window width 100-150, sill ~100 off floor (plan view: just the opening).\n"
    + "  • Ceiling height ~270 (relevant for sections, not plan).\n"
    + "  • Rooms (typical minimum / comfortable): bedroom 900x300 min, ~300x350 good;\n"
    + "    double bedroom >=320x340; living room >=350x400; kitchen >=200x300;\n"
    + "    full bathroom >=150x200, lavatory >=90x120; hallway width >=90 (>=120 better).\n"
    + "  • Furniture (w x d, cm): single bed 90x190, double 140x190, queen 160x200;\n"
    + "    nightstand 45x40; wardrobe depth 60; sofa 2-seat 160x90, 3-seat 210x90;\n"
    + "    dining table 4p 120x80 / 6p 160x90; chair 45x45; desk 120x60;\n"
    + "    fridge 70x70; stove 60x60; kitchen counter depth 60; sink 50x40;\n"
    + "    toilet 40x70; bathroom sink 50x45; shower >=80x80; bathtub 170x70.\n"
    + "  • A car (garage): 250x500; garage room >=280x550.\n\n"

    + "ERGONOMICS & CIRCULATION (respect these so the plan is usable):\n"
    + "  • Clearances: >=90 in front of doors (never block a door's swing); >=70 to\n"
    + "    walk past furniture; >=75 around a dining table to pull out chairs; >=60\n"
    + "    in front of a wardrobe/closet; >=60 in front of kitchen counters/appliances.\n"
    + "  • A bed: keep >=60 on at least one long side and the foot; headboard to a wall.\n"
    + "  • Kitchen work triangle (sink-stove-fridge): each leg 120-270; don't line them\n"
    + "    up touching. Counter run with sink between stove and fridge is ideal.\n"
    + "  • Bathroom: >=20 between fixtures; >=60 clear in front of toilet and sink.\n"
    + "  • Every room needs a sensible door; habitable rooms (bed/living/kitchen) need a\n"
    + "    window on an exterior wall. Don't place furniture over doors or windows.\n"
    + "  • Sanity-check totals: interior room sizes should sum to the building minus\n"
    + "    walls. State key room dimensions with dim_h/dim_v so sizes are verifiable.\n\n"

    + "LAYERS & NON-RECTANGULAR SHELLS:\n"
    + "  • plan.layer(\"ROOF\", (r,g,b)) defines/recolors a layer; pass layer=\"ROOF\" to\n"
    + "    any draw call to put it there. Entities now land on their real named layer\n"
    + "    (toggleable + colored in QCAD) — use layers to organize (WALLS/ROOF/FURNITURE…).\n"
    + "  • The house need NOT be rectangular: plan.walls_polyline([(x,y),...], t, closed=True)\n"
    + "    builds L-/U-/courtyard shells (orthogonal vertices) with clean joins.\n\n"

    + "PRESENTATION — make plans look professional (do these for a finished plan):\n"
    + "  • LINETYPES: pre-set line layers EIXO (centre axis, CENTER), PROJ (things above\n"
    + "    the cut plane like beams/overhead, DASHED), OCULTO (hidden edges, HIDDEN).\n"
    + "    Put a line there to get its dash pattern, e.g. plan.line(a,b,\"PROJ\") for a\n"
    + "    beam shown dashed, plan.line(a,b,\"EIXO\") for a symmetry axis.\n"
    + "  • plan.room(...) already stamps each room's area in m² — prefer it over bare\n"
    + "    labels so areas are always shown.\n"
    + "  • NORTH + SCALE: plan.north((x,y)) draws a north arrow; plan.scalebar((x,y),\n"
    + "    total_cm) a graphic scale bar. Put them in a free area beside the plan.\n"
    + "  • TITLE BLOCK: call plan.sheet(title, scale, author=, date=, project=) LAST.\n"
    + "    It draws a drawing border + a title block (carimbo) in a band below the plan\n"
    + "    (never overlapping it). e.g. plan.sheet(\"PLANTA BAIXA\",\"1:50\",project=\"Casa X\").\n"
    + "  • Keep text ASCII-ish; avoid characters the CAD font lacks (— is auto-fixed to -).\n\n"

    + "MORE TOOLS (besides qcad_command/qcad_draw/qcad_view):\n"
    + "  • qcad_query(what): read the live drawing — \"extents\" (bounding box+size),\n"
    + "    \"layers\" (per-layer entity counts), \"count\". Use it to self-verify sizes and\n"
    + "    that entities landed on the right layers, instead of guessing.\n"
    + "  • qcad_erase(layer=… or ids=…): delete by layer or entity ids — edit\n"
    + "    incrementally (e.g. erase the FURNITURE layer) instead of redrawing all.\n"
    + "  • qcad_undo(steps): roll back the last operations.\n"
    + "  • qcad_patterns(filter): list QCAD's 127 built-in hatch patterns (textures).\n"
    + "    Pass any to plan.surface(pts, mat, pattern=NAME) or plan.layer(name,\n"
    + "    pattern=NAME). e.g. AR-PARQ1/JIS_WOOD (wood), NET/SQUARE/HEXAGONS (tile),\n"
    + "    BRSTONE/GRAVEL (stone), BRICK, GRASS. Search with a filter like \"wood\".\n"
    + "  • qcad_export(fmt, path): deliver the final plan — pdf | png | dxf | dwg | svg.\n"
    + "    pdf produces a real vector A3 sheet auto-fit to a standard scale (e.g. 1:50);\n"
    + "    pair it with plan.sheet() for a titled deliverable. png is a quick raster.\n\n"

    + "SEEING YOUR WORK:\n"
    + "  • You have a second tool, `qcad_view`, that renders the current drawing to an\n"
    + "    image and returns it so you can actually LOOK at what you made.\n"
    + "  • Call `qcad_view` after drawing a shape (and any time you're unsure) to verify\n"
    + "    proportions, alignment, and that nothing is missing or wrong.\n"
    + "  • If the image reveals a mistake, fix it with `qcad_command` and view again.\n"
    + "  • For a multi-part drawing, view at least once at the end before reporting done.\n\n"

    + "Be concise. Always confirm what you drew briefly at the end.";

// Runtime state.
ArchitectCopilot.messages = [];       // API-mode conversation history
ArchitectCopilot.netman = null;       // QNetworkAccessManager (API mode)
ArchitectCopilot.apiKey = null;       // resolved at send time
ArchitectCopilot.toolLoopCount = 0;
ArchitectCopilot.busy = false;
ArchitectCopilot.mode = "api";

// TCP listener (used by the MCP companion to call back into QCAD).
ArchitectCopilot.tcpServer = null;

// Claude Code (OAuth) mode state.
ArchitectCopilot.claudeProc = null;
ArchitectCopilot.claudeStdoutBuf = "";
ArchitectCopilot.oauthSessionId = null;

// UI references (set by init).
ArchitectCopilot.uiHistory = null;
ArchitectCopilot.uiInput = null;
ArchitectCopilot.uiSendBtn = null;
ArchitectCopilot.uiStatus = null;
ArchitectCopilot.uiModeBtn = null;
ArchitectCopilot.uiInputWidget = null;   // the chat input (QLineEdit)

// Input history (up/down arrow recall), pending attached image, streaming state.
ArchitectCopilot.history = [];
ArchitectCopilot.historyIdx = -1;
ArchitectCopilot.pendingImage = null;     // path to an image to send with next msg
ArchitectCopilot.imageCounter = 0;
ArchitectCopilot.currentReply = null;     // API-mode QNetworkReply (for abort)
ArchitectCopilot.streamType = null;       // current streaming block: "thinking"|"text"

// ---------------------------------------------------------------------------
// Single generic tool exposed to Claude (API mode).
ArchitectCopilot.tools = [
    {
        name: "qcad_command",
        description:
            "Send one command-line token to QCAD. This is the same input the user can type at "
            + "QCAD's bottom command line. Use it to invoke any QCAD action by name (e.g. \"line\", "
            + "\"circle\", \"rectangle\", \"zoomauto\") or to provide a coordinate (\"0,0\", "
            + "\"@50,0\", \"@100<45\") or a typed length (\"25\"). Send the empty string \"\" to "
            + "press Enter / finish a multi-step command. Send \"escape\" to cancel the active "
            + "action. The tool returns a short status string describing what QCAD did.",
        input_schema: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: "The string to feed into QCAD's command processor. Pass empty string for Enter."
                }
            },
            required: ["command"]
        }
    },
    {
        name: "qcad_view",
        description:
            "Render the current QCAD drawing to an image and return it so you can SEE "
            + "what has been drawn. Use this to verify your work — check proportions, "
            + "alignment, and that nothing is missing — and to self-correct after drawing. "
            + "Takes no required arguments.",
        input_schema: {
            type: "object",
            properties: {},
            required: []
        }
    },
    {
        name: "qcad_draw",
        description:
            "Build a precise technical drawing (floor plans, anything needing exact "
            + "geometry, wall thickness, doors with swing arcs, windows, dimensions, or "
            + "labels) by running Python geometry code, then put it into QCAD. Prefer "
            + "this over many qcad_command calls. Your code gets a `plan` object (units "
            + "cm, angles deg CCW). Do not call plan.save(). API: plan.wall, plan.door, "
            + "plan.window, plan.label, plan.dim_h, plan.dim_v, plan.line/rect/circle/arc/"
            + "ellipse/polyline, plan.text, plan.fixture_*. After drawing, call qcad_view "
            + "to inspect. mode='add' adds to the open drawing (incremental, default); "
            + "'replace' clears then draws; 'new' opens a new document.",
        input_schema: {
            type: "object",
            properties: {
                code: {
                    type: "string",
                    description: "Python code using the `plan` object to build the drawing."
                },
                mode: {
                    type: "string",
                    "enum": ["add", "replace", "new"],
                    description: "How to apply: add (default, incremental), replace, or new."
                }
            },
            required: ["code"]
        }
    }
];

// ---------------------------------------------------------------------------
// EAction lifecycle (toggle dock).
ArchitectCopilot.prototype.beginEvent = function() {
    EAction.prototype.beginEvent.call(this);
    var appWin = EAction.getMainWindow();
    if (isNull(appWin)) return;
    var dock = appWin.findChild("ArchitectCopilotDock");
    if (isNull(dock)) return;
    dock.visible = !dock.visible;
    if (dock.visible) dock.raise();
};

ArchitectCopilot.prototype.finishEvent = function() {
    EAction.prototype.finishEvent.call(this);
};

// ---------------------------------------------------------------------------
// init: register action, build dock widget, start TCP server.
ArchitectCopilot.init = function(basePath) {
    var appWin = EAction.getMainWindow();
    if (isNull(appWin)) return;

    ArchitectCopilot.mode = RSettings.getStringValue(
        "ArchitectCopilot/Mode", ArchitectCopilot.MODE_API);

    var action = new RGuiAction(qsTr("Architect &Copilot"), appWin);
    action.setRequiresDocument(false);
    action.setScriptFile(basePath + "/ArchitectCopilot.js");
    action.setDefaultShortcut(new QKeySequence("g,a"));
    action.setDefaultCommands(["copilot", "architect"]);
    action.setGroupSortOrder(3900);
    action.setSortOrder(100);
    action.setWidgetNames(["ToolsMenu", "ToolsToolBar", "ToolsToolsPanel"]);

    // ── Form widget + layout ────────────────────────────────────────────
    var formWidget = new QWidget();
    formWidget.objectName = "ArchitectCopilotForm";
    var layout = new QVBoxLayout(formWidget);
    layout.setContentsMargins(4, 4, 4, 4);
    layout.setSpacing(4);

    var history = new QTextEdit(formWidget);
    history.objectName = "ArchitectCopilotHistory";
    history.readOnly = true;
    history.minimumHeight = 240;
    layout.addWidget(history, 1, 0);

    var status = new QLabel("", formWidget);
    status.objectName = "ArchitectCopilotStatus";
    layout.addWidget(status, 0, 0);

    var input = new QLineEdit(formWidget);
    input.objectName = "ArchitectCopilotInput";
    input.placeholderText = qsTr("Ask me to draw something… (Enter=send, Esc=stop, ↑=history)");
    layout.addWidget(input, 0, 0);

    // Row 1: send / stop / clear / mode.
    var row1 = new QWidget(formWidget);
    var row1Layout = new QHBoxLayout(row1);
    row1Layout.setContentsMargins(0, 0, 0, 0);
    row1Layout.setSpacing(4);
    var sendBtn = new QPushButton(qsTr("Send"), row1);
    sendBtn.objectName = "ArchitectCopilotSend";
    var stopBtn = new QPushButton(qsTr("Stop"), row1);
    stopBtn.objectName = "ArchitectCopilotStop";
    stopBtn.toolTip = qsTr("Interrupt the running agent (or press Esc).");
    stopBtn.enabled = false;
    var clearBtn = new QPushButton(qsTr("Clear"), row1);
    clearBtn.objectName = "ArchitectCopilotClear";
    var modeBtn = new QPushButton(ArchitectCopilot.modeLabel(), row1);
    modeBtn.objectName = "ArchitectCopilotMode";
    row1Layout.addWidget(sendBtn, 0, 0);
    row1Layout.addWidget(stopBtn, 0, 0);
    row1Layout.addWidget(clearBtn, 0, 0);
    row1Layout.addWidget(modeBtn, 0, 0);
    row1Layout.addStretch(1);
    row1.setLayout(row1Layout);
    layout.addWidget(row1, 0, 0);
    ArchitectCopilot.uiStopBtn = stopBtn;

    // Row 2: API key / OAuth token / Setup.
    var row2 = new QWidget(formWidget);
    var row2Layout = new QHBoxLayout(row2);
    row2Layout.setContentsMargins(0, 0, 0, 0);
    row2Layout.setSpacing(4);
    var apiKeyBtn = new QPushButton(qsTr("API key"), row2);
    apiKeyBtn.objectName = "ArchitectCopilotApiKey";
    var oauthLoginBtn = new QPushButton(qsTr("OAuth Login"), row2);
    oauthLoginBtn.objectName = "ArchitectCopilotOAuthLogin";
    oauthLoginBtn.toolTip = qsTr("Open browser, paste code, exchange for token (in-app).");
    var oauthBtn = new QPushButton(qsTr("OAuth (paste)"), row2);
    oauthBtn.objectName = "ArchitectCopilotOAuth";
    oauthBtn.toolTip = qsTr("Paste a token you already have from `claude setup-token`.");
    var setupBtn = new QPushButton(qsTr("Setup MCP"), row2);
    setupBtn.objectName = "ArchitectCopilotSetup";
    var imageBtn = new QPushButton(qsTr("Image"), row2);
    imageBtn.objectName = "ArchitectCopilotImage";
    imageBtn.toolTip = qsTr("Attach an image for the agent to see (or paste/drop one into the input).");
    var mentionBtn = new QPushButton(qsTr("@ File"), row2);
    mentionBtn.objectName = "ArchitectCopilotMention";
    mentionBtn.toolTip = qsTr("Reference an open drawing (switches to it). Or type @ in the input.");
    var historyBtn = new QPushButton(qsTr("History"), row2);
    historyBtn.objectName = "ArchitectCopilotHistory2";
    historyBtn.toolTip = qsTr("Browse and resume past conversations.");
    row2Layout.addWidget(apiKeyBtn, 0, 0);
    row2Layout.addWidget(oauthLoginBtn, 0, 0);
    row2Layout.addWidget(oauthBtn, 0, 0);
    row2Layout.addWidget(setupBtn, 0, 0);
    row2Layout.addWidget(imageBtn, 0, 0);
    row2Layout.addWidget(mentionBtn, 0, 0);
    row2Layout.addWidget(historyBtn, 0, 0);
    row2Layout.addStretch(1);
    row2.setLayout(row2Layout);
    layout.addWidget(row2, 0, 0);

    formWidget.setLayout(layout);

    var dock = new RDockWidget(qsTr("Architect Copilot"), appWin);
    dock.objectName = "ArchitectCopilotDock";
    dock.setWidget(formWidget);
    appWin.addDockWidget(Qt.RightDockWidgetArea, dock);
    dock.visible = true;

    if (typeof(dock.shown) !== "undefined") {
        dock.shown.connect(function() { action.setChecked(true); });
        dock.hidden.connect(function() { action.setChecked(false); });
    }

    // Cache UI refs.
    ArchitectCopilot.uiHistory = history;
    ArchitectCopilot.uiInput = input;
    ArchitectCopilot.uiInputWidget = input;
    ArchitectCopilot.uiSendBtn = sendBtn;
    ArchitectCopilot.uiStatus = status;
    ArchitectCopilot.uiModeBtn = modeBtn;

    // Start a fresh conversation session + @-mention completer for open drawings.
    ArchitectCopilot.newSession();
    ArchitectCopilot.refreshDocCompleter();

    // Enter sends (native QLineEdit signal — no key override, so typing/paste
    // keep working). Esc/Up/Down via QShortcut scoped to the input. All guarded
    // so a binding quirk can never break the text field.
    input.returnPressed.connect(function() { ArchitectCopilot.doSend(); });
    try {
        var ctx = (typeof(Qt.WidgetShortcut) !== "undefined") ? Qt.WidgetShortcut : Qt.WindowShortcut;
        // QCAD's binding: QShortcut(QKeySequence, QWidget, char member, char amb, ShortcutContext)
        var mkSc = function(keyCode, fn) {
            var sc = new QShortcut(new QKeySequence(keyCode, 0, 0, 0), input, "", "", ctx);
            sc.activated.connect(fn);
            return sc;
        };
        mkSc(Qt.Key_Escape, function() { ArchitectCopilot.stop(); });
        mkSc(Qt.Key_Up,     function() { ArchitectCopilot.historyNav(-1); });
        mkSc(Qt.Key_Down,   function() { ArchitectCopilot.historyNav(1); });
        ArchitectCopilot.fileLog("shortcuts installed");
    } catch (e) {
        ArchitectCopilot.fileLog("shortcut setup failed (typing still works): " + e);
    }

    // Wire interactions.
    sendBtn.clicked.connect(function() { ArchitectCopilot.doSend(); });
    stopBtn.clicked.connect(function() { ArchitectCopilot.stop(); });
    imageBtn.clicked.connect(function() { ArchitectCopilot.pickImage(); });
    mentionBtn.clicked.connect(function() { ArchitectCopilot.pickMention(); });
    historyBtn.clicked.connect(function() { ArchitectCopilot.pickHistory(); });

    clearBtn.clicked.connect(function() {
        // Save the current conversation, then start a fresh session (ChatGPT-style).
        ArchitectCopilot.saveSession();
        ArchitectCopilot.newSession();
        ArchitectCopilot.messages = [];
        ArchitectCopilot.oauthSessionId = null;
        ArchitectCopilot.pendingImage = null;
        RSettings.setValue("ArchitectCopilot/OAuthSessionId", "");
        history.clear();
        ArchitectCopilot.append("system", "New conversation.");
    });

    modeBtn.clicked.connect(function() {
        ArchitectCopilot.toggleMode();
    });

    apiKeyBtn.clicked.connect(function() {
        ArchitectCopilot.promptApiKey(true);
    });
    oauthLoginBtn.clicked.connect(function() {
        ArchitectCopilot.startOAuthLogin();
    });
    oauthBtn.clicked.connect(function() {
        ArchitectCopilot.promptOAuthToken(true);
    });
    setupBtn.clicked.connect(function() {
        ArchitectCopilot.runSetup();
    });

    ArchitectCopilot.netman = new QNetworkAccessManager(appWin);
    ArchitectCopilot.startTcpServer(appWin);

    // Zero-click readiness: ensure the MCP companion venv exists. If it does,
    // pre-write the config so the very first message just works. If not,
    // provision it silently in the background now.
    if (ArchitectCopilot.resolveMcpPython().length > 0) {
        ArchitectCopilot.ensureMcpConfig();
        ArchitectCopilot.append("system",
            "Ready. Ask me to draw something — e.g. \"desenha um quadrado 80x80 na origem\".");
    } else {
        ArchitectCopilot.append("system",
            "Preparing the AI bridge (one-time, ~1 min)… you can type meanwhile.");
        ArchitectCopilot.runSetup(true);
    }
    ArchitectCopilot.fileLog("init: chat panel registered (mode=" + ArchitectCopilot.mode + ")");
};

ArchitectCopilot.uninit = function() {
    if (!isNull(ArchitectCopilot.tcpServer)) {
        try { ArchitectCopilot.tcpServer.close(); } catch (e) {}
    }
};

// ---------------------------------------------------------------------------
// TCP listener — accepts JSON-line requests from the MCP companion and
// hands the embedded command to QCAD's command processor.
ArchitectCopilot.startTcpServer = function(parent) {
    try {
        var server = new QTcpServer(parent);
        var addr = new QHostAddress(ArchitectCopilot.TCP_HOST);
        if (!server.listen(addr, ArchitectCopilot.TCP_PORT)) {
            ArchitectCopilot.append("system",
                "TCP listener failed on " + ArchitectCopilot.TCP_HOST + ":"
                + ArchitectCopilot.TCP_PORT + " (port already in use?)");
            return;
        }
        server.newConnection.connect(function() {
            var sock = server.nextPendingConnection();
            sock.readyRead.connect(function() {
                try {
                    var data = sock.readAll();
                    var s = "" + data;
                    var line = s.split("\n")[0];
                    var req = JSON.parse(line);
                    var result;
                    if (typeof(req.add_file) !== "undefined") {
                        // Incremental edit: inject primitives into the open doc.
                        result = ArchitectCopilot.addEntitiesFromFile(
                            req.add_file, !!req.replace);
                        ArchitectCopilot.fileLog("tcp add_file -> " + result);
                        sock.write(new QByteArray(JSON.stringify({result: result}) + "\n"));
                        sock.flush();
                    } else if (typeof(req.query) !== "undefined") {
                        // Read-back of the live document (extents/layers/entities).
                        var qres = ArchitectCopilot.doQuery("" + req.query);
                        ArchitectCopilot.fileLog("tcp query " + req.query);
                        sock.write(new QByteArray(JSON.stringify(qres) + "\n"));
                        sock.flush();
                    } else if (typeof(req.erase) !== "undefined") {
                        // Targeted delete by layer or by entity ids.
                        result = ArchitectCopilot.doErase(req.erase);
                        ArchitectCopilot.fileLog("tcp erase -> " + result);
                        sock.write(new QByteArray(JSON.stringify({result: result}) + "\n"));
                        sock.flush();
                    } else if (typeof(req.undo) !== "undefined") {
                        result = ArchitectCopilot.doUndo(req.undo | 0);
                        ArchitectCopilot.fileLog("tcp undo -> " + result);
                        sock.write(new QByteArray(JSON.stringify({result: result}) + "\n"));
                        sock.flush();
                    } else if (typeof(req["export"]) !== "undefined") {
                        result = ArchitectCopilot.doExport(req["export"]);
                        ArchitectCopilot.fileLog("tcp export -> " + result);
                        sock.write(new QByteArray(JSON.stringify({result: result}) + "\n"));
                        sock.flush();
                    } else if (typeof(req.capture) !== "undefined") {
                        // Vision request: render drawing to a PNG, return its path.
                        var capPath = (typeof(req.capture) === "string" && req.capture.length > 0)
                            ? req.capture : "";
                        result = ArchitectCopilot.captureView(capPath);
                        ArchitectCopilot.fileLog("tcp capture -> " + result);
                        var ok = result.indexOf("error:") !== 0;
                        sock.write(new QByteArray(JSON.stringify(
                            ok ? {result: "ok", path: result} : {result: result}) + "\n"));
                        sock.flush();
                    } else {
                        var cmd = req.command;
                        if (typeof(cmd) !== "string") cmd = "";
                        result = ArchitectCopilot.runQcadCommand(cmd);
                        ArchitectCopilot.fileLog("tcp " + JSON.stringify(req) + " -> " + result);
                        sock.write(new QByteArray(JSON.stringify({result: result}) + "\n"));
                        sock.flush();
                    }
                } catch (e) {
                    sock.write(new QByteArray(
                        JSON.stringify({result: "error: " + e}) + "\n"));
                    sock.flush();
                    ArchitectCopilot.fileLog("tcp error: " + e);
                }
                sock.disconnectFromHost();
            });
        });
        ArchitectCopilot.tcpServer = server;
        ArchitectCopilot.fileLog(
            "tcp listening on " + ArchitectCopilot.TCP_HOST + ":" + ArchitectCopilot.TCP_PORT);
    } catch (e) {
        ArchitectCopilot.append("system", "TCP server error: " + e);
        ArchitectCopilot.fileLog("tcp init error: " + e);
    }
};

// ---------------------------------------------------------------------------
// Mode toggle.
ArchitectCopilot.modeLabel = function() {
    return ArchitectCopilot.mode === ArchitectCopilot.MODE_OAUTH
        ? "Mode: Claude Code" : "Mode: API";
};

ArchitectCopilot.toggleMode = function() {
    if (ArchitectCopilot.mode === ArchitectCopilot.MODE_API) {
        ArchitectCopilot.mode = ArchitectCopilot.MODE_OAUTH;
    } else {
        ArchitectCopilot.mode = ArchitectCopilot.MODE_API;
    }
    RSettings.setValue("ArchitectCopilot/Mode", ArchitectCopilot.mode);
    if (!isNull(ArchitectCopilot.uiModeBtn)) {
        ArchitectCopilot.uiModeBtn.text = ArchitectCopilot.modeLabel();
    }
    ArchitectCopilot.append("system", "switched to " + ArchitectCopilot.mode.toUpperCase() + " mode");
    ArchitectCopilot.fileLog("mode -> " + ArchitectCopilot.mode);
};

// ---------------------------------------------------------------------------
// Send button / Enter: read the multi-line input, record history, dispatch.
ArchitectCopilot.doSend = function() {
    var inp = ArchitectCopilot.uiInputWidget;
    if (isNull(inp)) return;
    var t = ("" + inp.text).replace(/^\s+|\s+$/g, "");
    if ((!t || t.length === 0) && !ArchitectCopilot.pendingImage) return;
    if (ArchitectCopilot.busy) return;
    inp.text = "";
    // @mention: if the message references an open drawing, switch to it so the
    // agent operates on the right document.
    var mentions = t.match(/@([^\s@]+\.(?:dxf|dwg))/gi);
    if (mentions) {
        for (var m = 0; m < mentions.length; m++) {
            var nm = mentions[m].substr(1);
            if (ArchitectCopilot.activateDoc(nm)) {
                ArchitectCopilot.append("system", "→ switched to " + nm);
            }
        }
    }
    if (t.length > 0) {
        ArchitectCopilot.history.push(t);
        if (ArchitectCopilot.history.length > 100) ArchitectCopilot.history.shift();
    }
    ArchitectCopilot.historyIdx = ArchitectCopilot.history.length;
    ArchitectCopilot.refreshDocCompleter();
    ArchitectCopilot.sendUserMessage(t);
};

// Up/Down arrow recall through previously sent messages.
ArchitectCopilot.historyNav = function(dir) {
    var inp = ArchitectCopilot.uiInputWidget;
    var h = ArchitectCopilot.history;
    if (isNull(inp) || h.length === 0) return;
    var idx = ArchitectCopilot.historyIdx + dir;
    if (idx < 0) idx = 0;
    if (idx >= h.length) {
        ArchitectCopilot.historyIdx = h.length;
        inp.text = "";
        return;
    }
    ArchitectCopilot.historyIdx = idx;
    inp.text = h[idx];
    if (typeof(inp.end) === "function") inp.end(false);   // cursor to end (QLineEdit)
};

// Esc / Stop: interrupt the running agent.
ArchitectCopilot.stop = function() {
    var stopped = false;
    if (!isNull(ArchitectCopilot.claudeProc)) {
        try { ArchitectCopilot.claudeProc.kill(); stopped = true; } catch (e) {}
        ArchitectCopilot.claudeProc = null;
    }
    if (!isNull(ArchitectCopilot.currentReply)) {
        try { ArchitectCopilot.currentReply.abort(); stopped = true; } catch (e) {}
        ArchitectCopilot.currentReply = null;
    }
    ArchitectCopilot.streamEnd();
    if (stopped || ArchitectCopilot.busy) {
        ArchitectCopilot.append("system", "⏹ stopped.");
    }
    ArchitectCopilot.setBusy(false, "");
};

// ---------------------------------------------------------------------------
// Image attachment (for vision). Saved under ~/.qcad-agent/attached/.
ArchitectCopilot.attachedDir = function() {
    var d = QDir.homePath() + "/.qcad-agent/attached";
    if (!new QDir(d).exists()) QDir.root().mkpath(d);
    return d;
};

ArchitectCopilot.attachImagePath = function(path) {
    ArchitectCopilot.pendingImage = path;
    var name = new QFileInfo(path).fileName();
    ArchitectCopilot.append("system", "🖼 image attached (" + name + ") — will be sent with your next message.");
    ArchitectCopilot.fileLog("image attached: " + path);
    return true;
};

ArchitectCopilot.pickImage = function() {
    var path = QFileDialog.getOpenFileName(
        EAction.getMainWindow(), qsTr("Attach image"),
        QDir.homePath(), "Images (*.png *.jpg *.jpeg *.gif *.bmp *.webp)");
    if (path && path.length > 0) ArchitectCopilot.attachImagePath(path);
};

ArchitectCopilot.attachImageFromMime = function(src) {
    try {
        var img = src.imageData();
        if (isNull(img)) return false;
        var qimg = new QImage(img);
        if (qimg.isNull()) return false;
        var p = ArchitectCopilot.attachedDir() + "/paste_" + (++ArchitectCopilot.imageCounter) + ".png";
        if (qimg.save(p, "PNG")) return ArchitectCopilot.attachImagePath(p);
    } catch (e) { ArchitectCopilot.fileLog("attachImageFromMime: " + e); }
    return false;
};

ArchitectCopilot.attachImageFromUrls = function(urls) {
    try {
        for (var i = 0; i < urls.length; i++) {
            var lf = urls[i].toLocalFile ? urls[i].toLocalFile() : ("" + urls[i]);
            if (!lf || lf.length === 0) continue;
            var ext = new QFileInfo(lf).suffix().toLowerCase();
            if (["png", "jpg", "jpeg", "gif", "bmp", "webp"].indexOf(ext) !== -1
                && new QFileInfo(lf).exists()) {
                return ArchitectCopilot.attachImagePath(lf);
            }
        }
    } catch (e) { ArchitectCopilot.fileLog("attachImageFromUrls: " + e); }
    return false;
};

// ---------------------------------------------------------------------------
// Public entry: dispatch a user message (with any pending image).
ArchitectCopilot.sendUserMessage = function(text) {
    var img = ArchitectCopilot.pendingImage;
    ArchitectCopilot.pendingImage = null;
    ArchitectCopilot.append("user", text + (img ? "  [+image]" : ""));
    ArchitectCopilot.fileLog("user: " + text + (img ? " [image=" + img + "]" : ""));
    if (ArchitectCopilot.mode === ArchitectCopilot.MODE_OAUTH) {
        ArchitectCopilot.callClaudeCode(text, img);
    } else {
        var content = [];
        if (text && text.length > 0) content.push({ type: "text", text: text });
        if (img) {
            var b64 = ArchitectCopilot.readFileBase64(img);
            if (b64 !== null) {
                content.push({
                    type: "image",
                    source: { type: "base64",
                        media_type: ArchitectCopilot.imageMediaType(img), data: b64 }
                });
            }
        }
        if (content.length === 0) content.push({ type: "text", text: "" });
        ArchitectCopilot.messages.push({ role: "user", content: content });
        ArchitectCopilot.toolLoopCount = 0;
        ArchitectCopilot.callClaude();
    }
};

ArchitectCopilot.imageMediaType = function(path) {
    var ext = new QFileInfo(path).suffix().toLowerCase();
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "gif") return "image/gif";
    if (ext === "webp") return "image/webp";
    return "image/png";
};

// ---------------------------------------------------------------------------
// Credentials.
ArchitectCopilot.resolveApiKey = function(forcePrompt) {
    if (!forcePrompt && ArchitectCopilot.apiKey) {
        return ArchitectCopilot.apiKey;
    }
    if (!forcePrompt) {
        try {
            var env = QProcessEnvironment.systemEnvironment().value("ANTHROPIC_API_KEY", "");
            if (env && env.length > 0) {
                ArchitectCopilot.apiKey = env;
                return env;
            }
        } catch (e) { /* fall through */ }
        var stored = RSettings.getStringValue("ArchitectCopilot/ApiKey", "");
        if (stored && stored.length > 0) {
            ArchitectCopilot.apiKey = stored;
            return stored;
        }
    }
    return ArchitectCopilot.promptApiKey(false);
};

ArchitectCopilot.promptApiKey = function(silent) {
    var appWin = EAction.getMainWindow();
    var current = RSettings.getStringValue("ArchitectCopilot/ApiKey", "");
    var result = QInputDialog.getText(
        appWin,
        qsTr("Architect Copilot"),
        qsTr("Anthropic API key (stored locally):"),
        QLineEdit.Password,
        current
    );
    if (isNull(result)) result = "";
    if (result.length > 0) {
        ArchitectCopilot.apiKey = result;
        RSettings.setValue("ArchitectCopilot/ApiKey", result);
        if (!silent) ArchitectCopilot.append("system", "API key saved.");
        return result;
    }
    if (!silent) ArchitectCopilot.append("system", "API key not provided.");
    return null;
};

ArchitectCopilot.resolveOAuthToken = function() {
    try {
        var env = QProcessEnvironment.systemEnvironment().value("CLAUDE_CODE_OAUTH_TOKEN", "");
        if (env && env.length > 0) return env;
    } catch (e) {}
    var stored = RSettings.getStringValue("ArchitectCopilot/OAuthToken", "");
    if (stored && stored.length > 0) return stored;
    return null;
};

ArchitectCopilot.promptOAuthToken = function(silent) {
    var appWin = EAction.getMainWindow();
    ArchitectCopilot.append("system",
        "Generate a token by running `claude setup-token` in a terminal, then paste it here.");
    var current = RSettings.getStringValue("ArchitectCopilot/OAuthToken", "");
    var result = QInputDialog.getText(
        appWin,
        qsTr("Architect Copilot"),
        qsTr("Claude Code OAuth token (from `claude setup-token`):"),
        QLineEdit.Password,
        current
    );
    if (isNull(result)) result = "";
    if (result.length > 0) {
        RSettings.setValue("ArchitectCopilot/OAuthToken", result);
        if (!silent) ArchitectCopilot.append("system", "OAuth token saved.");
        return result;
    }
    if (!silent) ArchitectCopilot.append("system", "OAuth token not provided.");
    return null;
};

// ---------------------------------------------------------------------------
// In-app OAuth login (PKCE). Button opens the browser to the Claude.com
// authorize URL, the user pastes the resulting code back into QCAD, and we
// exchange it for a long-lived `sk-ant-oat01-...` access token.
//
// NOTE: redirect_uri is platform.claude.com (Anthropic-hosted), not localhost.
// That callback page displays a code for the user to copy; there is no way to
// make this OAuth client redirect to localhost (client_id registration).
ArchitectCopilot.oauthVerifier = null;
ArchitectCopilot.oauthState = null;

ArchitectCopilot.b64url = function(s) {
    return s.replace(/\s+/g, "")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
};

ArchitectCopilot.generateCodeVerifier = function() {
    var p = new QProcess();
    p.processEnvironment = ArchitectCopilot.makeProcessEnv();
    p.start(ArchitectCopilot.OPENSSL_BIN, ["rand", "-base64", "32"]);
    if (!p.waitForFinished(3000)) {
        ArchitectCopilot.fileLog("oauth: openssl rand timed out");
        return "";
    }
    var s = "" + p.readAllStandardOutput();
    return ArchitectCopilot.b64url(s);
};

ArchitectCopilot.computeCodeChallenge = function(verifier) {
    // Verifier is base64url chars only (A-Za-z0-9_-), safe in single-quoted sh.
    var cmd = "printf %s '" + verifier + "' | "
        + ArchitectCopilot.OPENSSL_BIN + " dgst -sha256 -binary | "
        + ArchitectCopilot.OPENSSL_BIN + " base64";
    var p = new QProcess();
    p.processEnvironment = ArchitectCopilot.makeProcessEnv();
    p.start("/bin/sh", ["-c", cmd]);
    if (!p.waitForFinished(3000)) {
        ArchitectCopilot.fileLog("oauth: openssl dgst timed out");
        return "";
    }
    var s = "" + p.readAllStandardOutput();
    return ArchitectCopilot.b64url(s);
};

ArchitectCopilot.startOAuthLogin = function() {
    var appWin = EAction.getMainWindow();
    var verifier = ArchitectCopilot.generateCodeVerifier();
    if (!verifier || verifier.length < 32) {
        ArchitectCopilot.append("system",
            "Failed to generate code_verifier — is openssl at /usr/bin/openssl?");
        return;
    }
    var challenge = ArchitectCopilot.computeCodeChallenge(verifier);
    if (!challenge || challenge.length < 32) {
        ArchitectCopilot.append("system", "Failed to compute code_challenge.");
        return;
    }
    var state = ArchitectCopilot.generateCodeVerifier();
    ArchitectCopilot.oauthVerifier = verifier;
    ArchitectCopilot.oauthState = state;

    var params = [
        "code=true",
        "client_id=" + ArchitectCopilot.OAUTH_CLIENT_ID,
        "response_type=code",
        "redirect_uri=" + encodeURIComponent(ArchitectCopilot.OAUTH_REDIRECT_URI),
        "scope=" + encodeURIComponent(ArchitectCopilot.OAUTH_SCOPE),
        "code_challenge=" + challenge,
        "code_challenge_method=S256",
        "state=" + state
    ];
    var url = ArchitectCopilot.OAUTH_AUTHORIZE_URL + "?" + params.join("&");

    ArchitectCopilot.append("system", "Opening browser for Claude login…");
    ArchitectCopilot.fileLog("oauth: authorize url length=" + url.length);
    QDesktopServices.openUrl(new QUrl(url));

    ArchitectCopilot.append("system",
        "Authorize in the browser, then copy the code shown on the page and paste it below.");
    var pasted = QInputDialog.getText(
        appWin,
        qsTr("Architect Copilot — OAuth Login"),
        qsTr("Paste the code from claude.com (format: code#state or just code):"),
        QLineEdit.Normal,
        ""
    );
    if (isNull(pasted)) pasted = "";
    pasted = (pasted + "").replace(/^\s+|\s+$/g, "");
    if (pasted.length === 0) {
        ArchitectCopilot.append("system", "OAuth cancelled.");
        return;
    }
    var code = pasted;
    var returnedState = "";
    var hashIdx = pasted.indexOf("#");
    if (hashIdx >= 0) {
        code = pasted.substring(0, hashIdx);
        returnedState = pasted.substring(hashIdx + 1);
    }
    if (returnedState.length > 0 && returnedState !== state) {
        ArchitectCopilot.append("system",
            "OAuth state mismatch — aborting (possible CSRF).");
        ArchitectCopilot.fileLog("oauth: state mismatch expected=" + state
            + " got=" + returnedState);
        return;
    }
    ArchitectCopilot.exchangeOAuthCode(code, verifier, state);
};

ArchitectCopilot.exchangeOAuthCode = function(code, verifier, state) {
    var body = {
        grant_type: "authorization_code",
        code: code,
        redirect_uri: ArchitectCopilot.OAUTH_REDIRECT_URI,
        client_id: ArchitectCopilot.OAUTH_CLIENT_ID,
        code_verifier: verifier,
        state: state
    };
    var payload = JSON.stringify(body);

    var req = new QNetworkRequest(new QUrl(ArchitectCopilot.OAUTH_TOKEN_URL));
    req.setRawHeader(new QByteArray("Content-Type"), new QByteArray("application/json"));
    req.setRawHeader(new QByteArray("Accept"), new QByteArray("application/json"));

    ArchitectCopilot.setBusy(true, "Exchanging code for token…");
    var reply = ArchitectCopilot.netman.post(req, new QByteArray(payload));
    reply.finished.connect(function() {
        try {
            var raw = reply.readAll();
            var text = "" + raw;
            var status = reply.attribute(QNetworkRequest.HttpStatusCodeAttribute);
            ArchitectCopilot.fileLog("oauth: token status=" + status
                + " body=" + ArchitectCopilot.truncate(text, 600));
            if (!isNull(status) && status >= 400) {
                ArchitectCopilot.append("system",
                    "Token exchange failed (HTTP " + status + "): "
                    + ArchitectCopilot.truncate(text, 400));
                return;
            }
            var resp;
            try { resp = JSON.parse(text); }
            catch (pe) {
                ArchitectCopilot.append("system",
                    "Bad JSON from token endpoint: " + ArchitectCopilot.truncate(text, 400));
                return;
            }
            var tok = resp.access_token;
            if (!tok || tok.length === 0) {
                ArchitectCopilot.append("system",
                    "No access_token in response: " + ArchitectCopilot.truncate(text, 400));
                return;
            }
            RSettings.setValue("ArchitectCopilot/OAuthToken", tok);
            if (resp.refresh_token) {
                RSettings.setValue("ArchitectCopilot/OAuthRefreshToken", resp.refresh_token);
            }
            if (resp.expires_in) {
                ArchitectCopilot.fileLog("oauth: token expires_in=" + resp.expires_in);
            }
            ArchitectCopilot.append("system",
                "Logged in via OAuth. Switching to Claude Code mode.");
            if (ArchitectCopilot.mode !== ArchitectCopilot.MODE_OAUTH) {
                ArchitectCopilot.toggleMode();
            }
        } catch (e) {
            ArchitectCopilot.append("system", "Token exchange error: " + e);
            ArchitectCopilot.fileLog("oauth: exchange error: " + e);
        } finally {
            ArchitectCopilot.setBusy(false, "");
            reply.deleteLater();
        }
    });
};

// ---------------------------------------------------------------------------
// MCP setup: run setup_mcp.sh, capture the venv python path, write a config.
// silent=true is used for the automatic one-time provisioning on init so it
// doesn't spam the chat or block; it also guards against concurrent runs.
ArchitectCopilot.setupRunning = false;
ArchitectCopilot.runSetup = function(silent) {
    if (ArchitectCopilot.setupRunning) return;
    // Cross-platform bootstrap: run setup_mcp.py with the system python.
    var script = ArchitectCopilot.includeBasePath + "/setup_mcp.py";
    if (!new QFileInfo(script).exists()) {
        if (!silent) ArchitectCopilot.append("system", "setup_mcp.py not found at " + script);
        return;
    }
    var python = ArchitectCopilot.findPythonBin();
    ArchitectCopilot.setupRunning = true;
    if (!silent) {
        ArchitectCopilot.append("system", "Running MCP setup (may take a minute)…");
        ArchitectCopilot.setBusy(true, "Setting up MCP venv…");
    }

    var proc = new QProcess(EAction.getMainWindow());
    proc.processEnvironment = ArchitectCopilot.makeProcessEnv();
    var outBuf = "";
    var errBuf = "";
    proc.readyReadStandardOutput.connect(function() {
        outBuf += "" + proc.readAllStandardOutput();
    });
    proc.readyReadStandardError.connect(function() {
        errBuf += "" + proc.readAllStandardError();
    });
    proc['finished(int,QProcess::ExitStatus)'].connect(function(code, status) {
        ArchitectCopilot.setupRunning = false;
        if (!silent) ArchitectCopilot.setBusy(false, "");
        ArchitectCopilot.fileLog("setup_mcp.py exit=" + code + " stdout=" + outBuf + " stderr=" + errBuf);
        if (code !== 0) {
            if (!silent) ArchitectCopilot.append("system",
                "Setup failed (exit " + code + "): " + ArchitectCopilot.truncate(errBuf || outBuf, 400));
            return;
        }
        var lines = outBuf.split(/\r?\n/);
        var pyPath = "";
        for (var i = lines.length - 1; i >= 0; i--) {
            if (lines[i] && lines[i].length > 0) { pyPath = lines[i]; break; }
        }
        if (pyPath.length === 0) {
            if (!silent) ArchitectCopilot.append("system", "Setup finished but no python path on stdout.");
            return;
        }
        RSettings.setValue("ArchitectCopilot/McpPython", pyPath);
        if (!silent) ArchitectCopilot.append("system", "MCP venv ready at " + pyPath);
        else ArchitectCopilot.append("system", "Ready — ask me to draw something.");
        ArchitectCopilot.ensureMcpConfig();
    });
    try {
        proc.start(python, [script]);
        proc.closeWriteChannel();
    } catch (e) {
        ArchitectCopilot.setupRunning = false;
        if (!silent) ArchitectCopilot.append("system", "Failed to start python: " + e);
        ArchitectCopilot.fileLog("setup start threw: " + e);
    }
};

// Resolve the venv python: saved setting first, else the conventional path.
// Self-heals the saved setting when the default path is found.
ArchitectCopilot.resolveMcpPython = function() {
    var py = RSettings.getStringValue("ArchitectCopilot/McpPython", "");
    if (py && py.length > 0 && new QFileInfo(py).exists()) {
        return py;
    }
    var def = QDir.homePath() + ArchitectCopilot.DEFAULT_VENV_PYTHON;
    if (new QFileInfo(def).exists()) {
        RSettings.setValue("ArchitectCopilot/McpPython", def);
        return def;
    }
    return "";
};

ArchitectCopilot.ensureMcpConfig = function() {
    var py = ArchitectCopilot.resolveMcpPython();
    if (!py || py.length === 0) {
        ArchitectCopilot.append("system",
            "Preparing MCP companion (one-time)… try again in a moment.");
        ArchitectCopilot.runSetup(true);
        return null;
    }
    var serverPath = ArchitectCopilot.includeBasePath + "/qcad_mcp_server.py";
    if (!new QFileInfo(serverPath).exists()) {
        ArchitectCopilot.append("system", "qcad_mcp_server.py not found at " + serverPath);
        return null;
    }
    var home = QDir.homePath();
    var cfgDir = home + "/.qcad-agent";
    if (!new QDir(cfgDir).exists()) {
        QDir.root().mkpath(cfgDir);
    }
    var cfgPath = cfgDir + "/mcp-config.json";
    var cfg = {
        mcpServers: {
            qcad: {
                command: py,
                args: [serverPath],
                env: {
                    QCAD_MCP_HOST: ArchitectCopilot.TCP_HOST,
                    QCAD_MCP_PORT: "" + ArchitectCopilot.TCP_PORT
                }
            }
        }
    };
    var file = new QFile(cfgPath);
    var flags = new QIODevice.OpenMode(QIODevice.WriteOnly | QIODevice.Truncate | QIODevice.Text);
    if (file.open(flags)) {
        var ts = new QTextStream(file);
        ts.writeString(JSON.stringify(cfg, null, 2));
        file.close();
        ArchitectCopilot.fileLog("wrote mcp config: " + cfgPath);
        return cfgPath;
    }
    ArchitectCopilot.append("system", "Could not write " + cfgPath);
    return null;
};

// ---------------------------------------------------------------------------
// Mode 1: API — direct calls to api.anthropic.com.
ArchitectCopilot.callClaude = function() {
    var key = ArchitectCopilot.resolveApiKey(false);
    if (!key) {
        ArchitectCopilot.append("system", "No API key — cannot reach Claude.");
        return;
    }
    if (ArchitectCopilot.toolLoopCount >= ArchitectCopilot.MAX_TOOL_LOOPS) {
        ArchitectCopilot.append("system", "Tool loop limit reached; stopping.");
        return;
    }

    var body = {
        model: ArchitectCopilot.MODEL,
        max_tokens: ArchitectCopilot.MAX_TOKENS,
        system: ArchitectCopilot.SYSTEM_PROMPT,
        tools: ArchitectCopilot.tools,
        messages: ArchitectCopilot.messages
    };
    var payload = JSON.stringify(body);

    var req = new QNetworkRequest(new QUrl(ArchitectCopilot.API_URL));
    req.setRawHeader(new QByteArray("Content-Type"), new QByteArray("application/json"));
    req.setRawHeader(new QByteArray("x-api-key"), new QByteArray(key));
    req.setRawHeader(new QByteArray("anthropic-version"),
        new QByteArray(ArchitectCopilot.API_VERSION));

    ArchitectCopilot.setBusy(true, "Thinking…");
    var reply = ArchitectCopilot.netman.post(req, new QByteArray(payload));
    ArchitectCopilot.currentReply = reply;

    reply.finished.connect(function() {
        ArchitectCopilot.currentReply = null;
        try {
            var data = reply.readAll();
            var text = "" + data;
            var status = reply.attribute(QNetworkRequest.HttpStatusCodeAttribute);
            if (!isNull(status) && status >= 400) {
                ArchitectCopilot.append("system",
                    "HTTP " + status + ": " + ArchitectCopilot.truncate(text, 800));
                ArchitectCopilot.fileLog("api error " + status + ": " + text);
            } else {
                var response;
                try {
                    response = JSON.parse(text);
                } catch (e) {
                    ArchitectCopilot.append("system",
                        "Invalid JSON from API: " + ArchitectCopilot.truncate(text, 400));
                    ArchitectCopilot.fileLog("parse error: " + e + " body=" + text);
                    return;
                }
                ArchitectCopilot.handleApiResponse(response);
            }
        } catch (outer) {
            ArchitectCopilot.append("system", "client error: " + outer);
            ArchitectCopilot.fileLog("client error: " + outer);
        } finally {
            ArchitectCopilot.setBusy(false, "");
            reply.deleteLater();
        }
    });
};

ArchitectCopilot.handleApiResponse = function(response) {
    if (!isNull(response.error)) {
        var em = response.error.message || JSON.stringify(response.error);
        ArchitectCopilot.append("system", "API error: " + em);
        ArchitectCopilot.fileLog("api error: " + em);
        return;
    }
    if (isNull(response.content)) {
        ArchitectCopilot.append("system", "Empty response from API.");
        return;
    }

    ArchitectCopilot.messages.push({ role: "assistant", content: response.content });

    var toolResults = [];
    for (var i = 0; i < response.content.length; i++) {
        var block = response.content[i];
        if (block.type === "text") {
            ArchitectCopilot.append("copilot", block.text);
            ArchitectCopilot.fileLog("copilot: " + block.text);
        } else if (block.type === "tool_use" && block.name === "qcad_draw") {
            var drawCode = (block.input && block.input.code !== undefined) ? block.input.code : "";
            var drawMode = (block.input && block.input.mode !== undefined) ? block.input.mode : "add";
            ArchitectCopilot.append("tool", "→ qcad_draw(<code>, mode=" + drawMode + ")");
            ArchitectCopilot.fileLog("tool_use qcad_draw mode=" + drawMode);
            var drawResult = ArchitectCopilot.runDrawCode(drawCode, drawMode);
            ArchitectCopilot.append("tool", "← " + drawResult);
            toolResults.push({
                type: "tool_result", tool_use_id: block.id, content: drawResult
            });
        } else if (block.type === "tool_use" && block.name === "qcad_view") {
            ArchitectCopilot.append("tool", "→ qcad_view()");
            ArchitectCopilot.fileLog("tool_use qcad_view");
            var imgPath = ArchitectCopilot.captureView("");
            if (imgPath.indexOf("error:") === 0) {
                ArchitectCopilot.append("tool", "← " + imgPath);
                toolResults.push({
                    type: "tool_result", tool_use_id: block.id, content: imgPath
                });
            } else {
                var b64 = ArchitectCopilot.readFileBase64(imgPath);
                ArchitectCopilot.append("tool", "← [rendered drawing image]");
                if (b64 === null) {
                    toolResults.push({
                        type: "tool_result", tool_use_id: block.id,
                        content: "error: could not read rendered image"
                    });
                } else {
                    toolResults.push({
                        type: "tool_result", tool_use_id: block.id,
                        content: [{
                            type: "image",
                            source: { type: "base64", media_type: "image/png", data: b64 }
                        }]
                    });
                }
            }
        } else if (block.type === "tool_use") {
            var cmdStr = (block.input && block.input.command !== undefined) ? block.input.command : "";
            ArchitectCopilot.append("tool", "→ qcad_command(\"" + cmdStr + "\")");
            ArchitectCopilot.fileLog("tool_use qcad_command \"" + cmdStr + "\"");
            var result = ArchitectCopilot.runQcadCommand(cmdStr);
            ArchitectCopilot.append("tool", "← " + result);
            ArchitectCopilot.fileLog("tool_result \"" + cmdStr + "\" -> " + result);
            toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: result
            });
        }
    }

    if (toolResults.length > 0) {
        ArchitectCopilot.messages.push({ role: "user", content: toolResults });
        ArchitectCopilot.toolLoopCount++;
        ArchitectCopilot.callClaude();
    }
};

// ---------------------------------------------------------------------------
// Mode 2: Claude Code (OAuth) — shell out to `claude -p` and parse stream-json.
ArchitectCopilot.callClaudeCode = function(userText, imagePath) {
    // Token is OPTIONAL. If the `claude` CLI is already logged in (it stores
    // credentials in the macOS keychain), `claude -p` authenticates on its own
    // and no token is needed — this is the "use it like a Claude Code agent"
    // path. We only inject CLAUDE_CODE_OAUTH_TOKEN if one was explicitly saved.
    var token = ArchitectCopilot.resolveOAuthToken();
    var cfgPath = ArchitectCopilot.ensureMcpConfig();
    if (!cfgPath) {
        ArchitectCopilot.append("system",
            "MCP config not ready. Click 'Setup MCP' first.");
        return;
    }

    var allowed = "mcp__qcad__qcad_command,mcp__qcad__qcad_view,mcp__qcad__qcad_draw,"
        + "mcp__qcad__qcad_query,mcp__qcad__qcad_erase,mcp__qcad__qcad_undo,"
        + "mcp__qcad__qcad_patterns,mcp__qcad__qcad_export";
    var prompt = userText;
    if (imagePath) {
        // claude -p can't take inline image bytes; point it at the file and let
        // it use the Read tool (which renders images) to see it.
        allowed += ",Read";
        prompt = userText + "\n\n[The user attached an image at " + imagePath
            + " . Use the Read tool to view it before responding.]";
    }

    var args = [
        "-p", prompt,
        "--mcp-config", cfgPath,
        "--strict-mcp-config",          // ignore the user's global MCP servers
        "--allowedTools", allowed,
        "--append-system-prompt", ArchitectCopilot.SYSTEM_PROMPT,
        "--output-format", "stream-json",
        "--include-partial-messages",   // stream reasoning + text token-by-token
        "--verbose"
    ];
    var sid = RSettings.getStringValue("ArchitectCopilot/OAuthSessionId", "");
    if (sid && sid.length > 0) {
        args.unshift(sid);
        args.unshift("--resume");
    }

    var proc = new QProcess(EAction.getMainWindow());
    var env = ArchitectCopilot.makeProcessEnv();
    if (token && token.length > 0) {
        env.insert("CLAUDE_CODE_OAUTH_TOKEN", token);
        ArchitectCopilot.fileLog("claude: using saved OAuth token");
    } else {
        ArchitectCopilot.fileLog("claude: no token — relying on CLI keychain login");
    }
    proc.processEnvironment = env;

    ArchitectCopilot.claudeProc = proc;
    ArchitectCopilot.claudeStdoutBuf = "";
    ArchitectCopilot.streamedAny = false;
    ArchitectCopilot.streamType = null;

    proc.readyReadStandardOutput.connect(function() {
        var chunk = "" + proc.readAllStandardOutput();
        ArchitectCopilot.claudeStdoutBuf += chunk;
        var lines = ArchitectCopilot.claudeStdoutBuf.split(/\r?\n/);
        ArchitectCopilot.claudeStdoutBuf = lines.pop();
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i];
            if (!ln || ln.length === 0) continue;
            ArchitectCopilot.handleClaudeCodeEvent(ln);
        }
    });
    proc.readyReadStandardError.connect(function() {
        var err = "" + proc.readAllStandardError();
        if (err && err.length > 0) {
            ArchitectCopilot.fileLog("claude stderr: " + err);
        }
    });
    // `finished` is an overloaded signal — must pick the overload explicitly,
    // otherwise QtScript throws "ambiguous connect".
    proc['finished(int,QProcess::ExitStatus)'].connect(function(code, status) {
        // flush any final partial line.
        if (ArchitectCopilot.claudeStdoutBuf.length > 0) {
            ArchitectCopilot.handleClaudeCodeEvent(ArchitectCopilot.claudeStdoutBuf);
            ArchitectCopilot.claudeStdoutBuf = "";
        }
        ArchitectCopilot.streamEnd();
        ArchitectCopilot.setBusy(false, "");
        if (code !== 0 && !isNull(ArchitectCopilot.claudeProc)) {
            ArchitectCopilot.append("system", "claude exited with code " + code);
        }
        ArchitectCopilot.claudeProc = null;
    });
    // errorOccurred is Qt 5.6+; QCAD's QtScript binding is older, so connecting
    // to it (or other overloaded signals) may throw. Guard it.
    try { proc.errorOccurred.connect(function() {
        ArchitectCopilot.append("system", "Could not run `claude` (is it installed?).");
        ArchitectCopilot.setBusy(false, "");
    }); } catch (e) { ArchitectCopilot.fileLog("no errorOccurred signal: " + e); }

    ArchitectCopilot.setBusy(true, "Working… (Claude Code)");
    var claudeBin = ArchitectCopilot.findClaudeBin();
    ArchitectCopilot.fileLog("spawn " + claudeBin + " args=" + JSON.stringify(args).substr(0, 160));
    try {
        proc.start(claudeBin, args);
        proc.closeWriteChannel();   // signal EOF on stdin so claude -p doesn't wait 3s
        ArchitectCopilot.append("system", "running the agent…");
    } catch (e) {
        ArchitectCopilot.append("system", "Failed to start claude: " + e);
        ArchitectCopilot.fileLog("proc.start threw: " + e);
        ArchitectCopilot.setBusy(false, "");
    }
};

ArchitectCopilot.handleClaudeCodeEvent = function(jsonLine) {
    var evt;
    try { evt = JSON.parse(jsonLine); }
    catch (e) {
        ArchitectCopilot.fileLog("stream-json parse fail: " + e + " line=" + jsonLine);
        return;
    }
    if (isNull(evt) || !evt.type) return;

    // Streaming deltas (reasoning + assistant text token-by-token).
    if (evt.type === "stream_event" && evt.event) {
        var ev = evt.event;
        if (ev.type === "content_block_delta" && ev.delta) {
            if (ev.delta.type === "thinking_delta" && ev.delta.thinking) {
                ArchitectCopilot.streamDelta("thinking", ev.delta.thinking);
            } else if (ev.delta.type === "text_delta" && ev.delta.text) {
                ArchitectCopilot.streamDelta("text", ev.delta.text);
            }
        } else if (ev.type === "content_block_stop") {
            ArchitectCopilot.streamEnd();
        }
        return;
    }

    if (evt.type === "system" && evt.session_id) {
        if (ArchitectCopilot.oauthSessionId !== evt.session_id) {
            ArchitectCopilot.oauthSessionId = evt.session_id;
            RSettings.setValue("ArchitectCopilot/OAuthSessionId", evt.session_id);
            ArchitectCopilot.fileLog("claude session_id=" + evt.session_id);
        }
        return;
    }

    if (evt.type === "assistant" && evt.message && evt.message.content) {
        // Text and thinking were already shown via streaming deltas; here we only
        // surface tool calls (and text as a fallback if streaming produced none).
        ArchitectCopilot.streamEnd();
        var content = evt.message.content;
        for (var i = 0; i < content.length; i++) {
            var b = content[i];
            if (b.type === "text" && b.text && ArchitectCopilot.streamedAny !== true) {
                ArchitectCopilot.append("copilot", b.text);
                ArchitectCopilot.fileLog("copilot: " + b.text);
            } else if (b.type === "tool_use") {
                ArchitectCopilot.append("tool", "→ " + ArchitectCopilot.summarizeToolUse(b.name, b.input));
                ArchitectCopilot.fileLog("tool_use " + b.name + " " + ArchitectCopilot.truncate(JSON.stringify(b.input), 200));
            }
        }
        return;
    }

    if (evt.type === "user" && evt.message && evt.message.content) {
        ArchitectCopilot.streamEnd();
        for (var j = 0; j < evt.message.content.length; j++) {
            var r = evt.message.content[j];
            if (r.type === "tool_result") {
                var c = ArchitectCopilot.summarizeToolResult(r.content);
                ArchitectCopilot.append("tool", "← " + c);
                ArchitectCopilot.fileLog("tool_result " + ArchitectCopilot.truncate(c, 300));
            }
        }
        return;
    }

    if (evt.type === "result") {
        ArchitectCopilot.streamEnd();
        if (evt.session_id) {
            ArchitectCopilot.oauthSessionId = evt.session_id;
            RSettings.setValue("ArchitectCopilot/OAuthSessionId", evt.session_id);
        }
        if (evt.is_error) {
            ArchitectCopilot.append("system",
                "claude run reported error: " + (evt.result || JSON.stringify(evt)));
        }
        return;
    }
};

// ---------------------------------------------------------------------------
// runQcadCommand — feed one string into QCAD's command processor.
// Mirrors the parsing flow of scripts/Widgets/CommandLine/CommandLine.js so
// the LLM gets the same behavior the user gets when typing at the bottom of
// the screen. Returns a short status string.
// Create a blank document if none is open — same mechanism QCAD uses at
// startup. Lets the assistant draw without the user opening a file first.
ArchitectCopilot.ensureDocument = function() {
    if (!isNull(EAction.getDocumentInterface())) return true;
    try {
        var act = RGuiAction.getByScriptFile("scripts/File/NewFile/NewFile.js");
        if (!isNull(act)) {
            act.slotTrigger();
            // The Plan library works in centimetres — declare it so dimensions and
            // PDF print scale are meaningful.
            try {
                var di = EAction.getDocumentInterface();
                if (!isNull(di)) di.getDocument().setUnit(RS.Centimeter);
            } catch (eu) { ArchitectCopilot.fileLog("setUnit: " + eu); }
            ArchitectCopilot.fileLog("auto-created new document (cm)");
        }
    } catch (e) {
        ArchitectCopilot.fileLog("ensureDocument error: " + e);
    }
    return !isNull(EAction.getDocumentInterface());
};

// Render the current drawing to a PNG so the assistant can SEE its work.
// Off-screen render via exportBitmap — needs no screen-recording permission and
// captures just the drawing (no window chrome). Returns the file path or "error:".
ArchitectCopilot.DEFAULT_VIEW_PNG = "/.qcad-agent/view.png";
ArchitectCopilot.captureView = function(path) {
    if (!path || path.length === 0) {
        path = QDir.homePath() + ArchitectCopilot.DEFAULT_VIEW_PNG;
    }
    if (isNull(EAction.getDocumentInterface())) {
        ArchitectCopilot.ensureDocument();
    }
    var di = EAction.getDocumentInterface();
    if (isNull(di)) return "error: no document to capture";
    try {
        di.deselectAll();
        // Reset: thaw hidden layers + regen the scene so the render never blanks.
        ArchitectCopilot.thawAllLayers(di);
        var view = di.getLastKnownViewWithFocus();
        if (isNull(view)) return "error: no graphics view available";
        var scene = view.getScene();
        if (isNull(scene)) return "error: no scene available";
        // Render real (non-screen) linetypes so dashed/centre lines show in the
        // preview just like they do in the PDF, not as solid lines.
        try { scene.setScreenBasedLinetypes(false); } catch (e) {}
        try { scene.setDraftMode(false); } catch (e) {}
        try { scene.regenerate(); } catch (e) {}
        var props = {
            width: 1400,
            height: 1000,
            margin: 30,
            antialiasing: true,
            zoomAll: true,
            backgroundColor: new RColor(255, 255, 255)
        };
        var ret = exportBitmap(di.getDocument(), scene, path, props);
        // exportBitmap returns [ok, message] or truthy on success across versions.
        var ok = (typeof(ret) === "object" && ret.length >= 1) ? ret[0] : ret;
        if (ok === false) {
            var msg = (typeof(ret) === "object" && ret.length >= 2) ? ret[1] : "unknown";
            return "error: export failed: " + msg;
        }
        if (!new QFileInfo(path).exists()) {
            return "error: export produced no file at " + path;
        }
        ArchitectCopilot.fileLog("captured view -> " + path);
        return path;
    } catch (e) {
        ArchitectCopilot.fileLog("captureView error: " + e);
        return "error: " + e;
    }
};

// Read a text file fully (for the primitives JSON).
ArchitectCopilot.readFileText = function(path) {
    try {
        var f = new QFile(path);
        if (!f.open(new QIODevice.OpenMode(QIODevice.ReadOnly | QIODevice.Text))) return null;
        var ts = new QTextStream(f);
        var s = ts.readAll();
        f.close();
        return "" + s;
    } catch (e) {
        ArchitectCopilot.fileLog("readFileText error: " + e);
        return null;
    }
};

// Map a Plan layer name to a display colour.
ArchitectCopilot.layerColor = function(name) {
    var map = {
        WALLS: [255, 255, 255], DOORS: [0, 200, 0], WINDOWS: [60, 120, 255],
        TEXT: [255, 220, 0], DIMS: [255, 60, 60], FIX: [230, 0, 230]
    };
    var c = map[name] || [255, 255, 255];
    return new RColor(c[0], c[1], c[2]);
};

// Build a hatch (solid fill or pattern texture) from a polygon primitive and
// add it via the active simple-transaction.
ArchitectCopilot.addHatch = function(p) {
    try {
        var di = EAction.getDocumentInterface();
        var doc = di.getDocument();
        var hd = new RHatchData();
        hd.setDocument(doc);
        hd.setAngle((p.angle || 0) * Math.PI / 180.0);
        hd.setScale(p.scale || 1.0);
        var solid = (p.solid !== false);
        hd.setSolid(solid);
        hd.setPatternName(solid ? "SOLID" : (p.pattern || "ANSI31"));
        var addLoop = function(pts) {
            hd.newLoop();
            for (var k = 0; k < pts.length; k++) {
                var a = pts[k];
                var b = pts[(k + 1) % pts.length];
                hd.addBoundary(new RLine(new RVector(a[0], a[1]), new RVector(b[0], b[1])));
            }
        };
        addLoop(p.pts);
        var holes = p.holes || [];
        for (var hh = 0; hh < holes.length; hh++) {
            if (holes[hh] && holes[hh].length >= 3) addLoop(holes[hh]);
        }
        var ent = new RHatchEntity(doc, hd);
        var lid = doc.getLayerId(p.layer || "FILL");
        if (lid !== undefined && lid !== null) ent.setLayerId(lid);
        if (p.color && p.color.length === 3) {
            ent.setColor(new RColor(p.color[0], p.color[1], p.color[2]));
        } else {
            ent.setColor(new RColor(RColor.ByLayer));   // material colour = the layer's
        }
        addObject(ent);
        return true;
    } catch (e) {
        ArchitectCopilot.fileLog("addHatch error: " + e);
        return false;
    }
};

// Unfreeze/turn on every layer + repaint — prevents the off-screen renderer
// from going blank when a drawing has frozen/invisible layers.
ArchitectCopilot.thawAllLayers = function(di) {
    try {
        var doc = di.getDocument();
        var ids = doc.queryAllLayers();
        var op = new RModifyObjectsOperation();
        for (var l = 0; l < ids.length; ++l) {
            var layer = doc.queryLayer(ids[l]);
            if (isNull(layer)) continue;
            layer.setFrozen(false);
            if (typeof(layer.setOff) === "function") layer.setOff(false);
            op.addObject(layer);
        }
        di.applyOperation(op);
        di.clearPreview();
        di.repaintViews();
    } catch (e) { ArchitectCopilot.fileLog("thawAllLayers: " + e); }
};

// Create/recolor the layers a drawing uses (from the primitives JSON layers
// map), thawed and visible, so entities land on the right (toggleable) layer.
// Map a 1/100mm lineweight number to the RLineweight enum value.
ArchitectCopilot.lwEnum = function(lw) {
    var m = { 0: RLineweight.Weight000, 9: RLineweight.Weight009,
        13: RLineweight.Weight013, 18: RLineweight.Weight018,
        25: RLineweight.Weight025, 35: RLineweight.Weight035,
        50: RLineweight.Weight050 };
    if (typeof(m[lw]) !== "undefined") return m[lw];
    return RLineweight.Weight013;
};

// Read a layer def (new {color,lw,...} format, or legacy [r,g,b]) -> {col, lw}.
ArchitectCopilot.layerDef = function(layersMap, name) {
    var d = layersMap ? layersMap[name] : null;
    if (d && d.length === 3) return { col: new RColor(d[0], d[1], d[2]), lw: 13, lt: null };   // legacy
    if (d && d.color && d.color.length === 3) {
        return { col: new RColor(d.color[0], d.color[1], d.color[2]),
                 lw: (typeof(d.lw) === "number") ? d.lw : 13,
                 lt: (typeof(d.linetype) === "string") ? d.linetype : null };
    }
    return null;
};

// Make sure all of QCAD's default linetypes (DASHED/CENTER/HIDDEN/...) are loaded
// into the open document, so layers can reference them by name. Runs once.
ArchitectCopilot.ensureLinetypes = function(di) {
    try {
        var doc = di.getDocument();
        if (doc.getLinetypeId("DASHED") !== RObject.INVALID_ID &&
            doc.getLinetypeId("CENTER") !== RObject.INVALID_ID &&
            doc.getLinetypeId("HIDDEN") !== RObject.INVALID_ID) {
            return; // already present
        }
        var lts = doc.getDefaultLinetypes();
        var op = new RAddObjectsOperation();
        for (var i = 0; i < lts.length; i++) op.addObject(lts[i]);
        di.applyOperation(op);
    } catch (e) { ArchitectCopilot.fileLog("ensureLinetypes: " + e); }
};

// Resolve a linetype name to an id in the open doc; falls back to CONTINUOUS.
ArchitectCopilot.linetypeId = function(doc, name) {
    if (!name) return doc.getLinetypeId("CONTINUOUS");
    try {
        var id = doc.getLinetypeId(name);
        if (id !== undefined && id !== null && id !== RObject.INVALID_ID) return id;
    } catch (e) {}
    return doc.getLinetypeId("CONTINUOUS");
};

ArchitectCopilot.ensureLayers = function(di, layersMap) {
    if (isNull(layersMap)) return;
    ArchitectCopilot.ensureLinetypes(di);
    var doc = di.getDocument();
    for (var name in layersMap) {
        if (!layersMap.hasOwnProperty(name) || name === "0") continue;
        var def = ArchitectCopilot.layerDef(layersMap, name);
        var col = def ? def.col : new RColor(255, 255, 255);
        var lw = ArchitectCopilot.lwEnum(def ? def.lw : 13);
        var ltId = ArchitectCopilot.linetypeId(doc, def ? def.lt : null);
        try {
            if (doc.hasLayer(name)) {
                var ex = doc.queryLayer(name);
                if (!isNull(ex)) {
                    ex.setFrozen(false);
                    if (typeof(ex.setOff) === "function") ex.setOff(false);
                    ex.setColor(col);
                    if (typeof(ex.setLineweight) === "function") ex.setLineweight(lw);
                    if (typeof(ex.setLinetypeId) === "function") ex.setLinetypeId(ltId);
                    var mop = new RModifyObjectsOperation();
                    mop.addObject(ex);
                    di.applyOperation(mop);
                }
            } else {
                var layer = new RLayer(doc, name, false, false, col, ltId, lw, false);
                di.applyOperation(new RAddObjectOperation(layer, false));
            }
        } catch (e) { ArchitectCopilot.fileLog("ensureLayer " + name + ": " + e); }
    }
};

ArchitectCopilot.layerColorFrom = function(layersMap, name) {
    var def = ArchitectCopilot.layerDef(layersMap, name);
    if (def) return def.col;
    return ArchitectCopilot.layerColor(name);
};

// Read-back of the live document so the agent can self-verify (no Bash/grep).
ArchitectCopilot.doQuery = function(what) {
    var di = EAction.getDocumentInterface();
    if (isNull(di)) return { result: "error: no document" };
    var doc = di.getDocument();
    try {
        if (what === "extents") {
            var bb = doc.getBoundingBox(true, true);
            var mn = bb.getMinimum(), mx = bb.getMaximum();
            return { result: "ok", extents: {
                minx: mn.x, miny: mn.y, maxx: mx.x, maxy: mx.y,
                width: mx.x - mn.x, height: mx.y - mn.y } };
        }
        if (what === "layers") {
            var ents = doc.queryAllEntities();
            var counts = {};
            for (var i = 0; i < ents.length; i++) {
                var e = doc.queryEntityDirect(ents[i]);
                if (isNull(e)) continue;
                var ln = e.getLayerName();
                counts[ln] = (counts[ln] || 0) + 1;
            }
            var ids = doc.queryAllLayers();
            var layers = [];
            for (var l = 0; l < ids.length; l++) {
                var layer = doc.queryLayer(ids[l]);
                if (isNull(layer)) continue;
                var nm = layer.getName();
                layers.push({ name: nm, entities: counts[nm] || 0, frozen: layer.isFrozen() });
            }
            return { result: "ok", layers: layers };
        }
        if (what === "count" || what === "summary" || what === "entities") {
            return { result: "ok", count: doc.queryAllEntities().length };
        }
        return { result: "error: unknown query '" + what + "' (use extents|layers|count)" };
    } catch (e) { return { result: "error: " + e }; }
};

// Targeted delete: {layer:"WALLS"} or {ids:[...]}. One undo step.
ArchitectCopilot.doErase = function(spec) {
    var di = EAction.getDocumentInterface();
    if (isNull(di)) return "error: no document";
    var doc = di.getDocument();
    try {
        var ids = [];
        if (spec && spec.layer) {
            var all = doc.queryAllEntities();
            for (var i = 0; i < all.length; i++) {
                var e = doc.queryEntityDirect(all[i]);
                if (!isNull(e) && e.getLayerName() === spec.layer) ids.push(all[i]);
            }
        } else if (spec && spec.ids && spec.ids.length) {
            ids = spec.ids;
        } else {
            return "error: erase needs {layer:name} or {ids:[...]}";
        }
        if (ids.length === 0) return "ok: nothing matched";
        var op = new RDeleteObjectsOperation();
        for (var j = 0; j < ids.length; j++) {
            var ent = doc.queryEntity(ids[j]);
            if (!isNull(ent)) op.deleteObject(ent);
        }
        di.applyOperation(op);
        ArchitectCopilot.runQcadCommand("zoomauto");
        return "ok: erased " + ids.length + " entities";
    } catch (e) { return "error: " + e; }
};

// Real vector PDF via QCAD's Print pipeline, auto-fit to an A3 page (orientation
// chosen from the drawing's aspect), centred with a small margin.
ArchitectCopilot.doExportPdf = function(di, path) {
    try {
        include("scripts/File/Print/Print.js");
        var doc = di.getDocument();
        di.deselectAll();
        ArchitectCopilot.thawAllLayers(di);
        var bb = doc.getBoundingBox(true, true);
        var bw = bb.getWidth(), bh = bb.getHeight();
        if (!(bw > 0) || !(bh > 0)) return "error: nothing to export";
        var landscape = bw >= bh;
        var pW = landscape ? 420 : 297, pH = landscape ? 297 : 420;   // A3 mm
        var u = doc.getUnit();
        var unitScale = RUnit.convert(1.0, u, RS.Millimeter);
        // The Plan library always works in centimetres; a unitless document then
        // has no scale info, so assume cm (1 unit = 10 mm) for a sane print scale.
        if (!(unitScale > 0) || u === RS.None) unitScale = 10.0;
        var margin = 12;                                              // mm
        var fit = Math.min((pW - 2 * margin) / (bw * unitScale),
                           (pH - 2 * margin) / (bh * unitScale));
        // Snap to the nearest standard architectural scale that still fits.
        var std = [10, 20, 25, 50, 75, 100, 125, 150, 200, 250, 500, 1000];
        var need = Math.ceil(1.0 / fit);
        var nDenom = std[std.length - 1];
        for (var si = 0; si < std.length; si++) { if (std[si] >= need) { nDenom = std[si]; break; } }
        var scaleVal = 1.0 / nDenom;                                  // clean 1:N ratio
        var spanX = pW / (unitScale * scaleVal);
        var spanY = pH / (unitScale * scaleVal);
        doc.setVariable("PageSettings/PaperUnit", RS.Millimeter);
        doc.setVariable("PageSettings/PaperWidth", landscape ? pH : pW);   // portrait dims
        doc.setVariable("PageSettings/PaperHeight", landscape ? pW : pH);
        doc.setVariable("PageSettings/PageOrientation", landscape ? "Landscape" : "Portrait");
        doc.setVariable("ColorSettings/ColorMode", "FullColor");
        doc.setVariable("ColorSettings/BackgroundColor", new RColor("white"));
        doc.setVariable("PageSettings/Scale", "1:" + nDenom);
        doc.setVariable("PageSettings/OffsetX", bb.getMinimum().x - (spanX - bw) / 2.0);
        doc.setVariable("PageSettings/OffsetY", bb.getMinimum().y - (spanY - bh) / 2.0);
        doc.setVariable("MultiPageSettings/Rows", 1);
        doc.setVariable("MultiPageSettings/Columns", 1);
        doc.setVariable("MultiPageSettings/PrintCropMarks", false);
        doc.setVariable("PageTagSettings/EnablePageTags", false);
        // NB: do NOT destr() the scene/view — RGraphicsSceneQt registers itself
        // with the document interface; destroying it leaves a dangling pointer in
        // di's scene list that crashes the next deselectAll(). Let GC reclaim them.
        var scene = new RGraphicsSceneQt(di);
        var view = new RGraphicsViewImage();
        view.setScene(scene);
        var pr = new Print(undefined, doc, view);
        var ok = pr.print(path);
        if (ok && new QFileInfo(path).exists()) {
            return "ok: exported " + path + " (A3 " + (landscape ? "landscape" : "portrait") +
                   ", scale 1:" + nDenom + ")";
        }
        return "error: PDF print failed";
    } catch (e) { return "error: " + e; }
};

// Export the open drawing to PNG (raster), PDF (vector print) or DXF/DWG/SVG.
ArchitectCopilot.doExport = function(spec) {
    var di = EAction.getDocumentInterface();
    if (isNull(di)) return "error: no document";
    var fmt = ("" + (spec.fmt || "pdf")).toLowerCase();
    var path = spec.path;
    if (!path) return "error: no path";
    try {
        if (fmt === "png" || fmt === "jpg" || fmt === "jpeg" || fmt === "bmp") {
            var r = ArchitectCopilot.captureView(path);
            return (("" + r).indexOf("error") === 0) ? r : ("ok: exported " + path);
        }
        if (fmt === "pdf") {
            return ArchitectCopilot.doExportPdf(di, path);
        }
        var names = { dxf: "R27 (2013) DXF", dwg: "R27 (2013) DWG",
                      svg: "Scalable Vector Graphics (SVG)" };
        var tries = [names[fmt], fmt.toUpperCase(), ""];
        for (var i = 0; i < tries.length; i++) {
            try {
                di.exportFile(path, tries[i]);
                if (new QFileInfo(path).exists()) return "ok: exported " + path;
            } catch (e) { /* try next format name */ }
        }
        return "error: export to " + fmt + " not supported by this QCAD build";
    } catch (e) { return "error: " + e; }
};

ArchitectCopilot.doUndo = function(n) {
    var di = EAction.getDocumentInterface();
    if (isNull(di)) return "error: no document";
    if (!n || n < 1) n = 1;
    try {
        for (var i = 0; i < n; i++) di.undo();
        ArchitectCopilot.runQcadCommand("zoomauto");
        return "ok: undid " + n + " step(s)";
    } catch (e) { return "error: " + e; }
};

// Incremental editing: inject primitives from a JSON file into the OPEN
// document as real entities, in one undo step. replace=true clears first.
ArchitectCopilot.addEntitiesFromFile = function(path, replace) {
    if (isNull(EAction.getDocumentInterface())) {
        ArchitectCopilot.ensureDocument();
    }
    var di = EAction.getDocumentInterface();
    if (isNull(di)) return "error: no document";
    var txt = ArchitectCopilot.readFileText(path);
    if (txt === null) return "error: could not read primitives file";
    var data;
    try { data = JSON.parse(txt); } catch (e) { return "error: bad primitives JSON: " + e; }
    var prims = data.primitives || [];
    var layersMap = data.layers || {};

    if (replace) {
        try {
            di.selectAll();
            var op = new RDeleteSelectionOperation();
            di.applyOperation(op);
        } catch (e) { ArchitectCopilot.fileLog("clear before replace failed: " + e); }
    }

    // Create the layers (with colours) up front so setCurrentLayer can use them.
    ArchitectCopilot.ensureLayers(di, layersMap);

    var count = 0;
    try {
        startTransaction(di);
        var doc = di.getDocument();
        var vmap = { bottom: RS.VAlignBottom, middle: RS.VAlignMiddle, top: RS.VAlignTop };
        var hmap = { left: RS.HAlignLeft, center: RS.HAlignCenter, right: RS.HAlignRight };
        // Put each entity on its named layer and leave it ByLayer (inherits the
        // layer's colour + lineweight) — the CAD-correct way. Only override when
        // the primitive carries an explicit colour.
        var byLayer = new RColor(RColor.ByLayer);
        var byLayerLt = doc.getLinetypeId("BYLAYER");
        var place = function(ent, p) {
            if (isNull(ent)) return false;
            var lid = doc.getLayerId(p.layer || "0");
            if (lid !== undefined && lid !== null) ent.setLayerId(lid);
            // Inherit the layer's linetype (so EIXO=CENTER, PROJ=DASHED etc. show).
            if (typeof(ent.setLinetypeId) === "function" &&
                byLayerLt !== undefined && byLayerLt !== null) {
                ent.setLinetypeId(byLayerLt);
            }
            if (p.color && p.color.length === 3) {
                ent.setColor(new RColor(p.color[0], p.color[1], p.color[2]));
            } else {
                ent.setColor(byLayer);
                if (typeof(ent.setLineweight) === "function") {
                    ent.setLineweight(RLineweight.WeightByLayer);
                }
            }
            addObject(ent);
            return true;
        };
        for (var i = 0; i < prims.length; i++) {
            var p = prims[i];
            if (p.t === "line") {
                place(shapeToEntity(doc, new RLine(new RVector(p.p1[0], p.p1[1]),
                    new RVector(p.p2[0], p.p2[1]))), p);
            } else if (p.t === "arc") {
                place(shapeToEntity(doc, new RArc(new RVector(p.c[0], p.c[1]), p.r,
                    deg2rad(p.a0), deg2rad(p.a1), false)), p);
            } else if (p.t === "circle") {
                place(shapeToEntity(doc, new RCircle(new RVector(p.c[0], p.c[1]), p.r)), p);
            } else if (p.t === "ellipse") {
                place(shapeToEntity(doc, new REllipse(new RVector(p.c[0], p.c[1]),
                    new RVector(p.mx, p.my), p.ratio, 0.0, Math.PI * 2, false)), p);
            } else if (p.t === "poly") {
                var pl = new RPolyline();
                for (var k = 0; k < p.pts.length; k++) {
                    pl.appendVertex(new RVector(p.pts[k][0], p.pts[k][1]));
                }
                pl.setClosed(!!p.closed);
                place(shapeToEntity(doc, pl), p);
            } else if (p.t === "text") {
                var va = vmap[p.valign] || RS.VAlignMiddle;
                var ha = hmap[p.halign] || RS.HAlignCenter;
                var pos = new RVector(p.x, p.y);
                var td = new RTextData(pos, pos, p.h, 0.0, va, ha, RS.LeftToRight,
                    RS.Exact, 1.0, p.s, "Standard", false, false, deg2rad(p.rot || 0), true);
                place(new RTextEntity(doc, td), p);
            } else if (p.t === "hatch") {
                if (ArchitectCopilot.addHatch(p)) count++;
                continue;
            } else {
                continue;
            }
            count++;
        }
        endTransaction();
    } catch (e) {
        try { endTransaction(); } catch (e2) {}
        ArchitectCopilot.fileLog("addEntities error: " + e);
        return "error: " + e;
    }
    // Make sure nothing the agent just drew is hidden, then refit the view.
    ArchitectCopilot.thawAllLayers(di);
    ArchitectCopilot.runQcadCommand("zoomauto");
    ArchitectCopilot.fileLog("addEntities: " + count + " entities (replace=" + replace + ")");
    return count + " entities";
};

// Run agent-authored Plan code through the venv python runner (API mode).
// Mirrors what the MCP qcad_draw tool does for Claude Code mode.
ArchitectCopilot.runDrawCode = function(code, mode) {
    mode = (mode || "add").toLowerCase();
    var py = ArchitectCopilot.resolveMcpPython();
    if (!py || py.length === 0) {
        return "error: python venv not ready (click 'Setup MCP')";
    }
    var runner = ArchitectCopilot.includeBasePath + "/qcad_run_plan.py";
    if (!new QFileInfo(runner).exists()) {
        return "error: qcad_run_plan.py not found";
    }
    try {
        var tmp = QDir.homePath() + "/.qcad-agent/agent_draw_code.py";
        var f = new QFile(tmp);
        var flags = new QIODevice.OpenMode(QIODevice.WriteOnly | QIODevice.Truncate | QIODevice.Text);
        if (!f.open(flags)) return "error: could not write temp code file";
        var ts = new QTextStream(f);
        ts.writeString(code);
        f.close();

        var args, jsonPath = QDir.homePath() + "/.qcad-agent/agent_primitives.json";
        if (mode === "new") {
            args = [runner, tmp];
        } else {
            args = [runner, "--emit-json", tmp, jsonPath];
        }
        var proc = new QProcess();
        proc.processEnvironment = ArchitectCopilot.makeProcessEnv();
        proc.start(py, args);
        if (!proc.waitForFinished(60000)) {
            return "error: qcad_draw timed out";
        }
        var out = ("" + proc.readAllStandardOutput()).replace(/^\s+|\s+$/g, "");
        var err = ("" + proc.readAllStandardError()).replace(/^\s+|\s+$/g, "");
        ArchitectCopilot.fileLog("qcad_draw(" + mode + ") out=" + out + " err=" + err);
        if (out.indexOf("OK") !== 0) {
            return out.length > 0 ? out : ("error: " + (err || "unknown qcad_draw failure"));
        }
        if (mode === "new") {
            return out + " — opened as a new document; call qcad_view to inspect.";
        }
        var res = ArchitectCopilot.addEntitiesFromFile(jsonPath, mode === "replace");
        if (("" + res).indexOf("error") === 0) return res;
        var verb = mode === "replace" ? "replaced drawing with" : "added";
        return "ok: " + verb + " geometry (" + res + "); call qcad_view to inspect.";
    } catch (e) {
        return "error: " + e;
    }
};

// Read a binary file and return base64 (for embedding the rendered PNG in an
// API-mode tool_result image block).
ArchitectCopilot.readFileBase64 = function(path) {
    try {
        var f = new QFile(path);
        if (!f.open(new QIODevice.OpenMode(QIODevice.ReadOnly))) return null;
        var bytes = f.readAll();
        f.close();
        return "" + bytes.toBase64();
    } catch (e) {
        ArchitectCopilot.fileLog("readFileBase64 error: " + e);
        return null;
    }
};

ArchitectCopilot.runQcadCommand = function(command) {
    var appWin = EAction.getMainWindow();
    if (isNull(appWin)) {
        return "error: no main window";
    }
    if (isNull(EAction.getDocumentInterface())) {
        ArchitectCopilot.ensureDocument();
    }
    var di = EAction.getDocumentInterface();
    if (isNull(di)) {
        return "error: could not open a document";
    }

    var cmd = ("" + command).replace(/^\s+|\s+$/g, "");

    if (cmd.length === 0) {
        try {
            var e0 = new RCommandEvent("");
            di.commandEvent(e0);
            return "ok: sent empty (Enter)";
        } catch (e) {
            return "error: " + e;
        }
    }

    var lower = cmd.toLowerCase();
    if (lower === "escape" || lower === "esc") {
        try {
            di.terminateCurrentAction();
            return "ok: action cancelled";
        } catch (e) {
            return "error: " + e;
        }
    }

    var doc = di.getDocument();

    if (cmd.charAt(0) === "=") {
        var expr = cmd.slice(1);
        var val = RMath.eval(expr);
        if (isNumber(val)) {
            return "ok: " + expr + " = " + val;
        }
        return "error: invalid expression \"" + expr + "\"";
    }

    var subbed;
    try { subbed = doc.substituteAutoVariables(cmd); } catch (e) { subbed = cmd; }

    try {
        var ec = new RCommandEvent(subbed);
        di.commandEvent(ec);
        if (ec.isAccepted()) {
            return "ok: command accepted by active action (\"" + subbed + "\")";
        }
    } catch (e) { /* fall through */ }

    // Coordinate first (LLM always sends explicit "x,y" or "@x,y" / "@r<θ").
    // Skip direct-distance-entry: it depends on cursor position, meaningless
    // from a TCP/LLM driver.
    // LLMs are trained on "x,y" with comma separator. QCAD's actual separator is
    // locale-dependent (e.g. ";" when decimal point is ","). Normalize the
    // canonical comma form to whatever QCAD expects before parsing.
    var canon = ArchitectCopilot.normalizeCoordinate(subbed);
    var pos = null;
    try { pos = RMath.parseCoordinate(canon, di.getRelativeZero()); }
    catch (e) { pos = null; }

    if (!isNull(pos) && !pos.isNaN()) {
        if (!pos.isValid()) {
            return "error: invalid coordinate \"" + subbed + "\"";
        }
        try {
            var view = di.getLastKnownViewWithFocus();
            var ev = new RCoordinateEvent(pos, view.getScene(), getRGraphicsView(view));
            di.coordinateEvent(ev);
            return "ok: coordinate (" + pos.x + "," + pos.y + ")";
        } catch (e) {
            return "error: dispatching coordinate: " + e;
        }
    }

    if (RGuiAction.triggerByCommand(lower)) {
        return "ok: triggered \"" + lower + "\"";
    }

    return "error: unknown command or invalid value \"" + cmd + "\"";
};

// ---------------------------------------------------------------------------
// UI helpers.
ArchitectCopilot.append = function(role, text) {
    var h = ArchitectCopilot.uiHistory;
    if (isNull(h)) return;
    var ts = new Date().toLocaleTimeString();
    var label;
    if (role === "user") label = "You";
    else if (role === "copilot") label = "Copilot";
    else if (role === "tool") label = "tool";
    else label = "system";
    h.append("[" + ts + "] " + label + ": " + text);
    ArchitectCopilot.recordLine(role, text);
};

// ---------------------------------------------------------------------------
// Session history (ChatGPT-style): conversations persist to ~/.qcad-agent/
// sessions/*.json and can be browsed/resumed via the History button.
ArchitectCopilot.session = null;   // { file, title, started, lines, oauth }

ArchitectCopilot.sessionsDir = function() {
    var d = QDir.homePath() + "/.qcad-agent/sessions";
    if (!new QDir(d).exists()) QDir.root().mkpath(d);
    return d;
};

ArchitectCopilot.newSession = function() {
    var now = new Date();
    var stamp = ("" + now.getTime());
    ArchitectCopilot.session = {
        file: ArchitectCopilot.sessionsDir() + "/" + stamp + ".json",
        title: "", started: now.toLocaleString(), lines: [], oauth: ""
    };
};

ArchitectCopilot.recordLine = function(role, text) {
    if (isNull(ArchitectCopilot.session)) ArchitectCopilot.newSession();
    var s = ArchitectCopilot.session;
    s.lines.push({ role: role, text: text });
    if (s.title.length === 0 && role === "user") {
        s.title = text.length > 48 ? text.substr(0, 48) + "…" : text;
    }
    s.oauth = ArchitectCopilot.oauthSessionId || s.oauth || "";
    ArchitectCopilot.saveSession();
};

ArchitectCopilot.saveSession = function() {
    var s = ArchitectCopilot.session;
    if (isNull(s) || s.lines.length === 0) return;
    try {
        var f = new QFile(s.file);
        var flags = new QIODevice.OpenMode(QIODevice.WriteOnly | QIODevice.Truncate | QIODevice.Text);
        if (f.open(flags)) {
            new QTextStream(f).writeString(JSON.stringify({
                title: s.title, started: s.started, oauth: s.oauth, lines: s.lines }));
            f.close();
        }
    } catch (e) { ArchitectCopilot.fileLog("saveSession: " + e); }
};

ArchitectCopilot.listSessions = function() {
    var out = [];
    try {
        var dir = new QDir(ArchitectCopilot.sessionsDir());
        var files = dir.entryList(["*.json"], QDir.Files, QDir.Time);  // newest first
        for (var i = 0; i < files.length; i++) {
            var path = ArchitectCopilot.sessionsDir() + "/" + files[i];
            var txt = ArchitectCopilot.readFileText(path);
            if (txt === null) continue;
            try {
                var d = JSON.parse(txt);
                out.push({ path: path, title: d.title || "(untitled)", started: d.started || "" });
            } catch (e) {}
        }
    } catch (e) { ArchitectCopilot.fileLog("listSessions: " + e); }
    return out;
};

ArchitectCopilot.pickHistory = function() {
    var sessions = ArchitectCopilot.listSessions();
    if (sessions.length === 0) {
        ArchitectCopilot.append("system", "No past conversations yet.");
        return;
    }
    var labels = [];
    for (var i = 0; i < sessions.length; i++) {
        labels.push(sessions[i].started + " — " + sessions[i].title);
    }
    var choice = QInputDialog.getItem(EAction.getMainWindow(),
        qsTr("Conversation history"), qsTr("Resume a past conversation:"),
        labels, 0, false);
    if (isNull(choice) || choice.length === 0) return;
    var idx = labels.indexOf(choice);
    if (idx < 0) return;
    ArchitectCopilot.loadSession(sessions[idx].path);
};

ArchitectCopilot.loadSession = function(path) {
    var txt = ArchitectCopilot.readFileText(path);
    if (txt === null) { ArchitectCopilot.append("system", "Could not read session."); return; }
    var d;
    try { d = JSON.parse(txt); } catch (e) { return; }
    // start the loaded session as the current one (so new turns append to it)
    ArchitectCopilot.uiHistory.clear();
    ArchitectCopilot.messages = [];
    ArchitectCopilot.session = {
        file: path, title: d.title || "", started: d.started || "",
        lines: d.lines || [], oauth: d.oauth || ""
    };
    ArchitectCopilot.oauthSessionId = d.oauth || null;
    if (d.oauth) RSettings.setValue("ArchitectCopilot/OAuthSessionId", d.oauth);
    var h = ArchitectCopilot.uiHistory;
    var lines = d.lines || [];
    for (var i = 0; i < lines.length; i++) {
        var lab = lines[i].role === "user" ? "You"
            : lines[i].role === "copilot" ? "Copilot"
            : lines[i].role === "tool" ? "tool" : "system";
        h.append(lab + ": " + lines[i].text);
    }
    h.append("——— resumed ———");
};

// ---------------------------------------------------------------------------
// @-mention of open drawings: list/activate QCAD documents by file name.
ArchitectCopilot.listOpenDocs = function() {
    var docs = [];
    try {
        var appWin = EAction.getMainWindow();
        var mdiArea = appWin.getMdiArea();
        var children = mdiArea.subWindowList();
        for (var i = 0; i < children.length; i++) {
            var doc = children[i].getDocument();
            if (isNull(doc)) continue;
            var fn = doc.getFileName();
            var name = (fn && fn.length > 0) ? new QFileInfo(fn).fileName() : "Untitled";
            docs.push({ name: name, win: children[i] });
        }
    } catch (e) { ArchitectCopilot.fileLog("listOpenDocs: " + e); }
    return docs;
};

ArchitectCopilot.activateDoc = function(name) {
    var docs = ArchitectCopilot.listOpenDocs();
    for (var i = 0; i < docs.length; i++) {
        if (docs[i].name === name) {
            try { EAction.getMainWindow().getMdiArea().setActiveSubWindow(docs[i].win); return true; }
            catch (e) {}
        }
    }
    return false;
};

ArchitectCopilot.refreshDocCompleter = function() {
    try {
        var inp = ArchitectCopilot.uiInputWidget;
        if (isNull(inp) || typeof(inp.setCompleter) !== "function") return;
        var docs = ArchitectCopilot.listOpenDocs();
        var list = [];
        for (var i = 0; i < docs.length; i++) list.push("@" + docs[i].name);
        var comp = new QCompleter(list, inp);
        comp.caseSensitivity = Qt.CaseInsensitive;
        inp.setCompleter(comp);
    } catch (e) { ArchitectCopilot.fileLog("refreshDocCompleter: " + e); }
};

ArchitectCopilot.pickMention = function() {
    var docs = ArchitectCopilot.listOpenDocs();
    if (docs.length === 0) { ArchitectCopilot.append("system", "No open drawings."); return; }
    var names = [];
    for (var i = 0; i < docs.length; i++) names.push(docs[i].name);
    var choice = QInputDialog.getItem(EAction.getMainWindow(),
        qsTr("Reference a drawing"), qsTr("Insert @mention and switch to:"),
        names, 0, false);
    if (isNull(choice) || choice.length === 0) return;
    ArchitectCopilot.activateDoc(choice);
    var inp = ArchitectCopilot.uiInputWidget;
    if (!isNull(inp)) inp.text = "@" + choice + " " + ("" + inp.text);
};

ArchitectCopilot.setBusy = function(busy, statusText) {
    ArchitectCopilot.busy = busy;
    if (!isNull(ArchitectCopilot.uiSendBtn)) {
        ArchitectCopilot.uiSendBtn.enabled = !busy;
    }
    if (!isNull(ArchitectCopilot.uiStopBtn)) {
        ArchitectCopilot.uiStopBtn.enabled = busy;
    }
    if (!isNull(ArchitectCopilot.uiStatus)) {
        ArchitectCopilot.uiStatus.text = statusText || "";
    }
};

// Incremental (streaming) display: append text to the end of the history pane
// without the per-line role prefix, with a header when a new block starts.
ArchitectCopilot.streamDelta = function(kind, text) {
    var h = ArchitectCopilot.uiHistory;
    if (isNull(h) || !text) return;
    if (ArchitectCopilot.streamType !== kind) {
        ArchitectCopilot.streamEnd();
        var header = (kind === "thinking") ? "\n[thinking] " : "\n[Copilot] ";
        ArchitectCopilot.streamInsert(header);
        ArchitectCopilot.streamType = kind;
    }
    if (kind === "text") ArchitectCopilot.streamedAny = true;
    ArchitectCopilot.streamInsert(text);
};

ArchitectCopilot.streamInsert = function(text) {
    var h = ArchitectCopilot.uiHistory;
    if (isNull(h)) return;
    var cur = h.textCursor();
    cur.movePosition(QTextCursor.End);
    h.setTextCursor(cur);
    h.insertPlainText(text);
    var sb = h.verticalScrollBar();
    if (!isNull(sb)) sb.value = sb.maximum;
};

ArchitectCopilot.streamEnd = function() {
    if (ArchitectCopilot.streamType !== null) {
        ArchitectCopilot.streamInsert("\n");
        ArchitectCopilot.streamType = null;
    }
};

ArchitectCopilot.truncate = function(s, max) {
    s = "" + s;
    if (s.length <= max) return s;
    return s.substr(0, max) + "…(" + (s.length - max) + " more)";
};

// Short, readable label for a tool call — no full code/JSON dumps in the chat.
ArchitectCopilot.summarizeToolUse = function(name, input) {
    input = input || {};
    var shortName = ("" + name).replace(/^mcp__qcad__/, "");
    if (shortName === "qcad_draw") {
        var code = typeof(input.code) === "string" ? input.code : "";
        var lines = code.length ? code.split(/\r?\n/).filter(function(l){ return l.replace(/\s/g,"").length>0; }).length : 0;
        var mode = input.mode || "add";
        return "qcad_draw [" + mode + "] (" + lines + " line" + (lines === 1 ? "" : "s") + " of geometry)";
    }
    if (shortName === "qcad_view") return "qcad_view (looking at the drawing)";
    if (shortName === "qcad_command") {
        return "qcad_command \"" + (input.command !== undefined ? input.command : "") + "\"";
    }
    return shortName + " " + ArchitectCopilot.truncate(JSON.stringify(input), 120);
};

// Turn a tool_result content (string, or array of text/image blocks) into a
// short human-readable line — never dump base64 image data into the chat.
ArchitectCopilot.summarizeToolResult = function(content) {
    if (typeof(content) === "string") return ArchitectCopilot.truncate(content, 300);
    if (isNull(content)) return "(no content)";
    if (content.length !== undefined) {
        var parts = [];
        for (var i = 0; i < content.length; i++) {
            var b = content[i];
            if (isNull(b)) continue;
            if (b.type === "image") parts.push("[image]");
            else if (b.type === "text" && typeof(b.text) === "string") parts.push(b.text);
            else if (typeof(b) === "string") parts.push(b);
        }
        if (parts.length > 0) return ArchitectCopilot.truncate(parts.join(" "), 300);
    }
    if (content.type === "image") return "[image]";
    if (typeof(content.text) === "string") return ArchitectCopilot.truncate(content.text, 300);
    return "[result]";
};

// macOS GUI apps inherit launchd's tiny PATH ("/usr/bin:/bin:...") that does
// not include Homebrew or the user's local bin. Augment it so QProcess can
// find `claude`, `python3`, etc.
ArchitectCopilot.makeProcessEnv = function() {
    var env = QProcessEnvironment.systemEnvironment();
    if (ArchitectCopilot.IS_WIN) {
        // On Windows claude/python are normally already on PATH; nothing to add.
        return env;
    }
    // macOS/Linux GUI apps inherit a minimal PATH — add the usual install dirs.
    var current = env.value("PATH", "");
    var parts = current.length > 0 ? current.split(":") : [];
    var extras = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        QDir.homePath() + "/.local/bin"
    ];
    for (var i = 0; i < extras.length; i++) {
        if (parts.indexOf(extras[i]) === -1) parts.push(extras[i]);
    }
    env.insert("PATH", parts.join(":"));
    return env;
};

ArchitectCopilot.findClaudeBin = function() {
    var stored = RSettings.getStringValue("ArchitectCopilot/ClaudeBin", "");
    if (stored && stored.length > 0 && new QFileInfo(stored).exists()) return stored;
    var home = QDir.homePath();
    var candidates = ArchitectCopilot.IS_WIN
        ? [home + "/AppData/Roaming/npm/claude.cmd",
           "C:/Program Files/nodejs/claude.cmd"]
        : ["/opt/homebrew/bin/claude",
           "/usr/local/bin/claude",
           home + "/.local/bin/claude",
           home + "/.npm-global/bin/claude"];
    for (var i = 0; i < candidates.length; i++) {
        if (new QFileInfo(candidates[i]).exists()) return candidates[i];
    }
    return ArchitectCopilot.IS_WIN ? "claude.cmd" : "claude"; // fall back to PATH
};

// Find a system python to bootstrap the MCP venv.
ArchitectCopilot.findPythonBin = function() {
    var stored = RSettings.getStringValue("ArchitectCopilot/PythonBin", "");
    if (stored && stored.length > 0 && new QFileInfo(stored).exists()) return stored;
    var home = QDir.homePath();
    var candidates = ArchitectCopilot.IS_WIN
        ? [home + "/AppData/Local/Programs/Python/Python312/python.exe",
           home + "/AppData/Local/Programs/Python/Python311/python.exe",
           "C:/Python312/python.exe", "C:/Python311/python.exe"]
        : ["/opt/homebrew/bin/python3", "/usr/local/bin/python3",
           "/usr/bin/python3"];
    for (var i = 0; i < candidates.length; i++) {
        if (new QFileInfo(candidates[i]).exists()) return candidates[i];
    }
    return ArchitectCopilot.IS_WIN ? "python" : "python3"; // fall back to PATH
};

// Translate the "x,y" form (which is what LLMs produce by training) into the
// separator QCAD's parseCoordinate actually accepts in the current locale.
// On many locales QCAD uses ";" because "," is the decimal point.
ArchitectCopilot.normalizeCoordinate = function(s) {
    var sep = RSettings.getStringValue("Input/CartesianCoordinateSeparator", ",");
    var dec = RSettings.getStringValue("Input/DecimalPoint", ".");
    if (sep === ",") return s; // already in canonical form
    // Replace bare "," (used as cart separator) with the real separator. Be
    // careful not to mangle decimals: if dec is "." and sep is ";", we can
    // just swap "," → ";" globally. If dec is "," (european), an LLM-produced
    // "100.5,50" still has unambiguous decimal "."s, so the swap is fine.
    return s.replace(/,/g, sep);
};

// ---------------------------------------------------------------------------
// File log helper.
ArchitectCopilot.fileLog = function(text) {
    try {
        var home = QDir.homePath();
        var dirPath = home + "/.qcad-agent";
        var dir = new QDir(dirPath);
        if (!dir.exists()) {
            QDir.root().mkpath(dirPath);
        }
        var file = new QFile(dirPath + "/agent-bridge.log");
        var flags = new QIODevice.OpenMode(QIODevice.WriteOnly | QIODevice.Append | QIODevice.Text);
        if (file.open(flags)) {
            var stream = new QTextStream(file);
            stream.writeString(new Date().toISOString() + " " + text + "\n");
            file.close();
        }
    } catch (e) { /* never break the panel because of logging */ }
};
