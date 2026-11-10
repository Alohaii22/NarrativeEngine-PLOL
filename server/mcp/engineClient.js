/**
 * Thin client for the Narrative Engine HTTP API (server.js, port 3001).
 *
 * The MCP server never touches `data/` directly: the running engine stays the
 * single writer, keeps its vector index and archive pipeline, and the open UI
 * sees every change. Every write carries `X-NE-Writer: mcp` so the UI knows to
 * re-hydrate (server/routes/externalRevision.js).
 */
export const DEFAULT_ENGINE_URL = `http://127.0.0.1:${Number(process.env.NE_ENGINE_PORT) || 3001}`;

export class EngineUnavailableError extends Error {}

export function createEngineClient({
    baseUrl = process.env.NARRATIVE_ENGINE_URL || DEFAULT_ENGINE_URL,
    fetchImpl = globalThis.fetch,
    ensureEngine = null,
    timeoutMs = 60_000,
} = {}) {
    const root = baseUrl.replace(/\/+$/, '');

    async function request(method, path, body) {
        const headers = { Accept: 'application/json' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (method !== 'GET') headers['X-NE-Writer'] = 'mcp';
        const send = () => fetchImpl(`${root}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            // A hung engine must fail the tool call, not hang the chat.
            signal: AbortSignal.timeout(timeoutMs),
        });
        let res;
        try {
            try {
                res = await send();
            } catch (err) {
                // Not running? Start it (engineLauncher.js) and try once more.
                if (!ensureEngine || !(await ensureEngine())) throw err;
                res = await send();
            }
        } catch (err) {
            const cause = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? err;
            const why = ensureEngine?.lastError ? `${ensureEngine.lastError} ` : '';
            throw new EngineUnavailableError(
                `Narrative Engine is not running, so nothing can be loaded or saved (no answer from ${root}: ${cause}). ${why}` +
                'Tell the player, in plain words: double-click Play_With_Claude.bat in the Narrative Engine folder ' +
                '(or run `npm run dev` there), wait for the window to say it is running, then ask to continue. ' +
                'Startup details are in server/mcp/.cache/engine.log. Do not keep narrating as if turns were saved.',
            );
        }
        if (res.status === 404) return null;
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`Narrative Engine ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
        }
        return res.json();
    }

    const c = (id) => `/api/campaigns/${encodeURIComponent(id)}`;

    return {
        baseUrl: root,
        listCampaigns: () => request('GET', '/api/campaigns'),
        getCampaign: (id) => request('GET', c(id)),
        putCampaign: (id, meta) => request('PUT', c(id), meta),
        putLore: (id, chunks) => request('PUT', `${c(id)}/lore`, chunks),
        getLocations: (id) => request('GET', `${c(id)}/locations`),
        putLocations: (id, locations) => request('PUT', `${c(id)}/locations`, locations),
        getChapters: (id) => request('GET', `${c(id)}/archive/chapters`),
        sealChapter: (id, title) => request('POST', `${c(id)}/archive/chapters/seal`, { title }),
        patchChapter: (id, chapterId, patch) => request('PATCH', `${c(id)}/archive/chapters/${encodeURIComponent(chapterId)}`, patch),
        addTimelineEvent: (id, event) => request('POST', `${c(id)}/timeline`, event),
        getState: (id) => request('GET', `${c(id)}/state`),
        putState: (id, state) => request('PUT', `${c(id)}/state`, state),
        getLore: (id) => request('GET', `${c(id)}/lore`),
        getNpcs: (id) => request('GET', `${c(id)}/npcs`),
        putNpcs: (id, npcs) => request('PUT', `${c(id)}/npcs`, npcs),
        loreSearch: (id, query, limit) => request('POST', `${c(id)}/lore/semantic-candidates`, { query, limit }),
        archiveSearch: (id, query, limit) => request('POST', `${c(id)}/archive/semantic-candidates`, { query, limit }),
        getArchiveIndex: (id) => request('GET', `${c(id)}/archive/index`),
        getScenes: (id, sceneIds) => request('GET', `${c(id)}/archive/scenes?ids=${encodeURIComponent(sceneIds.join(','))}`),
        appendScene: (id, userContent, assistantContent, importance) =>
            request('POST', `${c(id)}/archive`, {
                userContent,
                assistantContent,
                ...(typeof importance === 'number' ? { importance } : {}),
            }),
    };
}
