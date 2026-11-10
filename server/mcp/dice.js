/**
 * Standard dice notation for the GM: "d20", "2d6+3", "4d6kh3", "1d20+5 adv".
 * Rolls happen here, not in the model, so results are real and visible.
 */
const TERM = /^(\d*)d(\d+)(?:(kh|kl)(\d+))?$/i;
const MAX_DICE = 100;
const MAX_SIDES = 1000;

export class DiceError extends Error {}

/** The app's default d20 outcome bands (src/types/gamecontext.ts), read off the natural die. */
export function outcomeTier(natural) {
    if (natural <= 2) return 'Catastrophe';
    if (natural <= 6) return 'Failure';
    if (natural <= 15) return 'Success';
    if (natural <= 19) return 'Triumph';
    return 'Narrative Boon';
}

/**
 * @param {string} expression
 * @param {() => number} [random] returns [0, 1); injectable for tests
 */
export function rollDice(expression, random = Math.random) {
    const raw = String(expression ?? '').trim();
    if (!raw) throw new DiceError('Empty dice expression. Use forms like d20, 2d6+3, 4d6kh3, 1d20+5 adv.');

    let text = raw.toLowerCase();
    let mode = 'normal';
    const modeMatch = text.match(/\s+(adv|advantage|dis|disadvantage)$/);
    if (modeMatch) {
        mode = modeMatch[1].startsWith('adv') ? 'advantage' : 'disadvantage';
        text = text.slice(0, modeMatch.index).trim();
    }

    const compact = text.replace(/\s+/g, '');
    const tokens = compact.match(/[+-]?[^+-]+/g);
    // Anything the tokens do not cover ("d20+", "d20++5") is a typo, not a roll.
    if (!tokens || tokens.join('').length !== compact.length) throw new DiceError(`Can't read dice expression "${raw}"`);

    const groups = [];
    let modifier = 0;
    const rollDie = (sides) => 1 + Math.floor(random() * sides);

    for (const token of tokens) {
        const sign = token.startsWith('-') ? -1 : 1;
        const body = token.replace(/^[+-]/, '');
        if (/^\d+$/.test(body)) {
            modifier += sign * Number(body);
            continue;
        }
        const m = TERM.exec(body);
        if (!m) throw new DiceError(`Can't read "${token}" in "${raw}". Use forms like d20, 2d6+3, 4d6kh3.`);
        const count = m[1] ? Number(m[1]) : 1;
        const sides = Number(m[2]);
        if (count < 1 || count > MAX_DICE) throw new DiceError(`Dice count must be 1-${MAX_DICE}`);
        if (sides < 2 || sides > MAX_SIDES) throw new DiceError(`Dice sides must be 2-${MAX_SIDES}`);

        let rolls = Array.from({ length: count }, () => rollDie(sides));
        // Advantage/disadvantage applies to a single d20-style roll: roll it twice.
        let dropped = [];
        if (mode !== 'normal' && count === 1 && !m[3]) {
            const second = rollDie(sides);
            const pair = [rolls[0], second];
            const keep = mode === 'advantage' ? Math.max(...pair) : Math.min(...pair);
            dropped = [pair[0] === keep ? pair[1] : pair[0]];
            rolls = [keep];
        } else if (m[3]) {
            const keepCount = Math.min(Number(m[4]), count);
            const sorted = [...rolls].sort((a, b) => (m[3].toLowerCase() === 'kh' ? b - a : a - b));
            const kept = sorted.slice(0, keepCount);
            dropped = sorted.slice(keepCount);
            rolls = kept;
        }
        const subtotal = rolls.reduce((a, b) => a + b, 0) * sign;
        groups.push({ notation: `${sign < 0 ? '-' : ''}${body}`, sides, rolls, dropped, subtotal });
    }

    if (groups.length === 0) throw new DiceError(`"${raw}" has no dice in it. Use forms like d20, 2d6+3, 4d6kh3.`);
    const total = groups.reduce((a, g) => a + g.subtotal, 0) + modifier;
    const single = groups.length === 1 && groups[0].rolls.length === 1 ? groups[0] : null;
    return {
        expression: raw,
        mode,
        groups,
        modifier,
        total,
        natural: single ? single.rolls[0] : null,
        tier: single && single.sides === 20 ? outcomeTier(single.rolls[0]) : null,
        critical: single && single.sides === 20 ? (single.rolls[0] === 20 ? 'success' : single.rolls[0] === 1 ? 'failure' : null) : null,
    };
}

export function describeRoll(result, label) {
    const parts = result.groups.map((g) => {
        const dropped = g.dropped.length ? ` (dropped ${g.dropped.join(', ')})` : '';
        return `${g.notation}: [${g.rolls.join(', ')}]${dropped}`;
    });
    const mod = result.modifier ? ` ${result.modifier > 0 ? '+' : '-'} ${Math.abs(result.modifier)}` : '';
    const crit = result.critical === 'success' ? ' — NATURAL 20' : result.critical === 'failure' ? ' — NATURAL 1' : '';
    const mode = result.mode !== 'normal' ? ` with ${result.mode}` : '';
    const tier = result.tier ? ` · tier: ${result.tier}` : '';
    return `${label ? `${label}: ` : ''}${result.expression}${mode} → ${parts.join(' ')}${mod} = **${result.total}**${crit}${tier}`;
}
