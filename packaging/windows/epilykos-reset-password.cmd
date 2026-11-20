@echo off
rem Reset the Epilykos admin password. Run it from the Start menu ("Reset Epilykos admin password").
rem Options: --keep-two-step (leave two-step sign-in on), --no-restart (do not restart the service).
setlocal
set "ROOT=%~dp0"
net session >nul 2>&1
if errorlevel 1 (
  if /i "%~1"=="/elevated" (
    echo This needs administrator rights.
    pause
    exit /b 1
  )
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0' -ArgumentList '/elevated %*'"
  exit /b
)
set "PAUSE_AT_END="
if /i "%~1"=="/elevated" (set "PAUSE_AT_END=1" & shift)
set "ARGS="
set "NORESTART="
:next
if "%~1"=="" goto run
if /i "%~1"=="--no-restart" (set "NORESTART=1") else (set ARGS=%ARGS% %1)
shift
goto next
:run
"%ROOT%node\node.exe" "%ROOT%app\scripts\reset-password.js" --service-xml "%ROOT%service\EpilykosService.xml" %ARGS%
if errorlevel 1 goto end
if defined NORESTART goto end
echo Restarting the Epilykos service...
"%ROOT%service\EpilykosService.exe" restart
if errorlevel 1 (echo Could not restart the service. Restart "Epilykos" in Services.) else (echo Done. Sign in with the new password.)
:end
if defined PAUSE_AT_END pause
endlocal
