/**
 * Narrative Engine MCP server: Claude runs a Narrative Engine campaign as the
 * GM from Claude Desktop (or any MCP client), using the engine's memory,
 * lore recall, NPC ledger and archive. Display tools render an inline panel
 * (MCP Apps); text-only clients get the same information as text.
 *
 * Everything a tool returns stays in Claude's context for the rest of the
 * session. Text results are therefore short, and `structuredContent` carries
 * only what the panel draws.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { rollDice, describeRoll } from './dice.js';
import * as gm from './gm.js';
import { PANEL_URI, panelHtml } from './views.js';
import { listWorlds, findWorld, listRulesets, readRuleset, worldBlurb } from './worlds.js';
import { loadCampaignKit } from './kit.js';
import fs from 'fs';

/**
 * The turn loop. It is sent three ways because clients differ in what they
 * pass to the model: as the server instructions, inside the run_campaign
 * prompt, and at the top of every campaign briefing (which always arrives).
 */
export const GM_LOOP = `Every turn, in this order:
1. LOOK UP before you write. recall_lore for any place, faction, power, creature or custom the world might define; recall_memory when the past matters (a returning NPC, a promise, "last time"); get_npcs for named NPCs entering the scene. What you recall is canon: never contradict it, and never invent canon you could have looked up. If nothing comes back, improvise small details that fit.
2. ROLL when the outcome is uncertain and failure would matter: call roll_dice before you write the outcome. Never make up a number or roll "in your head". The result is final: narrate what it caused and do not soften it. Trivial or impossible actions need no roll.
3. NARRATE. Only the player decides what their hero does, says, thinks or feels. Stop at the next real decision.
4. SAVE. Right after the narration, in the same reply, call record_turn with the player's action and your narration word for word. Do it every turn without being asked, opening scene included. An unsaved turn is lost from the campaign and its memory. Character-creation questions and out-of-character chat are not turns.
5. KEEP STATE TRUE, together with record_turn: update_character for any change to HP/MP, items, money, level or condition; update_npc when a named NPC first appears or their situation or attitude changes; update_notebook for short-lived facts (timers, positions, ongoing effects) and remove them when they end.

Keep the story clean. The player sees only story: never mention tools, ids, saving, lookups or "the engine", and do not announce what you are about to check. After record_turn returns, add nothing; the turn is over. The dice tray already shows each roll, so do not repeat the arithmetic.
If a tool fails, say so in one short out-of-character line and carry on; if Narrative Engine cannot be reached, stop the story and pass on the instructions in the error.`;

export const SERVER_INSTRUCTIONS = `You are the Game Master (GM) of a Narrative Engine campaign, played with one player in this chat. Narrative Engine is your memory: it holds the GM rules, the world lore, the NPCs, the hero's sheet and every past scene. You tell the story; these tools keep it consistent and saved.

Starting a session:
- Call list_campaigns. If there are campaigns, ask which to continue or whether to start a new one, then open_campaign.
- New campaign: call list_worlds, pitch a few worlds that fit what the player asked for (one line each; the full list on request), let them choose, then create_campaign. Its result is the full briefing, so do not call open_campaign after it.
- The briefing's "GM rules" are your operating manual for tone, format, pacing and difficulty: follow them over your own habits. If the briefing has an "Opening prompt", follow it; it usually runs character creation first, one question at a time. Save the finished hero with update_character (name, race, class, appearance, stats, hpMax, starting gear) before the first scene.
- First scene: a specific place and moment with something already happening, ending where the player has a real choice. Resuming: one or two lines of "previously", then continue from the last recorded turn.

${GM_LOOP}

You are also the engine. Rulesets written for the Narrative Engine app describe engine tags and injected blocks (RESOLVED ROLL, DICE OUTCOMES, LOOT DROP, SURPRISE / ENCOUNTER / WORLD events, PLAY AS) that the app produces. Here nothing produces them, so you do that job: roll_dice replaces the engine's rolls (for a plain d20 it also reports the outcome tier the rules name), and now and then, when a scene has room, you introduce the small unprompted events the rules describe. Never print tags, tiers or engine syntax to the player.`;

const campaignId = z.string().min(1).describe('Campaign id from list_campaigns');
const meta = { ui: { resourceUri: PANEL_URI } };

function ok(text, structuredContent) {
    return { content: [{ type: 'text', text }], ...(structuredContent ? { structuredContent } : {}) };
}

function fail(err) {
    return { content: [{ type: 'text', text: `Error: ${err?.message ?? err}` }], isError: true };
}

const safe = (fn) => async (args) => {
    try { return await fn(args); } catch (err) { return fail(err); }
};

export function sheetText(s) {
    const lines = [`${s.name}${s.race || s.class ? ` — ${[s.race, s.class].filter(Boolean).join(' ')}` : ''}${s.level ? ` (Lv ${s.level})` : ''}`];
    if (s.hp) lines.push(`HP ${s.hp.current}/${s.hp.max}${s.mp?.max ? ` · MP ${s.mp.current}/${s.mp.max}` : ''}`);
    if (s.condition) lines.push(`Condition: ${s.condition}`);
    const stats = Object.entries(s.stats ?? {});
    if (stats.length) lines.push(`Stats: ${stats.map(([k, v]) => `${k} ${v}`).join(', ')}`);
    if (s.skills?.length) lines.push(`Skills: ${s.skills.join(', ')}`);
    if (s.abilities?.length) lines.push(`Abilities: ${s.abilities.join(', ')}`);
    if (s.inventory?.length) lines.push(`Inventory: ${s.inventory.map((i) => `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}${i.equipped ? ' (equipped)' : ''}`).join(', ')}`);
    if (s.traits?.length) lines.push(`Traits: ${s.traits.join('; ')}`);
    if (s.appearance) lines.push(`Appearance: ${s.appearance}`);
    if (s.personality) lines.push(`Personality: ${s.personality}`);
    if (s.notes) lines.push(`Notes: ${s.notes}`);
    return lines.join('\n');
}

/** One line: what changed is already in the caller's hands, so the full sheet is not repeated. */
function vitalsLine(s) {
    return `${s.name}: ${s.hp ? `HP ${s.hp.current}/${s.hp.max}` : 'no HP set'}${s.mp?.max ? ` · MP ${s.mp.current}/${s.mp.max}` : ''}${s.condition ? ` · ${s.condition}` : ''}`;
}

export function briefingText(b) {
    const heroReady = b.character.name !== 'Unnamed hero';
    const out = [`# ${b.campaign.name} (campaignId: ${b.campaign.id})`];
    out.push(b.isNewCampaign ? 'New campaign: no turns yet.' : `${b.turnsPlayed} turns played, ${b.scenesArchived} scenes in long-term memory.`);
    out.push('## How to run this campaign', GM_LOOP);
    if (b.rules) out.push('## GM rules (your operating manual; follow them)', b.rules);
    if (b.worldOverview.length) out.push('## World overview', ...b.worldOverview.map((l) => `### ${l.header}\n${l.content}`));
    out.push('## Hero', heroReady ? sheetText(b.character) : 'No hero yet. Run character creation, then save the hero with update_character.');
    if (b.npcs.length) out.push('## Known NPCs (get_npcs for details)', b.npcs.map((n) => `- ${n.name}${n.status ? ` — ${n.status}` : ''}${n.faction ? ` [${n.faction}]` : ''}`).join('\n'));
    if (b.notebook.length) out.push('## Scene notebook', b.notebook.map((n) => `- ${n}`).join('\n'));
    if (b.sceneNote) out.push('## Scene note', b.sceneNote);
    if (b.loreTopics.length) out.push('## Lore you can look up with recall_lore', b.loreTopics.join(' · '));
    if (b.recentTurns.length) out.push('## Most recent turns (older ones: recall_memory)', b.recentTurns.map((t) => `**${t.role === 'gm' ? 'GM' : 'Player'}:** ${t.text}`).join('\n\n'));
    if (b.starter) out.push('## Opening prompt (follow it; you already have the lore and rules it mentions)', b.starter);
    out.push(b.isNewCampaign
        ? `Begin now: ${b.starter ? 'follow the opening prompt' : heroReady ? 'open the first scene' : 'create the hero with the player, then open the first scene'}. Speak to the player in character as the GM; do not summarise this briefing.`
        : 'Resume now: give one or two lines of "previously", then continue from the last GM turn above. Do not summarise this briefing.');
    return out.join('\n\n');
}

/** What the campaign panel draws; the long text (rules, lore, turns) goes to Claude only. */
function campaignPanel(id, b) {
    return {
        view: 'campaign',
        campaignId: id,
        campaign: b.campaign,
        isNewCampaign: b.isNewCampaign,
        turnsPlayed: b.turnsPlayed,
        scenesArchived: b.scenesArchived,
        loreCount: b.loreTopics.length,
        character: b.character,
        npcs: b.npcs.slice(0, 12).map((n) => ({ name: n.name, status: n.status })),
        notebook: b.notebook,
    };
}

export function buildServer(client) {
    const server = new McpServer(
        { name: 'narrative-engine', version: '1.1.0' },
        { instructions: SERVER_INSTRUCTIONS },
    );

    registerAppResource(server, 'Narrative Engine panel', PANEL_URI,
        { description: 'Inline campaign, dice, character and turn views' },
        async () => ({ contents: [{ uri: PANEL_URI, mimeType: RESOURCE_MIME_TYPE, text: panelHtml() }] }));

    server.registerTool('list_campaigns', {
        title: 'List campaigns',
        description: 'START HERE when the player wants to play Narrative Engine or asks you to be their Game Master. Lists their saved campaigns, most recently played first. Then open one with open_campaign, or offer a new one with list_worlds.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
    }, safe(async () => {
        const list = await gm.listCampaigns(client);
        if (list.length === 0) return ok('No campaigns yet. Call list_worlds, pitch a few worlds to the player, and start one with create_campaign.', { campaigns: [] });
        return ok(`${list.map((c) => `- ${c.name} (campaignId: ${c.id})${c.lastPlayedAt ? ` — last played ${c.lastPlayedAt.slice(0, 10)}` : ''}`).join('\n')}\n\nAsk the player which to continue (open_campaign), or offer a new one (list_worlds).`, { campaigns: list });
    }));

    registerAppTool(server, 'open_campaign', {
        title: 'Open campaign',
        description: 'Load a saved campaign so you can run it as GM. Returns the briefing: how to run turns, the GM rules, world overview, hero sheet, NPCs, scene notebook and the most recent turns. Call once at the start of a session, before any turn. Not needed right after create_campaign.',
        inputSchema: { campaignId, recentTurns: z.number().int().min(0).max(20).default(6).describe('How many recent exchanges to include') },
        annotations: { readOnlyHint: true },
        _meta: meta,
    }, safe(async ({ campaignId: id, recentTurns }) => {
        const b = await gm.openCampaign(client, id, { recentTurns });
        return ok(briefingText(b), campaignPanel(id, b));
    }));

    server.registerTool('recall_lore', {
        title: 'Recall lore',
        description: 'Look up the world\'s canon: places, factions, people, powers, creatures, customs, history. Call it before narrating anything the lore might define, instead of inventing it. Ask one focused question per call.',
        inputSchema: { campaignId, query: z.string().min(2).describe('What you need to know, e.g. "who rules Valdor" or "how dark scrolls work"'), limit: z.number().int().min(1).max(8).default(4) },
        annotations: { readOnlyHint: true },
    }, safe(async ({ campaignId: id, query, limit }) => {
        const r = await gm.recallLore(client, id, query, limit);
        if (r.results.length === 0) return ok(`No lore found for "${query}". Improvise small details that fit the world overview; do not present them as established canon.`);
        return ok(r.results.map((l) => `### ${l.header}\n${l.content}`).join('\n\n'), { query: r.query, method: r.method, headers: r.results.map((l) => l.header) });
    }));

    server.registerTool('recall_memory', {
        title: 'Recall past scenes',
        description: 'Search the campaign\'s long-term memory of every recorded scene: what happened, who was there, what was promised. Call it when the player refers to the past, an old NPC or place returns, or you are unsure what was established.',
        inputSchema: { campaignId, query: z.string().min(2).describe('What you are trying to remember'), limit: z.number().int().min(1).max(6).default(3) },
        annotations: { readOnlyHint: true },
    }, safe(async ({ campaignId: id, query, limit }) => {
        const r = await gm.recallMemory(client, id, query, limit);
        if (r.scenes.length === 0) return ok(`No past scenes match "${query}". Try other words (a name, a place, an object), or treat it as not yet established.`, { query: r.query, method: r.method, sceneIds: [] });
        return ok(r.scenes.map((s) => s.content).join('\n\n'), { query: r.query, method: r.method, sceneIds: r.scenes.map((s) => s.sceneId) });
    }));

    server.registerTool('get_npcs', {
        title: 'Get NPCs',
        description: 'Read NPCs from the ledger: personality, voice, appearance, status, faction. Pass names for full details on NPCs entering the scene; pass none for a one-line roster.',
        inputSchema: { campaignId, names: z.array(z.string()).max(10).optional().describe('NPC names or aliases; omit for the roster') },
        annotations: { readOnlyHint: true },
    }, safe(async ({ campaignId: id, names }) => {
        const r = await gm.getNpcs(client, id, names);
        if (r.npcs.length === 0) return ok('No NPCs in the ledger yet. Add each named NPC with update_npc when they first appear.');
        const text = names?.length
            ? r.npcs.map((n) => (n.found === false
                ? `- ${n.name}: not in the ledger. If they matter, add them with update_npc.`
                : `### ${n.name}\n${Object.entries(n).filter(([k, v]) => !['name', 'found'].includes(k) && v).map(([k, v]) => `${k}: ${v}`).join('\n')}`)).join('\n\n')
            : r.npcs.map((n) => `- ${n.name}${n.status ? ` — ${n.status}` : ''}${n.faction ? ` [${n.faction}]` : ''}${n.condition && n.condition !== 'healthy' ? ` (${n.condition})` : ''}`).join('\n');
        return ok(text);
    }));

    server.registerTool('update_npc', {
        title: 'Create or update NPC',
        description: 'Add a named NPC to the ledger the first time they appear, or update one when their situation, attitude or health changes (matched by name or alias). Only the fields you pass change.',
        inputSchema: {
            campaignId,
            name: z.string().min(1),
            aliases: z.string().optional().describe('Comma-separated'),
            appearance: z.string().optional(),
            personality: z.string().optional(),
            voice: z.string().optional().describe('How they speak'),
            faction: z.string().optional(),
            status: z.string().optional().describe('Where they are and what they are doing now, e.g. "imprisoned in Valdor"'),
            storyRelevance: z.string().optional().describe('Why they matter; what they want from or owe the hero'),
            condition: z.enum(['healthy', 'wounded', 'critical', 'dead']).optional(),
        },
    }, safe(async ({ campaignId: id, ...input }) => {
        const r = await gm.upsertNpc(client, id, input);
        return ok(`${r.created ? 'Added' : 'Updated'} ${r.name}${r.changed.length ? ` (${r.changed.join(', ')})` : r.created ? '' : ' (no change)'}.`, r);
    }));

    server.registerTool('list_worlds', {
        title: 'List worlds',
        description: 'List the ready-made worlds that ship with Narrative Engine (fantasy, cyberpunk, zombie, superhero, franchise worlds and more) with a short pitch each, plus the optional GM rulesets. Use it to offer the player a new campaign; pitch a few that fit their taste rather than reading out the whole list.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
    }, safe(async () => {
        const worlds = listWorlds().map((w) => ({ id: w.id, name: w.name, pitch: worldBlurb(w, 160), hasStarter: !!w.starterFile, hasLoot: !!w.lootFile, ownRules: !!w.rulesFile }));
        if (worlds.length === 0) return ok('No worlds found in Example_Setup/World_compendium. The Narrative Engine folder may be incomplete; ask the player to re-download it.');
        const text = `${worlds.map((w) => `- **${w.name}** (world: ${w.id})${w.ownRules ? ' [own GM rules]' : ''}: ${w.pitch}`).join('\n')}`
            + `\n\nGM rulesets (optional "ruleset" argument; the default is the world's own rules or AI_GM_OS v5.0 Immersive): ${listRulesets().join(', ')}`;
        return ok(text, { worlds: worlds.map((w) => ({ id: w.id, name: w.name })) });
    }));

    registerAppTool(server, 'create_campaign', {
        title: 'Create campaign',
        description: 'Start a new campaign from a ready-made world (see list_worlds) once the player has chosen one. Builds the lore, NPCs, locations and GM rules exactly like the app\'s New Campaign form and returns the full briefing, so do not call open_campaign afterwards.',
        inputSchema: {
            world: z.string().min(2).describe('World id or name from list_worlds'),
            name: z.string().min(1).max(80).optional().describe('Campaign name (defaults to the world name)'),
            ruleset: z.string().optional().describe('Part of a ruleset file name to override the default, e.g. "v3.2" for easy difficulty'),
        },
        _meta: meta,
    }, safe(async ({ world: worldQuery, name, ruleset }) => {
        const world = findWorld(worldQuery);
        if (!world) throw new Error(`No world matching "${worldQuery}". Call list_worlds for the options.`);
        const rules = readRuleset(world, ruleset);
        const kit = await loadCampaignKit();
        const created = await gm.createCampaign(client, kit, {
            name: name?.trim() || world.name,
            loreText: fs.readFileSync(world.loreFile, 'utf-8'),
            rulesText: rules.text,
            lootText: world.lootFile ? fs.readFileSync(world.lootFile, 'utf-8') : undefined,
            starterText: world.starterFile ? fs.readFileSync(world.starterFile, 'utf-8') : undefined,
        });
        const b = await gm.openCampaign(client, created.id);
        const header = `Created "${created.name}" from ${world.name} with ${rules.name}: ${created.loreEntries} lore entries, ${created.npcs} NPCs, ${created.locations} locations.`;
        return ok(`${header}\n\n${briefingText(b)}`, { ...campaignPanel(created.id, b), created });
    }));

    registerAppTool(server, 'roll_dice', {
        title: 'Roll dice',
        description: 'Roll real dice and show them to the player. Call it for EVERY uncertain outcome, before you narrate the result; never invent a number. Notation: d20, 2d6+3, 4d6kh3 (keep highest 3), 1d20+5 adv / dis. A plain d20 also reports the outcome tier (Catastrophe, Failure, Success, Triumph, Narrative Boon) for rules that use tiers.',
        inputSchema: {
            expression: z.string().min(2).max(60).describe('Dice notation only, e.g. "1d20+3" or "d20 adv"'),
            label: z.string().max(80).optional().describe('What the roll is for, e.g. "Stealth vs DC 14"'),
        },
        _meta: meta,
    }, safe(async ({ expression, label }) => {
        const r = rollDice(expression);
        return ok(describeRoll(r, label), { view: 'dice', label: label ?? '', ...r });
    }));

    registerAppTool(server, 'show_character', {
        title: 'Show character sheet',
        description: 'Show the hero\'s full character sheet (HP/MP, stats, skills, inventory, traits). Use it when the player asks to see their sheet or you need to check what the hero has.',
        inputSchema: { campaignId },
        annotations: { readOnlyHint: true },
        _meta: meta,
    }, safe(async ({ campaignId: id }) => {
        const b = await gm.openCampaign(client, id, { recentTurns: 0 });
        return ok(sheetText(b.character), { view: 'character', campaignId: id, sheet: b.character });
    }));

    registerAppTool(server, 'update_character', {
        title: 'Update character',
        description: 'Create the hero at character creation, and afterwards record every change to them as it happens: damage and healing (hpDelta), max HP, MP, level, stats, condition, skills, notes, and inventory (add / remove / equip / unequip, including coins). Only the fields you pass change.',
        inputSchema: {
            campaignId,
            name: z.string().optional().describe('Hero name (character creation)'),
            race: z.string().optional(),
            class: z.string().optional().describe('Class, role or archetype'),
            appearance: z.string().optional(),
            personality: z.string().optional(),
            skills: z.array(z.string()).optional().describe('Replaces the skill list'),
            abilities: z.array(z.string()).optional().describe('Replaces the ability list'),
            traits: z.array(z.string()).optional().describe('Replaces the trait list'),
            hpDelta: z.number().int().optional().describe('Negative for damage, positive for healing'),
            hpSet: z.number().int().min(0).optional(),
            hpMax: z.number().int().min(1).optional().describe('Maximum HP; a new or unhurt hero is set to full'),
            mpDelta: z.number().int().optional(),
            mpMax: z.number().int().min(0).optional(),
            level: z.number().int().min(1).optional(),
            stats: z.record(z.string(), z.number()).optional().describe('e.g. {"STR": 12, "DEX": 15}; merged into existing stats'),
            condition: z.enum(['healthy', 'wounded', 'critical', 'dead']).optional(),
            notes: z.string().optional(),
            inventory: z.array(z.object({
                action: z.enum(['add', 'remove', 'equip', 'unequip']),
                name: z.string().min(1),
                qty: z.number().int().min(1).optional(),
                category: z.enum(['weapon', 'armor', 'consumable', 'currency', 'key', 'misc', 'equipped']).optional(),
                equipped: z.boolean().optional(),
                notes: z.string().optional(),
            })).max(20).optional(),
        },
        _meta: meta,
    }, safe(async ({ campaignId: id, ...patch }) => {
        const r = await gm.updateCharacter(client, id, patch);
        const text = r.changes.length ? `Saved: ${r.changes.join(', ')}.\n${vitalsLine(r.sheet)}` : `Nothing changed.\n${vitalsLine(r.sheet)}`;
        return ok(text, { view: 'character', campaignId: id, ...r });
    }));

    server.registerTool('update_notebook', {
        title: 'Update scene notebook',
        description: 'Your short-term scratchpad for the current scene: timers, positions, ongoing effects, combat state, things you must not forget next turn. Actions: add (text), remove (any note containing the text), clear. Remove notes when they stop being true. Max 5 actions per call.',
        inputSchema: {
            campaignId,
            actions: z.array(z.object({ action: z.enum(['add', 'remove', 'clear']), text: z.string().optional() })).min(1).max(5),
        },
    }, safe(async ({ campaignId: id, actions }) => {
        const r = await gm.updateNotebook(client, id, actions);
        return ok(r.notebook.length ? `Scene notebook:\n${r.notebook.map((n) => `- ${n}`).join('\n')}` : 'Scene notebook is empty.', r);
    }));

    registerAppTool(server, 'record_turn', {
        title: 'Record turn',
        description: 'Save the turn you just narrated: the player\'s action and your narration become part of the campaign, its long-term memory, and the Narrative Engine window. Call it after EVERY narration, in the same reply, without being asked; an unrecorded turn is forgotten. After it returns, write nothing more.',
        inputSchema: {
            campaignId,
            playerAction: z.string().describe('What the player did or said this turn, in their words (empty string for an opening scene)'),
            narration: z.string().min(1).describe('Your narration for this turn, word for word as the player saw it'),
            importance: z.number().int().min(1).max(10).optional().describe('How much this scene matters later: 1-3 routine, 4-6 notable, 7-10 turning point'),
        },
        _meta: meta,
    }, safe(async ({ campaignId: id, ...turn }) => {
        const r = await gm.recordTurn(client, id, turn);
        const text = r.duplicate
            ? `Turn ${r.turnNumber} was already saved; nothing written twice.`
            : `Turn ${r.turnNumber} saved${r.sceneId ? '' : ' to the chat, but long-term memory did not take it (it will be missing from recall_memory)'}.`;
        return ok(text, { view: 'turn', campaignId: id, ...r });
    }));

    server.registerPrompt('run_campaign', {
        title: 'Run a Narrative Engine campaign',
        description: 'Start or resume a campaign with Claude as the Game Master',
        argsSchema: { campaign: z.string().optional().describe('Campaign name or id (leave empty to choose)') },
    }, ({ campaign }) => ({
        messages: [{
            role: 'user',
            content: {
                type: 'text',
                text: `${SERVER_INSTRUCTIONS}\n\n${campaign
                    ? `Let's play. Open the campaign "${campaign}" (match it against list_campaigns) and begin.`
                    : 'Let\'s play Narrative Engine. Check my campaigns, then ask me whether to continue one or start a new world.'}`,
            },
        }],
    }));

    return server;
}
