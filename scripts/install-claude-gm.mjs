#!/usr/bin/env node
/**
 * Registers the Narrative Engine MCP server with Claude Desktop, so Claude can
 * run your campaigns. Used by Play_With_Claude.bat / .command; safe to run
 * any number of times.
 *
 * - Merges one "narrative-engine" entry into claude_desktop_config.json and
 *   leaves every other setting and server untouched.
 * - Backs up the existing config to claude_desktop_config.json.bak first.
 * - Uses absolute paths (Claude Desktop does not read your shell's PATH).
 *
 * Exit codes: 0 = already set up, 10 = config changed (restart Claude
 * Desktop to load it), 1 = error.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(REPO_ROOT, 'server', 'mcp', 'index.js');
const SERVER_NAME = 'narrative-engine';

export function configPaths(platform = process.platform, env = process.env, home = os.homedir()) {
    if (platform === 'win32') {
        const paths = [path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')];
        // The Microsoft Store build keeps its config in a virtualized folder.
        const packages = path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Packages');
        try {
            for (const dir of fs.readdirSync(packages)) {
                if (/^Claude_/i.test(dir)) paths.push(path.join(packages, dir, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
            }
        } catch { /* no Store packages */ }
        return paths;
    }
    if (platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')];
    return [path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json')];
}

export function serverEntry(nodePath = process.execPath, entry = SERVER_ENTRY) {
    return { command: nodePath, args: [entry] };
}

/** Returns { changed, config } with our server merged in. Throws on unreadable JSON. */
export function mergeConfig(existingText, entry) {
    let config = {};
    if (existingText && existingText.trim()) {
        config = JSON.parse(existingText);
        if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new Error('config is not a JSON object');
    }
    const servers = (config.mcpServers && typeof config.mcpServers === 'object') ? config.mcpServers : {};
    const current = servers[SERVER_NAME];
    const merged = { ...(current ?? {}), ...entry };
    const changed = JSON.stringify(current) !== JSON.stringify(merged);
    return { changed, config: { ...config, mcpServers: { ...servers, [SERVER_NAME]: merged } } };
}

export function install({ paths = configPaths(), entry = serverEntry(), log = console.log } = {}) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 20 || (major === 20 && minor < 19)) {
        throw new Error(`Node.js ${process.versions.node} is too old; Narrative Engine needs 20.19 or newer (nodejs.org).`);
    }
    let changedAny = false;
    // Write to every location that exists; if none does yet, create the standard one.
    const targets = paths.filter((p) => fs.existsSync(path.dirname(p)));
    if (targets.length === 0) {
        targets.push(paths[0]);
        log('Claude Desktop config folder not found yet. If Claude Desktop is not installed, get it from https://claude.ai/download');
    }
    for (const file of targets) {
        const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
        let result;
        try {
            result = mergeConfig(existing, entry);
        } catch (err) {
            throw new Error(`Can't read ${file} (${err.message}). Fix or delete that file, then run this again.`);
        }
        if (!result.changed) {
            log(`Already connected: ${file}`);
            continue;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (existing) fs.writeFileSync(`${file}.bak`, existing);
        fs.writeFileSync(file, `${JSON.stringify(result.config, null, 2)}\n`);
        log(`Connected Narrative Engine to Claude Desktop: ${file}`);
        changedAny = true;
    }
    return changedAny;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.exit(install() ? 10 : 0);
    } catch (err) {
        console.error(`Setup failed: ${err.message}`);
        process.exit(1);
    }
}
