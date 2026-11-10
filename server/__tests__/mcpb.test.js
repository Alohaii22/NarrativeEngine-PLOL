import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildBundle, buildManifest, LAUNCHER } from '../../scripts/build-mcpb.mjs';

describe('Claude Desktop extension (.mcpb)', () => {
    it('describes a node server with the folder as a directory setting', () => {
        const m = buildManifest({ folder: '/games/NE', nodePath: '/usr/bin/node', version: '9.9.9' });
        expect(m).toMatchObject({ manifest_version: '0.3', name: 'narrative-engine', version: '9.9.9' });
        expect(m.server).toMatchObject({ type: 'node', entry_point: 'server/index.js' });
        expect(m.server.mcp_config.env).toEqual({ NE_FOLDER: '${user_config.folder}', NE_NODE: '/usr/bin/node' });
        expect(m.user_config.folder).toMatchObject({ type: 'directory', required: true, default: '/games/NE' });
    });

    it('packs a zip that unzip can read, with manifest, launcher and icon', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-'));
        const file = path.join(dir, 'ne.mcpb');
        fs.writeFileSync(file, buildBundle());
        const listing = execFileSync('unzip', ['-l', file], { encoding: 'utf-8' });
        for (const name of ['manifest.json', 'server/index.js', 'icon.png']) expect(listing).toContain(name);
        const manifest = JSON.parse(execFileSync('unzip', ['-p', file, 'manifest.json'], { encoding: 'utf-8' }));
        expect(manifest.name).toBe('narrative-engine');
        expect(execFileSync('unzip', ['-p', file, 'server/index.js'], { encoding: 'utf-8' })).toBe(LAUNCHER);
    });

    it('launcher explains a missing folder instead of crashing silently', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-'));
        const launcher = path.join(dir, 'index.js');
        fs.writeFileSync(launcher, LAUNCHER);
        const r = spawnSync(process.execPath, [launcher], { env: { ...process.env, NE_FOLDER: path.join(dir, 'nope') }, encoding: 'utf-8' });
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/folder not found/);
    });
});
