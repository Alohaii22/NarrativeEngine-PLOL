import { describe, it, expect, vi } from 'vitest';
import { listWorlds, findWorld, readRuleset, worldBlurb, DEFAULT_RULESET } from '../mcp/worlds.js';
import { loadCampaignKit } from '../mcp/kit.js';
import { createCampaign } from '../mcp/gm.js';
import { createEngineLauncher } from '../mcp/engineLauncher.js';
import { createEngineClient } from '../mcp/engineClient.js';
import { mergeConfig, configPaths, serverEntry } from '../../scripts/install-claude-gm.mjs';
import fs from 'fs';

describe('world catalog', () => {
    const worlds = listWorlds();

    it('finds the bundled worlds once each, with lore', () => {
        expect(worlds.length).toBeGreaterThan(10);
        expect(new Set(worlds.map((w) => w.id)).size).toBe(worlds.length);
        for (const w of worlds) expect(fs.existsSync(w.loreFile)).toBe(true);
    });

    it('pairs lore with starter prompt and loot, and spots worlds with their own GM rules', () => {
        const scroll = findWorld('class scroll world');
        expect(scroll.loreFile).toMatch(/Lore\.md$/);
        expect(scroll.starterFile).toMatch(/Start_Prompt\.md$/);
        expect(scroll.lootFile).toMatch(/loot\.json$/);
        expect(findWorld('colonial').rulesFile).toMatch(/AI_GM_OS/);
        expect(findWorld('no such world at all')).toBeNull();
    });

    it('picks the default ruleset unless one is named', () => {
        expect(readRuleset(findWorld('tenebria')).name).toBe(DEFAULT_RULESET);
        expect(readRuleset(findWorld('tenebria'), 'v3.2').name).toMatch(/v3\.2/);
        expect(() => readRuleset(null, 'nonexistent-ruleset')).toThrow(/Options/);
    });

    it('writes a readable pitch without authoring markup', () => {
        for (const w of worlds) {
            const pitch = worldBlurb(w);
            expect(pitch).not.toMatch(/<!--|rag:|\[CHUNK/i);
        }
    });
});

describe('create_campaign', () => {
    it('builds a campaign with the app\'s own campaign kit', async () => {
        const kit = await loadCampaignKit();
        const writes = {};
        const client = {
            putCampaign: async (id, v) => { writes.meta = v; },
            putState: async (id, v) => { writes.state = v; },
            putLore: async (id, v) => { writes.lore = v; },
            putNpcs: async (id, v) => { writes.npcs = v; },
            putLocations: async (id, v) => { writes.locations = v; },
        };
        const world = findWorld('class scroll world');
        const result = await createCampaign(client, kit, {
            name: 'Test Run',
            loreText: fs.readFileSync(world.loreFile, 'utf-8'),
            rulesText: 'RULES',
            lootText: fs.readFileSync(world.lootFile, 'utf-8'),
            starterText: 'START',
        });
        expect(result.id).toMatch(/^cmp_[a-z0-9]+$/);
        expect(writes.meta).toMatchObject({ id: result.id, name: 'Test Run' });
        expect(writes.state.context).toMatchObject({ rulesRaw: 'RULES', starter: 'START', notebookActive: true });
        expect(writes.state.context.lootTree).toBeTruthy();
        expect(writes.state.context.encounterConfig.types.length).toBeGreaterThan(0);
        expect(writes.state.messages).toEqual([]);
        expect(writes.lore.length).toBe(result.loreEntries);
        expect(writes.lore.filter((c) => c.category === 'character').every((c) => c.disabled)).toBe(true);
        expect(writes.npcs?.length ?? 0).toBe(result.npcs);
    }, 60_000);
});

describe('Claude Desktop installer', () => {
    const entry = serverEntry('/usr/bin/node', '/repo/server/mcp/index.js');

    it('adds the server and keeps everything else', () => {
        const { changed, config } = mergeConfig('{"theme":"dark","mcpServers":{"other":{"command":"x"}}}', entry);
        expect(changed).toBe(true);
        expect(config.theme).toBe('dark');
        expect(config.mcpServers.other).toEqual({ command: 'x' });
        expect(config.mcpServers['narrative-engine']).toEqual(entry);
    });

    it('is idempotent and keeps user-added env settings', () => {
        const once = mergeConfig('', entry).config;
        once.mcpServers['narrative-engine'].env = { NE_AUTOSTART: '0' };
        const twice = mergeConfig(JSON.stringify(once), entry);
        expect(twice.changed).toBe(false);
        expect(twice.config.mcpServers['narrative-engine'].env).toEqual({ NE_AUTOSTART: '0' });
    });

    it('refuses to overwrite a config it cannot parse', () => {
        expect(() => mergeConfig('{ not json', entry)).toThrow();
        expect(() => mergeConfig('[1,2]', entry)).toThrow();
    });

    it('knows where Claude Desktop keeps its config', () => {
        expect(configPaths('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming', LOCALAPPDATA: '/nonexistent' }, '/h')[0]).toMatch(/Roaming[\\/]Claude[\\/]claude_desktop_config\.json$/);
        expect(configPaths('darwin', {}, '/Users/a')[0]).toBe('/Users/a/Library/Application Support/Claude/claude_desktop_config.json');
        expect(configPaths('linux', {}, '/home/a')[0]).toBe('/home/a/.config/Claude/claude_desktop_config.json');
    });
});

describe('engine auto-start', () => {
    it('starts the engine once when it is down, then retries the request', async () => {
        let up = false;
        const spawnImpl = vi.fn(() => { setTimeout(() => { up = true; }, 50); return { unref() {} }; });
        const fetchImpl = vi.fn(async () => {
            if (!up) throw new Error('ECONNREFUSED');
            return new Response('[]', { status: 200 });
        });
        const ensureEngine = createEngineLauncher({ baseUrl: 'http://127.0.0.1:3001', fetchImpl, spawnImpl, timeoutMs: 5_000, enabled: true });
        const client = createEngineClient({ baseUrl: 'http://127.0.0.1:3001', fetchImpl, ensureEngine });
        await expect(Promise.all([client.listCampaigns(), client.listCampaigns()])).resolves.toEqual([[], []]);
        expect(spawnImpl).toHaveBeenCalledTimes(1);
        expect(spawnImpl.mock.calls[0][1]).toEqual(['server.js']);
    });

    it('never spawns for a remote engine or when disabled', async () => {
        const spawnImpl = vi.fn();
        const fetchImpl = async () => { throw new Error('down'); };
        expect(await createEngineLauncher({ baseUrl: 'http://192.168.1.5:3001', fetchImpl, spawnImpl, enabled: true })()).toBe(false);
        expect(await createEngineLauncher({ baseUrl: 'http://127.0.0.1:3001', fetchImpl, spawnImpl, enabled: false })()).toBe(false);
        expect(spawnImpl).not.toHaveBeenCalled();
    });
});
