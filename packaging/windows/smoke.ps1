<#
  Install the built package silently on this machine, check that it runs, then uninstall it.
  Used by the Windows package workflow; also fine to run by hand (as Administrator).
    powershell -File packaging\windows\smoke.ps1 -Installer dist\Epilykos-Setup-1.2.3.exe
#>
param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'
$installDir = Join-Path $env:ProgramFiles 'Epilykos'
$data = Join-Path $env:ProgramData 'Epilykos'
$log = Join-Path $env:TEMP 'epilykos-setup.log'

function Fail($msg) {
  Write-Host "::error::$msg"
  foreach ($f in @($log) + (Get-ChildItem (Join-Path $data 'service-logs') -ErrorAction SilentlyContinue | ForEach-Object FullName)) {
    if (Test-Path $f) { Write-Host "----- $f"; Get-Content $f -Tail 80 }
  }
  exit 1
}

Write-Host '== install'
$p = Start-Process -FilePath $Installer -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TASKS=firewall', "/LOG=$log" -PassThru
if (-not $p.WaitForExit(600000)) { Fail 'the installer did not finish in 10 minutes' }
if ($p.ExitCode -ne 0) { Fail "installer exited $($p.ExitCode)" }

Write-Host '== service'
$svc = Get-Service Epilykos -ErrorAction SilentlyContinue
if (-not $svc) { Fail 'the Epilykos service was not installed' }

Write-Host '== healthz'
$ok = $false
for ($i = 0; $i -lt 60 -and -not $ok; $i++) {
  try { $ok = (Invoke-WebRequest -Uri 'http://127.0.0.1:3000/healthz' -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200 } catch { Start-Sleep -Seconds 3 }
}
if (-not $ok) { Fail 'the dashboard did not answer /healthz within 3 minutes' }
$page = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/' -UseBasicParsing
if ($page.StatusCode -ne 200) { Fail 'the home page did not load' }

Write-Host '== data folder is outside Program Files'
if (-not (Test-Path (Join-Path $data 'data'))) { Fail 'no data folder in ProgramData' }
if (-not (Get-ChildItem (Join-Path $data 'data') -ErrorAction SilentlyContinue)) { Fail 'the database was not written to the ProgramData data folder' }

Write-Host '== bundled python'
$py = Join-Path $installDir 'python\python.exe'
& $py (Join-Path $installDir 'app\modules\ble\ble_helper.py') --self-test
if ($LASTEXITCODE -ne 0) { Fail 'the Bluetooth helper self-test failed' }
& $py -c "import bleak, aiobmsble, tinytuya; print('bleak', bleak.__version__ if hasattr(bleak,'__version__') else 'ok')"
if ($LASTEXITCODE -ne 0) { Fail 'the bundled Python is missing a library' }

Write-Host '== tools'
& (Join-Path $installDir 'tools\cloudflared.exe') --version
if ($LASTEXITCODE -ne 0) { Fail 'cloudflared does not run' }

Write-Host '== uninstall'
$ulog = Join-Path $env:TEMP 'epilykos-uninstall.log'
$u = Start-Process -FilePath (Join-Path $installDir 'unins000.exe') -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=$ulog" -PassThru
if (-not $u.WaitForExit(180000)) {
  Write-Host '----- the uninstaller did not finish in 3 minutes'
  Get-Process | Where-Object { $_.Name -match 'unins|Epilykos|node|python|cloudflared' } | Format-Table Id, Name, StartTime
  if (Test-Path $ulog) { Get-Content $ulog -Tail 60 }
  Get-Process unins* -ErrorAction SilentlyContinue | Stop-Process -Force
  Fail 'the uninstaller hung'
}
if ($u.ExitCode -ne 0) { $log = $ulog; Fail "uninstaller exited $($u.ExitCode)" }
if (Get-Service Epilykos -ErrorAction SilentlyContinue) { Fail 'the service is still installed after uninstalling' }
if (-not (Test-Path (Join-Path $data 'data'))) { Fail 'uninstalling removed the data folder' }
Write-Host 'Windows package smoke test passed'
