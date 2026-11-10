import { describe, it, expect, vi } from 'vitest';
import { pollExternalRevision, type ExternalSyncDeps } from '../useExternalCampaignSync';

function deps(revision: number | null, busy = false): ExternalSyncDeps & { rehydrate: ReturnType<typeof vi.fn> } {
    return {
        fetchRevision: vi.fn(async () => revision),
        isBusy: () => busy,
        rehydrate: vi.fn(async () => {}),
    };
}

describe('pollExternalRevision', () => {
    it('records a baseline on the first poll without reloading', async () => {
        const d = deps(3);
        expect(await pollExternalRevision('c1', undefined, d)).toBe(3);
        expect(d.rehydrate).not.toHaveBeenCalled();
    });

    it('reloads when Claude changed the campaign', async () => {
        const d = deps(4);
        expect(await pollExternalRevision('c1', 3, d)).toBe(4);
        expect(d.rehydrate).toHaveBeenCalledWith('c1');
    });

    it('reloads after a server restart resets the counter', async () => {
        const d = deps(0);
        expect(await pollExternalRevision('c1', 7, d)).toBe(0);
        expect(d.rehydrate).toHaveBeenCalled();
    });

    it('waits while a turn streams or a save is pending, then retries', async () => {
        const busy = deps(4, true);
        expect(await pollExternalRevision('c1', 3, busy)).toBe(3);
        expect(busy.rehydrate).not.toHaveBeenCalled();
    });

    it('keeps the last revision when the server is unreachable', async () => {
        const d = deps(null);
        expect(await pollExternalRevision('c1', 3, d)).toBe(3);
        expect(d.rehydrate).not.toHaveBeenCalled();
    });
});
