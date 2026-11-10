// Closing the window inside the one-second save debounce used to lose those
// edits: nothing flushed on the way out. These pin the two behaviours the fix
// relies on, against the real save pipeline with only `fetch` stubbed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFlushSavesOnExit } from '../useFlushSavesOnExit';
import { useAppStore } from '../../store/useAppStore';
import { cancelPendingSaves, debouncedSaveCampaignState, debouncedSaveNPCLedger, hasPendingSaves } from '../../store/slices/campaignSlice';

type AppState = ReturnType<typeof useAppStore.getState>;
let fetchMock: ReturnType<typeof vi.fn>;

function setVisibility(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
}

function fireBeforeUnload(): BeforeUnloadEvent {
    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent;
    window.dispatchEvent(event);
    return event;
}

beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    cancelPendingSaves();
    useAppStore.setState({ activeCampaignId: 'camp-a' } as Partial<AppState>);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
});

afterEach(() => {
    cancelPendingSaves();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('useFlushSavesOnExit', () => {
    it('sends pending saves as soon as the page is hidden', () => {
        renderHook(() => useFlushSavesOnExit());
        debouncedSaveCampaignState();
        expect(fetchMock).not.toHaveBeenCalled();     // still inside the debounce

        setVisibility('hidden');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/campaigns\/camp-a\/state$/);
        expect(hasPendingSaves()).toBe(false);
    });

    it('warns before unload while a save is pending, and starts it', () => {
        renderHook(() => useFlushSavesOnExit());
        debouncedSaveCampaignState();

        const event = fireBeforeUnload();

        expect(event.defaultPrevented).toBe(true);    // the browser shows "leave site?"
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('lets the page close without a prompt when nothing is pending', () => {
        renderHook(() => useFlushSavesOnExit());
        const event = fireBeforeUnload();
        expect(event.defaultPrevented).toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does nothing when the page becomes visible again', () => {
        renderHook(() => useFlushSavesOnExit());
        debouncedSaveCampaignState();
        setVisibility('visible');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    // The timer handles were never cleared when the debounce fired on its own,
    // so after the first save the page reported a pending save for ever: a
    // "leave site?" prompt on every close, and the live display never reloaded
    // turns Claude recorded through the MCP server (useExternalCampaignSync
    // skips a reload while a save is pending).
    it('stops reporting a pending save once the debounce has fired by itself', () => {
        renderHook(() => useFlushSavesOnExit());
        debouncedSaveCampaignState();
        debouncedSaveNPCLedger('camp-a', []);
        expect(hasPendingSaves()).toBe(true);

        vi.advanceTimersByTime(1100);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(hasPendingSaves()).toBe(false);
        expect(fireBeforeUnload().defaultPrevented).toBe(false);
    });

    it('removes its listeners on unmount', () => {
        const { unmount } = renderHook(() => useFlushSavesOnExit());
        unmount();
        debouncedSaveCampaignState();
        expect(fireBeforeUnload().defaultPrevented).toBe(false);
    });
});
