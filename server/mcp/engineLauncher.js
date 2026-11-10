/**
 * Starts the Narrative Engine server (server.js) in the background when the
 * MCP server finds it isn't running, so playing from Claude Desktop needs no
 * terminal. Output goes to server/mcp/.cache/engine.log.
 *
 * Disable with NE_AUTOSTART=0 (e.g. when the engine runs on another machine).
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const LOG_FILE = path.join(HERE, '.cache', 'engine.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isUp(baseUrl, fetchImpl) {
    try {
        const res = await fetchImpl(`${baseUrl}/api/campaigns`);
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * @returns {() => Promise<boolean>} call when a request fails to connect;
 *   resolves true once the engine answers, false if it could not be started.
 */
export function createEngineLauncher({
    baseUrl,
    fetchImpl = globalThis.fetch,
    spawnImpl = spawn,
    timeoutMs = 90_000,
    enabled = process.env.NE_AUTOSTART !== '0',
} = {}) {
    let pending = null;
    const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(baseUrl);

    return function ensureEngine() {
        if (!enabled || !local) return Promise.resolve(false);
        if (pending) return pending;
        pending = (async () => {
            if (await isUp(baseUrl, fetchImpl)) return true;
            fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
            const out = fs.openSync(LOG_FILE, 'a');
            console.error(`[MCP] Narrative Engine isn't running; starting it (log: ${LOG_FILE})`);
            const child = spawnImpl(process.execPath, ['server.js'], {
                cwd: REPO_ROOT,
                detached: true,
                stdio: ['ignore', out, out],
                windowsHide: true,
            });
            child.unref?.();
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
                await sleep(500);
                if (await isUp(baseUrl, fetchImpl)) return true;
            }
            return false;
        })().finally(() => { setTimeout(() => { pending = null; }, 0); });
        return pending;
    };
}
