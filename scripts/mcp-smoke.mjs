#!/usr/bin/env node
/**
 * End-to-end smoke test for "Claude as GM": plays a real session through the
 * MCP server over stdio, exactly the way Claude Desktop talks to it.
 *
 *   npm run mcp:smoke                       isolated: own engine on a spare port, throwaway data
 *   npm run mcp:smoke -- --engine-url http://127.0.0.1:3001 [--keep]
 *                                           against a running engine (its real data/);
 *                                           the smoke campaign is deleted unless --keep
 *   npm run mcp:smoke -- --ui-url http://localhost:5173   also check the UI serves the campaign
 *                                           (needs --engine-url: the UI proxies to port 3001)
 *   --world <id>    world to play (default class-scroll-world)
 *   --semantic      wait for the embedding model and require semantic recall (slow on first run)
 *   --verbose       print every tool result
 *
 * Exit code 0 = every check passed.
 */
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP_ENTRY = path.join(REPO_ROOT, 'server', 'mcp', 'index.js');
const EXPECTED_TOOLS = ['close_chapter', 'create_campaign', 'get_npcs', 'list_campaigns', 'list_worlds', 'open_campaign', 'recall_lore',
    'recall_memory', 'record_turn', 'roll_dice', 'show_character', 'update_character', 'update_notebook', 'update_npc'];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const VERBOSE = flag('--verbose');
const KEEP = flag('--keep');
const SEMANTIC = flag('--semantic');
const WORLD = opt('--world') ?? 'class-scroll-world';
const UI_URL = opt('--ui-url')?.replace(/\/+$/, '');
let engineUrl = opt('--engine-url')?.replace(/\/+$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const failures = [];
function check(name, cond, detail = '') {
    if (cond) { passed += 1; console.log(`  ok   ${name}`); }
    else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const step = (title) => console.log(`\n${title}`);

// ── Engine (isolated mode) ───────────────────────────────────────────────
function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    });
}

async function engineUp(url) {
    try { return (await fetch(`${url}/api/campaigns`)).ok; } catch { return false; }
}

let engineProc = null;
let engineLog = '';
let dataDir = null;
async function startEngine(port) {
    engineProc = spawn(process.execPath, ['server.js'], {
        cwd: REPO_ROOT,
        env: { ...process.env, NE_ENGINE_PORT: String(port), DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    engineProc.stdout.on('data', (d) => { engineLog += d; });
    engineProc.stderr.on('data', (d) => { engineLog += d; });
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i++) {
        if (engineProc.exitCode !== null) throw new Error(`engine exited early (${engineProc.exitCode}):\n${engineLog.slice(-2000)}`);
        if (await engineUp(url)) return url;
        await sleep(500);
    }
    throw new Error(`engine did not answer on ${url} within 60s:\n${engineLog.slice(-2000)}`);
}
async function stopEngine() {
    if (!engineProc || engineProc.exitCode !== null) return;
    const done = new Promise((r) => engineProc.once('exit', r));
    engineProc.kill();
    await Promise.race([done, sleep(5000)]);
    engineProc = null;
}

// ── MCP client ───────────────────────────────────────────────────────────
async function connect(url, extraEnv = {}) {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [MCP_ENTRY],
        cwd: REPO_ROOT,
        env: { ...process.env, NARRATIVE_ENGINE_URL: url, NE_AUTOSTART: '0', ...extraEnv },
        stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (d) => { stderr += d; });
    const client = new Client({ name: 'ne-smoke', version: '1.0.0' });
    await client.connect(transport);
    const sizes = [];
    const call = async (name, args = {}) => {
        const res = await client.callTool({ name, arguments: args });
        const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        sizes.push({ name, chars: text.length, structured: res.structuredContent ? JSON.stringify(res.structuredContent).length : 0 });
        if (VERBOSE) console.log(`    [${name}] ${text.slice(0, 600).replace(/\n/g, '\n    ')}${text.length > 600 ? ` …(+${text.length - 600})` : ''}`);
        return { text, isError: !!res.isError, data: res.structuredContent ?? null };
    };
    return { client, call, sizes, stderr: () => stderr, close: () => client.close() };
}

// ── The session ──────────────────────────────────────────────────────────
const HERO = 'Smokey Vale';
const NPC = 'Marrow Tessaly';
const MARKER = 'quillfeather'; // distinctive word that only appears in turn 2

async function main() {
    const isolated = !engineUrl;
    if (UI_URL && isolated) throw new Error('--ui-url needs --engine-url (the UI talks to the engine on port 3001)');
    if (isolated) {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-smoke-'));
        // Share the real install's embedding-model cache, so a smoke run never
        // downloads the model into a folder that is about to be deleted.
        const realCache = path.join(REPO_ROOT, 'data', '.embeddings_cache');
        fs.mkdirSync(realCache, { recursive: true });
        try { fs.symlinkSync(realCache, path.join(dataDir, '.embeddings_cache'), 'junction'); } catch { /* falls back to a private cache */ }
        step(`Starting an isolated engine (data: ${dataDir})`);
        engineUrl = await startEngine(await freePort());
        check('engine answers', true);
    } else {
        step(`Using the engine at ${engineUrl}`);
        check('engine answers', await engineUp(engineUrl), 'start it with `npm run dev`');
        if (failures.length) return;
    }

    let campaignId = null;
    let gm = await connect(engineUrl);
    try {
        step('Server surface');
        const tools = (await gm.client.listTools()).tools;
        check(`${EXPECTED_TOOLS.length} tools registered`, JSON.stringify(tools.map((t) => t.name).sort()) === JSON.stringify(EXPECTED_TOOLS), tools.map((t) => t.name).join(','));
        check('every tool has a description', tools.every((t) => (t.description ?? '').length > 20));
        const prompts = (await gm.client.listPrompts()).prompts;
        check('run_campaign prompt registered', prompts.some((p) => p.name === 'run_campaign'));
        const prompt = await gm.client.getPrompt({ name: 'run_campaign', arguments: {} });
        check('run_campaign prompt tells the GM to record turns', /record_turn/.test(prompt.messages[0].content.text));
        check('server sends GM instructions', /record_turn/.test(gm.client.getInstructions() ?? ''));

        step('New campaign');
        const worlds = await gm.call('list_worlds');
        check('list_worlds offers the bundled worlds', !worlds.isError && (worlds.data?.worlds?.length ?? 0) > 10);
        check('the chosen world is offered', worlds.data?.worlds?.some((w) => w.id === WORLD), WORLD);
        const created = await gm.call('create_campaign', { world: WORLD, name: 'MCP Smoke Test' });
        campaignId = created.data?.campaignId ?? null;
        check('create_campaign returns a campaign id', !created.isError && !!campaignId, created.text.slice(0, 200));
        if (!campaignId) return;
        check('create_campaign built lore', (created.data?.created?.loreEntries ?? 0) > 5);
        check('briefing carries the GM rules', /GM rules/.test(created.text));
        check('briefing carries the opening prompt', /Opening prompt/.test(created.text));
        check('briefing carries the turn loop', /record_turn/.test(created.text) && /roll_dice/.test(created.text));
        check('panel data stays small (no rules or lore in it)', JSON.stringify(created.data).length < 6000, String(JSON.stringify(created.data).length));
        const listed = await gm.call('list_campaigns');
        check('list_campaigns shows it', listed.text.includes(campaignId));
        const opened = await gm.call('open_campaign', { campaignId });
        check('open_campaign: new campaign, no turns', !opened.isError && /New campaign/.test(opened.text));

        step('Character creation');
        const made = await gm.call('update_character', {
            campaignId, name: HERO, race: 'Human', class: 'Scroll Runner', level: 1,
            hpMax: 24, stats: { STR: 10, DEX: 15, WIS: 13 }, skills: ['Stealth', 'Lockpicking'],
            appearance: 'Lean, ink-stained fingers, a courier satchel.', personality: 'Curious and stubborn.',
            inventory: [
                { action: 'add', name: 'Short sword', category: 'weapon', equipped: true },
                { action: 'add', name: 'Healing draught', qty: 2, category: 'consumable' },
            ],
        });
        check('hero created', !made.isError && made.data?.sheet?.name === HERO, made.text.slice(0, 200));
        check('a new hero starts at full HP', made.data?.sheet?.hp?.current === 24 && made.data?.sheet?.hp?.max === 24, JSON.stringify(made.data?.sheet?.hp));
        check('starting gear saved', made.data?.sheet?.inventory?.length === 2);

        step('Play: opening scene + 5 turns');
        const lore = await gm.call('recall_lore', { campaignId, query: 'class scroll' });
        check('recall_lore returns lore', !lore.isError && (lore.data?.headers?.length ?? 0) > 0 && /^### /.test(lore.text), lore.text.slice(0, 120));
        const noLore = await gm.call('recall_lore', { campaignId, query: 'zzqx vrrbl' });
        check('recall_lore with no match says so instead of failing', !noLore.isError && /No lore found/.test(noLore.text), noLore.text.slice(0, 120));
        const t0 = await gm.call('record_turn', { campaignId, playerAction: '', narration: `📅 Evening | 📍 Port Vell - the slate steps | 👥 Nobody

Rain hammers the slate roofs as ${HERO} steps off the ferry, satchel held tight. A lantern swings over the Scribe Hall door.` });
        check('opening scene recorded as turn 1', !t0.isError && t0.data?.turnNumber === 1, t0.text);
        check('opening scene archived', !!t0.data?.sceneId);
        check('📍 header: a new place is added and becomes the current place', t0.data?.location?.place === 'Port Vell' && t0.data?.location?.newPlace === 'Port Vell' && t0.data?.location?.feature === 'the slate steps', JSON.stringify(t0.data?.location));

        // Turn 2: dice + new NPC
        const roll = await gm.call('roll_dice', { expression: '1d20+3', label: 'Persuasion DC 12' });
        check('roll_dice returns a real total', !roll.isError && Number.isInteger(roll.data?.total) && roll.data.total >= 4 && roll.data.total <= 23, roll.text);
        const npc = await gm.call('update_npc', { campaignId, name: NPC, appearance: 'Tall archivist with a silver monocle', personality: 'Dry, exacting', status: 'Guarding the Scribe Hall archive', faction: 'Scribe Hall' });
        check('update_npc adds a new NPC', !npc.isError && npc.data?.created === true, npc.text);
        const t1 = await gm.call('record_turn', { campaignId, playerAction: 'I ask the archivist for the sealed ledger.', narration: `📅 Evening | 📍 Scribe Hall - reading room | 👥 ${NPC}

${NPC} adjusts her monocle. "The ${MARKER} ledger is not lent to couriers," she says, but her eyes linger on your satchel seal.`, importance: 6 });
        check('turn 2 recorded', t1.data?.turnNumber === 2, t1.text);
        check('📍 header: the hero moves to the next place', t1.data?.location?.place === 'Scribe Hall' && t1.data?.location?.feature === 'reading room', JSON.stringify(t1.data?.location));

        // Turn 3: parallel state writes (Claude often sends tool calls together)
        const [nb, dmg, t2] = await Promise.all([
            gm.call('update_notebook', { campaignId, actions: [{ action: 'add', text: 'Archive closes at the ninth bell' }, { action: 'add', text: 'Guard patrol passes every 10 minutes' }] }),
            gm.call('update_character', { campaignId, hpDelta: -5 }),
            gm.call('record_turn', { campaignId, playerAction: 'I slip past the reading desks toward the vault stairs.', narration: 'A loose flagstone turns under your boot. You catch the rail hard, jarring your shoulder, and the lamps below flicker.' }),
        ]);
        check('parallel calls all succeed', !nb.isError && !dmg.isError && !t2.isError);
        const afterParallel = await gm.call('open_campaign', { campaignId, recentTurns: 10 });
        check('parallel writes: notebook kept', (afterParallel.data?.notebook?.length ?? 0) === 2, JSON.stringify(afterParallel.data?.notebook));
        check('parallel writes: HP change kept', afterParallel.data?.character?.hp?.current === 19, JSON.stringify(afterParallel.data?.character?.hp));
        check('parallel writes: turn kept', /loose flagstone/.test(afterParallel.text));

        // Turn 4: adv roll, inventory use, NPC update
        const adv = await gm.call('roll_dice', { expression: 'd20+2 adv', label: 'Stealth' });
        check('advantage roll drops one die', !adv.isError && adv.data?.groups?.[0]?.dropped?.length === 1, adv.text);
        const inv = await gm.call('update_character', { campaignId, hpDelta: 4, inventory: [{ action: 'remove', name: 'Healing draught', qty: 1 }, { action: 'add', name: 'Vault key', category: 'key' }] });
        check('healing and inventory change', inv.data?.sheet?.hp?.current === 23 && inv.data?.sheet?.inventory?.length === 3, inv.text.slice(0, 200));
        const npc2 = await gm.call('update_npc', { campaignId, name: NPC.toLowerCase(), status: 'Searching the hall for an intruder', condition: 'healthy' });
        check('update_npc updates the same NPC (case-insensitive)', npc2.data?.created === false && npc2.data?.changed?.includes('status'), npc2.text);
        const t3 = await gm.call('record_turn', { campaignId, playerAction: 'I drink a draught and unlock the vault.', narration: 'The key bites. Cold air rolls out of the vault, carrying the smell of old vellum.' });
        check('turn 4 recorded', t3.data?.turnNumber === 4, t3.text);

        // Turn 5: notebook housekeeping, duplicate guard
        const nb2 = await gm.call('update_notebook', { campaignId, actions: [{ action: 'remove', text: 'patrol' }, { action: 'add', text: 'Inside the vault; door ajar' }] });
        check('notebook remove + add', nb2.data?.notebook?.length === 2 && !nb2.data.notebook.some((n) => /patrol/.test(n)), JSON.stringify(nb2.data?.notebook));
        const t4args = { campaignId, playerAction: 'I search the shelves for the ledger.', narration: 'Third shelf, behind a false spine: the ledger, its cover stamped with a feathered quill.' };
        const t4 = await gm.call('record_turn', t4args);
        check('turn 5 recorded', t4.data?.turnNumber === 5, t4.text);
        const dup = await gm.call('record_turn', t4args);
        check('recording the same turn twice does not duplicate it', !dup.isError && dup.data?.turnNumber === 5, dup.text);

        // Turn 6
        const t5 = await gm.call('record_turn', { campaignId, playerAction: 'I take the ledger and head for the roof.', narration: 'Bells begin to ring below. You climb into the rain with the ledger under your coat.', importance: 8,
            events: [{ subject: HERO, predicate: 'holds', object: `the ${MARKER} ledger`, summary: `${HERO} stole the ${MARKER} ledger from the Scribe Hall vault.`, importance: 8 }] });
        check('turn 6 recorded', t5.data?.turnNumber === 6, t5.text);
        check('timeline event saved with the turn', t5.data?.timelineEvents === 1, t5.text);
        const early = await gm.call('close_chapter', { campaignId, title: 'The Vault', summary: `${HERO} talked past ${NPC}, slipped into the Scribe Hall vault and stole the ${MARKER} ledger.`, unresolvedThreads: ['Who rang the bells?'] });
        check('close_chapter seals the chapter', !early.isError && early.data?.sceneCount === 6 && !!early.data?.nextChapterId, early.text);

        step('Error paths');
        const badRoll = await gm.call('roll_dice', { expression: 'banana' });
        check('bad dice expression is a clear error', badRoll.isError && /d20|2d6/.test(badRoll.text), badRoll.text);
        const badId = await gm.call('open_campaign', { campaignId: 'no_such_campaign' });
        check('unknown campaign is a clear error', badId.isError && /list_campaigns/.test(badId.text), badId.text);
        const badTurn = await gm.call('record_turn', { campaignId: 'no_such_campaign', playerAction: 'x', narration: 'y' });
        check('record_turn on an unknown campaign fails without writing', badTurn.isError, badTurn.text);
        const badWorld = await gm.call('create_campaign', { world: 'zzzz-not-a-world' });
        check('unknown world is a clear error', badWorld.isError && /list_worlds/.test(badWorld.text), badWorld.text);

        step('Output size (what Claude has to read)');
        const biggest = (name) => Math.max(0, ...gm.sizes.filter((s) => s.name === name).map((s) => s.chars));
        for (const name of ['create_campaign', 'open_campaign', 'recall_lore', 'record_turn', 'update_character', 'update_notebook', 'roll_dice']) {
            console.log(`  ${name.padEnd(18)} ${String(biggest(name)).padStart(6)} chars`);
        }
        check('record_turn replies stay tiny', biggest('record_turn') < 200);
        check('roll_dice replies stay tiny', biggest('roll_dice') < 200);
        check('update_character replies stay small', biggest('update_character') < 400);
        check('recall_lore stays under 10k chars', biggest('recall_lore') < 10_000);
        check('reopening a campaign stays under 40k chars', biggest('open_campaign') < 40_000);

        step('Close and reopen');
        await gm.close();
        if (isolated) {
            const port = Number(new URL(engineUrl).port);
            await stopEngine();
            engineUrl = await startEngine(port);
            check('engine restarted on the same data', true);
        }
        gm = await connect(engineUrl);
        const again = await gm.call('list_campaigns');
        check('campaign still listed', again.text.includes(campaignId));
        const re = await gm.call('open_campaign', { campaignId, recentTurns: 10 });
        check('reopen: not a new campaign', !re.isError && re.data?.isNewCampaign === false);
        check('reopen: 6 scenes in the archive', re.data?.scenesArchived === 6, String(re.data?.scenesArchived));
        check('reopen: recent turns include the last narration', /Bells begin to ring/.test(re.text));
        check('reopen: recent turns include the opening', /steps off the ferry/.test(re.text));
        check('reopen: hero persisted', re.data?.character?.name === HERO && re.data?.character?.hp?.current === 23, JSON.stringify(re.data?.character?.hp));
        check('reopen: inventory persisted', re.data?.character?.inventory?.some((i) => i.name === 'Vault key') && re.data?.character?.inventory?.find((i) => i.name === 'Healing draught')?.qty === 1);
        check('reopen: notebook persisted', re.data?.notebook?.includes('Inside the vault; door ajar'));
        check('reopen: no opening prompt once play has started', !/## Opening prompt/.test(re.text));
        check('reopen: briefing says where the hero is', /## Where the hero is\s+Scribe Hall - reading room/.test(re.text));
        check('reopen: briefing carries the story so far', /## Story so far[\s\S]*The Vault/.test(re.text));
        const api = (p) => fetch(`${engineUrl}/api/campaigns/${campaignId}${p}`).then((r) => r.json());
        const [places, timeline, chapters] = await Promise.all([api('/locations'), api('/timeline'), api('/archive/chapters')]);
        check('engine: Places has the new places', ['Port Vell', 'Scribe Hall'].every((n) => places.some((l) => l.name === n)), places.map((l) => l.name).join(', '));
        check('engine: timeline has the event under scene 006', timeline.some((e) => e.predicate === 'holds' && e.sceneId === '006' && /ledger/.test(e.object)), JSON.stringify(timeline).slice(0, 200));
        check('engine: chapter 1 sealed with the summary, chapter 2 open', chapters[0]?.sealedAt && chapters[0]?.title === 'The Vault' && /stole/.test(chapters[0]?.summary) && chapters.some((c) => !c.sealedAt), JSON.stringify(chapters.map((c) => [c.chapterId, c.title, !!c.sealedAt])));
        const who = await gm.call('get_npcs', { campaignId, names: [NPC] });
        check('reopen: NPC persisted with latest status', /Searching the hall/.test(who.text), who.text.slice(0, 200));
        const sheet = await gm.call('show_character', { campaignId });
        check('show_character shows the hero', sheet.text.includes(HERO) && /HP 23\/24/.test(sheet.text), sheet.text.slice(0, 200));
        const mem = await gm.call('recall_memory', { campaignId, query: `the ${MARKER} ledger` });
        check('recall_memory finds the earlier scene', !mem.isError && mem.text.includes(MARKER), mem.text.slice(0, 200));
        console.log(`  (recall method: ${mem.data?.method})`);
        const mem2 = await gm.call('recall_memory', { campaignId, query: `What did ${NPC} say about lending to couriers?` });
        check('recall_memory finds a scene by NPC name', mem2.text.includes('monocle'), mem2.text.slice(0, 200));

        if (SEMANTIC) {
            step('Semantic recall (waits for the embedding model)');
            let method = '';
            for (let i = 0; i < 180 && method !== 'semantic+keyword'; i++) {
                method = (await gm.call('recall_memory', { campaignId, query: 'a librarian refuses to hand over a book' })).data?.method;
                if (method !== 'semantic+keyword') await sleep(5000);
            }
            check('recall_memory uses semantic search once the model is ready', method === 'semantic+keyword', method);
        }

        if (UI_URL) {
            step(`UI at ${UI_URL}`);
            const page = await fetch(`${UI_URL}/`).then((r) => (r.ok ? r.text() : ''), () => '');
            check('UI serves the app page', /<div id="root"/.test(page));
            const viaUi = await fetch(`${UI_URL}/api/campaigns`).then((r) => r.json(), () => []);
            check('UI (through its API proxy) lists the campaign', Array.isArray(viaUi) && viaUi.some((c) => c.id === campaignId));
            const state = await fetch(`${UI_URL}/api/campaigns/${campaignId}/state`).then((r) => r.json(), () => null);
            check('UI can load the recorded chat', (state?.messages ?? []).filter((m) => m.role === 'assistant').length === 6);
            const rev = await fetch(`${UI_URL}/api/campaigns/${campaignId}/external-revision`).then((r) => r.json(), () => null);
            check('live-sync counter moved with Claude\'s writes', (rev?.revision ?? 0) > 0, JSON.stringify(rev));
        }

        step('Engine down');
        await gm.close();
        gm = await connect(`http://127.0.0.1:${await freePort()}`);
        const down = await gm.call('list_campaigns');
        check('engine down: plain-words error, no crash', down.isError && /Narrative Engine/.test(down.text) && /Play_With_Claude|npm run dev/.test(down.text), down.text);
        const still = await gm.call('roll_dice', { expression: 'd20' });
        check('engine down: dice still work', !still.isError);
    } finally {
        await gm.close().catch(() => {});
        if (campaignId && !isolated && !KEEP) {
            await fetch(`${engineUrl}/api/campaigns/${campaignId}`, { method: 'DELETE' }).catch(() => {});
            console.log(`\nDeleted the smoke campaign ${campaignId}.`);
        } else if (campaignId && !isolated) {
            console.log(`\nKept the smoke campaign ${campaignId} ("MCP Smoke Test").`);
        }
    }
}

let crashed = null;
try { await main(); } catch (err) { crashed = err; }
await stopEngine();
if (dataDir) {
    // Remove the junction first so the shared model cache is never followed and deleted.
    try { fs.rmdirSync(path.join(dataDir, '.embeddings_cache')); } catch { /* not a junction */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp folder; the OS cleans it */ }
}
if (crashed) { console.error(`\nSmoke test crashed: ${crashed.stack ?? crashed}`); process.exit(2); }
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? `:\n  - ${failures.join('\n  - ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
