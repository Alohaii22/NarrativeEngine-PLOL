/**
 * Game-master operations behind the MCP tools. Pure logic over an engine
 * client (engineClient.js), so it can be tested against a fake.
 */
import crypto from 'crypto';

const MAX_NOTEBOOK_NOTES = 50;
const MAX_RULES_CHARS = 60_000;
const MAX_LORE_CHARS = 4_000;
const NPC_TEXT_FIELDS = ['aliases', 'appearance', 'faction', 'storyRelevance', 'status', 'voice', 'personality'];
const NPC_CONDITIONS = ['healthy', 'wounded', 'critical', 'dead'];
const INVENTORY_CATEGORIES = ['weapon', 'armor', 'consumable', 'currency', 'key', 'misc', 'equipped'];

export const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

function clip(text, max) {
    const s = String(text ?? '');
    return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}

function words(text) {
    return String(text ?? '').toLowerCase().match(/[\p{L}\p{N}']{3,}/gu) ?? [];
}

const norm = (s) => String(s ?? '').trim().toLowerCase();

async function requireState(client, campaignId) {
    const state = await client.getState(campaignId);
    if (!state) throw new Error(`No campaign "${campaignId}". Call list_campaigns to see the ids.`);
    return state;
}

/** PUT /state is a full overwrite: always send every field back. */
function saveState(client, campaignId, state) {
    return client.putState(campaignId, {
        context: state.context ?? {},
        messages: state.messages ?? [],
        condenser: state.condenser,
        pinnedExcerpts: state.pinnedExcerpts ?? [],
    });
}

// ── Campaigns ───────────────────────────────────────────────────────────

export async function listCampaigns(client) {
    const campaigns = (await client.listCampaigns()) ?? [];
    return campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        lastPlayedAt: c.lastPlayedAt ? new Date(c.lastPlayedAt).toISOString() : null,
    }));
}

export function characterSheet(context) {
    const pc = context?.playerCharacter ?? null;
    const data = context?.characterProfileData ?? {};
    return {
        name: pc?.name || data.name || 'Unnamed hero',
        race: data.race || '',
        class: data.class || '',
        level: data.level ?? null,
        hp: data.hp ?? null,
        mp: data.mp ?? null,
        stats: data.stats ?? context?.characterProfile?.stats ?? {},
        skills: data.skills ?? [],
        abilities: data.abilities ?? [],
        traits: [
            ...(data.traits ?? []),
            ...((context?.characterProfile?.activeTraits ?? []).map((t) => t.text ?? t.trait ?? '').filter(Boolean)),
        ].slice(0, 12),
        appearance: pc?.appearance || '',
        personality: pc?.personality || '',
        condition: pc?.condition || null,
        notes: data.notes || '',
        inventory: (context?.inventoryItems ?? []).map((i) => ({
            name: i.name, qty: i.qty, category: i.category, equipped: !!i.equipped, notes: i.notes || '',
        })),
    };
}

function npcSummary(npc) {
    return {
        name: npc.name,
        status: npc.status || '',
        faction: npc.faction || '',
        condition: npc.condition || null,
        storyRelevance: clip(npc.storyRelevance, 160),
    };
}

export async function openCampaign(client, campaignId, { recentTurns = 8 } = {}) {
    const [meta, state, lore, npcs, archive] = await Promise.all([
        client.getCampaign(campaignId),
        client.getState(campaignId),
        client.getLore(campaignId),
        client.getNpcs(campaignId),
        client.getArchiveIndex(campaignId).catch(() => []),
    ]);
    if (!meta && !state) throw new Error(`No campaign "${campaignId}". Call list_campaigns to see the ids.`);
    const context = state?.context ?? {};
    const messages = (state?.messages ?? []).filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.ephemeral && m.content);
    const recent = messages.slice(-recentTurns * 2).map((m) => ({
        role: m.role === 'user' ? 'player' : 'gm',
        text: clip(m.displayContent || m.content, 3_000),
    }));
    const chunks = (lore ?? []).filter((c) => !c.disabled);
    const alwaysLore = chunks
        .filter((c) => c.alwaysInclude || c.ragMode === 'always' || c.category === 'world_overview')
        .slice(0, 8)
        .map((c) => ({ header: c.header, content: clip(c.content, MAX_LORE_CHARS) }));

    return {
        campaign: { id: campaignId, name: meta?.name ?? campaignId },
        rules: clip(context.rulesRaw, MAX_RULES_CHARS),
        worldOverview: alwaysLore,
        loreTopics: chunks.map((c) => c.header).slice(0, 150),
        character: characterSheet(context),
        notebook: (context.notebook ?? []).map((n) => n.text),
        sceneNote: context.sceneNoteActive ? context.sceneNote || '' : '',
        npcs: (npcs ?? []).filter((n) => !n.isPC).map(npcSummary).slice(0, 60),
        scenesArchived: Array.isArray(archive) ? archive.length : 0,
        recentTurns: recent,
        starter: messages.length === 0 ? (context.starter || '') : '',
        isNewCampaign: messages.length === 0,
    };
}

// ── Recall ──────────────────────────────────────────────────────────────

export function keywordScore(query, text, keywords = []) {
    const q = new Set(words(query));
    if (q.size === 0) return 0;
    const body = words(text);
    let score = 0;
    for (const w of body) if (q.has(w)) score += 1;
    for (const k of keywords) if (q.has(norm(k)) || words(k).some((w) => q.has(w))) score += 3;
    return score;
}

export async function recallLore(client, campaignId, query, limit = 5) {
    const chunks = ((await client.getLore(campaignId)) ?? []).filter((c) => !c.disabled);
    const byId = new Map(chunks.map((c) => [c.id, c]));
    let ids = [];
    let semantic = false;
    try {
        const res = await client.loreSearch(campaignId, query, limit);
        if (res && !res.pending && Array.isArray(res.loreIds)) {
            ids = res.loreIds.filter((id) => byId.has(id));
            semantic = ids.length > 0;
        }
    } catch { /* vector search is optional; keyword recall below always works */ }

    const keywordHits = chunks
        .map((c) => ({ c, s: keywordScore(query, `${c.header} ${c.content}`, [...(c.triggerKeywords ?? []), ...(c.linkedEntities ?? [])]) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.c.id);
    for (const id of keywordHits) if (!ids.includes(id)) ids.push(id);

    return {
        query,
        method: semantic ? 'semantic+keyword' : 'keyword',
        results: ids.slice(0, limit).map((id) => {
            const c = byId.get(id);
            return { header: c.header, category: c.category, content: clip(c.content, MAX_LORE_CHARS) };
        }),
    };
}

export async function recallMemory(client, campaignId, query, limit = 4) {
    let sceneIds = [];
    let semantic = false;
    try {
        const res = await client.archiveSearch(campaignId, query, limit);
        if (res && !res.pending && Array.isArray(res.sceneIds)) {
            sceneIds = res.sceneIds.slice(0, limit);
            semantic = sceneIds.length > 0;
        }
    } catch { /* fall back to keywords */ }

    if (sceneIds.length < limit) {
        const index = (await client.getArchiveIndex(campaignId).catch(() => [])) ?? [];
        const hits = index
            .map((e) => ({ id: e.sceneId, s: keywordScore(query, e.userSnippet, [...(e.keywords ?? []), ...(e.npcsMentioned ?? []), ...(e.witnesses ?? [])]) }))
            .filter((x) => x.s > 0 && !sceneIds.includes(x.id))
            .sort((a, b) => b.s - a.s);
        sceneIds.push(...hits.slice(0, limit - sceneIds.length).map((x) => x.id));
    }
    const scenes = sceneIds.length ? ((await client.getScenes(campaignId, sceneIds)) ?? []) : [];
    return {
        query,
        method: semantic ? 'semantic+keyword' : 'keyword',
        scenes: scenes.map((s) => ({ sceneId: s.sceneId, content: clip(s.content, 3_000) })),
    };
}

// ── NPCs ────────────────────────────────────────────────────────────────

function findNpc(npcs, name) {
    const n = norm(name);
    return npcs.find((x) => norm(x.name) === n)
        ?? npcs.find((x) => String(x.aliases ?? '').split(',').map(norm).includes(n))
        ?? null;
}

export async function getNpcs(client, campaignId, names) {
    const npcs = ((await client.getNpcs(campaignId)) ?? []).filter((n) => !n.isPC);
    if (!names || names.length === 0) return { npcs: npcs.map(npcSummary) };
    return {
        npcs: names.map((name) => {
            const npc = findNpc(npcs, name);
            if (!npc) return { name, found: false };
            const out = { found: true, name: npc.name, condition: npc.condition || null };
            for (const f of NPC_TEXT_FIELDS) if (npc[f]) out[f] = npc[f];
            return out;
        }),
    };
}

export async function upsertNpc(client, campaignId, input) {
    const name = String(input?.name ?? '').trim();
    if (!name) throw new Error('NPC name is required');
    const npcs = (await client.getNpcs(campaignId)) ?? [];
    let npc = findNpc(npcs.filter((n) => !n.isPC), name);
    const created = !npc;
    if (!npc) {
        npc = { id: newId('npc'), name, aliases: '', appearance: '', faction: '', storyRelevance: '', status: '', voice: '', personality: '', exampleOutput: '' };
        npcs.push(npc);
    }
    const changed = [];
    for (const f of NPC_TEXT_FIELDS) {
        if (typeof input[f] === 'string' && input[f] !== npc[f]) { npc[f] = input[f]; changed.push(f); }
    }
    if (input.condition !== undefined) {
        if (!NPC_CONDITIONS.includes(input.condition)) throw new Error(`condition must be one of ${NPC_CONDITIONS.join(', ')}`);
        if (npc.condition !== input.condition) { npc.condition = input.condition; changed.push('condition'); }
    }
    if (created || changed.length) await client.putNpcs(campaignId, npcs);
    return { name: npc.name, created, changed };
}

// ── Character & notebook ────────────────────────────────────────────────

const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v))));

export async function updateCharacter(client, campaignId, patch = {}) {
    const state = await requireState(client, campaignId);
    const context = state.context ?? (state.context = {});
    const data = context.characterProfileData ?? (context.characterProfileData = {
        name: context.playerCharacter?.name ?? '', race: '', class: '', level: 1,
        hp: { current: 10, max: 10 }, stats: {}, skills: [], abilities: [], traits: [], notes: '',
    });
    const log = [];

    if (patch.hpDelta !== undefined || patch.hpMax !== undefined || patch.hpSet !== undefined) {
        const hp = data.hp ?? (data.hp = { current: 10, max: 10 });
        if (patch.hpMax !== undefined) hp.max = clampInt(patch.hpMax, 1, 1_000_000);
        if (patch.hpSet !== undefined) hp.current = clampInt(patch.hpSet, 0, hp.max);
        if (patch.hpDelta !== undefined) hp.current = clampInt(hp.current + Number(patch.hpDelta), 0, hp.max);
        log.push(`HP ${hp.current}/${hp.max}`);
    }
    if (patch.mpDelta !== undefined || patch.mpMax !== undefined) {
        const mp = data.mp ?? (data.mp = { current: 0, max: 0 });
        if (patch.mpMax !== undefined) mp.max = clampInt(patch.mpMax, 0, 1_000_000);
        if (patch.mpDelta !== undefined) mp.current = clampInt(mp.current + Number(patch.mpDelta), 0, mp.max);
        log.push(`MP ${mp.current}/${mp.max}`);
    }
    if (patch.level !== undefined) { data.level = clampInt(patch.level, 1, 1000); log.push(`level ${data.level}`); }
    if (patch.stats && typeof patch.stats === 'object') {
        data.stats = { ...(data.stats ?? {}) };
        for (const [k, v] of Object.entries(patch.stats)) if (Number.isFinite(Number(v))) data.stats[k] = Number(v);
        log.push(`stats ${Object.keys(patch.stats).join(', ')}`);
    }
    for (const f of ['name', 'race', 'class']) {
        if (typeof patch[f] === 'string' && patch[f].trim()) {
            data[f] = patch[f].trim();
            if (f === 'name') {
                context.playerCharacter = { ...(context.playerCharacter ?? { id: newId('pc'), aliases: '', faction: '', storyRelevance: 'Player character', status: '', voice: '', exampleOutput: '' }), name: data.name };
            }
            log.push(`${f} ${data[f]}`);
        }
    }
    for (const f of ['appearance', 'personality']) {
        if (typeof patch[f] === 'string' && patch[f].trim()) {
            context.playerCharacter = { ...(context.playerCharacter ?? { id: newId('pc'), name: data.name || 'Hero' }), [f]: patch[f].trim() };
            log.push(f);
        }
    }
    if (Array.isArray(patch.skills)) { data.skills = patch.skills.map(String); log.push('skills'); }
    if (Array.isArray(patch.abilities)) { data.abilities = patch.abilities.map(String); log.push('abilities'); }
    if (Array.isArray(patch.traits)) { data.traits = patch.traits.map(String); log.push('traits'); }
    if (typeof patch.notes === 'string') { data.notes = patch.notes; log.push('notes'); }
    if (patch.condition !== undefined && context.playerCharacter) {
        if (!NPC_CONDITIONS.includes(patch.condition)) throw new Error(`condition must be one of ${NPC_CONDITIONS.join(', ')}`);
        context.playerCharacter.condition = patch.condition;
        log.push(`condition ${patch.condition}`);
    }

    const items = context.inventoryItems ?? (context.inventoryItems = []);
    for (const op of patch.inventory ?? []) {
        const name = String(op?.name ?? '').trim();
        if (!name) continue;
        const existing = items.find((i) => norm(i.name) === norm(name));
        const qty = Number.isFinite(Number(op.qty)) ? Math.round(Number(op.qty)) : 1;
        if (op.action === 'remove') {
            if (!existing) continue;
            existing.qty -= qty;
            if (existing.qty <= 0) items.splice(items.indexOf(existing), 1);
            log.push(`-${qty} ${existing.name}`);
        } else if (op.action === 'add') {
            if (existing) existing.qty += qty;
            else items.push({
                id: newId('item'), name, qty,
                category: INVENTORY_CATEGORIES.includes(op.category) ? op.category : 'misc',
                keywords: words(name), equipped: !!op.equipped, lastUsedScene: '', importance: 5, notes: op.notes ?? '',
            });
            log.push(`+${qty} ${name}`);
        } else if (op.action === 'equip' || op.action === 'unequip') {
            if (existing) { existing.equipped = op.action === 'equip'; log.push(`${op.action} ${existing.name}`); }
        }
    }

    await saveState(client, campaignId, state);
    return { changes: log, sheet: characterSheet(context) };
}

export async function updateNotebook(client, campaignId, actions = []) {
    if (actions.length > 5) throw new Error('At most 5 notebook actions per call');
    const state = await requireState(client, campaignId);
    const context = state.context ?? (state.context = {});
    let notes = [...(context.notebook ?? [])];
    for (const a of actions) {
        if (a.action === 'clear') notes = [];
        else if (a.action === 'add' && a.text) notes.push({ id: newId('note'), text: String(a.text), timestamp: Date.now() });
        else if (a.action === 'remove' && a.text) {
            const t = norm(a.text);
            notes = notes.filter((n) => !norm(n.text).includes(t));
        }
    }
    context.notebook = notes.slice(-MAX_NOTEBOOK_NOTES);
    await saveState(client, campaignId, state);
    return { notebook: context.notebook.map((n) => n.text) };
}

// ── Turns ───────────────────────────────────────────────────────────────

/**
 * Save one exchange as a real Narrative Engine turn: the player's action and
 * the GM's narration become chat messages, and the scene goes into the
 * long-term archive (keyword index + vector embedding) so recall finds it later.
 */
export async function recordTurn(client, campaignId, { playerAction, narration, importance }) {
    const player = String(playerAction ?? '').trim();
    const gm = String(narration ?? '').trim();
    if (!gm) throw new Error('narration is required: pass the exact narration you showed the player');
    const state = await requireState(client, campaignId);

    let sceneId;
    try {
        const archived = await client.appendScene(campaignId, player || '(continue)', gm, importance);
        sceneId = archived?.sceneId;
    } catch (err) {
        // The turn is still saved to the chat; only long-term recall misses it.
        console.error('[MCP] archive append failed:', err.message);
    }

    const now = Date.now();
    const messages = state.messages ?? (state.messages = []);
    if (player) messages.push({ id: newId('msg'), role: 'user', content: player, timestamp: now });
    messages.push({ id: newId('msg'), role: 'assistant', content: gm, timestamp: now + 1, ...(sceneId ? { sceneId } : {}) });
    await saveState(client, campaignId, state);

    return {
        sceneId: sceneId ?? null,
        turnNumber: messages.filter((m) => m.role === 'assistant').length,
        playerAction: player,
        narration: gm,
        character: characterSheet(state.context),
        notebook: (state.context?.notebook ?? []).map((n) => n.text),
    };
}

// ── New campaigns ───────────────────────────────────────────────────────

/**
 * Create a campaign from a bundled world, built by the same code as the
 * app's New Campaign form (src/services/campaignKit.ts).
 * `kit` is the loaded campaign kit; `files` holds the texts to build from.
 */
export async function createCampaign(client, kit, { name, loreText, rulesText, lootText, starterText }) {
    const built = kit.buildCampaignFromMarkdown({ loreText, rulesText, lootText });
    const id = newId('cmp').replace(/[^a-zA-Z0-9_-]/g, '');
    const now = Date.now();
    const context = { ...built.context, starter: starterText ?? '', starterActive: !!starterText };
    await client.putCampaign(id, { id, name, coverImage: '', createdAt: now, lastPlayedAt: now });
    await client.putState(id, { context, messages: [], condenser: built.condenser, pinnedExcerpts: [] });
    await client.putLore(id, built.chunks);
    if (built.npcs.length) await client.putNpcs(id, built.npcs);
    if (built.locations.length) await client.putLocations(id, built.locations);
    return {
        id,
        name,
        loreEntries: built.chunks.length,
        npcs: built.npcs.length,
        locations: built.locations.length,
        warnings: built.warnings,
    };
}
