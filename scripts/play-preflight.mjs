#!/usr/bin/env node
/**
 * The checks behind Play_With_Claude.bat / .command, in one testable place.
 *
 *   node scripts/play-preflight.mjs            what is running, and what to start
 *   node scripts/play-preflight.mjs --wait N   wait until what was started answers (N = the code above)
 *   node scripts/play-preflight.mjs --deps     can the installed packages actually load?
 *
 * Exit codes of the default mode:
 *    0  engine and live display already running from this folder: start nothing
 *   20  start both (npm run dev)
 *   21  engine is running: start only the live display (vite)
 *   22  live display is running: start only the engine (node server.js)
 *   23  start only the engine: port 5173 belongs to another program, so no live display
 *    1  cannot continue; the reason and what to do are printed
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { portTaken } from '../server/mcp/engineLauncher.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Fixed ports in normal use; NE_ENGINE_PORT / NE_UI_PORT move a test copy out of the way.
export const ENGINE_PORT = Number(process.env.NE_ENGINE_PORT) || 3001;
export const UI_PORT = Number(process.env.NE_UI_PORT) || 5173;
export const ENGINE_URL = `http://127.0.0.1:${ENGINE_PORT}`;
export const UI_URL = `http://localhost:${UI_PORT}`;
export const START = { NONE: 0, BOTH: 20, UI: 21, ENGINE: 22, ENGINE_NO_UI: 23, ERROR: 1 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function samePath(a, b, platform = process.platform) {
    const clean = (p) => {
        const s = String(p ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/');
        return platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s;
    };
    return clean(a) !== '' && clean(a) === clean(b);
}

async function getJson(fetchImpl, url) {
    try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(4000) });
        return res.ok ? await res.json() : null;
    } catch {
        return null;
    }
}

async function getText(fetchImpl, url) {
    try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(4000) });
        return res.ok ? await res.text() : null;
    } catch {
        return null;
    }
}

/**
 * engine: 'ours' (this folder) | 'other' (another or older copy of Narrative Engine)
 *       | 'foreign' (a different program has the port) | 'down'
 * ui:     'up' | 'foreign' | 'down'
 */
export async function probe({ folder = REPO_ROOT, fetchImpl = globalThis.fetch, portTakenImpl = portTaken, platform = process.platform } = {}) {
    const status = { engine: 'down', engineFolder: '', enginePid: null, ui: 'down' };
    const info = await getJson(fetchImpl, `${ENGINE_URL}/api/launcher/info`);
    if (info?.app === 'narrative-engine') {
        status.engine = samePath(info.folder, folder, platform) ? 'ours' : 'other';
        status.engineFolder = info.folder ?? '';
        status.enginePid = info.pid ?? null;
    } else if (Array.isArray(await getJson(fetchImpl, `${ENGINE_URL}/api/campaigns`))) {
        status.engine = 'other'; // a copy from before /api/launcher/info existed
    } else if (await portTakenImpl(ENGINE_URL)) {
        status.engine = 'foreign';
    }
    const page = await getText(fetchImpl, `${UI_URL}/launcher.html`);
    if (page !== null && /Narrative Engine/i.test(page)) status.ui = 'up';
    else if (page !== null || await portTakenImpl(UI_URL)) status.ui = 'foreign';
    return status;
}

/** Best effort, Windows only: which process is listening on a port. */
export function pidOnPort(port, run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf-8', windowsHide: true })) {
    try {
        const line = run('netstat', ['-ano', '-p', 'tcp']).split(/\r?\n/)
            .find((l) => /LISTENING/i.test(l) && new RegExp(`[:.]${port}\\s`).test(l));
        const pid = Number(line?.trim().split(/\s+/).pop());
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
        return null;
    }
}

/** What to start, and what to tell the player. Pure: unit-tested. */
export function decide(status, { pid = null, platform = process.platform } = {}) {
    const stop = pid && platform === 'win32'
        ? [`To close it: press the Windows key, type cmd, press Enter, then type   taskkill /PID ${pid} /F   and press Enter.`]
        : ['Close that program (restarting the computer also works), then run this again.'];
    if (status.engine === 'foreign') {
        return { code: START.ERROR, lines: [`Another program is already using port ${ENGINE_PORT}, which Narrative Engine needs.`, ...stop, 'Then run this again.'] };
    }
    if (status.engine === 'other') {
        return {
            code: START.ERROR,
            lines: [
                status.engineFolder
                    ? `A different copy of Narrative Engine is already running, from this folder:\n      ${status.engineFolder}`
                    : 'An older copy of Narrative Engine is already running (from another folder, or from before an update).',
                'Only one can run at a time. Close its window (the minimized "Narrative Engine" window in the taskbar).',
                ...(pid ? stop : []),
                'Then run this again.',
            ],
        };
    }
    if (status.ui === 'foreign') {
        const lines = [`Note: another program is using port ${UI_PORT}, so the live display window is not available.`, 'You can still play: Claude does not need it.'];
        return status.engine === 'ours'
            ? { code: START.NONE, lines: ['Narrative Engine is already running.', ...lines] }
            : { code: START.ENGINE_NO_UI, lines };
    }
    if (status.engine === 'ours' && status.ui === 'up') return { code: START.NONE, lines: ['Narrative Engine is already running. Nothing to start.'] };
    if (status.engine === 'ours') return { code: START.UI, lines: ['Narrative Engine is already running. Starting the live display...'] };
    if (status.ui === 'up') return { code: START.ENGINE, lines: ['Starting Narrative Engine...'] };
    return { code: START.BOTH, lines: ['Starting Narrative Engine (live display window)...'] };
}

/** After starting: wait until the parts that were started answer. */
export async function waitReady(code, { probeImpl = probe, timeoutMs = 150_000, intervalMs = 1500, log = console.log } = {}) {
    const needUi = code === START.BOTH || code === START.UI;
    const deadline = Date.now() + timeoutMs;
    let status = await probeImpl();
    let said = false;
    while (Date.now() < deadline) {
        if (status.engine === 'ours' && (!needUi || status.ui === 'up')) return { ready: true, status };
        if (!said && Date.now() > deadline - timeoutMs + 12_000) { log('  Still starting (the first start takes a minute or two)...'); said = true; }
        await sleep(intervalMs);
        status = await probeImpl();
    }
    return { ready: false, status };
}

/**
 * npm runs package install scripts through cmd.exe, which mis-parses a folder
 * path containing these characters ("\Narrative was unexpected at this time").
 * Spaces are fine. Only Windows is affected.
 */
export function pathIsInstallable(folder, platform = process.platform) {
    return platform !== 'win32' || !/[&()^!%]/.test(folder);
}

/** Can the engine's native pieces load with this Node? (They break when Node is upgraded.) */
export function checkDeps(root = REPO_ROOT) {
    const require = createRequire(path.join(root, 'package.json'));
    // @narrative/engine is this repo's own packages/engine, linked into
    // node_modules by absolute path: moving the folder leaves the link dangling.
    // `npm install` re-links it.
    const missing = ['express', '@modelcontextprotocol/sdk/package.json', 'vite/package.json', 'concurrently/package.json', 'esbuild']
        .filter((m) => { try { require.resolve(m); return false; } catch { return true; } });
    if (missing.length) return { ok: false, fix: 'install', reason: `not installed yet: ${missing.join(', ')}` };
    // existsSync follows the link, so a dangling one reads as missing.
    if (!fs.existsSync(path.join(root, 'node_modules', '@narrative', 'engine', 'package.json'))) {
        return { ok: false, fix: 'install', reason: 'This folder was moved or renamed since the install; re-linking it.' };
    }
    try {
        const Database = require('better-sqlite3');
        new Database(':memory:').close();
    } catch (err) {
        return { ok: false, fix: 'rebuild', reason: `the database module does not load with Node ${process.versions.node} (${String(err.message).split('\n')[0]})` };
    }
    return { ok: true };
}

function tail(file, lines = 12) {
    try { return fs.readFileSync(file, 'utf-8').trim().split(/\r?\n/).slice(-lines).map((l) => `      ${l}`).join('\n'); } catch { return ''; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const say = (lines) => { for (const l of lines) console.log(`  ${l}`); };
    if (process.argv.includes('--path')) process.exit(pathIsInstallable(REPO_ROOT) ? 0 : 1);
    if (process.argv.includes('--deps')) {
        const r = checkDeps();
        if (!r.ok) console.log(`  ${r.reason}`);
        process.exit(r.ok ? 0 : r.fix === 'install' ? 10 : 11);
    }
    const waitIdx = process.argv.indexOf('--wait');
    if (waitIdx > 0) {
        const code = Number(process.argv[waitIdx + 1]);
        const { ready, status } = await waitReady(code);
        if (ready) { say(['Narrative Engine is running.']); process.exit(0); }
        const devLog = path.join(REPO_ROOT, 'server', 'mcp', '.cache', 'dev.log');
        say([
            status.engine === 'ours' ? 'The engine started, but the live display did not. You can still play in Claude.' : 'Narrative Engine did not start.',
            'Last lines of its log (server\\mcp\\.cache\\dev.log):',
        ]);
        console.log(tail(devLog) || '      (the log is empty)');
        process.exit(status.engine === 'ours' ? 3 : 2);
    }
    const status = await probe();
    const pid = status.engine === 'foreign' || status.engine === 'other' ? (status.enginePid ?? pidOnPort(ENGINE_PORT)) : null;
    const { code, lines } = decide(status, { pid });
    say(lines);
    process.exit(code);
}
