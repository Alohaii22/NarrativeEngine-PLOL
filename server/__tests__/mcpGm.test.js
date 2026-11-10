import { describe, it, expect, beforeEach } from 'vitest';
import { rollDice, describeRoll, DiceError, outcomeTier } from '../mcp/dice.js';
import * as gm from '../mcp/gm.js';
import { createEngineClient, EngineUnavailableError } from '../mcp/engineClient.js';
import { panelHtml, PANEL_URI } from '../mcp/views.js';
import { loadCampaignKit } from '../mcp/kit.js';

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
        locations: [
            { id: 'loc_hold', name: 'Cinderhold', aliases: 'the hold', features: ['gate'], connections: [] },
            { id: 'loc_market', name: 'Ash Market', aliases: '', features: [], connections: [] },
        ],
        chapters: [],
        timeline: [],
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
            // Like the engine: the first scene opens chapter CH01, later ones join the open chapter.
            let open = db.chapters.find((c) => !c.sealedAt);
            if (!open) db.chapters.push(open = { chapterId: `CH${String(db.chapters.length + 1).padStart(2, '0')}`, title: 'Open Chapter', sceneCount: 0 });
            open.sceneCount++;
            return { ok: true, sceneId };
        },
        getLocations: async () => structuredClone(db.locations),
        putLocations: async (_id, l) => { db.locations = structuredClone(l); return { ok: true }; },
        getChapters: async () => structuredClone(db.chapters),
        sealChapter: async (_id, title) => {
            const open = db.chapters.find((c) => !c.sealedAt);
            Object.assign(open, { sealedAt: Date.now(), title });
            const next = { chapterId: `CH${String(db.chapters.length + 1).padStart(2, '0')}`, title: 'Open Chapter', sceneCount: 0 };
            db.chapters.push(next);
            return { sealedChapter: structuredClone(open), newOpenChapter: next };
        },
        patchChapter: async (_id, chapterId, patch) => Object.assign(db.chapters.find((c) => c.chapterId === chapterId), patch),
        addTimelineEvent: async (_id, e) => { db.timeline.push(e); return { id: `tl_${db.timeline.length}`, ...e }; },
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
        expect(() => rollDice('')).toThrow(DiceError);
        expect(() => rollDice('d20+')).toThrow(DiceError);
        expect(() => rollDice('2d6kh')).toThrow(DiceError);
        expect(() => rollDice('1d20+3 (stealth)')).toThrow(/d20, 2d6\+3/);
    });

    it('reads the notation Claude tends to write', () => {
        expect(rollDice('D20', fixed(0.5)).total).toBe(11);
        expect(rollDice(' 2d6 + 3 ', fixed(0, 0)).total).toBe(5);
        expect(rollDice('d20-2', fixed(0)).total).toBe(-1);
        expect(rollDice('1d8+1d6+2', fixed(0.99, 0)).total).toBe(8 + 1 + 2);
        expect(rollDice('3d6-1d4', fixed(0, 0, 0, 0.99)).total).toBe(3 - 4);
        expect(rollDice('2d20kl1', fixed(0.99, 0)).groups[0]).toMatchObject({ rolls: [1], dropped: [20] });
        expect(rollDice('1d20 Advantage', fixed(0, 0.5)).mode).toBe('advantage');
        expect(rollDice('1d20+2 disadvantage', fixed(0.5, 0)).total).toBe(3);
    });

    it('stays inside the die for every random value', () => {
        for (const r of [0, 0.0001, 0.5, 0.9999, 0.999999999]) {
            const roll = rollDice('d20', () => r).total;
            expect(roll).toBeGreaterThanOrEqual(1);
            expect(roll).toBeLessThanOrEqual(20);
        }
        const many = rollDice('100d6').groups[0].rolls;
        expect(many).toHaveLength(100);
        expect(many.every((n) => Number.isInteger(n) && n >= 1 && n <= 6)).toBe(true);
    });

    it('advantage only doubles a single die, and keep-rules win over it', () => {
        const two = rollDice('2d6 adv', fixed(0, 0.99));
        expect(two.groups[0].rolls).toEqual([1, 6]);
        expect(two.groups[0].dropped).toEqual([]);
        expect(rollDice('4d6kh3 adv', fixed(0, 0.5, 0.99, 0.2)).total).toBe(12);
    });

    it('reports the outcome tier of a plain d20 and nothing for other dice', () => {
        const tierAt = (n) => rollDice('d20', () => (n - 1) / 20).tier;
        expect([1, 2, 3, 6, 7, 15, 16, 19, 20].map(tierAt)).toEqual([
            'Catastrophe', 'Catastrophe', 'Failure', 'Failure', 'Success', 'Success', 'Triumph', 'Triumph', 'Narrative Boon',
        ]);
        expect([1, 20].map(outcomeTier)).toEqual(['Catastrophe', 'Narrative Boon']);
        expect(rollDice('2d6').tier).toBeNull();
        expect(rollDice('d100').tier).toBeNull();
        expect(describeRoll(rollDice('d20+3', () => 0.5), 'Climb')).toBe('Climb: d20+3 → d20: [11] + 3 = **14** · tier: Success');
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

    it('keeps every change when Claude sends tool calls at the same time', async () => {
        // Slow engine: without the per-campaign queue each call reads the same
        // old state and the last write wipes the others out.
        const { getState, putState } = client;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        client.getState = async (id) => { await wait(5); return getState(id); };
        client.putState = async (id, s) => { await wait(5); return putState(id, s); };
        await Promise.all([
            gm.updateNotebook(client, 'c1', [{ action: 'add', text: 'Torch burns out in 3 turns' }]),
            gm.updateCharacter(client, 'c1', { hpDelta: -4 }),
            gm.recordTurn(client, 'c1', { playerAction: 'I light the torch.', narration: 'The dark pulls back.' }),
            gm.updateCharacter(client, 'c1', { inventory: [{ action: 'add', name: 'Torch' }] }),
            gm.upsertNpc(client, 'c1', { name: 'Mira', status: 'holding the rope' }),
            gm.upsertNpc(client, 'c1', { name: 'Oren', status: 'on watch' }),
        ]);
        expect(db.state.context.notebook.map((n) => n.text)).toEqual(['Torch burns out in 3 turns']);
        expect(db.state.context.characterProfileData.hp.current).toBe(10);
        expect(db.state.context.inventoryItems.map((i) => i.name)).toEqual(['Torch']);
        expect(db.state.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
        expect(db.npcs.map((n) => n.name)).toEqual(['Vash', 'Mira', 'Oren']);
    });

    it('a failed call does not block the ones queued behind it', async () => {
        const results = await Promise.allSettled([
            gm.updateCharacter(client, 'c1', { condition: 'sleepy' }),
            gm.updateCharacter(client, 'c1', { hpDelta: -1 }),
        ]);
        expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
        expect(db.state.context.characterProfileData.hp.current).toBe(13);
    });

    it('does not save the same turn twice when a call is retried', async () => {
        const turn = { playerAction: 'I knock.', narration: 'The door opens a crack.' };
        const first = await gm.recordTurn(client, 'c1', turn);
        const again = await gm.recordTurn(client, 'c1', { ...turn, narration: '  The door opens a crack.\n' });
        expect(first).toMatchObject({ turnNumber: 1, duplicate: false, sceneId: '001' });
        expect(again).toMatchObject({ turnNumber: 1, duplicate: true, sceneId: '001' });
        expect(db.state.messages).toHaveLength(2);
        expect(db.index).toHaveLength(1);
        const next = await gm.recordTurn(client, 'c1', { playerAction: 'I knock.', narration: 'Nobody answers this time.' });
        expect(next).toMatchObject({ turnNumber: 2, duplicate: false });
    });

    it('persists a turn in the shape the app reads, and returns only a receipt', async () => {
        db.state.condenser = { condensedUpToIndex: 3 };
        const t = await gm.recordTurn(client, 'c1', { playerAction: '', narration: 'Opening scene.', importance: 7 });
        expect(t).not.toHaveProperty('narration');
        expect(t.character.name).toBe('Kira');
        const saved = db.puts.at(-1);
        expect(saved.messages).toEqual([expect.objectContaining({ role: 'assistant', content: 'Opening scene.', sceneId: '001', id: expect.stringMatching(/^msg_/), timestamp: expect.any(Number) })]);
        // The rest of the campaign state rides along untouched.
        expect(saved.context.rulesRaw).toBe('Be gritty.');
        expect(saved.condenser).toEqual({ condensedUpToIndex: 3 });
        expect(saved.pinnedExcerpts).toEqual([{ id: 'p1' }]);
    });

    it('refuses to write to a campaign that does not exist', async () => {
        await expect(gm.recordTurn(client, 'nope', { playerAction: 'x', narration: 'y' })).rejects.toThrow(/list_campaigns/);
        await expect(gm.updateCharacter(client, 'nope', { hpDelta: 1 })).rejects.toThrow(/list_campaigns/);
        await expect(gm.updateNotebook(client, 'nope', [{ action: 'clear' }])).rejects.toThrow(/list_campaigns/);
        await expect(gm.upsertNpc(client, 'nope', { name: 'Ghost' })).rejects.toThrow(/list_campaigns/);
        expect(db.puts).toHaveLength(0);
        expect(db.index).toHaveLength(0);
    });

    it('creates a hero at full health and keeps a hurt hero hurt', async () => {
        db.state.context.characterProfileData = undefined;
        db.state.context.playerCharacter = undefined;
        let r = await gm.updateCharacter(client, 'c1', { name: 'Brann', class: 'Smith', hpMax: 30, mpMax: 8, condition: 'healthy' });
        expect(r.sheet).toMatchObject({ name: 'Brann', class: 'Smith', hp: { current: 30, max: 30 }, mp: { current: 8, max: 8 }, condition: 'healthy' });
        r = await gm.updateCharacter(client, 'c1', { hpDelta: -12 });
        r = await gm.updateCharacter(client, 'c1', { hpMax: 36 });
        expect(r.sheet.hp).toEqual({ current: 18, max: 36 });
        r = await gm.updateCharacter(client, 'c1', { hpMax: 10 });
        expect(r.sheet.hp).toEqual({ current: 10, max: 10 });
    });

    it('keeps what it hands back to Claude short', async () => {
        db.lore = [
            ...Array.from({ length: 12 }, (_, i) => ({ id: `o${i}`, header: `Overview ${i}`, content: 'x'.repeat(5000), alwaysInclude: true })),
            { id: 'big', header: 'Dragons', content: `dragon ${'y'.repeat(9000)}`, triggerKeywords: ['dragon'] },
        ];
        db.state.messages = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `${i} ${'z'.repeat(6000)}`, timestamp: i }));
        const b = await gm.openCampaign(client, 'c1');
        expect(b.worldOverview.reduce((n, l) => n + l.content.length, 0)).toBeLessThan(9000);
        expect(b.recentTurns).toHaveLength(12);
        expect(b.turnsPlayed).toBe(20);
        expect(b.recentTurns.reduce((n, t) => n + t.text.length, 0)).toBeLessThan(20_000);
        // The last GM reply is the one play resumes from, so it gets the most room.
        expect(b.recentTurns.at(-1).text.length).toBeGreaterThan(b.recentTurns[0].text.length);
        expect((await gm.openCampaign(client, 'c1', { recentTurns: 0 })).recentTurns).toEqual([]);
        const lore = await gm.recallLore(client, 'c1', 'dragon');
        expect(lore.results[0].content.length).toBeLessThan(2600);
    });

    it('still saves the turn when the archive is down', async () => {
        client.appendScene = async () => { throw new Error('down'); };
        const t = await gm.recordTurn(client, 'c1', { playerAction: '', narration: 'Opening scene.' });
        expect(t.sceneId).toBeNull();
        expect(db.state.messages).toHaveLength(1);
        await expect(gm.recordTurn(client, 'c1', { playerAction: 'x', narration: ' ' })).rejects.toThrow(/narration/);
    });
});

describe('Claude-only bookkeeping (what the app otherwise does with its own AI model)', () => {
    let db;
    let client;
    let kit;
    beforeEach(async () => {
        ({ db, client } = fakeEngine());
        kit ??= await loadCampaignKit();
    });

    it('moves the current place from the 📍 header with the app\'s own parser', async () => {
        let t = await gm.recordTurn(client, 'c1', { playerAction: '', narration: '📅 Dusk | 📍 Cinderhold - the forge | 👥 Vash\n\nSparks climb the dark.' }, { kit });
        expect(t.location).toEqual({ place: 'Cinderhold', feature: 'the forge', newPlace: null });
        expect(db.state.context).toMatchObject({ currentPlaceId: 'loc_hold', currentFeature: 'the forge' });
        expect(db.locations.find((l) => l.id === 'loc_hold').features).toEqual(['gate', 'the forge']);

        // A place the world does not have yet is added to Places, as the app does.
        t = await gm.recordTurn(client, 'c1', { playerAction: 'I leave.', narration: '📅 Night | 📍 Salt Road - milestone | 👥 Nobody\n\nWind.' }, { kit });
        expect(t.location).toMatchObject({ place: 'Salt Road', feature: 'milestone', newPlace: 'Salt Road' });
        expect(db.locations.map((l) => l.name)).toContain('Salt Road');

        // No header: the place stays where it was and the turn still saves.
        t = await gm.recordTurn(client, 'c1', { playerAction: 'I wait.', narration: 'Nothing moves.' }, { kit });
        expect(t.location).toBeNull();
        expect(db.state.context.currentPlaceId).toBe(db.locations.find((l) => l.name === 'Salt Road').id);
        expect(db.state.messages.filter((m) => m.role === 'assistant')).toHaveLength(3);

        const b = await gm.openCampaign(client, 'c1');
        expect(b.location).toEqual({ place: 'Salt Road', feature: 'milestone' });
        expect(b.places).toContain('Cinderhold');
    });

    it('saves the turn even when location tracking cannot run', async () => {
        const t = await gm.recordTurn(client, 'c1', { playerAction: '', narration: '📅 Dusk | 📍 Cinderhold | 👥 Vash\n\nText.' });
        expect(t.location).toBeNull();
        client.getLocations = async () => { throw new Error('locations file corrupt'); };
        const t2 = await gm.recordTurn(client, 'c1', { playerAction: 'go', narration: '📅 Dusk | 📍 Cinderhold | 👥 Vash\n\nMore.' }, { kit });
        expect(t2.sceneId).toBe('002');
        expect(db.state.messages.filter((m) => m.role === 'assistant')).toHaveLength(2);
    });

    it('files Claude\'s timeline events under the scene and open chapter', async () => {
        const t = await gm.recordTurn(client, 'c1', {
            playerAction: 'I take the key.',
            narration: 'The key is yours.',
            events: [{ subject: 'Kira', predicate: 'holds', object: 'the vault key', importance: 6 }],
        });
        expect(t.timelineEvents).toBe(1);
        expect(db.timeline).toEqual([{ subject: 'Kira', predicate: 'holds', object: 'the vault key', summary: 'Kira holds the vault key', importance: 6, sceneId: '001', chapterId: 'CH01' }]);
        await expect(gm.recordTurn(client, 'c1', { playerAction: 'x', narration: 'y', events: Array(6).fill({ subject: 'a', predicate: 'misc', object: 'b' }) })).rejects.toThrow(/At most 5/);
    });

    it('closes a chapter with Claude\'s summary and shows it as the story so far', async () => {
        await expect(gm.closeChapter(client, 'c1', { title: 'Too soon', summary: 'Nothing has happened yet at all.' })).rejects.toThrow(/no recorded scenes/);
        await gm.recordTurn(client, 'c1', { playerAction: '', narration: 'Opening.' });
        await gm.recordTurn(client, 'c1', { playerAction: 'Go on.', narration: 'The gate opens.' });
        const r = await gm.closeChapter(client, 'c1', { title: 'The Gate', summary: 'Kira reached Cinderhold and the gate opened.', unresolvedThreads: ['Who sent the letter?'] });
        expect(r).toEqual({ chapterId: 'CH01', title: 'The Gate', sceneCount: 2, nextChapterId: 'CH02' });
        expect(db.chapters[0]).toMatchObject({ title: 'The Gate', summary: 'Kira reached Cinderhold and the gate opened.', synopsis: 'Kira reached Cinderhold and the gate opened.', unresolvedThreads: ['Who sent the letter?'] });
        expect((await gm.openCampaign(client, 'c1')).storySoFar).toEqual([{ title: 'The Gate', summary: 'Kira reached Cinderhold and the gate opened.' }]);
        await expect(gm.closeChapter(client, 'c1', { title: '', summary: 'x' })).rejects.toThrow(/title and a summary/);
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
