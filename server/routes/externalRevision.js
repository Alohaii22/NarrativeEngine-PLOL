import { Router } from 'express';
import { validateCampaignId } from '../lib/fileStore.js';
import { wrapAsync } from '../lib/asyncHandler.js';

/**
 * External-writer revision counter.
 *
 * The MCP server (server/mcp) lets Claude run a campaign from Claude Desktop
 * while the Narrative Engine UI stays open as a live display. It writes
 * through this same API and tags every write with `X-NE-Writer: mcp`.
 *
 * This router counts those tagged writes per campaign and exposes the count.
 * The UI polls it and re-hydrates when it moves. Counting only tagged writes
 * matters: the UI's own saves must never trigger a reload of itself.
 *
 * The counter is in memory. A server restart resets it to 0, and the UI
 * treats any change, including a reset, as "reload".
 */
export const EXTERNAL_WRITER_HEADER = 'x-ne-writer';

const CAMPAIGN_PATH = /^\/api\/campaigns\/([a-zA-Z0-9_-]+)(?:\/|$)/;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createExternalRevisionRouter() {
    const router = Router();
    const revisions = new Map();

    router.use((req, res, next) => {
        if (!WRITE_METHODS.has(req.method) || !req.headers[EXTERNAL_WRITER_HEADER]) return next();
        const match = CAMPAIGN_PATH.exec(req.path);
        // Searches are POSTs too, but they change nothing.
        if (!match || /semantic-candidates|\/search$/.test(req.path)) return next();
        const campaignId = match[1];
        res.on('finish', () => {
            if (res.statusCode < 400) revisions.set(campaignId, (revisions.get(campaignId) ?? 0) + 1);
        });
        next();
    });

    router.get('/api/campaigns/:id/external-revision', wrapAsync((req, res) => {
        validateCampaignId(req.params.id);
        res.json({ revision: revisions.get(req.params.id) ?? 0 });
    }));

    return router;
}
