import type { GameContext, LootTree } from '../types';
import {
    saveLoreChunks, getNPCLedger, saveNPCLedger,
    loadCampaignState, saveCampaignState,
} from '../store/campaignStore';
import { extractEngineSeeds } from './lore/loreEngineSeeder';
import { parseNPCsFromLore } from './lore/loreNPCParser';
import { parseLocationsFromLoreDetailed } from './lore/loreLocationParser';
import { locationTableDescriptor, loadLocationTable } from './tables/locationTable';
import { genericSave } from './tables/genericAccessor';
import { resolvePlace } from './locationParser';
import { dedupeNPCLedger } from '../store/slices/campaignSlice';
import { loadLootTree } from './lore/lootTreeLoader';
import { readWorldFile, type WorldImport } from './lore/worldCard';


export { DEFAULT_CONTEXT, DEFAULT_CONDENSER } from './campaignKit';
import { DEFAULT_CONTEXT, DEFAULT_CONDENSER, chunkMarkdownLore, applyEngineSeeds } from './campaignKit';

export async function initializeCampaignState(params: {
    campaignId: string;
    loreFile: File | null;
    rulesFile: File | null;
    lootFile?: File | null;
    preparedWorld?: WorldImport;
}): Promise<void> {
    const { campaignId, loreFile, rulesFile, lootFile } = params;

    let seeds: ReturnType<typeof extractEngineSeeds> | null = null;
    if (loreFile) {
        const importedWorld = params.preparedWorld ?? (/\.(png|json)$/i.test(loreFile.name) ? await readWorldFile(loreFile) : null);
        const loreText = importedWorld ? '' : await loreFile.text();
        // Character and location chunks are RAG-disabled on import: the parsers below turn
        // the same chunks into ledger entries, and the ledger is the authoritative injection
        // path for both (payload/world.ts drops any ledger NPC whose name collides with a
        // retrieved lore header, so leaving both on lets lore shadow the ledger; for places
        // the shadowing is the reverse — lore says "Flourishing" forever while the ledger's
        // `status` tracks that the city was sacked in ch. 12).
        // Filters on category, not disabled, so seeding is unaffected. Re-enable per chunk
        // or in bulk from the Context Bank → World tab.
        const chunks = importedWorld ? importedWorld.card.world.chunks : chunkMarkdownLore(loreText);
        await saveLoreChunks(campaignId, chunks);

        // Keep authored world-card keywords unchanged; enrich legacy Markdown only.
        if (!importedWorld) try {
            const { useAppStore } = await import('../store/useAppStore');
            const utilityEndpointForEnrichment = useAppStore.getState().getActiveUtilityEndpoint();
            if (utilityEndpointForEnrichment?.endpoint) {
                import('./lore/loreKeywordEnricher').then(({ enrichLoreKeywords }) => {
                    enrichLoreKeywords(campaignId, chunks, utilityEndpointForEnrichment)
                        .catch(err => console.warn('[LoreEnricher] Background enrichment failed:', err));
                }).catch(() => {});
            }
        } catch (err) {
            console.warn('[LoreEnricher] Failed to queue enrichment:', err);
        }

        // World cards carry lore only; do not turn imported entries into live NPCs or locations.
        if (!importedWorld) {
            const parsedNPCs = parseNPCsFromLore(chunks);
            if (parsedNPCs.length > 0) {
                const existingNPCs = await getNPCLedger(campaignId);
                await saveNPCLedger(campaignId, dedupeNPCLedger([...existingNPCs, ...parsedNPCs]));
            }

            // Same deal for places. Dedupe against the existing ledger by name+alias
            // (resolvePlace is the ledger's own matcher) so re-importing a lore file
            // into a campaign in progress tops up rather than duplicating.
            // WO 6.3 §3 — use the detailed parse so unresolvable `ConnectedTo:`
            // names warn (the ledger and the map must agree).
            const { locations: parsedLocations, warnings: locationWarnings } = parseLocationsFromLoreDetailed(chunks);
            for (const w of locationWarnings) {
                console.warn(`[loreLocationParser] ${w}`);
            }
            if (parsedLocations.length > 0) {
                const existingLocations = await loadLocationTable(campaignId);
                const additions = parsedLocations.filter(loc => !resolvePlace(loc.name, existingLocations));
                if (additions.length > 0) {
                    await genericSave(locationTableDescriptor as never, campaignId, [...existingLocations, ...additions]);
                }
            }

            seeds = extractEngineSeeds(chunks);
        }
    }

    let lootTree: LootTree | null = null;
    if (lootFile) {
        try {
            const rawLoot = JSON.parse(await lootFile.text());
            lootTree = loadLootTree(rawLoot);
        } catch (e) {
            console.error('[LootLoader] Failed to parse lootFile:', e);
        }
    }

    const existingState = await loadCampaignState(campaignId);
    if (!existingState || rulesFile || seeds || lootTree) {
        const ctx = { ...DEFAULT_CONTEXT, ...(existingState?.context ?? {}) } as GameContext;
        if (rulesFile) ctx.rulesRaw = await rulesFile.text();
        if (lootTree) ctx.lootTree = lootTree;
        const seeded = seeds ? applyEngineSeeds(ctx, seeds) : ctx;
        await saveCampaignState(campaignId, {
            context: { ...DEFAULT_CONTEXT, ...seeded }, messages: existingState?.messages ?? [],
            condenser: { ...(existingState?.condenser ?? DEFAULT_CONDENSER) },
        });
    }
}
