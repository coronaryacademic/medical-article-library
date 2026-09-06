@echo off
setlocal
cd /d "%~dp0"

set "PORT=8088"
set "URL=http://localhost:%PORT%"

echo =======================================================
echo   UW Medical Article Library
echo =======================================================

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js was not found.
    echo Install the Node.js LTS version and run this file again.
    pause
    exit /b 1
)

if not exist "node_modules\express" (
    echo Installing dependencies for the first run...
    call npm.cmd install
    if errorlevel 1 (
        echo Dependency installation failed.
        pause
        exit /b 1
    )
)

start "" "%URL%"
echo Starting server at %URL%
echo Keep this window open while using the library.
echo Press Ctrl+C to stop the server.
node server.js

endlocal