# Architect Copilot on QCAD

Goal: use QCAD as the CAD engine and attach an agent to QCAD-native tools.

## Decision

The first integration layer exposes QCAD exactly as it is:

- QCAD CLI options from `qcad.1`
- QCAD action scripts from `scripts/**/*Init.js`
- QCAD script files from `scripts/**/*.js`

No architecture-specific wrappers are created at this layer.

## Current Implementation

Files:

```text
agent/qcad-tools/TOOLS.md
agent/qcad-tools/extract_qcad_tools.py
agent/qcad-tools/qcad_agent_connector.py
agent/qcad-tools/generated/qcad-tools.json
agent/qcad-tools/generated/architect-copilot-seed-tools.json
```

Generated catalog:

```text
18 QCAD CLI options / entrypoints
270 QCAD action scripts
542 QCAD executable scripts
30 seed tools for the first Architect Copilot loop
```

## Agent Contract

The agent should call QCAD-native surfaces through the connector:

```json
{
  "call": "qcad.catalog"
}
```

```json
{
  "call": "qcad -exec <script-file> [options]",
  "scriptFile": "scripts/Draw/Line/Line2P/Line2P.js",
  "options": [],
  "noGui": true,
  "quit": true
}
```

```json
{
  "call": "qcad.argv",
  "argv": ["-help"]
}
```

The connector accepts only `scriptFile` values present in the generated catalog.

## First Seed Tools

Use exact QCAD `scriptFile` values from:

```text
agent/qcad-tools/generated/architect-copilot-seed-tools.json
```

Examples:

```text
scripts/Draw/Line/Line2P/Line2P.js
scripts/Draw/Polyline/DrawPolyline/DrawPolyline.js
scripts/Draw/Shape/ShapeRectanglePP/ShapeRectanglePP.js
scripts/Draw/Shape/ShapeRectangleSize/ShapeRectangleSize.js
scripts/Draw/Dimension/DimAligned/DimAligned.js
scripts/Draw/Text/Text.js
scripts/Layer/AddLayer/AddLayer.js
scripts/Modify/Translate/Translate.js
scripts/Modify/Trim/Trim.js
scripts/File/OpenFile/OpenFile.js
scripts/File/SaveAs/SaveAs.js
```

These are not renamed. The semantic planner can later decide that a "wall" compiles to lines, polylines, layers, offsets, and dimensions.

## Runtime Requirement

The connector needs a QCAD executable:

```bash
export QCAD_BIN=/path/to/qcad
```

If `QCAD_BIN` is not set, it calls `qcad` from `PATH`.

This repo clone does not currently include a built binary. Build is documented in `CLAUDE.md`:

```bash
CMAKE_PREFIX_PATH=/path/to/qt6 cmake -DBUILD_QT6=ON -G Ninja .
ninja -j20
```

## Next Build Step

Before live CAD execution, build or install QCAD and validate:

```bash
echo '{"call":"qcad.argv","argv":["-help"],"timeout":30}' \
  | python3 agent/qcad-tools/qcad_agent_connector.py --pretty
```

Then validate a script call:

```bash
echo '{
  "call": "qcad -exec <script-file> [options]",
  "scriptFile": "scripts/simple_create.js",
  "options": [],
  "noGui": true,
  "quit": true,
  "timeout": 120
}' | python3 agent/qcad-tools/qcad_agent_connector.py --pretty
```

## Higher Layer Later

The next layer can be an Architect Copilot planner that maps:

```text
room layout intent -> exact QCAD scripts/actions/entities
```

But that layer should depend on this catalog instead of bypassing it.
