import { useEffect } from 'react';
import { API_BASE as API } from '../lib/apiBase';
import { hasPendingSaves } from '../store/slices/campaignSlice';
import { hydrateCampaign } from '../store/campaignHydrator';
import { useAppStore } from '../store/useAppStore';

export const EXTERNAL_SYNC_INTERVAL_MS = 2500;

export type ExternalSyncDeps = {
    fetchRevision: (campaignId: string) => Promise<number | null>;
    isBusy: () => boolean;
    rehydrate: (campaignId: string) => Promise<void>;
};

/**
 * One poll step. Returns the revision to remember.
 *
 * `lastSeen === undefined` means "first poll": it records the baseline and
 * never reloads, so opening a campaign does not hydrate it twice. A busy UI
 * (a turn streaming, or a save still pending) skips the reload and keeps the
 * old revision, so the next poll retries instead of losing the change.
 */
export async function pollExternalRevision(
    campaignId: string,
    lastSeen: number | undefined,
    deps: ExternalSyncDeps,
): Promise<number | undefined> {
    const revision = await deps.fetchRevision(campaignId);
    if (revision === null) return lastSeen;
    if (lastSeen === undefined || revision === lastSeen) return revision;
    if (deps.isBusy()) return lastSeen;
    await deps.rehydrate(campaignId);
    return revision;
}

const defaultDeps: ExternalSyncDeps = {
    async fetchRevision(campaignId) {
        try {
            const res = await fetch(`${API}/campaigns/${campaignId}/external-revision`);
            if (!res.ok) return null;
            const body = await res.json() as { revision?: unknown };
            return typeof body.revision === 'number' ? body.revision : null;
        } catch {
            return null;
        }
    },
    isBusy: () => useAppStore.getState().isStreaming || hasPendingSaves(),
    rehydrate: (campaignId) => hydrateCampaign(campaignId),
};

/**
 * Keeps the open campaign in step with writes made outside this window —
 * today, Claude running the game through the MCP server (server/mcp). When
 * Claude records a turn or edits an NPC, the change shows up here within a
 * few seconds, with no manual refresh.
 */
export function useExternalCampaignSync(campaignId: string | null, enabled: boolean, deps: ExternalSyncDeps = defaultDeps) {
    useEffect(() => {
        if (!campaignId || !enabled) return;
        let lastSeen: number | undefined;
        let running = false;
        let stopped = false;
        const tick = async () => {
            if (running || stopped) return;
            running = true;
            try {
                lastSeen = await pollExternalRevision(campaignId, lastSeen, deps);
            } catch (e) {
                console.warn('[ExternalSync] poll failed:', e);
            } finally {
                running = false;
            }
        };
        void tick();
        const timer = setInterval(() => { void tick(); }, EXTERNAL_SYNC_INTERVAL_MS);
        return () => { stopped = true; clearInterval(timer); };
    }, [campaignId, enabled, deps]);
}
