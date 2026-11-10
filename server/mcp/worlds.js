/**
 * Catalog of the ready-made worlds and GM rulesets in Example_Setup/, so
 * Claude can start a campaign without the New Campaign form.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SETUP_DIR = process.env.NE_SETUP_DIR || path.join(REPO_ROOT, 'Example_Setup');
export const DEFAULT_RULESET = 'AI_GM_OS_v5.0 - Immersive Mode.md';

const STARTER = /start|starter|creation|interview/i;
const NOT_LORE = /design_pillars|merge_prompt|claude\.md|template/i;
const GM_OS = /^ai_gm_os/i;

export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function describeWorld(dir, name) {
    const files = fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile());
    const md = files.filter((f) => f.toLowerCase().endsWith('.md'));
    const starter = md.find((f) => STARTER.test(f));
    const rules = md.find((f) => GM_OS.test(f));
    const lore = md
        .filter((f) => f !== starter && f !== rules && !NOT_LORE.test(f))
        .map((f) => ({ f, size: fs.statSync(path.join(dir, f)).size }))
        .sort((a, b) => b.size - a.size)[0]?.f;
    if (!lore) return null;
    const loot = files.find((f) => /^loot.*\.json$/i.test(f));
    return {
        id: slug(name),
        name,
        dir,
        loreFile: path.join(dir, lore),
        starterFile: starter ? path.join(dir, starter) : null,
        rulesFile: rules ? path.join(dir, rules) : null,
        lootFile: loot ? path.join(dir, loot) : null,
    };
}

/** Every world folder under World_compendium (nested up to 3 deep), deduped by name. */
export function listWorlds(setupDir = SETUP_DIR) {
    const root = path.join(setupDir, 'World_compendium');
    if (!fs.existsSync(root)) return [];
    const found = new Map();
    const walk = (dir, depth) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (!entry.isDirectory()) continue;
            const full = path.join(dir, entry.name);
            const world = describeWorld(full, entry.name);
            if (world) {
                if (!found.has(world.id)) found.set(world.id, world);
            } else if (depth < 3) {
                walk(full, depth + 1);
            }
        }
    };
    walk(root, 1);
    return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function listRulesets(setupDir = SETUP_DIR) {
    const dir = path.join(setupDir, 'Ruleset');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort();
}

export function findWorld(query, setupDir = SETUP_DIR) {
    const worlds = listWorlds(setupDir);
    const q = slug(query);
    return worlds.find((w) => w.id === q)
        ?? worlds.find((w) => w.id.includes(q) || q.includes(w.id))
        ?? null;
}

/** First paragraph-ish of the lore, for a one-line pitch. */
export function worldBlurb(world, max = 220) {
    const text = fs.readFileSync(world.loreFile, 'utf-8').replace(/<!--[\s\S]*?-->/g, '');
    const SKIP = /setting bones|rag|retriev|file purpose|chunk|anchor id|^table of contents/i;
    const para = text.split(/\n\s*\n/)
        .map((p) => p.replace(/^#+.*$/gm, '').replace(/\[CHUNK:[^\]]*\]/g, '').replace(/[*_`>|]/g, '').replace(/\s+/g, ' ').trim())
        .find((p) => p.length > 60 && !SKIP.test(p) && !/^[-\s]+$/.test(p)) ?? '';
    return para.length > max ? `${para.slice(0, max).replace(/\s+\S*$/, '')}…` : para;
}

export function readRuleset(world, rulesetName, setupDir = SETUP_DIR) {
    if (rulesetName) {
        const file = listRulesets(setupDir).find((f) => f.toLowerCase().includes(rulesetName.toLowerCase()));
        if (!file) throw new Error(`No ruleset matching "${rulesetName}". Options: ${listRulesets(setupDir).join(', ')}`);
        return { name: file, text: fs.readFileSync(path.join(setupDir, 'Ruleset', file), 'utf-8') };
    }
    if (world?.rulesFile) return { name: path.basename(world.rulesFile), text: fs.readFileSync(world.rulesFile, 'utf-8') };
    const def = path.join(setupDir, 'Ruleset', DEFAULT_RULESET);
    return { name: DEFAULT_RULESET, text: fs.existsSync(def) ? fs.readFileSync(def, 'utf-8') : '' };
}
