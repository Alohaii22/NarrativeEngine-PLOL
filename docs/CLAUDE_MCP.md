# Claude as your Game Master (MCP server)

Play a Narrative Engine campaign with **Claude as the GM**, from the Claude
desktop app, on your regular Claude subscription. No API key is needed.

Claude runs the story in the Claude chat. Narrative Engine keeps everything else:
the rules, world lore, NPCs, the hero's sheet, and long-term memory of every
scene. Leave the Narrative Engine window open and it **updates live** as Claude
plays.

```
 Claude Desktop  ──MCP (stdio)──▶  server/mcp  ──HTTP──▶  Narrative Engine server  ──▶  data/
 (you play here,                  (GM tools +            (port 3001, the only          ▲
  inline panels)                   panels)                 writer to data/)             │
                                                                                         │
 Narrative Engine UI  ◀── polls every 2.5 s, reloads when Claude changes the campaign ──┘
```

## One-click start

1. Install [Claude Desktop](https://claude.ai/download) and [Node.js LTS](https://nodejs.org/) if you don't have them.
2. Double-click **`Play_With_Claude.bat`** (Windows) or **`Play_With_Claude.command`** (macOS).
3. Install the extension in Claude Desktop: **Settings > Desktop app**, click **Manage** next to **Extensions**, then **Advanced settings > Install Extension…** (in the **Extension Developer** section), choose `NarrativeEngine.mcpb` from the folder, and click **Install**. Dragging the file onto the Claude Desktop window also works.
4. Start a new chat and type **"Let's play Narrative Engine"**. Allow the `narrative-engine` tools when asked.

The first run installs everything, which takes a few minutes. The button then:
- builds `NarrativeEngine.mcpb`, a Claude Desktop extension pointing at this folder;
- starts Narrative Engine and opens the Campaign Launcher in your browser.

If Narrative Engine isn't running when Claude needs it, it starts in the background on its own.

**Check it:** in a chat, click **+** below the message box and choose **Connectors**: Narrative Engine should be listed. It also appears on the Extensions page (**Settings > Desktop app**, **Manage** next to Extensions), where you can turn it off or change its folder. (Older Claude Desktop versions had this under **Settings > Extensions**.)
**If it fails:** open `server/mcp/.cache/mcp.log` in the Narrative Engine folder. The extension logs every start and error there.

The manual steps below are only needed if you want to set things up by hand (for example with Claude Code, or on Linux).

## Campaign Launcher

The launchers open the **Campaign Launcher** (`http://localhost:5173/launcher.html`, also linked from the hub). Pick a bundled world, or upload your own files:

| File | Needed? | What it is |
|---|---|---|
| World lore (.md) | **Required** | The setting. Use `##` headings; each section becomes something the GM can recall |
| GM rules (.md) | Recommended | How the GM plays; defaults to AI_GM_OS v5.0 Immersive |
| Opening prompt (.md) | Recommended | How the story starts, often with character creation |
| Loot table (.json) | Optional | Item tables for the loot engine |
| Character cards (.png/.json) | Optional | SillyTavern cards, imported as NPCs (PNG image becomes the portrait) |
| Hero sheet | Optional | Fill it in, or let the GM create your character in the story |

It checks everything before creating the campaign (lore entries, NPCs, locations, unreadable files) and shows what the GM will know.

## What Claude can do

| Tool | What it does | Panel in chat |
|---|---|---|
| `list_campaigns` | Lists your campaigns | |
| `list_worlds` | The ready-made worlds in `Example_Setup/`, each with a pitch | |
| `create_campaign` | Starts a new campaign from a world, built exactly like the app's New Campaign form | Campaign card |
| `open_campaign` | Loads the GM rules, world overview, hero, NPCs, notebook and recent turns | Campaign card |
| `recall_lore` | Searches world lore (semantic search plus keywords) | |
| `recall_memory` | Searches every past scene in the archive | |
| `get_npcs` / `update_npc` | Reads and updates the NPC ledger | |
| `roll_dice` | Real dice: `d20`, `2d6+3`, `4d6kh3`, `1d20+5 adv` | Dice tray with **Roll again** |
| `show_character` / `update_character` | Character creation (name, race, class, looks, skills), HP/MP, level, stats, condition, inventory | Character sheet with HP buttons |
| `update_notebook` | Short-lived scene state (timers, positions, effects) | |
| `record_turn` | Saves the turn to the chat and long-term memory | Turn summary |

The server also includes a **`run_campaign`** prompt. In Claude Desktop, pick it
from the **+** menu to start a session with the GM instructions already loaded.

## Setup

You need Node.js 20.19+ and this repo installed (`npm install`), the same as
for the app itself.

### 1. Start Narrative Engine

```bash
npm run dev
```

The MCP server talks to it on `http://127.0.0.1:3001`. If it's not running, the
MCP server starts `server.js` in the background (log: `server/mcp/.cache/engine.log`;
set `NE_AUTOSTART=0` to turn this off). Run `npm run dev` yourself when you also
want the live display in the browser.

### 2. Add the server to Claude Desktop

Easiest: run `node scripts/build-mcpb.mjs` and double-click the `NarrativeEngine.mcpb` it creates. Older Claude Desktop versions also read a config file; `node scripts/install-claude-gm.mjs` writes it for you, or by hand: open Claude Desktop → **Settings → Developer → Edit Config**. That opens
`claude_desktop_config.json`:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

Add the server, using the full path to your copy of the repo:

```json
{
  "mcpServers": {
    "narrative-engine": {
      "command": "node",
      "args": ["C:\\Games\\NarrativeEngine-PLOL\\server\\mcp\\index.js"]
    }
  }
}
```

On macOS/Linux the path looks like `/Users/you/NarrativeEngine-PLOL/server/mcp/index.js`.

Claude Desktop does not use your shell's PATH. If it reports that `node` was not
found, replace `"node"` with the full path: run `where node` (Windows) or
`which node` (macOS/Linux) to get it.

Restart Claude Desktop **completely** (quit from the tray or menu bar, not just
close the window). `narrative-engine` should then appear under the tools
(slider) icon.

### 3. Play

Start a chat and either pick **run_campaign** from the **+** menu, or say:

> Be my Game Master. List my Narrative Engine campaigns.

Claude asks before using tools the first time. Allow them for this chat, or
choose "Always allow".

## Other ways to connect

- **Claude Code** (text only, no panels):
  `claude mcp add narrative-engine -- node /full/path/to/server/mcp/index.js`
- **Clients that connect by URL:** `npm run mcp:http` serves the same tools
  at `http://127.0.0.1:3002/mcp` (`MCP_PORT` changes the port). claude.ai
  connects from Anthropic's servers, so it needs a public HTTPS tunnel in front
  of that. The server has no authentication, so don't expose it publicly
  without adding some.
- **A Narrative Engine server on another port or machine:** set
  `NARRATIVE_ENGINE_URL` (default `http://127.0.0.1:3001`) in the `env` block
  of the Claude Desktop config.

## Good to know

- **Saving happens through `record_turn`.** Claude is told to call it after every
  narration. If you notice it skipped one, say "record that turn". An
  unrecorded turn is missing from the app and from long-term memory.
- **Play in one place at a time.** While Claude is running a campaign, don't
  also send turns or edit that campaign in the Narrative Engine window. The
  window is a live display; edits from both sides at the same moment can
  overwrite each other.
- **Memory search warms up.** Semantic recall needs the engine's embedding
  model, which downloads on first run. Until it's ready, recall falls back to
  keyword search, and scenes archived meanwhile are re-indexed later.
- **Panels need Claude Desktop or claude.ai.** Other clients get the same
  information as text.
- **Engine tags in rulesets:** rulesets written for the app mention engine tags
  and automatic rolls. Through MCP, Claude handles those itself with real dice
  rolls and never prints tags.
- **Updating panel code:** Claude Desktop caches panels aggressively. After
  changing `server/mcp/views.js`, fully restart Claude Desktop.

## Files

- `server/mcp/index.js`: entry point (stdio, or `--http`)
- `server/mcp/server.js`: tools, panel resource, `run_campaign` prompt, GM instructions
- `server/mcp/gm.js`: game logic (recall, NPCs, character, notebook, turns)
- `server/mcp/worlds.js`: the catalog of bundled worlds and rulesets
- `server/mcp/kit.js`: compiles `src/services/campaignKit.ts` for Node, so campaigns are built by the app's own code
- `server/mcp/engineLauncher.js`: starts the engine when it's not running
- `scripts/build-mcpb.mjs`: builds the Claude Desktop extension (`NarrativeEngine.mcpb`)
- `scripts/install-claude-gm.mjs`: config-file registration (Linux/older Claude Desktop) and cleanup of it
- `Play_With_Claude.bat` / `Play_With_Claude.command`: the one-click launchers
- `server/mcp/dice.js`: dice notation
- `server/mcp/views.js`: the inline panel (MCP Apps)
- `server/mcp/engineClient.js`: HTTP client for the engine; tags writes with `X-NE-Writer: mcp`
- `server/routes/externalRevision.js` and `src/hooks/useExternalCampaignSync.ts`: live sync to the open UI
