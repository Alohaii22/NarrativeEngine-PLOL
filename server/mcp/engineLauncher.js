/**
 * Starts the Narrative Engine server (server.js) in the background when the
 * MCP server finds it isn't running, so playing from Claude Desktop needs no
 * terminal. Output goes to server/mcp/.cache/engine.log.
 *
 * Disable with NE_AUTOSTART=0 (e.g. when the engine runs on another machine).
 */
import fs from 'fs';
import net from 'net';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const LOG_FILE = path.join(HERE, '.cache', 'engine.log');
const MAX_LOG_BYTES = 2 * 1024 * 1024;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function isUp(baseUrl, fetchImpl) {
    try {
        const res = await fetchImpl(`${baseUrl}/api/campaigns`, { signal: AbortSignal.timeout(5000) });
        return res.ok;
    } catch {
        return false;
    }
}

/** Is anything at all listening there? (Tells "engine is down" from "another program has the port".) */
function portTaken(baseUrl) {
    return new Promise((resolve) => {
        const { hostname, port } = new URL(baseUrl);
        const socket = net.connect({ host: hostname, port: Number(port) || 80 });
        const done = (taken) => { socket.destroy(); resolve(taken); };
        socket.setTimeout(1500, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

function logTail(logFile, lines = 6) {
    try {
        return fs.readFileSync(logFile, 'utf-8').trim().split(/\r?\n/).slice(-lines).join(' | ').slice(-600);
    } catch {
        return '';
    }
}

/**
 * @returns {(() => Promise<boolean>) & { lastError: string }} call when a
 *   request fails to connect; resolves true once the engine answers, false if
 *   it could not be started (`lastError` then says why, in plain words).
 */
export function createEngineLauncher({
    baseUrl,
    fetchImpl = globalThis.fetch,
    spawnImpl = spawn,
    portTakenImpl = portTaken,
    timeoutMs = 90_000,
    enabled = process.env.NE_AUTOSTART !== '0',
    repoRoot = REPO_ROOT,
    logFile = LOG_FILE,
} = {}) {
    let pending = null;
    const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(baseUrl);

    async function start() {
        ensureEngine.lastError = '';
        if (await isUp(baseUrl, fetchImpl)) return true;
        if (!fs.existsSync(path.join(repoRoot, 'node_modules', 'express'))) {
            ensureEngine.lastError = 'Narrative Engine is not installed yet: double-click Play_With_Claude.bat once so it can install.';
            return false;
        }
        if (await portTakenImpl(baseUrl)) {
            ensureEngine.lastError = `Another program is using port ${new URL(baseUrl).port}. Close it (or restart the PC), then try again.`;
            return false;
        }
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        try { if (fs.statSync(logFile).size > MAX_LOG_BYTES) fs.truncateSync(logFile); } catch { /* no log yet */ }
        const out = fs.openSync(logFile, 'a');
        fs.writeSync(out, `\n[${new Date().toISOString()}] starting the engine from ${repoRoot} with ${process.execPath}\n`);
        console.error(`[MCP] Narrative Engine isn't running; starting it (log: ${logFile})`);
        let exited = null;
        try {
            const child = spawnImpl(process.execPath, ['server.js'], {
                cwd: repoRoot,
                detached: true,
                stdio: ['ignore', out, out],
                windowsHide: true,
            });
            child.on?.('exit', (code, signal) => { exited = signal ?? code ?? 1; });
            child.on?.('error', (err) => { exited = err.message; });
            child.unref?.();
        } catch (err) {
            exited = err.message;
        } finally {
            fs.closeSync(out);
        }
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await sleep(exited === null ? 500 : 0);
            if (await isUp(baseUrl, fetchImpl)) return true;
            if (exited !== null) {
                ensureEngine.lastError = `The engine stopped right after starting (${exited}). Last lines of engine.log: ${logTail(logFile) || '(empty)'}`;
                return false;
            }
        }
        ensureEngine.lastError = `The engine did not answer within ${Math.round(timeoutMs / 1000)} seconds.`;
        return false;
    }

    function ensureEngine() {
        if (!enabled || !local) return Promise.resolve(false);
        if (pending) return pending;
        pending = start().finally(() => { setTimeout(() => { pending = null; }, 0); });
        return pending;
    }
    ensureEngine.lastError = '';
    return ensureEngine;
}
