; Epilykos for Windows: installs the app, its own Node and Python, and runs it as the "Epilykos" service.
; Build:  iscc /DAppVersion=1.2.3 /DStageDir=..\..\dist\stage /O..\..\dist packaging\windows\epilykos.iss
; Data (database, keys, backups) lives in %ProgramData%\Epilykos and is never removed by an update or an uninstall.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef VersionNumeric
  #define VersionNumeric "0.0.0.0"
#endif
#ifndef StageDir
  #define StageDir "..\..\dist\stage"
#endif

[Setup]
AppId={{6D1B1E52-6F0C-4C0B-9C35-3B2E4B1A7E01}
AppName=Epilykos
AppVersion={#AppVersion}
AppPublisher=Epilykos
AppPublisherURL=https://github.com/ashipaek0/epilykos
AppSupportURL=https://epilykos.ashipaek0.com.ng/
DefaultDirName={autopf}\Epilykos
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=Epilykos-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
LicenseFile={#StageDir}\LICENSE.txt
CloseApplications=no
SetupLogging=yes
UninstallDisplayName=Epilykos
VersionInfoVersion={#VersionNumeric}

[Tasks]
Name: "firewall"; Description: "Let other devices on my home network open the dashboard (Windows Firewall, private networks only)"; GroupDescription: "Network:"
Name: "tailscale"; Description: "Install Tailscale for remote access (needs Windows Package Manager)"; GroupDescription: "Network:"; Flags: unchecked

[Dirs]
Name: "{commonappdata}\Epilykos"; Permissions: admins-full system-full
Name: "{commonappdata}\Epilykos\data"; Permissions: admins-full system-full
Name: "{commonappdata}\Epilykos\logs"; Permissions: admins-full system-full
Name: "{commonappdata}\Epilykos\service-logs"; Permissions: admins-full system-full

[InstallDelete]
; An update replaces the program folders whole, so files a newer version dropped do not linger. Never data or logs.
Type: filesandordirs; Name: "{app}\app\node_modules"
Type: filesandordirs; Name: "{app}\app\modules"
Type: filesandordirs; Name: "{app}\app\routes"
Type: filesandordirs; Name: "{app}\app\services"
Type: filesandordirs; Name: "{app}\app\public"
Type: filesandordirs; Name: "{app}\app\private"
Type: filesandordirs; Name: "{app}\app\profiles"
Type: filesandordirs; Name: "{app}\python"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\Epilykos dashboard"; Filename: "http://localhost:3000/"

[Run]
; The app's data and logs folders are shortcuts (junctions) into %ProgramData%, so the program folder can be replaced freely.
Filename: "{cmd}"; Parameters: "/C if not exist ""{app}\app\data"" mklink /J ""{app}\app\data"" ""{commonappdata}\Epilykos\data"""; Flags: runhidden; StatusMsg: "Linking the data folder..."
Filename: "{cmd}"; Parameters: "/C if not exist ""{app}\app\logs"" mklink /J ""{app}\app\logs"" ""{commonappdata}\Epilykos\logs"""; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Epilykos dashboard"""; Flags: runhidden; Tasks: firewall
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Epilykos dashboard"" dir=in action=allow protocol=TCP localport=3000 profile=private program=""{app}\node\node.exe"""; Flags: runhidden; Tasks: firewall; StatusMsg: "Opening the firewall for private networks..."
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""if (Get-Command winget -ErrorAction SilentlyContinue) {{ winget install --id Tailscale.Tailscale -e --silent --accept-package-agreements --accept-source-agreements }"""; Flags: runhidden; Tasks: tailscale; StatusMsg: "Installing Tailscale..."
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /TN EpilykosUpdate /F"; Flags: runhidden
Filename: "{app}\service\EpilykosService.exe"; Parameters: "install"; Flags: runhidden; StatusMsg: "Installing the Epilykos service..."
Filename: "{app}\service\EpilykosService.exe"; Parameters: "start"; Flags: runhidden; StatusMsg: "Starting Epilykos..."
Filename: "http://localhost:3000/"; Description: "Open the Epilykos dashboard"; Flags: shellexec postinstall skipifsilent nowait

[UninstallRun]
Filename: "{app}\service\EpilykosService.exe"; Parameters: "stop"; Flags: runhidden; RunOnceId: "StopService"
Filename: "{app}\service\EpilykosService.exe"; Parameters: "uninstall"; Flags: runhidden; RunOnceId: "RemoveService"
Filename: "{cmd}"; Parameters: "/C rmdir ""{app}\app\data"""; Flags: runhidden; RunOnceId: "UnlinkData"
Filename: "{cmd}"; Parameters: "/C rmdir ""{app}\app\logs"""; Flags: runhidden; RunOnceId: "UnlinkLogs"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Epilykos dashboard"""; Flags: runhidden; RunOnceId: "RemoveFirewall"

[UninstallDelete]
; Only what the program itself creates; the data and logs links are removed (not followed) by the steps above.
Type: filesandordirs; Name: "{app}\python"
Type: filesandordirs; Name: "{app}\app\node_modules"

[Code]
function ServiceExists(): Boolean;
var
  Code: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\sc.exe'), 'query Epilykos', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
end;

{ An update: stop the running service and remove it (it is installed again afterwards with the new settings). }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  Wrapper: String;
begin
  Result := '';
  if ServiceExists() then
  begin
    Wrapper := ExpandConstant('{app}\service\EpilykosService.exe');
    if FileExists(Wrapper) then
    begin
      Exec(Wrapper, 'stop', '', SW_HIDE, ewWaitUntilTerminated, Code);
      Exec(Wrapper, 'uninstall', '', SW_HIDE, ewWaitUntilTerminated, Code);
    end
    else
      Exec(ExpandConstant('{sys}\sc.exe'), 'stop Epilykos', '', SW_HIDE, ewWaitUntilTerminated, Code);
    Sleep(2000);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usDone) and not UninstallSilent then
    MsgBox('Epilykos was removed. Your data (database, keys and backups) is still in ' + ExpandConstant('{commonappdata}\Epilykos') + ' and is kept for a future install. Delete that folder to remove it.', mbInformation, MB_OK);
end;
