import { describe, it, expect } from 'vitest';
import { probe, decide, waitReady, samePath, pidOnPort, pathIsInstallable, checkDeps, START, ENGINE_URL, UI_URL } from '../../scripts/play-preflight.mjs';

/** A fake machine: what answers on the engine and UI ports. */
function machine({ engine = null, legacyEngine = false, ui = null, taken = [] } = {}) {
    const json = (body) => new Response(JSON.stringify(body), { status: 200 });
    const fetchImpl = async (url) => {
        if (url === `${ENGINE_URL}/api/launcher/info`) {
            if (engine) return json({ app: 'narrative-engine', folder: engine.folder, pid: engine.pid ?? 4242 });
            if (legacyEngine) return new Response('{"error":"Not found"}', { status: 404 });
        }
        if (url === `${ENGINE_URL}/api/campaigns` && (engine || legacyEngine)) return json([]);
        if (url === `${UI_URL}/launcher.html` && ui !== null) return new Response(ui, { status: 200 });
        throw new TypeError('fetch failed');
    };
    const portTakenImpl = async (url) => taken.includes(url);
    return { fetchImpl, portTakenImpl, folder: 'C:\\Games\\Narrative Engine', platform: 'win32' };
}
const OURS = { folder: 'c:/games/narrative engine/' };
const LAUNCHER_PAGE = '<title>Narrative Engine Campaign Launcher</title>';

describe('what is already running', () => {
    it('nothing: start both', async () => {
        const status = await probe(machine());
        expect(status).toMatchObject({ engine: 'down', ui: 'down' });
        expect(decide(status).code).toBe(START.BOTH);
    });

    it('everything, from this folder: start nothing (running the launcher twice)', async () => {
        const status = await probe(machine({ engine: OURS, ui: LAUNCHER_PAGE }));
        expect(status).toMatchObject({ engine: 'ours', ui: 'up' });
        const d = decide(status);
        expect(d.code).toBe(START.NONE);
        expect(d.lines.join(' ')).toMatch(/already running/);
    });

    it('engine only (auto-started by Claude): start just the live display', async () => {
        expect(decide(await probe(machine({ engine: OURS }))).code).toBe(START.UI);
    });

    it('live display only: start just the engine', async () => {
        expect(decide(await probe(machine({ ui: LAUNCHER_PAGE }))).code).toBe(START.ENGINE);
    });

    it('a copy in another folder has the port: stop, name the folder and how to close it', async () => {
        const status = await probe(machine({ engine: { folder: 'D:\\Old\\NarrativeEngine', pid: 5508 }, ui: LAUNCHER_PAGE }));
        expect(status).toMatchObject({ engine: 'other', engineFolder: 'D:\\Old\\NarrativeEngine', enginePid: 5508 });
        const d = decide(status, { pid: status.enginePid, platform: 'win32' });
        expect(d.code).toBe(START.ERROR);
        expect(d.lines.join('\n')).toMatch(/D:\\Old\\NarrativeEngine/);
        expect(d.lines.join('\n')).toMatch(/taskkill \/PID 5508 \/F/);
    });

    it('a copy from before the update has the port: stop', async () => {
        const status = await probe(machine({ legacyEngine: true }));
        expect(status.engine).toBe('other');
        const d = decide(status);
        expect(d.code).toBe(START.ERROR);
        expect(d.lines.join(' ')).toMatch(/older copy/i);
    });

    it('another program has port 3001: stop and say so in plain words', async () => {
        const status = await probe(machine({ taken: [ENGINE_URL] }));
        expect(status.engine).toBe('foreign');
        const d = decide(status, { pid: 777, platform: 'win32' });
        expect(d.code).toBe(START.ERROR);
        expect(d.lines[0]).toMatch(/Another program is already using port 3001/);
        expect(d.lines.join(' ')).toMatch(/taskkill \/PID 777 \/F/);
        expect(decide(status).lines.join(' ')).toMatch(/restarting the computer/);
    });

    it('another program has port 5173: play without the live display', async () => {
        const silent = await probe(machine({ taken: [UI_URL] }));
        const otherSite = await probe(machine({ ui: '<title>Some other dev server</title>' }));
        expect(silent.ui).toBe('foreign');
        expect(otherSite.ui).toBe('foreign');
        const d = decide(silent);
        expect(d.code).toBe(START.ENGINE_NO_UI);
        expect(d.lines.join(' ')).toMatch(/still play/);
        expect(decide({ ...silent, engine: 'ours' }).code).toBe(START.NONE);
    });
});

describe('helpers', () => {
    it('compares Windows paths without caring about case, slashes or a trailing slash', () => {
        expect(samePath('C:\\Games\\NE\\', 'c:/games/ne', 'win32')).toBe(true);
        expect(samePath('C:\\Games\\NE', 'C:\\Games\\NE2', 'win32')).toBe(false);
        expect(samePath('/home/a/NE', '/home/a/ne', 'linux')).toBe(false);
        expect(samePath('', '', 'win32')).toBe(false);
    });

    it('finds the process listening on a port from netstat output', () => {
        const netstat = () => [
            '  Proto  Local Address          Foreign Address        State           PID',
            '  TCP    127.0.0.1:30011        0.0.0.0:0              LISTENING       111',
            '  TCP    127.0.0.1:3001         0.0.0.0:0              LISTENING       5508',
            '  TCP    127.0.0.1:52000        127.0.0.1:3001         ESTABLISHED     999',
        ].join('\r\n');
        expect(pidOnPort(3001, netstat)).toBe(5508);
        expect(pidOnPort(8080, netstat)).toBeNull();
        expect(pidOnPort(3001, () => { throw new Error('no netstat'); })).toBeNull();
    });

    it('rejects folders npm cannot install into on Windows, and accepts spaces', () => {
        expect(pathIsInstallable('C:\\Games\\Narrative Engine', 'win32')).toBe(true);
        expect(pathIsInstallable('C:\\Users\\K\\Tom & Jerry\\NE', 'win32')).toBe(false);
        expect(pathIsInstallable('C:\\Games\\NE (copy)', 'win32')).toBe(false);
        expect(pathIsInstallable('C:\\Games\\100% NE', 'win32')).toBe(false);
        expect(pathIsInstallable('/Users/k/NE (copy)', 'darwin')).toBe(true);
    });

    it('reports a folder that was never installed', () => {
        expect(checkDeps('/no/such/folder')).toMatchObject({ ok: false, fix: 'install' });
        expect(checkDeps()).toEqual({ ok: true });
    });

    it('waits until what was started answers, and gives up after the timeout', async () => {
        let calls = 0;
        const coming = async () => (++calls < 3 ? { engine: 'down', ui: 'down' } : { engine: 'ours', ui: 'up' });
        expect(await waitReady(START.BOTH, { probeImpl: coming, intervalMs: 5, timeoutMs: 2000, log: () => {} })).toMatchObject({ ready: true });
        // Engine up but no display: enough when only the engine was started, not when both were.
        const engineOnly = async () => ({ engine: 'ours', ui: 'down' });
        expect((await waitReady(START.ENGINE_NO_UI, { probeImpl: engineOnly, intervalMs: 5, timeoutMs: 200, log: () => {} })).ready).toBe(true);
        expect(await waitReady(START.BOTH, { probeImpl: engineOnly, intervalMs: 5, timeoutMs: 60, log: () => {} })).toMatchObject({ ready: false, status: { engine: 'ours' } });
    });
});
