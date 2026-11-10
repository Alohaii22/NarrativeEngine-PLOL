import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, briefingText, traceLine, GM_LOOP, SERVER_INSTRUCTIONS } from '../mcp/server.js';
import { createEngineClient } from '../mcp/engineClient.js';
import { createEngineLauncher } from '../mcp/engineLauncher.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TEST_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ne-launcher-')), 'engine.log');

/**
 * The MCP server as Claude sees it: real protocol, real tool handlers, and a
 * fake Narrative Engine behind `fetch`.
 */
function fakeEngineFetch() {
    const files = new Map();
    const scenes = [];
    const calls = [];
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const fetchImpl = async (url, init = {}) => {
        const { pathname } = new URL(url);
        const method = init.method ?? 'GET';
        calls.push(`${method} ${pathname}`);
        const body = init.body ? JSON.parse(init.body) : undefined;
        if (pathname === '/api/campaigns') return json([...files.entries()].filter(([k]) => k.endsWith(':meta')).map(([, v]) => v));
        const m = /^\/api\/campaigns\/([^/]+)(?:\/(.*))?$/.exec(pathname);
        if (!m) return json({ error: 'Not found' }, 404);
        const [, id, rest = 'meta'] = m;
        if (rest === 'archive' && method === 'POST') {
            const sceneId = String(scenes.length + 1).padStart(3, '0');
            scenes.push({ sceneId, userSnippet: body.userContent, content: `## SCENE ${sceneId}\n${body.userContent}\n${body.assistantContent}`, keywords: [] });
            return json({ ok: true, sceneId });
        }
        if (rest === 'archive/index') return json(scenes.map(({ sceneId, userSnippet, keywords }) => ({ sceneId, userSnippet, keywords })));
        if (rest === 'archive/scenes') return json(scenes.filter((s) => new URL(url).searchParams.get('ids').split(',').includes(s.sceneId)));
        if (rest.endsWith('semantic-candidates')) return json({ pending: true });
        const key = `${id}:${rest}`;
        if (method === 'PUT') { files.set(key, body); return json({ ok: true }); }
        if (!files.has(key)) return ['lore', 'npcs'].includes(rest) ? json([]) : json({ error: 'Not found' }, 404);
        return json(files.get(key));
    };
    return { fetchImpl, files, scenes, calls };
}

async function connect(engineClient) {
    const server = buildServer(engineClient);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (name, args = {}) => {
        const res = await client.callTool({ name, arguments: args });
        return { text: res.content.map((c) => c.text).join('\n'), isError: !!res.isError, data: res.structuredContent };
    };
    return { client, call, close: () => client.close() };
}

function seedCampaign(files, id = 'c1') {
    files.set(`${id}:meta`, { id, name: 'Ashfall', lastPlayedAt: 1700000000000 });
    files.set(`${id}:state`, {
        context: { rulesRaw: 'Be gritty.', starter: 'Ask the player for a name first.', notebook: [], inventoryItems: [] },
        messages: [],
        pinnedExcerpts: [],
    });
    files.set(`${id}:lore`, [{ id: 'l1', header: 'The Ashfall', content: 'A cataclysm of ash.', alwaysInclude: true }]);
}

describe('MCP server over the protocol', () => {
    let engine, mcp;
    beforeEach(async () => {
        engine = fakeEngineFetch();
        mcp = await connect(createEngineClient({ baseUrl: 'http://engine.test', fetchImpl: engine.fetchImpl }));
    });
    afterEach(() => mcp.close());

    it('exposes the 14 tools and the run_campaign prompt', async () => {
        const { tools } = await mcp.client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual(['close_chapter', 'create_campaign', 'get_npcs', 'list_campaigns', 'list_worlds', 'open_campaign', 'recall_lore',
            'recall_memory', 'record_turn', 'roll_dice', 'show_character', 'update_character', 'update_notebook', 'update_npc']);
        const prompt = await mcp.client.getPrompt({ name: 'run_campaign', arguments: { campaign: 'Ashfall' } });
        expect(prompt.messages[0].content.text).toContain('"Ashfall"');
        expect(mcp.client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    });

    it('tells Claude how to GM in the instructions, the prompt and every briefing', async () => {
        // Clients differ in what reaches the model; the briefing always does.
        for (const must of ['record_turn', 'roll_dice', 'recall_lore', 'recall_memory', 'update_character', 'update_npc', 'update_notebook', 'close_chapter', '📅', '📍', '👥']) {
            expect(GM_LOOP).toContain(must);
        }
        expect(SERVER_INSTRUCTIONS).toContain(GM_LOOP);
        seedCampaign(engine.files);
        const opened = await mcp.call('open_campaign', { campaignId: 'c1' });
        expect(opened.text).toContain(GM_LOOP);
        expect(opened.text).toContain('Be gritty.');
        expect(opened.text).toContain('Ask the player for a name first.');
        expect(opened.text).toContain('No hero yet');
        const { tools } = await mcp.client.listTools();
        const describe = (name) => tools.find((t) => t.name === name).description;
        expect(describe('list_campaigns')).toMatch(/START HERE/);
        expect(describe('record_turn')).toMatch(/EVERY narration/);
        expect(describe('roll_dice')).toMatch(/never invent a number/i);
        expect(describe('create_campaign')).toMatch(/do not call open_campaign/);
    });

    it('points an empty install at the bundled worlds', async () => {
        const r = await mcp.call('list_campaigns');
        expect(r.isError).toBe(false);
        expect(r.text).toMatch(/list_worlds/);
    });

    it('plays a turn end to end and reopens it', async () => {
        seedCampaign(engine.files);
        const hero = await mcp.call('update_character', { campaignId: 'c1', name: 'Kira', class: 'Ranger', hpMax: 18 });
        expect(hero.text).toBe('Saved: HP 18/18, name Kira, class Ranger.\nKira: HP 18/18');
        const roll = await mcp.call('roll_dice', { expression: 'd20+2', label: 'Tracking' });
        expect(roll.text).toMatch(/^Tracking: d20\+2 → d20: \[\d+\] \+ 2 = \*\*\d+\*\*/);
        expect(roll.data).toMatchObject({ view: 'dice', label: 'Tracking' });
        const turn = await mcp.call('record_turn', { campaignId: 'c1', playerAction: 'I follow the tracks.', narration: 'They lead to a cold fire.' });
        expect(turn.text).toBe('Turn 1 saved.');
        expect(turn.data).toMatchObject({ view: 'turn', turnNumber: 1, sceneId: '001' });
        expect(turn.data).not.toHaveProperty('narration');
        expect((await mcp.call('record_turn', { campaignId: 'c1', playerAction: 'I follow the tracks.', narration: 'They lead to a cold fire.' })).text).toMatch(/already saved/);

        const reopened = await mcp.call('open_campaign', { campaignId: 'c1' });
        expect(reopened.text).toMatch(/1 turns played/);
        expect(reopened.text).toContain('**Player:** I follow the tracks.');
        expect(reopened.text).toContain('**GM:** They lead to a cold fire.');
        expect(reopened.text).not.toContain('## Opening prompt');
        expect(reopened.text).toMatch(/Resume now/);
        // The panel payload carries what the panel draws, not the rules or the turns.
        expect(JSON.stringify(reopened.data)).not.toContain('Be gritty.');
        expect(reopened.data).toMatchObject({ view: 'campaign', turnsPlayed: 1, character: { name: 'Kira' } });
        expect((await mcp.call('recall_memory', { campaignId: 'c1', query: 'tracks' })).text).toContain('cold fire');
    });

    it('turns bad input into errors Claude can act on, without touching the engine', async () => {
        seedCampaign(engine.files);
        engine.calls.length = 0;
        expect(await mcp.call('roll_dice', { expression: 'two dice please' })).toMatchObject({ isError: true, text: expect.stringMatching(/d20, 2d6\+3/) });
        expect(engine.calls).toEqual([]);
        expect(await mcp.call('open_campaign', { campaignId: 'nope' })).toMatchObject({ isError: true, text: expect.stringMatching(/list_campaigns/) });
        expect(await mcp.call('record_turn', { campaignId: 'nope', playerAction: 'x', narration: 'y' })).toMatchObject({ isError: true });
        expect(await mcp.call('create_campaign', { world: 'no such world anywhere' })).toMatchObject({ isError: true, text: expect.stringMatching(/list_worlds/) });
        expect(engine.scenes).toHaveLength(0);
        // Schema violations are rejected by the protocol layer, not passed through.
        const noNarration = await mcp.call('record_turn', { campaignId: 'c1', playerAction: 'x', narration: '' });
        expect(noNarration.isError).toBe(true);
        expect(engine.files.get('c1:state').messages).toEqual([]);
    });

    it('reports an engine error status with the engine\'s own message', async () => {
        seedCampaign(engine.files);
        const { fetchImpl } = engine;
        const broken = await connect(createEngineClient({
            baseUrl: 'http://engine.test',
            fetchImpl: async (url, init) => (init?.method === 'PUT' ? new Response('{"error":"disk full"}', { status: 500 }) : fetchImpl(url, init)),
        }));
        const r = await broken.call('update_notebook', { campaignId: 'c1', actions: [{ action: 'add', text: 'x' }] });
        expect(r).toMatchObject({ isError: true, text: expect.stringMatching(/500.*disk full/) });
        await broken.close();
    });
});

describe('when the engine is down', () => {
    const refuse = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };

    it('every engine tool fails in plain words and dice still roll', async () => {
        const mcp = await connect(createEngineClient({ baseUrl: 'http://127.0.0.1:3001', fetchImpl: refuse }));
        for (const [name, args] of [
            ['list_campaigns', {}],
            ['open_campaign', { campaignId: 'c1' }],
            ['record_turn', { campaignId: 'c1', playerAction: 'x', narration: 'y' }],
            ['update_character', { campaignId: 'c1', hpDelta: -1 }],
            ['update_npc', { campaignId: 'c1', name: 'Vash' }],
            ['update_notebook', { campaignId: 'c1', actions: [{ action: 'clear' }] }],
            ['recall_memory', { campaignId: 'c1', query: 'fire' }],
            ['recall_lore', { campaignId: 'c1', query: 'ash' }],
        ]) {
            const r = await mcp.call(name, args);
            expect(r.isError, name).toBe(true);
            expect(r.text, name).toMatch(/Narrative Engine is not running/);
            expect(r.text, name).toMatch(/Play_With_Claude\.bat/);
            expect(r.text, name).toMatch(/ECONNREFUSED/);
        }
        expect((await mcp.call('roll_dice', { expression: 'd20' })).isError).toBe(false);
        expect((await mcp.call('list_worlds')).isError).toBe(false);
        await mcp.close();
    });

    it('starts the engine once, retries, and the call succeeds', async () => {
        const engine = fakeEngineFetch();
        seedCampaign(engine.files);
        let up = false;
        const fetchImpl = async (url, init) => (up ? engine.fetchImpl(url, init) : refuse());
        const spawnImpl = vi.fn(() => { setTimeout(() => { up = true; }, 30); return { unref() {}, on() {} }; });
        const ensureEngine = createEngineLauncher({ baseUrl: 'http://127.0.0.1:3001', fetchImpl, spawnImpl, portTakenImpl: async () => false, logFile: TEST_LOG, timeoutMs: 5000, enabled: true });
        const mcp = await connect(createEngineClient({ baseUrl: 'http://127.0.0.1:3001', fetchImpl, ensureEngine }));
        const [a, b] = await Promise.all([mcp.call('list_campaigns'), mcp.call('open_campaign', { campaignId: 'c1' })]);
        expect(a.isError).toBe(false);
        expect(b.text).toContain('Ashfall');
        expect(spawnImpl).toHaveBeenCalledTimes(1);
        await mcp.close();
    });

    it('gives up after the timeout and says where the log is', async () => {
        const spawnImpl = vi.fn(() => ({ unref() {}, on() {} }));
        const ensureEngine = createEngineLauncher({ baseUrl: 'http://127.0.0.1:3001', fetchImpl: refuse, spawnImpl, portTakenImpl: async () => false, logFile: TEST_LOG, timeoutMs: 600, enabled: true });
        const mcp = await connect(createEngineClient({ baseUrl: 'http://127.0.0.1:3001', fetchImpl: refuse, ensureEngine }));
        const r = await mcp.call('list_campaigns');
        expect(r).toMatchObject({ isError: true, text: expect.stringMatching(/engine\.log/) });
        expect(spawnImpl).toHaveBeenCalledTimes(1);
        await mcp.close();
    });

    it('a hung engine times out instead of hanging the chat', async () => {
        const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
        const mcp = await connect(createEngineClient({ baseUrl: 'http://127.0.0.1:3001', fetchImpl: hang, timeoutMs: 100 }));
        const r = await mcp.call('list_campaigns');
        expect(r).toMatchObject({ isError: true, text: expect.stringMatching(/Narrative Engine is not running/) });
        await mcp.close();
    });
});

describe('briefing text', () => {
    const base = {
        campaign: { id: 'c1', name: 'Ashfall' }, rules: 'RULES', worldOverview: [], loreTopics: ['Ember Guild'], notebook: [], sceneNote: '',
        npcs: [], scenesArchived: 0, turnsPlayed: 0, recentTurns: [], starter: '', isNewCampaign: true,
        character: { name: 'Unnamed hero', stats: {}, inventory: [], traits: [] },
    };

    it('sends a new campaign to character creation, then the first scene', () => {
        expect(briefingText(base)).toMatch(/create the hero with the player, then open the first scene/);
        expect(briefingText({ ...base, starter: 'Interview the player.' })).toMatch(/follow the opening prompt/);
        expect(briefingText({ ...base, character: { ...base.character, name: 'Kira' } })).toMatch(/Begin now: open the first scene/);
    });

    it('gives the campaign id Claude needs for every later call', () => {
        expect(briefingText(base)).toMatch(/^# Ashfall \(campaignId: c1\)/);
    });
});

describe('tool trace for mcp.log', () => {
    it('records the dice total and the saved turn number, never the story text', () => {
        const dice = traceLine('roll_dice', { expression: '1d20+2', label: 'Stealth' }, { content: [], structuredContent: { view: 'dice', total: 14 } }, 3);
        expect(dice).toBe('[tool] roll_dice "1d20+2" (Stealth) -> ok total=14 (3 ms)');
        const turn = traceLine('record_turn', { campaignId: 'c1', playerAction: 'I run', narration: 'The secret door opens.' }, { content: [], structuredContent: { view: 'turn', turnNumber: 4 } }, 12);
        expect(turn).toMatch(/record_turn narration 22 chars, action 5 chars -> ok turn=4/);
        expect(turn).not.toMatch(/secret door/);
    });

    it('records failures with the start of the error', () => {
        const line = traceLine('recall_lore', { query: 'who rules' }, { isError: true, content: [{ type: 'text', text: 'Error: Narrative Engine is not running' }] }, 5);
        expect(line).toMatch(/recall_lore "who rules" -> ERROR Error: Narrative Engine is not running/);
    });

    it('logs one line per real tool call', async () => {
        const lines = [];
        const spy = vi.spyOn(console, 'error').mockImplementation((l) => lines.push(String(l)));
        try {
            const server = buildServer(createEngineClient({ baseUrl: 'http://127.0.0.1:1', fetchImpl: async () => { throw new Error('down'); } }));
            const [a, b] = InMemoryTransport.createLinkedPair();
            const client = new Client({ name: 't', version: '1' });
            await Promise.all([server.connect(a), client.connect(b)]);
            await client.callTool({ name: 'roll_dice', arguments: { expression: '2d6' } });
            await client.close();
        } finally { spy.mockRestore(); }
        expect(lines.filter((l) => l.includes('[tool] roll_dice "2d6" -> ok total='))).toHaveLength(1);
    });
});
