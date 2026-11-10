@echo off
setlocal
cd /d "%~dp0"
title Narrative Engine - Play with Claude

echo.
echo   ==============================================
echo     Narrative Engine  x  Claude as your GM
echo   ==============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo   Node.js is not installed. Opening the download page...
    echo   Install the LTS version, then double-click this file again.
    start "" "https://nodejs.org/"
    pause
    exit /b 1
)

if not exist "node_modules\@modelcontextprotocol\sdk" (
    echo   First run: installing. This takes a few minutes...
    call npm install
    if errorlevel 1 goto :fail
)

if not exist "packages\engine\dist\index.js" (
    echo   Building the engine...
    call npm run build --prefix packages/engine
    if errorlevel 1 goto :fail
)

echo   Connecting Narrative Engine to Claude Desktop...
node scripts\install-claude-gm.mjs
set INSTALL_RESULT=%errorlevel%
if %INSTALL_RESULT%==1 goto :fail

echo   Starting Narrative Engine (live display window)...
start "Narrative Engine" /min cmd /c "npm run dev"

rem Claude Desktop only reads its config at startup: restart it if we just changed it.
if %INSTALL_RESULT%==10 (
    taskkill /IM claude.exe /F >nul 2>nul
    timeout /t 2 /nobreak >nul
)

set CLAUDE_EXE=%LOCALAPPDATA%\AnthropicClaude\claude.exe
if exist "%CLAUDE_EXE%" (
    start "" "%CLAUDE_EXE%"
) else (
    start "" "claude://" 2>nul
    if errorlevel 1 (
        echo   Claude Desktop was not found. Opening the download page...
        start "" "https://claude.ai/download"
    )
)

timeout /t 6 /nobreak >nul
start "" "http://localhost:5173"

echo.
echo   Ready! In Claude Desktop, start a new chat and type:
echo.
echo       Let's play Narrative Engine
echo.
echo   (Allow the narrative-engine tools when Claude asks.)
echo   The browser window shows your campaign live as you play.
echo   You can close this window.
echo.
pause
exit /b 0

:fail
echo.
echo   Something went wrong. Scroll up for the error, or run Repair_Narrative_Engine.bat.
pause
exit /b 1
