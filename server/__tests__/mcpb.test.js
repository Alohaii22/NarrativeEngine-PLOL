import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildBundle, buildManifest, LAUNCHER, writeInstallPointer } from '../../scripts/build-mcpb.mjs';

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

    /** Runs the generated launcher the way Claude Desktop does, with a pointer file of our choosing. */
    function runLauncher(env) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-'));
        const launcher = path.join(dir, 'index.js');
        fs.writeFileSync(launcher, LAUNCHER);
        const pointer = path.join(dir, 'install.json');
        if (env.pointer) fs.writeFileSync(pointer, JSON.stringify(env.pointer));
        const r = spawnSync(process.execPath, [launcher], {
            env: { ...process.env, NE_POINTER_FILE: pointer, NE_NODE: '', NE_FOLDER: env.folder ?? '' },
            encoding: 'utf-8',
            input: '',
            timeout: 20_000,
        });
        return { ...r, dir };
    }

    /** A folder that looks like an install: the MCP entry point, optionally "installed". */
    function fakeInstall({ installed = true, entry = 'process.stderr.write("FAKE MCP SERVER STARTED in " + process.cwd());' } = {}) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ne install '));
        fs.mkdirSync(path.join(root, 'server', 'mcp'), { recursive: true });
        fs.writeFileSync(path.join(root, 'server', 'mcp', 'index.js'), entry);
        if (installed) fs.mkdirSync(path.join(root, 'node_modules', '@modelcontextprotocol', 'sdk'), { recursive: true });
        return root;
    }

    it('launcher explains a missing folder instead of crashing silently', () => {
        const r = runLauncher({ folder: path.join(os.tmpdir(), 'no-such-ne-folder') });
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/folder not found/);
        expect(r.stderr).toMatch(/Play_With_Claude\.bat/);
    });

    it('launcher starts the server from the configured folder (spaces in the path)', () => {
        const root = fakeInstall();
        const r = runLauncher({ folder: root });
        expect(r.status).toBe(0);
        expect(r.stderr).toContain('FAKE MCP SERVER STARTED');
        expect(fs.readFileSync(path.join(root, 'server', 'mcp', '.cache', 'mcp.log'), 'utf-8')).toMatch(/Starting .*index\.js/);
    });

    it('launcher follows a moved folder: uses the one Play_With_Claude last ran from', () => {
        const moved = fakeInstall();
        const r = runLauncher({ folder: 'C:\\Old Place\\Narrative Engine', pointer: { folder: moved } });
        expect(r.status).toBe(0);
        expect(r.stderr).toMatch(/is gone; using/);
        expect(r.stderr).toContain('FAKE MCP SERVER STARTED');
    });

    it('launcher prefers the folder set in the extension when both exist', () => {
        const configured = fakeInstall({ entry: 'process.stderr.write("CONFIGURED");' });
        const other = fakeInstall({ entry: 'process.stderr.write("POINTER");' });
        const r = runLauncher({ folder: configured, pointer: { folder: other } });
        expect(r.stderr).toContain('CONFIGURED');
        expect(r.stderr).not.toContain('POINTER');
    });

    it('launcher says to run Play_With_Claude when the folder was never installed', () => {
        const r = runLauncher({ folder: fakeInstall({ installed: false }) });
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/not installed yet/);
    });

    it('launcher passes the server\'s exit code and stderr through, and logs them', () => {
        const root = fakeInstall({ entry: 'console.error("boom: cannot find module"); process.exit(7);' });
        const r = runLauncher({ folder: root });
        expect(r.status).toBe(7);
        expect(r.stderr).toContain('boom: cannot find module');
        const log = fs.readFileSync(path.join(root, 'server', 'mcp', '.cache', 'mcp.log'), 'utf-8');
        expect(log).toContain('boom: cannot find module');
        expect(log).toMatch(/MCP server exited \(7\)/);
    });

    it('records where this install lives for the extension to find', () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcpb-')), 'nested', 'install.json');
        writeInstallPointer({ folder: 'C:\\Games\\NE', nodePath: 'C:\\node.exe', file });
        expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toMatchObject({ folder: 'C:\\Games\\NE', node: 'C:\\node.exe' });
    });
});
