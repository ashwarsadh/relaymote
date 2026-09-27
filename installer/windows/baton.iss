; baton.iss - Inno Setup 6 script for Relaymote. Build with installer\windows\build.ps1, which stages the
; app, the production node_modules and a verified portable node.exe, then calls:
;   ISCC /DAppVersion=<x.y.z> /DSourceDir=<stage> /DOutputDir=<dist> baton.iss
; This file must stay UTF-8 WITH a BOM: Inno reads a BOM-less script as ANSI and mangles the dashes.
;
; Per-user install, no admin prompt. The data folder (~\.baton) is never touched by install or
; uninstall.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\..\dist\build\win\Relaymote"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\dist"
#endif

[Setup]
AppId={{0762B4E7-45DD-40C5-B58F-E0456E54DC08}
AppName=Relaymote
AppVersion={#AppVersion}
AppVerName=Relaymote {#AppVersion}
AppPublisher=Relaymote contributors
AppPublisherURL=https://github.com/ashwarsadh/relaymote
AppSupportURL=https://github.com/ashwarsadh/relaymote/issues
AppUpdatesURL=https://github.com/ashwarsadh/relaymote/releases
AppComments=Your Claude Code sessions, in your pocket.
VersionInfoVersion={#AppVersion}
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\Baton
DefaultGroupName=Relaymote
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=Relaymote-Setup-{#AppVersion}-x64
SetupIconFile=baton.ico
UninstallDisplayIcon={app}\baton.ico
UninstallDisplayName=Relaymote
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
ChangesEnvironment=yes
CloseApplications=no
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "addtopath"; Description: "Add ""baton"" to my PATH, so it works in any terminal"; GroupDescription: "Command line:"

[InstallDelete]
; An upgrade replaces the app folders wholesale, so files dropped from a release do not linger.
Type: filesandordirs; Name: "{app}\bin"
Type: filesandordirs; Name: "{app}\lib"
Type: filesandordirs; Name: "{app}\mcp"
Type: filesandordirs; Name: "{app}\mobile"
Type: filesandordirs; Name: "{app}\scripts"
Type: filesandordirs; Name: "{app}\hooks"
Type: filesandordirs; Name: "{app}\assets"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\node_modules"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Relaymote"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\scripts\run-hidden.vbs"" ""{app}\runtime\node.exe"" ""{app}\bin\baton.js"" open"; WorkingDir: "{app}"; IconFilename: "{app}\baton.ico"; Comment: "Open Relaymote (starts it in the background if needed)"
Name: "{group}\Relaymote — Pair a phone"; Filename: "{app}\baton-pair.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\baton.ico"; Comment: "Show the QR code that signs your phone in"
Name: "{group}\Relaymote — Status"; Filename: "{app}\baton-status.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\baton.ico"; Comment: "Check that Claude Desktop, the debugger and Relaymote are working"

[Run]
; Finish page. Autostart runs first so that setup (told --no-autostart) does not override an unticked box.
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\bin\baton.js"" autostart"; Description: "Start Relaymote when I sign in"; Flags: postinstall skipifsilent runhidden waituntilterminated
Filename: "{app}\baton-setup.cmd"; Parameters: "--no-autostart"; WorkingDir: "{app}"; Description: "Run first-time setup (turns on Claude Desktop's Developer Mode and debugger, registers the tools, opens Relaymote)"; Flags: postinstall skipifsilent shellexec nowait

[Code]
const
  EnvKey = 'Environment';

function DirInPath(const Paths, Dir: String): Boolean;
begin
  Result := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Paths) + ';') > 0;
end;

procedure AddToPath(const Dir: String);
var
  Paths: String;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Paths) then Paths := '';
  if DirInPath(Paths, Dir) then Exit;
  if (Paths <> '') and (Copy(Paths, Length(Paths), 1) <> ';') then Paths := Paths + ';';
  RegWriteExpandStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Paths + Dir);
end;

procedure RemoveFromPath(const Dir: String);
var
  Paths: String;
  P: Integer;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Paths) then Exit;
  Paths := ';' + Paths + ';';
  P := Pos(';' + Uppercase(Dir) + ';', Uppercase(Paths));
  if P = 0 then Exit;
  Delete(Paths, P, Length(Dir) + 1);
  if Copy(Paths, 1, 1) = ';' then Delete(Paths, 1, 1);
  if Copy(Paths, Length(Paths), 1) = ';' then Delete(Paths, Length(Paths), 1);
  RegWriteExpandStringValue(HKEY_CURRENT_USER, EnvKey, 'Path', Paths);
end;

// Stops the tray and daemon running from {app} (an upgrade must replace node.exe); with
// -Unregister it also removes autostart and the Claude Code MCP registration.
procedure StopBaton(const Extra: String);
var
  Script: String;
  Rc: Integer;
begin
  Script := ExpandConstant('{app}\stop-baton.ps1');
  if FileExists(Script) then
    Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoProfile -ExecutionPolicy Bypass -File "' + Script + '" ' + Extra, '', SW_HIDE, ewWaitUntilTerminated, Rc);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then StopBaton('');
  if (CurStep = ssPostInstall) and WizardIsTaskSelected('addtopath') then AddToPath(ExpandConstant('{app}'));
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Data: String;
begin
  if CurUninstallStep = usUninstall then StopBaton('-Unregister');
  if CurUninstallStep = usPostUninstall then
  begin
    RemoveFromPath(ExpandConstant('{app}'));
    Data := GetEnv('BATON_HOME');
    if Data = '' then Data := GetEnv('USERPROFILE') + '\.baton';
    Log('Relaymote data folder left in place: ' + Data);
    if (not UninstallSilent) and DirExists(Data) then
      MsgBox('Relaymote was removed. Your settings, pairing key and history were kept in:' + #13#10 + #13#10 + Data + #13#10 + #13#10 +
        'Delete that folder yourself if you no longer need it.', mbInformation, MB_OK);
  end;
end;
