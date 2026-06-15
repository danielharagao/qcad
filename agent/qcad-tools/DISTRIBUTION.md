# QCAD Architect Copilot — Distribution

## The DMG

`dist/qcad-architect-copilot-macos-x86_64.dmg` is a self-contained, drag-to-install
package containing `QCAD.app` (x86_64, runs natively on Intel and under Rosetta on
Apple Silicon) with:

- All Qt 5.15 frameworks bundled
- QCAD plugins, scripts, fonts, patterns, linetypes
- The **Architect Copilot** addon (`Contents/Resources/scripts/Tools/ArchitectCopilot/`)

## Rebuilding the DMG

From a known-good, fully-bundled app (the reliable path):

```bash
agent/qcad-tools/package_dmg.sh [/path/to/QCAD.app]   # default: /Applications/QCAD.app
```

This refreshes the addon from the repo, strips dev cruft, ad-hoc re-signs, adds the
`/Applications` symlink, creates the DMG and verifies it (`hdiutil verify` + SHA256).

From source: `agent/qcad-tools/build_macos_local.sh` (heavier; the local source build
may need extra dylib/resource bundling — prefer `package_dmg.sh` for releases).

## Install (end user)

1. Open the DMG, drag **QCAD.app** to **Applications**.
2. The app is **ad-hoc signed**, so Gatekeeper will block it on first launch on
   another Mac. To allow it: **right-click → Open** (once), or:
   ```bash
   xattr -dr com.apple.quarantine /Applications/QCAD.app
   ```
   (Proper distribution would require signing with an Apple Developer ID + notarization.)

## Runtime prerequisites for the AI features

The CAD app works on its own. The Architect Copilot panel needs:

- **python3** on PATH (macOS ships one, or Homebrew). On first use the panel
  auto-creates a venv at `~/.qcad-agent/mcp-venv` and installs `mcp`, `ezdxf`,
  `shapely` (needs internet once). You can also trigger it via the **Setup MCP** button.
- **An AI backend**, one of:
  - **API mode** — an Anthropic API key (paste via the **API key** button).
  - **Claude Code mode** — the `claude` CLI installed and logged in (uses the
    macOS keychain; no key to paste). Toggle with the **Mode** button.

## First run

Open Tools → Architect Copilot. The panel auto-bootstraps the MCP venv, then you can
type natural-language requests (e.g. "desenha um apto de 2 quartos"). The agent draws,
views its own work, and self-corrects.

## Windows installer (via GitHub Actions)

The Windows build can't be produced on macOS, so it's built in CI:

- Workflow: `.github/workflows/build-windows-installer.yml` (run manually via the
  Actions tab → "Build Windows Installer" → Run workflow).
- It installs Qt 5.15.2 + QtScript + MSVC, runs `agent/qcad-tools/windows/build_windows.ps1`
  (qmake/nmake build → `windeployqt` → stages `dist/win-stage` with the addon and
  QCAD resources), then builds an **Inno Setup** installer
  (`agent/qcad-tools/windows/installer.iss`).
- Output artifact: `qcad-architect-copilot-windows-x86_64-setup.exe` + SHA256.

The same cross-platform addon ships on Windows. Runtime prerequisites there:
**Python 3** on PATH (panel auto-creates `%USERPROFILE%\.qcad-agent\mcp-venv` on first
use) and an AI backend (Anthropic API key, or the `claude` CLI logged in). The MCP
bridge bootstrap is now `setup_mcp.py` (cross-platform), replacing the macOS-only
`setup_mcp.sh`.

> The Windows build scripts are a first cut; QCAD's Windows build has its own quirks,
> so the first CI runs may need small fixes (exe path discovery, resource layout).
> Iterate from the Actions logs.

## Notes / limitations

- Credentials (API key / OAuth token) are stored in QCAD's settings plist in plain
  text. Claude Code mode avoids storing a key (uses the CLI keychain login).
- The local TCP bridge (127.0.0.1:54321) has no auth — any local process could drive
  the panel while it is open. Fine for single-user desktop use; add a shared secret
  before multi-user/untrusted environments.
