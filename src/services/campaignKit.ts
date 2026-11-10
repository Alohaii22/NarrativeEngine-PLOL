/**
 * Pure campaign construction: no store, no fetch, no DOM.
 *
 * The app's New Campaign flow (campaignInit.ts) and the Claude-as-GM MCP
 * server (server/mcp, which bundles this file for Node with esbuild) both
 * build campaigns through here, so a campaign Claude creates is identical to
 * one made in the app.
 */
import type { GameContext, LootTree, LoreChunk, NPCEntry, LocationEntry } from '../types';
import { buildDefaultDiceSystem } from '../types';
import { chunkLoreFile } from './lore/loreChunker';
import { extractEngineSeeds } from './lore/loreEngineSeeder';
import { parseNPCsFromLore } from './lore/loreNPCParser';
import { parseLocationsFromLoreDetailed } from './lore/loreLocationParser';
import { loadLootTree } from './lore/lootTreeLoader';
import { dedupeNPCLedger } from './npc/dedupeNPCLedger';
import {
    DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES, DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES,
    DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHERE, DEFAULT_WORLD_WHY, DEFAULT_WORLD_WHAT,
} from './engineDefaults';

export const DEFAULT_CONTEXT = {
    loreRaw: '', rulesRaw: '', canonState: '', headerIndex: '',
    starter: '', continuePrompt: '', inventory: '', characterProfile: { identity: {}, activeTraits: [] },
    inventoryItems: [],
    characterProfileData: { name: '', race: '', class: '', level: 1, hp: { current: 20, max: 20 }, stats: {}, skills: [], abilities: [], traits: [], notes: '' },
    smartBookkeepingActive: true,
    surpriseDC: 95, encounterDC: 198, worldEventDC: 498,
    canonStateActive: false, headerIndexActive: false, starterActive: false,
    continuePromptActive: false, inventoryActive: false, characterProfileActive: false,
    surpriseEngineActive: false, encounterEngineActive: true, worldEngineActive: true,
    diceFairnessActive: true, sceneNote: '', sceneNoteActive: false, sceneNoteDepth: 3,
    diceSystem: buildDefaultDiceSystem(),
    worldVibe: '',
    worldEventConfig: { initialDC: 498, dcReduction: 2, who: [] as string[], where: [] as string[], why: [] as string[], what: [] as string[] },
    notebook: [],
    notebookActive: true,
    relationshipMemory: false,
};

export const DEFAULT_CONDENSER = { condensedUpToIndex: -1 };

export type EngineSeeds = ReturnType<typeof extractEngineSeeds>;

/** Markdown lore → lore chunks. Character and location chunks are RAG-disabled:
 *  the NPC and location ledgers are their authoritative injection path. */
export function chunkMarkdownLore(loreText: string): LoreChunk[] {
    return chunkLoreFile(loreText).map(c =>
        c.category === 'character' || c.category === 'location' ? { ...c, disabled: true } : c
    );
}

/** Seed the surprise / encounter / world-event engines from the lore, keeping any tuning already set. */
export function applyEngineSeeds(ctx: GameContext, seeds: EngineSeeds): GameContext {
    return {
        ...ctx,
        surpriseConfig: {
            ...ctx.surpriseConfig, initialDC: ctx.surpriseConfig?.initialDC ?? 95,
            dcReduction: ctx.surpriseConfig?.dcReduction ?? 3,
            types: seeds.surpriseTypes.length > 0 ? seeds.surpriseTypes : [...DEFAULT_SURPRISE_TYPES],
            tones: seeds.surpriseTones.length > 0 ? seeds.surpriseTones : [...DEFAULT_SURPRISE_TONES],
        },
        encounterConfig: {
            ...ctx.encounterConfig, initialDC: ctx.encounterConfig?.initialDC ?? 198,
            dcReduction: ctx.encounterConfig?.dcReduction ?? 2,
            types: seeds.encounterTypes.length > 0 ? seeds.encounterTypes : [...DEFAULT_ENCOUNTER_TYPES],
            tones: seeds.encounterTones.length > 0 ? seeds.encounterTones : [...DEFAULT_ENCOUNTER_TONES],
        },
        worldEventConfig: {
            ...ctx.worldEventConfig, initialDC: ctx.worldEventConfig?.initialDC ?? 498,
            dcReduction: ctx.worldEventConfig?.dcReduction ?? 2,
            who: seeds.worldWho.length > 0 ? seeds.worldWho : [...DEFAULT_WORLD_WHO],
            where: seeds.worldWhere.length > 0 ? seeds.worldWhere : [...DEFAULT_WORLD_WHERE],
            why: seeds.worldWhy.length > 0 ? seeds.worldWhy : [...DEFAULT_WORLD_WHY],
            what: seeds.worldWhat.length > 0 ? seeds.worldWhat : [...DEFAULT_WORLD_WHAT],
        },
    } as GameContext;
}

export type BuiltCampaign = {
    chunks: LoreChunk[];
    npcs: NPCEntry[];
    locations: LocationEntry[];
    context: GameContext;
    condenser: typeof DEFAULT_CONDENSER;
    warnings: string[];
};

/** A brand-new campaign from Markdown lore, a rules file and optional loot JSON. */
export function buildCampaignFromMarkdown(input: { loreText: string; rulesText?: string; lootText?: string }): BuiltCampaign {
    const warnings: string[] = [];
    const chunks = input.loreText ? chunkMarkdownLore(input.loreText) : [];
    const npcs = dedupeNPCLedger(parseNPCsFromLore(chunks));
    const parsedLocations = parseLocationsFromLoreDetailed(chunks);
    warnings.push(...parsedLocations.warnings);

    let context = { ...DEFAULT_CONTEXT } as unknown as GameContext;
    if (input.rulesText) context.rulesRaw = input.rulesText;
    if (input.lootText) {
        try {
            const tree: LootTree | null = loadLootTree(JSON.parse(input.lootText));
            if (tree) context.lootTree = tree;
        } catch (e) {
            warnings.push(`Loot file ignored: ${(e as Error).message}`);
        }
    }
    if (chunks.length > 0) context = applyEngineSeeds(context, extractEngineSeeds(chunks));

    return { chunks, npcs, locations: parsedLocations.locations, context, condenser: { ...DEFAULT_CONDENSER }, warnings };
}
