#!/usr/bin/env python3
"""Extract QCAD-native agent tools from the repository.

This intentionally mirrors QCAD surfaces instead of inventing semantic wrappers.
The generated catalog is built from:
- qcad.1 command-line switches;
- scripts/**/*Init.js action registrations;
- scripts/**/*.js executable script files.
"""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "agent" / "qcad-tools" / "generated" / "qcad-tools.json"


CLI_OPTIONS = [
    {
        "tool": "qcad -help",
        "kind": "cli-option",
        "argv": ["-help"],
        "source": "qcad.1",
        "description": "Displays QCAD help.",
    },
    {
        "tool": "qcad -version",
        "kind": "cli-option",
        "argv": ["-version"],
        "source": "qcad.1",
        "description": "Displays QCAD version.",
    },
    {
        "tool": "qcad -config <path>",
        "kind": "cli-option",
        "argv": ["-config", "<path>"],
        "source": "qcad.1",
        "description": "Reads and stores settings to QCAD3.ini at the given path.",
    },
    {
        "tool": "qcad -locale <locale>",
        "kind": "cli-option",
        "argv": ["-locale", "<locale>"],
        "source": "qcad.1",
        "description": "Sets the locale used by QCAD.",
    },
    {
        "tool": "qcad -filter <filter>",
        "kind": "cli-option",
        "argv": ["-filter", "<filter>"],
        "source": "qcad.1",
        "description": "Opens following files with the explicitly given import filter.",
    },
    {
        "tool": "qcad -allow-multiple-instances",
        "kind": "cli-option",
        "argv": ["-allow-multiple-instances"],
        "source": "qcad.1",
        "description": "Allows multiple QCAD instances.",
    },
    {
        "tool": "qcad -app-id <ID>",
        "kind": "cli-option",
        "argv": ["-app-id", "<ID>"],
        "source": "qcad.1",
        "description": "Sets the QCAD application ID.",
    },
    {
        "tool": "qcad -rescan",
        "kind": "cli-option",
        "argv": ["-rescan"],
        "source": "qcad.1",
        "description": "Rescans scripts folder for new add-ons.",
    },
    {
        "tool": "qcad -always-load-scripts",
        "kind": "cli-option",
        "argv": ["-always-load-scripts"],
        "source": "qcad.1",
        "description": "Forces reloading of scripts when they are used.",
    },
    {
        "tool": "qcad -enable-script-debugger",
        "kind": "cli-option",
        "argv": ["-enable-script-debugger"],
        "source": "qcad.1",
        "description": "Enables the script debugger.",
    },
    {
        "tool": "qcad -debug-action-order",
        "kind": "cli-option",
        "argv": ["-debug-action-order"],
        "source": "qcad.1",
        "description": "Prints action order information in menus.",
    },
    {
        "tool": "qcad -autostart <script-file>",
        "kind": "cli-entrypoint",
        "argv": ["-autostart", "<script-file>"],
        "source": "qcad.1",
        "description": "Starts the given script file instead of scripts/autostart.js.",
    },
    {
        "tool": "qcad -exec <script-file> [options]",
        "kind": "cli-entrypoint",
        "argv": ["-exec", "<script-file>", "[options]"],
        "source": "qcad.1",
        "description": "Executes the given script file directly after starting QCAD.",
    },
    {
        "tool": "qcad -gui-css-file <CSS-file>",
        "kind": "cli-option",
        "argv": ["-gui-css-file", "<CSS-file>"],
        "source": "qcad.1",
        "description": "Loads the specified CSS file.",
    },
    {
        "tool": "qcad -no-gui",
        "kind": "cli-option",
        "argv": ["-no-gui"],
        "source": "qcad.1",
        "description": "Runs without GUI / without X11 connection.",
    },
    {
        "tool": "qcad -no-show",
        "kind": "cli-option",
        "argv": ["-no-show"],
        "source": "qcad.1",
        "description": "Uses GUI but does not display it.",
    },
    {
        "tool": "qcad -enable-xdata",
        "kind": "cli-option",
        "argv": ["-enable-xdata"],
        "source": "qcad.1",
        "description": "Enables XData custom properties.",
    },
    {
        "tool": "qcad -quit",
        "kind": "cli-option",
        "argv": ["-quit"],
        "source": "qcad.1",
        "description": "Quits QCAD after executing the given script(s).",
    },
]


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def extract_action_label(text: str) -> str | None:
    match = re.search(r"new\s+RGuiAction\s*\((.*?)\)\s*;", text, flags=re.S)
    if not match:
        return None
    expr = " ".join(match.group(1).split())
    simple = re.search(r'qsTranslate\("[^"]+",\s*"([^"]+)"\)', expr)
    if simple:
        return simple.group(1).replace("&", "")
    simple = re.search(r'qsTr\("([^"]+)"\)', expr)
    if simple:
        return simple.group(1).replace("&", "")
    simple = re.search(r'"([^"]+)"', expr)
    if simple:
        return simple.group(1).replace("&", "")
    return expr[:120]


def extract_default_commands(text: str) -> list[str]:
    commands: list[str] = []
    for match in re.finditer(r"\.setDefaultCommands\s*\(\s*\[(.*?)\]\s*\)", text, flags=re.S):
        commands.extend(re.findall(r'"([^"]+)"|\'([^\']+)\'', match.group(1)))
    flattened: list[str] = []
    for item in commands:
        value = item[0] or item[1]
        if value:
            flattened.append(value)
    return flattened


def action_script_from_init(init_file: Path) -> str | None:
    name = init_file.name.removesuffix("Init.js")
    candidate = init_file.with_name(f"{name}.js")
    if candidate.exists():
        return rel(candidate)
    return None


def extract_actions() -> list[dict]:
    actions = []
    for init_file in sorted((ROOT / "scripts").rglob("*Init.js")):
        text = init_file.read_text(encoding="utf-8", errors="ignore")
        action_script = action_script_from_init(init_file)
        actions.append(
            {
                "tool": action_script or rel(init_file),
                "kind": "qcad-action-script",
                "scriptFile": action_script,
                "initFile": rel(init_file),
                "label": extract_action_label(text),
                "defaultCommands": extract_default_commands(text),
                "qcadApi": "RGuiAction",
            }
        )
    return actions


def extract_exec_scripts(action_script_set: set[str]) -> list[dict]:
    scripts = []
    for script_file in sorted((ROOT / "scripts").rglob("*.js")):
        script = rel(script_file)
        if script.endswith("Init.js"):
            continue
        if script in action_script_set:
            continue
        scripts.append(
            {
                "tool": script,
                "kind": "qcad-script",
                "scriptFile": script,
                "entrypoint": "qcad -exec <script-file> [options]",
            }
        )
    return scripts


def main() -> None:
    actions = extract_actions()
    action_scripts = {item["scriptFile"] for item in actions if item.get("scriptFile")}
    catalog = {
        "schema": "architect-copilot.qcad-tools.v1",
        "sourceRepo": "https://github.com/danielharagao/qcad",
        "sourceCommit": "bb17c6ff00ed4e62ba7a382cfffe0aef4d8fc9de",
        "principle": "Expose QCAD-native CLI/script/action surfaces; do not rename them into semantic wrappers.",
        "cli": CLI_OPTIONS,
        "actions": actions,
        "scripts": extract_exec_scripts(action_scripts),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)}")
    print(f"cli={len(catalog['cli'])} actions={len(catalog['actions'])} scripts={len(catalog['scripts'])}")


if __name__ == "__main__":
    main()
