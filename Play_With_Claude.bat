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

rem Older versions added a config-file entry; the desktop extension replaces it.
node scripts\install-claude-gm.mjs --remove-legacy
set LEGACY=%errorlevel%
if %LEGACY%==1 goto :fail

echo   Building the Claude Desktop extension...
node scripts\build-mcpb.mjs
if errorlevel 1 goto :fail

echo   Starting Narrative Engine (live display window)...
start "Narrative Engine" /min cmd /c "npm run dev"

if %LEGACY%==10 (
    taskkill /IM claude.exe /F >nul 2>nul
    timeout /t 2 /nobreak >nul
)

node scripts\install-claude-gm.mjs --check-extension
if errorlevel 3 (
    echo.
    echo   Opening the extension in Claude Desktop: click INSTALL when it asks.
    start "" "%~dp0NarrativeEngine.mcpb"
) else (
    echo   The Narrative Engine extension is already installed in Claude Desktop.
    if exist "%LOCALAPPDATA%\AnthropicClaude\claude.exe" start "" "%LOCALAPPDATA%\AnthropicClaude\claude.exe"
)

timeout /t 6 /nobreak >nul
start "" "http://localhost:5173/launcher.html"

echo.
echo   Ready! In Claude Desktop:
echo     1. If an install screen appeared, click Install.
echo        (No install screen? Drag NarrativeEngine.mcpb from this folder
echo         into the Claude Desktop window.)
echo     2. Start a new chat and type:   Let's play Narrative Engine
echo     3. Allow the narrative-engine tools when Claude asks.
echo.
echo   Check it under Settings ^> Extensions. If something fails, send
echo   server\mcp\.cache\mcp.log to whoever is helping you.
echo.
pause
exit /b 0

:fail
echo.
echo   Something went wrong. Scroll up for the error, or run Repair_Narrative_Engine.bat.
pause
exit /b 1
