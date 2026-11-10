import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createExternalRevisionRouter } from '../routes/externalRevision.js';

function makeApp() {
    const app = express();
    app.use(express.json());
    app.use(createExternalRevisionRouter());
    app.put('/api/campaigns/:id/state', (_req, res) => res.json({ ok: true }));
    app.post('/api/campaigns/:id/lore/semantic-candidates', (_req, res) => res.json({ loreIds: [] }));
    app.put('/api/campaigns/:id/broken', (_req, res) => res.status(500).json({ error: 'x' }));
    return app;
}

const revision = async (app, id = 'c1') => (await request(app).get(`/api/campaigns/${id}/external-revision`)).body.revision;

describe('external revision counter', () => {
    it('counts only successful MCP-tagged writes, per campaign', async () => {
        const app = makeApp();
        expect(await revision(app)).toBe(0);

        await request(app).put('/api/campaigns/c1/state').send({});
        expect(await revision(app)).toBe(0); // the UI's own save

        await request(app).put('/api/campaigns/c1/state').set('X-NE-Writer', 'mcp').send({});
        expect(await revision(app)).toBe(1);
        expect(await revision(app, 'c2')).toBe(0);

        await request(app).post('/api/campaigns/c1/lore/semantic-candidates').set('X-NE-Writer', 'mcp').send({});
        await request(app).put('/api/campaigns/c1/broken').set('X-NE-Writer', 'mcp').send({});
        expect(await revision(app)).toBe(1); // searches and failures change nothing
    });

    it('rejects invalid campaign ids', async () => {
        const res = await request(makeApp()).get('/api/campaigns/..%2Fetc/external-revision');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});
