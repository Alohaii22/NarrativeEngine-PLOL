/**
 * Loads src/services/campaignKit.ts in Node by bundling it with esbuild on
 * first use. Campaigns Claude creates are then built by exactly the code the
 * app's New Campaign form uses. The bundle is cached under server/mcp/.cache
 * and rebuilt whenever any of its source files changes.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const ENTRY = path.join(REPO_ROOT, 'src/services/campaignKit.ts');
const CACHE_DIR = path.join(HERE, '.cache');
const OUT = path.join(CACHE_DIR, 'campaignKit.mjs');
const META = path.join(CACHE_DIR, 'campaignKit.meta.json');

let loaded;

function isFresh() {
    if (!fs.existsSync(OUT) || !fs.existsSync(META)) return false;
    try {
        const builtAt = fs.statSync(OUT).mtimeMs;
        const inputs = JSON.parse(fs.readFileSync(META, 'utf-8'));
        return inputs.every((rel) => {
            const file = path.join(REPO_ROOT, rel);
            return fs.existsSync(file) && fs.statSync(file).mtimeMs <= builtAt;
        });
    } catch {
        return false;
    }
}

async function build() {
    let esbuild;
    try {
        esbuild = await import('esbuild');
    } catch {
        throw new Error('esbuild is missing. Run `npm install` in the NarrativeEngine folder (or double-click Play_With_Claude again).');
    }
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const result = await esbuild.build({
        entryPoints: [ENTRY],
        bundle: true,
        platform: 'node',
        format: 'esm',
        outfile: OUT,
        absWorkingDir: REPO_ROOT,
        metafile: true,
        logLevel: 'silent',
        // Browser-only build-time constant some shared modules reference.
        define: { __APP_VERSION__: '"mcp"' },
    });
    fs.writeFileSync(META, JSON.stringify(Object.keys(result.metafile.inputs).filter((p) => !p.startsWith('node_modules'))));
}

export async function loadCampaignKit() {
    if (loaded) return loaded;
    if (!isFresh()) await build();
    // Shared modules log progress with console.log; in stdio mode stdout is the
    // MCP protocol channel, so keep their chatter on stderr.
    const log = console.log;
    console.log = (...args) => console.error(...args);
    try {
        loaded = await import(`${pathToFileURL(OUT).href}?v=${fs.statSync(OUT).mtimeMs}`);
    } finally {
        console.log = log;
    }
    return loaded;
}
