# QCAD Agent Tools

This is the first tool surface for the Architect Copilot.

The rule is intentional: expose QCAD as QCAD, not as invented architecture wrappers.

## Principle

- Tool names and entrypoints mirror QCAD-native surfaces.
- The agent connector may connect an agent call to QCAD, but it should not rename QCAD primitives into product concepts.
- Architecture concepts such as wall, room, door, window, zoning, code checks, or layout intent belong in a higher planning layer.
- This layer only exposes QCAD CLI, script files, and action scripts.

## Generated Catalog

Run:

```bash
python3 agent/qcad-tools/extract_qcad_tools.py
```

Generated file:

```text
agent/qcad-tools/generated/qcad-tools.json
```

Current catalog:

- `18` QCAD CLI options / entrypoints from `qcad.1`
- `270` QCAD action scripts from `scripts/**/*Init.js`
- `542` additional QCAD scripts from `scripts/**/*.js`

## Native QCAD Entrypoints

From `qcad.1`:

```text
qcad [options] [files]
qcad -exec <script-file> [options]
qcad -autostart <script-file>
qcad -no-gui
qcad -no-show
qcad -quit
qcad -rescan
qcad -always-load-scripts
```

The connector exposes these as:

```text
qcad.catalog
qcad.argv
qcad -exec <script-file> [options]
qcad -autostart <script-file>
```

The two `qcad -exec` / `qcad -autostart` calls require `scriptFile` to exist in the generated catalog.

## Examples

List catalog:

```bash
echo '{"call":"qcad.catalog"}' \
  | python3 agent/qcad-tools/qcad_agent_connector.py --pretty
```

Run exact QCAD argv:

```bash
echo '{"call":"qcad.argv","argv":["-help"],"timeout":30}' \
  | python3 agent/qcad-tools/qcad_agent_connector.py --pretty
```

Run an exact QCAD script through `-exec`:

```bash
echo '{
  "call": "qcad -exec <script-file> [options]",
  "scriptFile": "scripts/Draw/Line/Line2P/Line2P.js",
  "options": [],
  "noGui": true,
  "quit": true,
  "timeout": 120
}' | python3 agent/qcad-tools/qcad_agent_connector.py --pretty
```

## First Architect Copilot Tool Set

Use the catalog directly. For the first agent prompt, prefer these native QCAD families:

```text
scripts/Draw/Line/*
scripts/Draw/Polyline/*
scripts/Draw/Shape/*
scripts/Draw/Dimension/*
scripts/Draw/Text/*
scripts/Modify/*
scripts/Layer/*
scripts/Select/*
scripts/File/*
scripts/Misc/MiscIO/*
```

The agent should select exact `scriptFile` values from `generated/qcad-tools.json`.

## What Not To Do Here

Do not add tools named:

```text
drawWall
drawDoor
drawWindow
makeFloorPlan
inspectBuildingCode
```

Those can exist later as planner skills that compile intent into exact QCAD calls.
They do not belong in this connector.
