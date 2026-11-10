#!/usr/bin/env bash
# Narrative Engine x Claude as your GM — one-click start for macOS (double-click)
# and Linux (run: ./Play_With_Claude.command).
cd "$(dirname "$0")" || exit 1

echo
echo "  =============================================="
echo "    Narrative Engine  x  Claude as your GM"
echo "  =============================================="
echo

open_url() { if command -v open >/dev/null; then open "$1"; else xdg-open "$1" >/dev/null 2>&1 & fi; }
fail() { echo; echo "  Something went wrong: $1"; read -r -p "  Press Enter to close." _; exit 1; }

if ! command -v node >/dev/null; then
  echo "  Node.js is not installed. Opening the download page..."
  echo "  Install the LTS version, then run this again."
  open_url "https://nodejs.org/"
  read -r -p "  Press Enter to close." _
  exit 1
fi

if [ ! -d node_modules/@modelcontextprotocol/sdk ]; then
  echo "  First run: installing. This takes a few minutes..."
  npm install || fail "npm install failed (see above)"
fi

if [ ! -f packages/engine/dist/index.js ]; then
  echo "  Building the engine..."
  npm run build --prefix packages/engine || fail "engine build failed (see above)"
fi

if [ "$(uname)" = "Darwin" ]; then
  # Older versions added a config-file entry; the desktop extension replaces it.
  node scripts/install-claude-gm.mjs --remove-legacy; result=$?
  [ "$result" = 1 ] && fail "could not update the Claude Desktop config"
  echo "  Building the Claude Desktop extension..."
  node scripts/build-mcpb.mjs || fail "could not build the extension"
else
  echo "  Connecting Narrative Engine to Claude Desktop..."
  node scripts/install-claude-gm.mjs; result=$?
  [ "$result" = 1 ] && fail "could not update the Claude Desktop config"
fi

echo "  Starting Narrative Engine (live display)..."
mkdir -p server/mcp/.cache
nohup npm run dev > server/mcp/.cache/dev.log 2>&1 &

if [ "$(uname)" = "Darwin" ]; then
  if [ "$result" = 10 ]; then osascript -e 'quit app "Claude"' >/dev/null 2>&1; sleep 2; fi
  if node scripts/install-claude-gm.mjs --check-extension; then
    open -a Claude 2>/dev/null || open_url "https://claude.ai/download"
  else
    echo "  Opening the extension in Claude Desktop: click Install when it asks."
    open -a Claude "NarrativeEngine.mcpb" 2>/dev/null || open "NarrativeEngine.mcpb" 2>/dev/null || { echo "  Claude Desktop not found. Opening the download page..."; open_url "https://claude.ai/download"; }
  fi
else
  echo "  Open Claude Desktop (restart it if it was already running)."
fi

sleep 6
open_url "http://localhost:5173/launcher.html"

echo
echo "  Ready! In Claude Desktop (if an install screen appeared, click Install first),"
echo "  start a new chat and type:"
echo
echo "      Let's play Narrative Engine"
echo
echo "  (Allow the narrative-engine tools when Claude asks.)"
echo "  The browser window shows your campaign live as you play."
echo "  Keep this window open while you play; close it to stop the live display."
echo
wait
