# Build QCAD (with the Architect Copilot addon) on Windows and stage a deploy
# folder under dist/win-stage ready for Inno Setup. Run from a shell where qmake
# and an MSVC toolchain (nmake) are on PATH (the CI sets these up).
#
# NOTE: QCAD's Windows build path/quirks can vary; this script searches for the
# built qcad.exe and stages resources explicitly. Expect to iterate via CI logs.
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path "$PSScriptRoot\..\..\..").Path
Set-Location $Root
Write-Host "Repo root: $Root"

# --- Build -----------------------------------------------------------------
qmake -v
qmake CONFIG+=release qcad.pro
# jom is faster if present, else nmake
if (Get-Command jom -ErrorAction SilentlyContinue) { jom } else { nmake }

# --- Locate the built executable -------------------------------------------
$exe = Get-ChildItem -Path $Root -Recurse -Filter qcad.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\debug\\' } | Select-Object -First 1
if (-not $exe) { throw "qcad.exe not found after build" }
$binDir = $exe.Directory.FullName
Write-Host "Built exe: $($exe.FullName)"

# --- Stage deploy folder ----------------------------------------------------
$Stage = Join-Path $Root "dist\win-stage"
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Force $Stage | Out-Null

Copy-Item "$binDir\*.exe" $Stage -Force
Copy-Item "$binDir\*.dll" $Stage -Force -ErrorAction SilentlyContinue
if (Test-Path "$binDir\plugins") { Copy-Item -Recurse "$binDir\plugins" "$Stage\plugins" }

# Bundle Qt runtime DLLs/plugins next to the exe.
windeployqt --release --no-translations --no-system-d3d-compiler "$Stage\qcad.exe"

# QCAD runtime resources (scripts, fonts, patterns, etc.) live next to the exe.
foreach ($d in @("scripts","fonts","patterns","linetypes","libraries","ts")) {
    if (Test-Path "$Root\$d") { Copy-Item -Recurse "$Root\$d" "$Stage\$d" -Force }
}

# Make sure the Architect Copilot addon is present (source of truth = repo).
$addonDst = "$Stage\scripts\Tools\ArchitectCopilot"
New-Item -ItemType Directory -Force $addonDst | Out-Null
Copy-Item "$Root\scripts\Tools\ArchitectCopilot\*" $addonDst -Force
Get-ChildItem -Recurse -Directory -Filter "__pycache__" $Stage | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# Verify the addon files landed.
foreach ($f in @("ArchitectCopilot.js","qcad_plan_lib.py","qcad_run_plan.py","qcad_mcp_server.py","setup_mcp.py")) {
    if (-not (Test-Path "$addonDst\$f")) { throw "Missing addon file in stage: $f" }
}

Write-Host "Staged deploy at: $Stage"
Get-ChildItem $Stage | Select-Object Name | Format-Table -AutoSize
