import { describe, it, expect, beforeEach } from 'vitest';
import { rollDice, describeRoll, DiceError } from '../mcp/dice.js';
import * as gm from '../mcp/gm.js';
import { createEngineClient, EngineUnavailableError } from '../mcp/engineClient.js';
import { panelHtml, PANEL_URI } from '../mcp/views.js';

/** In-memory stand-in for the engine HTTP API. */
function fakeEngine() {
    const db = {
        campaigns: [{ id: 'c1', name: 'Ashfall', lastPlayedAt: 1700000000000 }],
        state: {
            context: {
                rulesRaw: 'Be gritty.',
                starter: 'You wake in ash.',
                playerCharacter: { name: 'Kira' },
                characterProfileData: { name: 'Kira', race: 'Human', class: 'Ranger', level: 2, hp: { current: 14, max: 18 }, stats: { DEX: 16 }, skills: [], abilities: [], traits: [], notes: '' },
                inventoryItems: [],
                notebook: [],
            },
            messages: [],
            pinnedExcerpts: [{ id: 'p1' }],
        },
        lore: [
            { id: 'l1', header: 'The Ashfall', content: 'A cataclysm.', alwaysInclude: true, category: 'world_overview', triggerKeywords: [] },
            { id: 'l2', header: 'Ember Guild', content: 'Smugglers of embersteel.', alwaysInclude: false, category: 'faction', triggerKeywords: ['embersteel'] },
            { id: 'l3', header: 'Hidden', content: 'embersteel secret', disabled: true, triggerKeywords: ['embersteel'] },
        ],
        npcs: [{ id: 'n1', name: 'Vash', aliases: 'The Ember King', status: 'in Cinderhold', faction: 'Ember Guild' }],
        index: [],
        scenes: [],
        puts: [],
    };
    const client = {
        listCampaigns: async () => db.campaigns,
        getCampaign: async (id) => db.campaigns.find((c) => c.id === id) ?? null,
        getState: async (id) => (id === 'c1' ? structuredClone(db.state) : null),
        putState: async (_id, s) => { db.puts.push(s); db.state = structuredClone(s); return { ok: true }; },
        getLore: async () => db.lore,
        getNpcs: async () => structuredClone(db.npcs),
        putNpcs: async (_id, n) => { db.npcs = n; return { ok: true }; },
        loreSearch: async () => ({ loreIds: [], pending: true }),
        archiveSearch: async () => ({ sceneIds: [], pending: true }),
        getArchiveIndex: async () => db.index,
        getScenes: async (_id, ids) => db.scenes.filter((s) => ids.includes(s.sceneId)),
        appendScene: async (_id, user, assistant) => {
            const sceneId = String(db.index.length + 1).padStart(3, '0');
            db.index.push({ sceneId, keywords: ['embersteel'], userSnippet: user, npcsMentioned: [], witnesses: [] });
            db.scenes.push({ sceneId, content: `## SCENE ${sceneId}\n${user}\n${assistant}` });
            return { ok: true, sceneId };
        },
    };
    return { db, client };
}

describe('rollDice', () => {
    const fixed = (...values) => { let i = 0; return () => values[i++ % values.length]; };

    it('rolls notation with modifiers', () => {
        const r = rollDice('2d6+3', fixed(0, 0.99));
        expect(r.groups[0].rolls).toEqual([1, 6]);
        expect(r.total).toBe(10);
    });

    it('keeps highest', () => {
        const r = rollDice('4d6kh3', fixed(0, 0.5, 0.99, 0.2));
        expect(r.groups[0].rolls).toEqual([6, 4, 2]);
        expect(r.groups[0].dropped).toEqual([1]);
        expect(r.total).toBe(12);
    });

    it('handles advantage, disadvantage and crits', () => {
        const adv = rollDice('d20+5 adv', fixed(0.99, 0.3));
        expect(adv.natural).toBe(20);
        expect(adv.critical).toBe('success');
        expect(adv.total).toBe(25);
        const dis = rollDice('d20 dis', fixed(0.99, 0));
        expect(dis.total).toBe(1);
        expect(dis.critical).toBe('failure');
        expect(describeRoll(adv, 'Perception')).toContain('NATURAL 20');
    });

    it('rejects nonsense and absurd sizes', () => {
        expect(() => rollDice('banana')).toThrow(DiceError);
        expect(() => rollDice('5')).toThrow(DiceError);
        expect(() => rollDice('1000d6')).toThrow(DiceError);
        expect(() => rollDice('d1')).toThrow(DiceError);
    });
});

describe('GM operations', () => {
    let db, client;
    beforeEach(() => ({ db, client } = fakeEngine()));

    it('opens a campaign with rules, overview and hero', async () => {
        const b = await gm.openCampaign(client, 'c1');
        expect(b.rules).toBe('Be gritty.');
        expect(b.worldOverview.map((l) => l.header)).toEqual(['The Ashfall']);
        expect(b.loreTopics).not.toContain('Hidden');
        expect(b.character.name).toBe('Kira');
        expect(b.isNewCampaign).toBe(true);
        expect(b.starter).toBe('You wake in ash.');
    });

    it('rejects an unknown campaign', async () => {
        await expect(gm.openCampaign(client, 'nope')).rejects.toThrow(/list_campaigns/);
    });

    it('falls back to keyword lore recall and skips disabled lore', async () => {
        const r = await gm.recallLore(client, 'c1', 'who trades embersteel?');
        expect(r.method).toBe('keyword');
        expect(r.results.map((x) => x.header)).toEqual(['Ember Guild']);
    });

    it('prefers semantic lore hits when the vector index is ready', async () => {
        client.loreSearch = async () => ({ loreIds: ['l1'] });
        const r = await gm.recallLore(client, 'c1', 'embersteel');
        expect(r.method).toBe('semantic+keyword');
        expect(r.results.map((x) => x.header)).toEqual(['The Ashfall', 'Ember Guild']);
    });

    it('finds NPCs by alias and adds new ones', async () => {
        const got = await gm.getNpcs(client, 'c1', ['the ember king', 'Nobody']);
        expect(got.npcs[0]).toMatchObject({ found: true, name: 'Vash' });
        expect(got.npcs[1]).toMatchObject({ found: false });
        const created = await gm.upsertNpc(client, 'c1', { name: 'Mira', status: 'scouting' });
        expect(created.created).toBe(true);
        const updated = await gm.upsertNpc(client, 'c1', { name: 'vash', condition: 'wounded' });
        expect(updated).toMatchObject({ created: false, changed: ['condition'] });
        expect(db.npcs.map((n) => n.name)).toEqual(['Vash', 'Mira']);
        await expect(gm.upsertNpc(client, 'c1', { name: 'X', condition: 'sleepy' })).rejects.toThrow();
    });

    it('updates HP within bounds and manages inventory', async () => {
        let r = await gm.updateCharacter(client, 'c1', { hpDelta: -50, inventory: [{ action: 'add', name: 'Rope', qty: 2 }] });
        expect(r.sheet.hp).toEqual({ current: 0, max: 18 });
        r = await gm.updateCharacter(client, 'c1', { hpDelta: 5, inventory: [{ action: 'add', name: 'rope' }, { action: 'equip', name: 'Rope' }] });
        expect(r.sheet.hp.current).toBe(5);
        expect(r.sheet.inventory).toEqual([expect.objectContaining({ name: 'Rope', qty: 3, equipped: true })]);
        r = await gm.updateCharacter(client, 'c1', { inventory: [{ action: 'remove', name: 'Rope', qty: 3 }] });
        expect(r.sheet.inventory).toEqual([]);
    });

    it('never drops pinned memories when saving state', async () => {
        await gm.updateNotebook(client, 'c1', [{ action: 'add', text: 'Storm in 2h' }]);
        expect(db.puts.at(-1).pinnedExcerpts).toEqual([{ id: 'p1' }]);
        expect(db.state.context.notebook.map((n) => n.text)).toEqual(['Storm in 2h']);
        await gm.updateNotebook(client, 'c1', [{ action: 'remove', text: 'storm' }]);
        expect(db.state.context.notebook).toEqual([]);
        await expect(gm.updateNotebook(client, 'c1', Array(6).fill({ action: 'clear' }))).rejects.toThrow();
    });

    it('records a turn as chat messages plus an archived scene, then recalls it', async () => {
        const t = await gm.recordTurn(client, 'c1', { playerAction: 'I dig for embersteel.', narration: 'You find a shard.' });
        expect(t).toMatchObject({ sceneId: '001', turnNumber: 1 });
        expect(db.state.messages.map((m) => [m.role, m.content, m.sceneId])).toEqual([
            ['user', 'I dig for embersteel.', undefined],
            ['assistant', 'You find a shard.', '001'],
        ]);
        const mem = await gm.recallMemory(client, 'c1', 'embersteel');
        expect(mem.scenes.map((s) => s.sceneId)).toEqual(['001']);
        const reopened = await gm.openCampaign(client, 'c1');
        expect(reopened.isNewCampaign).toBe(false);
        expect(reopened.recentTurns.map((r) => r.role)).toEqual(['player', 'gm']);
    });

    it('still saves the turn when the archive is down', async () => {
        client.appendScene = async () => { throw new Error('down'); };
        const t = await gm.recordTurn(client, 'c1', { playerAction: '', narration: 'Opening scene.' });
        expect(t.sceneId).toBeNull();
        expect(db.state.messages).toHaveLength(1);
        await expect(gm.recordTurn(client, 'c1', { playerAction: 'x', narration: ' ' })).rejects.toThrow(/narration/);
    });
});

describe('engine client', () => {
    it('tags writes as MCP and explains when the engine is down', async () => {
        const calls = [];
        const client = createEngineClient({
            baseUrl: 'http://engine.test/',
            fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response('{"ok":true}', { status: 200 }); },
        });
        await client.getState('c1');
        await client.putState('c1', { messages: [] });
        expect(calls[0].url).toBe('http://engine.test/api/campaigns/c1/state');
        expect(calls[0].init.headers['X-NE-Writer']).toBeUndefined();
        expect(calls[1].init.headers['X-NE-Writer']).toBe('mcp');

        const down = createEngineClient({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
        await expect(down.listCampaigns()).rejects.toThrow(EngineUnavailableError);
        await expect(down.listCampaigns()).rejects.toThrow(/npm run dev/);
    });
});

describe('panel', () => {
    it('inlines the MCP Apps client so the panel needs no network', () => {
        const html = panelHtml();
        expect(PANEL_URI.startsWith('ui://')).toBe(true);
        expect(html).toContain('const App =');
        expect(html).not.toMatch(/<script[^>]+src=/);
        expect(html).not.toMatch(/^\s*export\s*\{/m);
    });
});
