import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createLauncherRouter } from '../routes/launcher.js';

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(createLauncherRouter({ enginePort: 1 }));

const card = JSON.stringify({ spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Maren Cole', description: 'Harbor pilot.', personality: 'blunt', scenario: '', first_mes: 'Hi', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags: [], creator: '', character_version: '', extensions: {} } });
const lore = '# Coast\n\n## Overview\nA drowned coastline of salt mines.\n\n## Guild\nMiners.\n\n## Port\nA harbor.\n\n## Cult\nLantern keepers.\n\n## Money\nSalt tokens.\n';

describe('Campaign Launcher API', () => {
    it('lists bundled worlds and rulesets', async () => {
        const res = await request(app).get('/api/launcher/worlds');
        expect(res.status).toBe(200);
        expect(res.body.worlds.length).toBeGreaterThan(10);
        expect(res.body.rulesets).toContain(res.body.defaultRuleset);
    });

    it('requires lore before a campaign can be made', async () => {
        const res = await request(app).post('/api/launcher/check').send({});
        expect(res.body.ready).toBe(false);
        expect(res.body.checks[0]).toMatchObject({ level: 'error', slot: 'lore' });
    });

    it('checks a bundled world', async () => {
        const res = await request(app).post('/api/launcher/check').send({ world: 'class scroll world' });
        expect(res.body.ready).toBe(true);
        expect(res.body.checks.map((c) => c.slot)).toEqual(expect.arrayContaining(['lore', 'rules', 'starter', 'loot']));
    }, 60_000);

    it('checks uploaded lore, rules and character cards, flagging bad cards', async () => {
        const res = await request(app).post('/api/launcher/check').send({
            loreText: lore, rulesText: 'Be fair.', rulesName: 'mine.md',
            cards: [{ name: 'maren.json', text: card }, { name: 'bad.json', text: '{"x":1}' }],
        });
        expect(res.body.ready).toBe(false);
        expect(res.body.npcs).toContain('Maren Cole');
        const texts = res.body.checks.map((c) => `${c.level}:${c.text}`);
        expect(texts).toEqual(expect.arrayContaining(['ok:Character card: Maren Cole', 'ok:GM rules: mine.md']));
        expect(texts.some((t) => t.startsWith('error:bad.json'))).toBe(true);
    }, 60_000);

    it('rejects unknown worlds', async () => {
        const res = await request(app).post('/api/launcher/check').send({ world: 'zzz-not-a-world' });
        expect(res.status).toBe(400);
    });
});
