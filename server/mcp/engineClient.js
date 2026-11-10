/**
 * Thin client for the Narrative Engine HTTP API (server.js, port 3001).
 *
 * The MCP server never touches `data/` directly: the running engine stays the
 * single writer, keeps its vector index and archive pipeline, and the open UI
 * sees every change. Every write carries `X-NE-Writer: mcp` so the UI knows to
 * re-hydrate (server/routes/externalRevision.js).
 */
export const DEFAULT_ENGINE_URL = 'http://127.0.0.1:3001';

export class EngineUnavailableError extends Error {}

export function createEngineClient({
    baseUrl = process.env.NARRATIVE_ENGINE_URL || DEFAULT_ENGINE_URL,
    fetchImpl = globalThis.fetch,
} = {}) {
    const root = baseUrl.replace(/\/+$/, '');

    async function request(method, path, body) {
        const headers = { Accept: 'application/json' };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        if (method !== 'GET') headers['X-NE-Writer'] = 'mcp';
        let res;
        try {
            res = await fetchImpl(`${root}${path}`, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
            });
        } catch (err) {
            throw new EngineUnavailableError(
                `Can't reach Narrative Engine at ${root} (${err?.message ?? err}). ` +
                'Start it first: run `npm run dev` (or `node server.js`) in the NarrativeEngine folder.',
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
