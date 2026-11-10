@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem Flow uses goto, not ( ) blocks, so folder names with spaces are safe.
cd /d "%~dp0"
title Narrative Engine - Play with Claude

echo.
echo   ==============================================
echo     Narrative Engine  x  Claude as your GM
echo   ==============================================
echo.

rem ---- 1. Is this the real folder? (Running from inside a .zip lands in a temp copy.)
if not exist "server.js" goto :notunzipped
if not exist "package.json" goto :notunzipped
if not exist "server\mcp\index.js" goto :notunzipped

rem ---- 2. Node.js, new enough
where node >nul 2>nul
if errorlevel 1 goto :nonode
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>20||(a===20&&b>=19)?0:1)"
if errorlevel 1 goto :oldnode
where npm >nul 2>nul
if errorlevel 1 goto :nonpm

rem npm cannot run install scripts from a path containing & ( ) ^ ! or a percent sign
rem (spaces are fine). The check lives in a script so this file needs no tricky quoting.
node scripts\play-preflight.mjs --path
if errorlevel 1 goto :badpath

rem ---- 3. Install on first run; repair if a Node.js upgrade broke the install
if not exist "node_modules\@modelcontextprotocol\sdk\package.json" goto :install
if not exist "node_modules\express\package.json" goto :install
goto :depscheck

:install
echo   First run: installing. This takes a few minutes and needs the internet...
echo.
call npm install
if errorlevel 1 goto :installfail

:depscheck
node scripts\play-preflight.mjs --deps
if not errorlevel 10 goto :depsok
if errorlevel 11 goto :rebuild
echo   Finishing the install...
call npm install
if errorlevel 1 goto :installfail
goto :depsrecheck

:rebuild
echo   Node.js changed since the install. Rebuilding for this version...
call npm rebuild better-sqlite3
if errorlevel 1 goto :installfail

:depsrecheck
node scripts\play-preflight.mjs --deps
if errorlevel 10 goto :installfail

:depsok
if exist "packages\engine\dist\index.js" goto :enginebuilt
echo   Building the engine...
call npm run build --prefix packages/engine
if errorlevel 1 goto :installfail

:enginebuilt
rem ---- 4. Claude Desktop extension (also records this folder, so a moved folder keeps working)
rem Older versions added a config-file entry; the desktop extension replaces it.
node scripts\install-claude-gm.mjs --remove-legacy
set "LEGACY=%errorlevel%"
if "%LEGACY%"=="1" goto :fail

echo   Building the Claude Desktop extension...
node scripts\build-mcpb.mjs
if errorlevel 1 goto :fail

rem ---- 5. Start what is not running yet
if not exist "server\mcp\.cache" mkdir "server\mcp\.cache"
node scripts\play-preflight.mjs
set "STATE=%errorlevel%"
if "%STATE%"=="1" goto :blocked
if "%STATE%"=="0" goto :started
if "%STATE%"=="20" start "Narrative Engine (close this window to stop it)" /min cmd /c "npm run dev > server\mcp\.cache\dev.log 2>&1"
if "%STATE%"=="21" start "Narrative Engine display (close this window to stop it)" /min cmd /c "node node_modules\vite\bin\vite.js > server\mcp\.cache\dev.log 2>&1"
if "%STATE%"=="22" start "Narrative Engine (close this window to stop it)" /min cmd /c "node server.js > server\mcp\.cache\dev.log 2>&1"
if "%STATE%"=="23" start "Narrative Engine (close this window to stop it)" /min cmd /c "node server.js > server\mcp\.cache\dev.log 2>&1"

node scripts\play-preflight.mjs --wait %STATE%
set "WAITED=%errorlevel%"
if "%WAITED%"=="2" goto :startfail
rem 3 = the engine is up but the live display is not: carry on without the browser page.
if "%WAITED%"=="3" set "STATE=23"

:started
if "%LEGACY%"=="10" echo   An old Narrative Engine entry was removed from Claude Desktop's config. Quit Claude Desktop fully (tray icon, Quit) and open it again.

node scripts\install-claude-gm.mjs --check-extension
set "NEED_INSTALL=%errorlevel%"

rem NE_NO_OPEN (automated tests) skips opening windows; NE_UI_PORT moves a test copy off 5173.
set "UIPORT=5173"
if defined NE_UI_PORT set "UIPORT=%NE_UI_PORT%"
if defined NE_NO_OPEN goto :report
if "%NEED_INSTALL%"=="3" explorer /select,"%~dp0NarrativeEngine.mcpb"
if not "%STATE%"=="23" start "" "http://localhost:%UIPORT%/launcher.html"

:report
echo.
if not "%NEED_INSTALL%"=="3" goto :installed
echo   ONE-TIME SETUP in Claude Desktop:
echo     Settings ^> Desktop app ^> Manage ^(next to Extensions^)
echo     ^> Advanced settings ^> Extension Developer ^> Install Extension...
echo     and pick NarrativeEngine.mcpb ^(highlighted in the folder window that opened^).
echo     Or drag that file onto the Claude Desktop window. Then click Install.
echo     ^(Already installed it? Then skip this.^)
goto :howto

:installed
echo   The Narrative Engine extension is already installed in Claude Desktop.

:howto
echo.
echo   Now start a new chat in Claude Desktop and type:
echo.
echo       Let's play Narrative Engine
echo.
echo   ^(Allow the narrative-engine tools when Claude asks.^)
echo   The browser page shows your campaign live while you play.
echo   To stop Narrative Engine, close its minimized window in the taskbar.
echo.
echo   If something fails, the logs are in server\mcp\.cache ^(mcp.log, engine.log, dev.log^).
echo.
pause
exit /b 0

:notunzipped
echo   This file has to run from inside the Narrative Engine folder.
echo.
echo   If you opened it from a .zip: right-click the .zip, choose "Extract All...",
echo   open the extracted folder, and double-click Play_With_Claude.bat there.
echo.
pause
exit /b 1

:nonode
echo   Node.js is not installed. Opening the download page...
echo.
echo   Install the LTS version ^(keep the default options^), then double-click this file again.
if not defined NE_NO_OPEN start "" "https://nodejs.org/"
echo.
pause
exit /b 1

:oldnode
echo   Your Node.js is too old for Narrative Engine. Installed version:
node -v
echo   Needed: 20.19 or newer. Opening the download page...
echo.
echo   Install the LTS version over the old one, then double-click this file again.
if not defined NE_NO_OPEN start "" "https://nodejs.org/"
echo.
pause
exit /b 1

:nonpm
echo   Node.js is installed, but npm ^(which comes with it^) was not found.
echo   Reinstall Node.js LTS from https://nodejs.org with the default options,
echo   then double-click this file again.
echo.
pause
exit /b 1

:badpath
echo   The installer cannot work from this folder, because the folder's location
echo   contains one of these characters:   ^&   ^(   ^)   ^^   !   %%
echo.
echo   Rename the folder, or move it somewhere simple such as C:\Games\NarrativeEngine,
echo   then double-click Play_With_Claude.bat there. ^(Spaces in the name are fine.^)
echo.
pause
exit /b 1

:installfail
echo.
echo   The install did not finish. The error is in the lines above.
echo   Most common causes:
echo     - No internet connection, or a firewall or antivirus blocking npm. Check and try again.
echo     - The folder is inside OneDrive or is read-only. Move it somewhere like C:\Games and try again.
echo   If it keeps failing, run Repair_Narrative_Engine.bat ^(it reinstalls from scratch^).
echo.
pause
exit /b 1

:blocked
echo.
echo   Narrative Engine was not started. Do what the lines above say, then double-click this file again.
echo.
pause
exit /b 1

:startfail
echo.
echo   Try again. If it still fails, run Repair_Narrative_Engine.bat, or send the file
echo   server\mcp\.cache\dev.log to whoever is helping you.
echo.
pause
exit /b 1

:fail
echo.
echo   Something went wrong. The error is in the lines above.
echo   If it is not clear what to do, run Repair_Narrative_Engine.bat.
echo.
pause
exit /b 1
