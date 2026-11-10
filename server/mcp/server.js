/**
 * Narrative Engine MCP server: Claude runs a Narrative Engine campaign as the
 * GM from Claude Desktop (or any MCP client), using the engine's memory,
 * lore recall, NPC ledger and archive. Display tools render an inline panel
 * (MCP Apps); text-only clients get the same information as text.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { rollDice, describeRoll } from './dice.js';
import * as gm from './gm.js';
import { PANEL_URI, panelHtml } from './views.js';

export const SERVER_INSTRUCTIONS = `You are the Game Master for a Narrative Engine campaign. The engine holds the world: rules, lore, NPCs, the hero's sheet and every past scene. You narrate; the engine remembers.

How to run a session:
1. Call list_campaigns, then open_campaign with the player's choice. Treat the returned "rules" as your GM operating manual (tone, format, difficulty, dice protocol) and follow it.
2. Each turn: read the player's action. Before narrating, recall what you need — recall_lore for world facts, recall_memory for past events, get_npcs for anyone who appears. Never invent facts that contradict recalled lore.
3. Resolve uncertain actions with roll_dice; never fake a roll.
4. Narrate the outcome to the player.
5. Then ALWAYS call record_turn with the player's action and your exact narration, so the turn is saved to the campaign and its long-term memory. A turn that is not recorded is forgotten.
6. Keep state true: update_character for HP, items, level; update_npc when an NPC is met or changes; update_notebook for short-lived scene state (timers, positions, ongoing effects).`;

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

function sheetText(s) {
    const lines = [`${s.name}${s.race || s.class ? ` — ${[s.race, s.class].filter(Boolean).join(' ')}` : ''}${s.level ? ` (Lv ${s.level})` : ''}`];
    if (s.hp) lines.push(`HP ${s.hp.current}/${s.hp.max}${s.mp?.max ? ` · MP ${s.mp.current}/${s.mp.max}` : ''}`);
    if (s.condition) lines.push(`Condition: ${s.condition}`);
    const stats = Object.entries(s.stats ?? {});
    if (stats.length) lines.push(`Stats: ${stats.map(([k, v]) => `${k} ${v}`).join(', ')}`);
    if (s.inventory?.length) lines.push(`Inventory: ${s.inventory.map((i) => `${i.name}${i.qty > 1 ? ` ×${i.qty}` : ''}${i.equipped ? ' (equipped)' : ''}`).join(', ')}`);
    if (s.traits?.length) lines.push(`Traits: ${s.traits.join('; ')}`);
    if (s.notes) lines.push(`Notes: ${s.notes}`);
    return lines.join('\n');
}

function briefingText(b) {
    const out = [`# ${b.campaign.name} (id: ${b.campaign.id})`];
    out.push(b.isNewCampaign ? 'New campaign — no turns yet.' : `${b.scenesArchived} scenes in the archive.`);
    if (b.rules) out.push('## GM rules (follow these)', b.rules);
    if (b.worldOverview.length) out.push('## World overview', ...b.worldOverview.map((l) => `### ${l.header}\n${l.content}`));
    out.push('## Hero', sheetText(b.character));
    if (b.npcs.length) out.push('## Known NPCs', b.npcs.map((n) => `- ${n.name}${n.status ? ` — ${n.status}` : ''}${n.faction ? ` [${n.faction}]` : ''}`).join('\n'));
    if (b.notebook.length) out.push('## Scene notebook', b.notebook.map((n) => `- ${n}`).join('\n'));
    if (b.sceneNote) out.push('## Scene note', b.sceneNote);
    if (b.loreTopics.length) out.push('## Lore topics you can recall_lore', b.loreTopics.join(' · '));
    if (b.recentTurns.length) out.push('## Most recent turns', b.recentTurns.map((t) => `**${t.role === 'gm' ? 'GM' : 'Player'}:** ${t.text}`).join('\n\n'));
    if (b.starter) out.push('## Opening prompt', b.starter);
    out.push(b.isNewCampaign
        ? 'Start the session: open the scene (or begin character creation if the rules call for it).'
        : 'Resume from the most recent turn. Remember to record_turn after every narration.');
    return out.join('\n\n');
}

export function buildServer(client) {
    const server = new McpServer(
        { name: 'narrative-engine', version: '1.0.0' },
        { instructions: SERVER_INSTRUCTIONS },
    );

    registerAppResource(server, 'Narrative Engine panel', PANEL_URI,
        { description: 'Inline campaign, dice, character and turn views' },
        async () => ({ contents: [{ uri: PANEL_URI, mimeType: RESOURCE_MIME_TYPE, text: panelHtml() }] }));

    server.registerTool('list_campaigns', {
        title: 'List campaigns',
        description: 'List the Narrative Engine campaigns available to play, most recently played first.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
    }, safe(async () => {
        const list = await gm.listCampaigns(client);
        if (list.length === 0) return ok('No campaigns yet. Create one in the Narrative Engine app (New Campaign), then come back.');
        return ok(list.map((c) => `- ${c.name} (id: ${c.id})${c.lastPlayedAt ? ` — last played ${c.lastPlayedAt.slice(0, 10)}` : ''}`).join('\n'), { campaigns: list });
    }));

    registerAppTool(server, 'open_campaign', {
        title: 'Open campaign',
        description: 'Load a campaign to run it as GM: the GM rules, world overview, hero sheet, NPCs, scene notebook and the most recent turns. Call this before running any turns.',
        inputSchema: { campaignId, recentTurns: z.number().int().min(0).max(30).default(8).describe('How many recent exchanges to include') },
        annotations: { readOnlyHint: true },
        _meta: meta,
    }, safe(async ({ campaignId: id, recentTurns }) => {
        const b = await gm.openCampaign(client, id, { recentTurns });
        return ok(briefingText(b), { view: 'campaign', campaignId: id, ...b });
    }));

    server.registerTool('recall_lore', {
        title: 'Recall lore',
        description: 'Search the campaign\'s world lore (places, factions, characters, magic, rules of the setting). Use before narrating anything the lore might define.',
        inputSchema: { campaignId, query: z.string().min(2).describe('What you need to know'), limit: z.number().int().min(1).max(10).default(5) },
        annotations: { readOnlyHint: true },
    }, safe(async ({ campaignId: id, query, limit }) => {
        const r = await gm.recallLore(client, id, query, limit);
        if (r.results.length === 0) return ok(`No lore found for "${query}". You may improvise, consistent with the world overview.`, r);
        return ok(r.results.map((l) => `### ${l.header}\n${l.content}`).join('\n\n'), r);
    }));

    server.registerTool('recall_memory', {
        title: 'Recall past scenes',
        description: 'Search the campaign\'s long-term memory of past scenes: what happened, who was there, promises made. Use when the player references the past or an old NPC returns.',
        inputSchema: { campaignId, query: z.string().min(2), limit: z.number().int().min(1).max(8).default(4) },
        annotations: { readOnlyHint: true },
    }, safe(async ({ campaignId: id, query, limit }) => {
        const r = await gm.recallMemory(client, id, query, limit);
        if (r.scenes.length === 0) return ok(`No past scenes match "${query}".`, r);
        return ok(r.scenes.map((s) => s.content).join('\n\n'), r);
    }));

    server.registerTool('get_npcs', {
        title: 'Get NPCs',
        description: 'Get NPC details (personality, voice, appearance, status, faction) by name, or the full roster when no names are given.',
        inputSchema: { campaignId, names: z.array(z.string()).max(10).optional() },
        annotations: { readOnlyHint: true },
    }, safe(async ({ campaignId: id, names }) => {
        const r = await gm.getNpcs(client, id, names);
        const text = r.npcs.map((n) => (n.found === false
            ? `- ${n.name}: not in the ledger (new character — add with update_npc if they matter)`
            : `### ${n.name}\n${Object.entries(n).filter(([k]) => !['name', 'found'].includes(k) && n[k]).map(([k, v]) => `${k}: ${v}`).join('\n')}`)).join('\n\n');
        return ok(text || 'No NPCs yet.', r);
    }));

    server.registerTool('update_npc', {
        title: 'Create or update NPC',
        description: 'Add a new NPC to the ledger or update one (matched by name or alias). Only the fields you pass change.',
        inputSchema: {
            campaignId,
            name: z.string().min(1),
            aliases: z.string().optional().describe('Comma-separated'),
            appearance: z.string().optional(),
            personality: z.string().optional(),
            voice: z.string().optional().describe('How they speak'),
            faction: z.string().optional(),
            status: z.string().optional().describe('Current situation, e.g. "imprisoned in Valdor"'),
            storyRelevance: z.string().optional(),
            condition: z.enum(['healthy', 'wounded', 'critical', 'dead']).optional(),
        },
    }, safe(async ({ campaignId: id, ...input }) => {
        const r = await gm.upsertNpc(client, id, input);
        return ok(`${r.created ? 'Added' : 'Updated'} ${r.name}${r.changed.length ? ` (${r.changed.join(', ')})` : ''}.`, r);
    }));

    registerAppTool(server, 'roll_dice', {
        title: 'Roll dice',
        description: 'Roll dice for real and show the roll. Notation: d20, 2d6+3, 4d6kh3 (keep highest 3), 1d20+5 adv / dis. Use for every uncertain outcome.',
        inputSchema: {
            expression: z.string().min(2).max(60),
            label: z.string().max(80).optional().describe('What the roll is for, e.g. "Stealth check DC 14"'),
        },
        _meta: meta,
    }, safe(async ({ expression, label }) => {
        const r = rollDice(expression);
        return ok(describeRoll(r, label), { view: 'dice', label: label ?? '', ...r });
    }));

    registerAppTool(server, 'show_character', {
        title: 'Show character sheet',
        description: 'Show the hero\'s character sheet: HP/MP, stats, inventory, traits.',
        inputSchema: { campaignId },
        annotations: { readOnlyHint: true },
        _meta: meta,
    }, safe(async ({ campaignId: id }) => {
        const b = await gm.openCampaign(client, id, { recentTurns: 0 });
        return ok(sheetText(b.character), { view: 'character', campaignId: id, sheet: b.character });
    }));

    registerAppTool(server, 'update_character', {
        title: 'Update character',
        description: 'Change the hero\'s sheet: HP (hpDelta for damage/healing), MP, level, stats, condition, notes, and inventory (add/remove/equip/unequip).',
        inputSchema: {
            campaignId,
            hpDelta: z.number().int().optional().describe('Negative for damage, positive for healing'),
            hpSet: z.number().int().min(0).optional(),
            hpMax: z.number().int().min(1).optional(),
            mpDelta: z.number().int().optional(),
            mpMax: z.number().int().min(0).optional(),
            level: z.number().int().min(1).optional(),
            stats: z.record(z.string(), z.number()).optional(),
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
        return ok(`Updated: ${r.changes.join(', ') || 'nothing'}\n\n${sheetText(r.sheet)}`, { view: 'character', campaignId: id, ...r });
    }));

    server.registerTool('update_notebook', {
        title: 'Update scene notebook',
        description: 'Track short-lived scene state: timers, positions, ongoing effects, combat state. Actions: add (text), remove (text match), clear. Max 5 per call.',
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
        description: 'Save this turn to the campaign: the player\'s action and your exact narration become part of the story and its long-term memory, and appear in the Narrative Engine app. Call after EVERY narration.',
        inputSchema: {
            campaignId,
            playerAction: z.string().describe('What the player did or said this turn (empty for an opening scene)'),
            narration: z.string().min(1).describe('Your full narration for this turn, exactly as shown to the player'),
            importance: z.number().int().min(1).max(10).optional().describe('How memorable this scene is (1-10)'),
        },
        _meta: meta,
    }, safe(async ({ campaignId: id, ...turn }) => {
        const r = await gm.recordTurn(client, id, turn);
        return ok(`Turn ${r.turnNumber} saved${r.sceneId ? ` (scene ${r.sceneId})` : ''}.`, { view: 'turn', campaignId: id, ...r });
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
                    ? `Open the campaign "${campaign}" (match it against list_campaigns) and begin.`
                    : 'List my campaigns and ask which one to play.'}`,
            },
        }],
    }));

    return server;
}
