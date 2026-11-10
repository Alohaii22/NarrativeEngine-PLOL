/**
 * The MCP App panel Claude shows inline in the conversation: campaign
 * briefing, dice tray, character sheet and turn summary. One HTML document;
 * each tool result carries `structuredContent.view` to pick what to draw.
 *
 * The MCP Apps browser client is inlined from node_modules instead of loaded
 * from a CDN, so the panel works offline and needs no CSP allowances.
 */
import fs from 'fs';
import { createRequire } from 'module';

export const PANEL_URI = 'ui://narrative-engine/panel.html';

const require = createRequire(import.meta.url);
let cachedClient;

/** The ext-apps browser bundle as a plain script that defines `App`. */
export function inlineAppClient() {
    if (cachedClient) return cachedClient;
    const appEntry = require.resolve('@modelcontextprotocol/ext-apps/app-with-deps');
    const src = fs.readFileSync(appEntry, 'utf-8');
    const exportStart = src.lastIndexOf('export{');
    if (exportStart === -1) throw new Error('Unexpected ext-apps bundle: no export block');
    const exportBlock = src.slice(exportStart);
    const local = /([\w$]+) as App\b/.exec(exportBlock)?.[1];
    if (!local) throw new Error('Unexpected ext-apps bundle: App export not found');
    cachedClient = `${src.slice(0, exportStart)}\nconst App = ${local};\n`.replace(/<\/script/gi, '<\\/script');
    return cachedClient;
}

const STYLE = `
:root { color-scheme: light dark; --bg:#fbf8f3; --card:#fff; --ink:#1f1a14; --muted:#6b6257; --line:#e4dccf; --accent:#7c3aed; --good:#15803d; --bad:#b91c1c; }
@media (prefers-color-scheme: dark) { :root { --bg:#17141f; --card:#211d2b; --ink:#ece8f4; --muted:#a39cb3; --line:#352f44; --accent:#a78bfa; --good:#4ade80; --bad:#f87171; } }
* { box-sizing: border-box; }
body { margin:0; padding:12px; background:var(--bg); color:var(--ink); font:14px/1.5 system-ui, sans-serif; }
h1 { font:600 18px/1.25 Georgia, serif; margin:0 0 2px; }
h2 { font:600 12px/1.2 system-ui; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin:14px 0 6px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px 14px; }
.muted { color:var(--muted); }
.row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.pill { border:1px solid var(--line); border-radius:999px; padding:2px 10px; font-size:12px; }
.bar { height:8px; border-radius:99px; background:var(--line); overflow:hidden; flex:1; min-width:120px; }
.bar > i { display:block; height:100%; background:var(--good); }
.bar.mp > i { background:var(--accent); }
.stats { display:grid; grid-template-columns:repeat(auto-fill,minmax(70px,1fr)); gap:6px; }
.stat { border:1px solid var(--line); border-radius:8px; text-align:center; padding:4px; }
.stat b { display:block; font-size:16px; }
.dice { display:flex; gap:8px; flex-wrap:wrap; margin:10px 0; }
.die { width:46px; height:46px; border:2px solid var(--ink); border-radius:10px; display:grid; place-items:center; font:700 18px system-ui; animation:pop .35s ease-out; }
.die.drop { opacity:.35; border-style:dashed; }
.die.crit { border-color:var(--good); color:var(--good); }
.die.fumble { border-color:var(--bad); color:var(--bad); }
.total { font:700 30px Georgia, serif; }
@keyframes pop { from { transform:rotate(-25deg) scale(.6); opacity:0; } to { transform:none; opacity:1; } }
button { font:inherit; border:1px solid var(--line); background:var(--card); color:var(--ink); border-radius:8px; padding:4px 10px; cursor:pointer; }
button:hover { border-color:var(--accent); }
ul { margin:4px 0; padding-left:18px; }
@media (prefers-reduced-motion: reduce) { .die { animation:none; } }
`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const app = new App({ name: 'Narrative Engine', version: '1.0.0' });
let last = null;

function bar(label, v, cls) {
  if (!v || !v.max) return '';
  const pct = Math.max(0, Math.min(100, (v.current / v.max) * 100));
  return '<div class="row"><span style="width:28px">' + label + '</span><div class="bar ' + (cls||'') + '"><i style="width:' + pct + '%"></i></div><b>' + v.current + '/' + v.max + '</b></div>';
}

function sheetHtml(s, campaignId) {
  if (!s) return '';
  const sub = [s.race, s.class, s.level ? 'Lv ' + s.level : ''].filter(Boolean).join(' · ');
  const stats = Object.entries(s.stats || {}).map(([k, v]) => '<div class="stat"><span class="muted">' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('');
  const inv = (s.inventory || []).map((i) => '<li>' + esc(i.name) + (i.qty > 1 ? ' ×' + i.qty : '') + (i.equipped ? ' <span class="pill">equipped</span>' : '') + '</li>').join('');
  const hpButtons = campaignId && s.hp ? '<div class="row" style="margin-top:6px"><button data-hp="-5">−5</button><button data-hp="-1">−1</button><button data-hp="1">+1</button><button data-hp="5">+5</button><span class="muted">HP</span></div>' : '';
  return '<div class="card"><h1>' + esc(s.name) + '</h1>' + (sub ? '<div class="muted">' + esc(sub) + '</div>' : '')
    + (s.condition ? '<div class="pill" style="display:inline-block;margin-top:4px">' + esc(s.condition) + '</div>' : '')
    + '<div style="margin-top:8px">' + bar('HP', s.hp) + bar('MP', s.mp, 'mp') + '</div>' + hpButtons
    + (stats ? '<h2>Stats</h2><div class="stats">' + stats + '</div>' : '')
    + (inv ? '<h2>Inventory</h2><ul>' + inv + '</ul>' : '')
    + ((s.traits || []).length ? '<h2>Traits</h2><div class="row">' + s.traits.map((t) => '<span class="pill">' + esc(t) + '</span>').join('') + '</div>' : '')
    + '</div>';
}

function diceHtml(r) {
  const dice = r.groups.map((g) =>
    g.rolls.map((n) => '<div class="die' + (g.sides === 20 && n === 20 ? ' crit' : g.sides === 20 && n === 1 ? ' fumble' : '') + '">' + n + '</div>').join('')
    + g.dropped.map((n) => '<div class="die drop" title="dropped">' + n + '</div>').join('')).join('');
  const crit = r.critical === 'success' ? '<span class="pill" style="color:var(--good)">Natural 20!</span>' : r.critical === 'failure' ? '<span class="pill" style="color:var(--bad)">Natural 1</span>' : '';
  return '<div class="card">' + (r.label ? '<h2 style="margin-top:0">' + esc(r.label) + '</h2>' : '')
    + '<div class="muted">' + esc(r.expression) + (r.mode !== 'normal' ? ' · ' + r.mode : '') + (r.modifier ? ' · modifier ' + (r.modifier > 0 ? '+' : '') + r.modifier : '') + '</div>'
    + '<div class="dice">' + dice + '</div><div class="row"><span class="total">' + r.total + '</span>' + crit + '<span style="flex:1"></span><button id="again">Roll again</button></div></div>';
}

function campaignHtml(c) {
  const npcs = (c.npcs || []).slice(0, 12).map((n) => '<li><b>' + esc(n.name) + '</b>' + (n.status ? ' — ' + esc(n.status) : '') + '</li>').join('');
  const notes = (c.notebook || []).map((n) => '<li>' + esc(n) + '</li>').join('');
  return '<div class="card"><h1>' + esc(c.campaign.name) + '</h1><div class="muted">' + (c.isNewCampaign ? 'New campaign' : (c.turnsPlayed || c.scenesArchived) + ' turns played') + ' · ' + (c.loreCount || 0) + ' lore entries</div></div>'
    + '<h2>Hero</h2>' + sheetHtml(c.character)
    + (npcs ? '<h2>Known NPCs</h2><div class="card"><ul>' + npcs + '</ul></div>' : '')
    + (notes ? '<h2>Scene notebook</h2><div class="card"><ul>' + notes + '</ul></div>' : '');
}

function turnHtml(t) {
  const notes = (t.notebook || []).map((n) => '<li>' + esc(n) + '</li>').join('');
  // The story is already in the chat above; this is only the save receipt and the hero's status.
  return '<div class="row" style="margin-bottom:8px"><span class="pill">Turn ' + esc(t.turnNumber) + ' saved</span>'
    + (t.sceneId ? '' : '<span class="pill" style="color:var(--bad)">not in long-term memory</span>') + '</div>'
    + sheetHtml(t.character, t.campaignId)
    + (notes ? '<h2>Scene notebook</h2><div class="card"><ul>' + notes + '</ul></div>' : '');
}

function render(sc) {
  if (!sc || !sc.view) return;
  last = sc;
  const root = $('root');
  if (sc.view === 'dice') root.innerHTML = diceHtml(sc);
  else if (sc.view === 'character') root.innerHTML = '<h2 style="margin-top:0">Character</h2>' + sheetHtml(sc.sheet, sc.campaignId);
  else if (sc.view === 'campaign') root.innerHTML = campaignHtml(sc);
  else if (sc.view === 'turn') root.innerHTML = turnHtml(sc);
}

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLElement) || !last) return;
  try {
    if (t.id === 'again' && last.view === 'dice') {
      const res = await app.callServerTool({ name: 'roll_dice', arguments: { expression: last.expression + (last.mode !== 'normal' ? ' ' + (last.mode === 'advantage' ? 'adv' : 'dis') : ''), label: last.label } });
      render(res.structuredContent);
    } else if (t.dataset.hp && last.campaignId) {
      const res = await app.callServerTool({ name: 'update_character', arguments: { campaignId: last.campaignId, hpDelta: Number(t.dataset.hp) } });
      const sheet = res.structuredContent && res.structuredContent.sheet;
      if (sheet) render(last.view === 'turn' ? { ...last, character: sheet } : { ...last, sheet });
    }
  } catch (err) { console.error(err); }
});

app.ontoolresult = (result) => render(result.structuredContent);
await app.connect();
`;

export function panelHtml() {
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Narrative Engine</title>
<style>${STYLE}</style></head>
<body><div id="root" class="muted">Loading…</div>
<script type="module">
${inlineAppClient()}
${SCRIPT}
</script></body></html>`;
}
