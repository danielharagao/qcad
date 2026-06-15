; Inno Setup script for QCAD Architect Copilot (Windows).
; Build with: ISCC.exe installer.iss  (Inno Setup 6)
; Expects the deploy folder at ..\..\..\dist\win-stage (built by build_windows.ps1).

#define MyAppName "QCAD Architect Copilot"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Architect Copilot"
#define MyAppExeName "qcad.exe"

[Setup]
AppId={{B7E4B1C2-9C3A-4E2F-9A77-QCADCOPILOT01}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\QCAD Architect Copilot
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\..\..\dist
OutputBaseFilename=qcad-architect-copilot-windows-x86_64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "..\..\..\dist\win-stage\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Uninstall {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
