<#
  Stage the Windows package: everything the installer ships, laid out as it will be under C:\Program Files\Epilykos.

    stage\app\       Epilykos (production dependencies only)
    stage\node\      node.exe (the runner's own Node, so native modules match)
    stage\python\    embeddable Python with the Bluetooth and Tuya libraries
    stage\tools\     cloudflared.exe
    stage\service\   the service wrapper (WinSW) and its config

  Run from the repository root:  powershell -File packaging\windows\stage.ps1 -Version 1.2.3
#>
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Out = 'dist\stage',
  [string]$PythonVersion = '3.12.8',
  [string]$WinSWVersion = 'v2.12.0'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = (Get-Location).Path
$stage = Join-Path $root $Out
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

function Download($url, $file) {
  Write-Host "Downloading $url"
  Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
}

# ── app ───────────────────────────────────────────────────────────────────
$app = Join-Path $stage 'app'
New-Item -ItemType Directory -Force -Path $app | Out-Null
$skip = @('.git', '.github', 'node_modules', 'data', 'logs', 'test', 'plans', 'dist', 'packaging', 'docker', '.claude')
Get-ChildItem -Force $root | Where-Object { $skip -notcontains $_.Name -and $_.Name -notmatch '^(Dockerfile|docker-compose\.ya?ml|\.env.*|\.dockerignore|\.gitignore|\.gitattributes)$' } |
  ForEach-Object { Copy-Item -Recurse -Force $_.FullName (Join-Path $app $_.Name) }
Push-Location $app
# --ignore-scripts: better-sqlite3 and serialport ship ready-made Windows binaries; node-gyp is not needed (and fails on the runner).
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
Pop-Location
# The version the app (and its update check) reports comes from the service environment; keep package.json in step too.
$pkg = Get-Content (Join-Path $app 'package.json') -Raw | ConvertFrom-Json
$pkg.version = ($Version -replace '^v', '' -replace '[-+].*$', '')
$pkg | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $app 'package.json') -Encoding utf8

# ── node ──────────────────────────────────────────────────────────────────
$node = Join-Path $stage 'node'
New-Item -ItemType Directory -Force -Path $node | Out-Null
Copy-Item (Get-Command node).Source (Join-Path $node 'node.exe')
Copy-Item (Join-Path (Split-Path (Get-Command node).Source) 'LICENSE') (Join-Path $node 'LICENSE') -ErrorAction SilentlyContinue

# ── python (embeddable) + libraries ───────────────────────────────────────
$py = Join-Path $stage 'python'
$zip = Join-Path $env:TEMP 'python-embed.zip'
Download "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" $zip
Expand-Archive -Path $zip -DestinationPath $py -Force
$minor = ($PythonVersion -split '\.')[0..1] -join ''
$pth = Join-Path $py "python$minor._pth"
@("python$minor.zip", '.', 'Lib\site-packages', '', 'import site') | Set-Content $pth -Encoding ascii
$site = Join-Path $py 'Lib\site-packages'
New-Item -ItemType Directory -Force -Path $site | Out-Null
$reqs = Join-Path $env:TEMP 'python-requirements.txt'
(Get-Content (Join-Path $root 'modules\ble\requirements.txt')) + 'tinytuya' + 'tuya-device-sharing-sdk' + 'qrcode[pil]' | Set-Content $reqs -Encoding ascii
python -m pip install --disable-pip-version-check --no-warn-script-location --only-binary=:all: --platform win_amd64 --python-version $minor --implementation cp --target $site -r $reqs
if ($LASTEXITCODE -ne 0) { throw 'pip install failed' }

# ── cloudflared ───────────────────────────────────────────────────────────
$tools = Join-Path $stage 'tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
Download 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' (Join-Path $tools 'cloudflared.exe')

# ── service wrapper ───────────────────────────────────────────────────────
$svc = Join-Path $stage 'service'
New-Item -ItemType Directory -Force -Path $svc | Out-Null
Download "https://github.com/winsw/winsw/releases/download/$WinSWVersion/WinSW-x64.exe" (Join-Path $svc 'EpilykosService.exe')
$xml = Get-Content (Join-Path $PSScriptRoot 'EpilykosService.xml') -Raw
$xml.Replace('@VERSION@', ($Version -replace '^v', '')) | Set-Content (Join-Path $svc 'EpilykosService.xml') -Encoding utf8

Copy-Item (Join-Path $root 'LICENSE') (Join-Path $stage 'LICENSE.txt')
Write-Host "Staged $Version in $stage"
Get-ChildItem $stage | Format-Table Name
