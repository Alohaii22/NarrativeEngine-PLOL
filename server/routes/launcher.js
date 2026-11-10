import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import { wrapAsync } from '../lib/asyncHandler.js';
import { listWorlds, findWorld, listRulesets, readRuleset, worldBlurb, DEFAULT_RULESET } from '../mcp/worlds.js';
import { loadCampaignKit } from '../mcp/kit.js';
import { createCampaign, updateCharacter } from '../mcp/gm.js';
import { createEngineClient } from '../mcp/engineClient.js';

/**
 * Campaign Launcher API (public/launcher.html): browse the bundled worlds,
 * check a set of campaign files before committing to them, and create the
 * campaign — with the same campaign kit the New Campaign form uses.
 */
const INSTALL_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MAX_TEXT = 8 * 1024 * 1024;
const MAX_CARDS = 30;

const read = (file) => (file ? fs.readFileSync(file, 'utf-8') : undefined);

function textField(value, label) {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') throw Object.assign(new Error(`${label} must be text`), { statusCode: 400 });
    if (value.length > MAX_TEXT) throw Object.assign(new Error(`${label} is larger than 8 MB`), { statusCode: 400 });
    return value;
}

/** Bundled world files, overridden by anything the player uploaded. */
function resolveSources(body) {
    const world = body.world ? findWorld(body.world) : null;
    if (body.world && !world) throw Object.assign(new Error(`Unknown world "${body.world}"`), { statusCode: 400 });
    const loreText = textField(body.loreText, 'Lore') ?? read(world?.loreFile);
    const rulesUpload = textField(body.rulesText, 'Rules');
    const rules = rulesUpload !== undefined
        ? { name: body.rulesName || 'your rules file', text: rulesUpload }
        : readRuleset(world, body.ruleset || undefined);
    const lootText = textField(body.lootText, 'Loot') ?? read(world?.lootFile);
    const starterText = textField(body.starterText, 'Opening prompt') ?? read(world?.starterFile);
    const cards = Array.isArray(body.cards) ? body.cards.slice(0, MAX_CARDS) : [];
    return { world, loreText, rules, lootText, starterText, cards };
}

function cardData(card) {
    if (typeof card?.name !== 'string') throw new Error('Card is missing its file name');
    if (typeof card.dataUrl === 'string') {
        const m = /^data:[^;]+;base64,(.*)$/s.exec(card.dataUrl);
        if (!m) throw new Error(`${card.name}: unreadable image data`);
        const buf = Buffer.from(m[1], 'base64');
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    }
    if (typeof card.text === 'string') return card.text;
    throw new Error(`${card.name}: empty file`);
}

async function build(sources) {
    const kit = await loadCampaignKit();
    const checks = [];
    if (!sources.loreText || !sources.loreText.trim()) {
        checks.push({ level: 'error', slot: 'lore', text: 'World lore is required: pick a bundled world or upload a .md lore file.' });
        return { kit, built: null, cards: [], checks };
    }
    let built = kit.buildCampaignFromMarkdown({ loreText: sources.loreText, rulesText: sources.rules.text, lootText: sources.lootText });
    const prepared = [];
    for (const card of sources.cards) {
        try {
            const p = kit.prepareCharacterCard(card.name, cardData(card));
            if (card.portrait) p.npc.portrait = card.portrait;
            prepared.push(p);
            checks.push({ level: 'ok', slot: 'cards', text: `Character card: ${p.npc.name}` });
        } catch (err) {
            checks.push({ level: 'error', slot: 'cards', text: err.message });
        }
    }
    built = kit.mergeCards(built, prepared);

    const n = built.chunks.length;
    checks.unshift(n >= 5
        ? { level: 'ok', slot: 'lore', text: `Lore: ${n} entries, ${built.npcs.length} NPCs, ${built.locations.length} locations` }
        : { level: 'warn', slot: 'lore', text: `Lore has only ${n} entr${n === 1 ? 'y' : 'ies'}. Split it into sections with ## headings so the GM can recall each part.` });
    checks.push(sources.rules.text
        ? { level: 'ok', slot: 'rules', text: `GM rules: ${sources.rules.name}` }
        : { level: 'warn', slot: 'rules', text: 'No GM rules found; the GM will improvise its style.' });
    checks.push(sources.starterText
        ? { level: 'ok', slot: 'starter', text: 'Opening prompt included: the GM starts the story (often with character creation).' }
        : { level: 'info', slot: 'starter', text: 'No opening prompt: your first message sets the scene (e.g. "Begin in a tavern").' });
    if (sources.lootText) {
        checks.push(built.context.lootTree
            ? { level: 'ok', slot: 'loot', text: 'Loot table loaded' }
            : { level: 'warn', slot: 'loot', text: 'Loot file could not be read and will be skipped' });
    }
    for (const w of built.warnings) checks.push({ level: 'warn', slot: 'lore', text: w });
    return { kit, built, cards: prepared, checks };
}

export function createLauncherRouter({ enginePort = 3001 } = {}) {
    const router = Router();
    const client = createEngineClient({ baseUrl: `http://127.0.0.1:${enginePort}` });

    // Which install is answering on this port. Play_With_Claude uses it to tell
    // "already running" from "a copy in another folder has the port".
    router.get('/api/launcher/info', wrapAsync((_req, res) => {
        res.json({ app: 'narrative-engine', folder: INSTALL_FOLDER, port: enginePort, pid: process.pid });
    }));

    router.get('/api/launcher/worlds', wrapAsync((_req, res) => {
        res.json({
            worlds: listWorlds().map((w) => ({
                id: w.id,
                name: w.name,
                pitch: worldBlurb(w),
                hasStarter: !!w.starterFile,
                hasLoot: !!w.lootFile,
                ownRules: !!w.rulesFile,
            })),
            rulesets: listRulesets(),
            defaultRuleset: DEFAULT_RULESET,
        });
    }));

    router.post('/api/launcher/check', wrapAsync(async (req, res) => {
        const { built, checks } = await build(resolveSources(req.body ?? {}));
        res.json({
            ready: !checks.some((c) => c.level === 'error'),
            checks,
            npcs: built ? built.npcs.map((n) => n.name).slice(0, 60) : [],
            locations: built ? built.locations.map((l) => l.name).slice(0, 60) : [],
            loreTopics: built ? built.chunks.filter((c) => !c.disabled).map((c) => c.header).slice(0, 80) : [],
        });
    }));

    router.post('/api/launcher/create', wrapAsync(async (req, res) => {
        const body = req.body ?? {};
        const sources = resolveSources(body);
        const { kit, cards, checks } = await build(sources);
        const errors = checks.filter((c) => c.level === 'error');
        if (errors.length) return res.status(400).json({ error: errors.map((e) => e.text).join(' '), checks });

        const name = String(body.name || sources.world?.name || 'New Campaign').trim().slice(0, 80);
        // createCampaign builds from text; cards and the hero are applied on top.
        const cardKit = { ...kit, buildCampaignFromMarkdown: (input) => kit.mergeCards(kit.buildCampaignFromMarkdown(input), cards) };
        const created = await createCampaign(client, cardKit, {
            name,
            loreText: sources.loreText,
            rulesText: sources.rules.text,
            lootText: sources.lootText,
            starterText: sources.starterText,
        });

        const hero = body.hero && typeof body.hero === 'object' ? body.hero : null;
        if (hero && typeof hero.name === 'string' && hero.name.trim()) {
            const hp = Number(hero.hp);
            await updateCharacter(client, created.id, {
                name: hero.name, race: hero.race, class: hero.class,
                appearance: hero.appearance, personality: hero.personality,
                notes: typeof hero.background === 'string' ? hero.background : undefined,
                ...(Number.isFinite(hp) && hp > 0 ? { hpMax: hp, hpSet: hp } : {}),
            });
        }
        res.json({ ok: true, campaign: created });
    }));

    return router;
}
