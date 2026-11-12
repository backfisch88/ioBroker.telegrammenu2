'use strict';

const { getMenu } = require('./registry');
const { t } = require('./botI18n');

const PLACEHOLDER_RE = /\{\{([^}]+)\}\}/g;
const DATE_ONLY_RE = /^(\d{4}-\d{2}-\d{2})$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

// Distinguishes "date only" (2026-07-19) from "date with time"
// (2026-07-19T14:30) - so the matching format applies instead of showing an
// invented 00:00 time for plain date values.
function classifyDateLike(val) {
    if (typeof val !== 'string') {
        return null;
    }
    const s = val.trim();
    if (DATE_ONLY_RE.test(s)) {
        return 'date';
    }
    if (DATE_TIME_RE.test(s)) {
        return 'datetime';
    }
    return null;
}

function formatDateWithPattern(date, pattern) {
    const pad = n => String(n).padStart(2, '0');
    return String(pattern)
        .replace(/YYYY/g, date.getFullYear())
        .replace(/MM/g, pad(date.getMonth() + 1))
        .replace(/DD/g, pad(date.getDate()))
        .replace(/HH/g, pad(date.getHours()))
        .replace(/mm/g, pad(date.getMinutes()))
        .replace(/ss/g, pad(date.getSeconds()));
}

// Format plain date values (YYYY-MM-DD) WITHOUT a detour via new Date() -
// otherwise the string would be interpreted as UTC midnight and show up as
// 01:00/02:00 local time depending on the server time zone instead of exactly 00:00.
function formatDateOnlyWithPattern(dateOnlyStr, pattern) {
    const [y, m, d] = dateOnlyStr.split('-');
    return String(pattern)
        .replace(/YYYY/g, y)
        .replace(/MM/g, m)
        .replace(/DD/g, d)
        .replace(/HH/g, '00')
        .replace(/mm/g, '00')
        .replace(/ss/g, '00');
}

// Reads the global placeholder settings from the main menu node
// (menu key "main") - configurable in the editor under "⚙️ Global Settings".
// Falls back to sensible defaults if nothing is set.
async function getGlobalPlaceholderSettings(adapter) {
    try {
        const mainDef = await getMenu(adapter, 'main');
        return {
            boolEnabled: mainDef?.boolTranslateEnabled !== false,
            trueText: mainDef?.boolTrueText || t('bot.boolTrue'),
            falseText: mainDef?.boolFalseText || t('bot.boolFalse'),
            dateEnabled: mainDef?.dateTranslateEnabled !== false,
            dateFormat: mainDef?.dateFormat || 'DD.MM.YYYY',
            dateTimeFormat: mainDef?.dateTimeFormat || 'DD.MM.YYYY HH:mm',
        };
    } catch {
        return {
            boolEnabled: true,
            trueText: t('bot.boolTrue'),
            falseText: t('bot.boolFalse'),
            dateEnabled: true,
            dateFormat: 'DD.MM.YYYY',
            dateTimeFormat: 'DD.MM.YYYY HH:mm',
        };
    }
}

// Resolves {{0_userdata.0.Area.Datapoint}} in the message field from the editor
// against the current state value. Boolean and date/time values are translated/
// formatted automatically (both can be switched on/off globally and configured
// with their own text/format, see getGlobalPlaceholderSettings).
function formatPlaceholderValue(val, settings) {
    if (settings.boolEnabled) {
        if (val === true || val === 'true') {
            return settings.trueText;
        }
        if (val === false || val === 'false') {
            return settings.falseText;
        }
    }
    if (settings.dateEnabled) {
        const kind = classifyDateLike(val);
        if (kind === 'date') {
            return formatDateOnlyWithPattern(String(val).trim(), settings.dateFormat);
        }
        if (kind === 'datetime') {
            const d = new Date(val);
            if (!isNaN(d.getTime())) {
                return formatDateWithPattern(d, settings.dateTimeFormat);
            }
        }
    }
    return String(val);
}

// Tokenizer for expressions inside {{...}}: numbers, datapoint IDs (everything
// that is not a number/operator/string), arithmetic operators, parentheses,
// comparison operators and '...' string literals for the ternary part.
// Deliberately NO eval() - this is a small, safe, hand-written expression
// parser, even though templates are only set by the admin in the editor.
const TOKEN_RE = /\s*(?:'([^']*)'|(>=|<=|==|!=|[+\-*/()?:<>])|([^\s+\-*/()?:<>']+))/g;

function tokenize(raw) {
    const tokens = [];
    let m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(raw)) !== null) {
        if (m[1] !== undefined) {
            tokens.push({ type: 'string', value: m[1] });
        } else if (m[2] !== undefined) {
            tokens.push({ type: 'op', value: m[2] });
        } else if (m[3] !== undefined) {
            const num = Number(m[3]);
            tokens.push(Number.isNaN(num) ? { type: 'id', value: m[3] } : { type: 'num', value: num });
        }
    }
    return tokens;
}

// Collects all datapoint references (id tokens) of an expression so
// resolveTemplate can resolve them in one go (deduplicated) before the
// expression is evaluated.
function collectIds(tokens) {
    return tokens.filter(t => t.type === 'id').map(t => t.value);
}

// Small recursive descent parser with the usual precedence (multiplication
// before addition, then comparisons, "? 'a' : 'b'" last) - allows several
// datapoints in one expression, e.g. "(A - B) / B * 100" or
// "A - B > 0 ? '📈' : '📉'". On an error (missing value, wrong syntax) it
// returns null instead of throwing - resolveTemplate then shows '–'.
function evaluateExpression(tokens, values) {
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];

    function parsePrimary() {
        const t = peek();
        if (!t) {
            throw new Error('unerwartetes Ende');
        }
        if (t.type === 'op' && t.value === '(') {
            next();
            const v = parseComparison();
            if (!peek() || peek().value !== ')') {
                throw new Error(t('bot.missingClosingParen'));
            }
            next();
            return v;
        }
        if (t.type === 'op' && t.value === '-') {
            next();
            return -parsePrimary();
        }
        if (t.type === 'num') {
            next();
            return t.value;
        }
        if (t.type === 'id') {
            next();
            const raw = values[t.value];
            const n = Number(raw);
            if (raw === undefined || Number.isNaN(n)) {
                throw new Error(`"${t.value}" ist keine Zahl`);
            }
            return n;
        }
        throw new Error('unerwartetes Token');
    }

    function parseMultiplicative() {
        let v = parsePrimary();
        while (peek() && peek().type === 'op' && (peek().value === '*' || peek().value === '/')) {
            const op = next().value;
            const rhs = parsePrimary();
            if (op === '/' && rhs === 0) {
                throw new Error('Division durch 0');
            }
            v = op === '*' ? v * rhs : v / rhs;
        }
        return v;
    }

    function parseAdditive() {
        let v = parseMultiplicative();
        while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
            const op = next().value;
            const rhs = parseMultiplicative();
            v = op === '+' ? v + rhs : v - rhs;
        }
        return v;
    }

    function parseComparison() {
        const lhs = parseAdditive();
        const t = peek();
        if (t && t.type === 'op' && ['>', '<', '>=', '<=', '==', '!='].includes(t.value)) {
            const op = next().value;
            const rhs = parseAdditive();
            if (op === '>') {
                return lhs > rhs;
            }
            if (op === '<') {
                return lhs < rhs;
            }
            if (op === '>=') {
                return lhs >= rhs;
            }
            if (op === '<=') {
                return lhs <= rhs;
            }
            if (op === '==') {
                return lhs === rhs;
            }
            return lhs !== rhs;
        }
        return lhs;
    }

    // A branch after "?" or ":" is either a 'string' literal or - for chains like
    // "if X then A, else if Y then B, else C" - again a complete (nested) ternary
    // expression.
    function parseTernaryBranch() {
        if (peek() && peek().type === 'string') {
            return next().value;
        }
        return parseTernary();
    }

    function parseTernary() {
        const cond = parseComparison();
        if (peek() && peek().type === 'op' && peek().value === '?') {
            next();
            const whenTrue = parseTernaryBranch();
            if (!peek() || peek().value !== ':') {
                throw new Error(': erwartet');
            }
            next();
            const whenFalse = parseTernaryBranch();
            return cond ? whenTrue : whenFalse;
        }
        return cond;
    }

    try {
        const result = parseTernary();
        if (pos < tokens.length) {
            return null;
        } // Reste übrig -> ungültige Syntax
        return result;
    } catch {
        return null;
    }
}

async function resolveTemplate(adapter, text) {
    if (!text || !text.includes('{{')) {
        return text || '';
    }

    const settings = await getGlobalPlaceholderSettings(adapter);
    const matches = [...text.matchAll(PLACEHOLDER_RE)];
    const tokenized = matches.map(m => tokenize(m[1]));
    const values = {};

    const allIds = new Set();
    for (const tokens of tokenized) {
        for (const id of collectIds(tokens)) {
            allIds.add(id);
        }
    }
    for (const id of allIds) {
        try {
            const state = await adapter.getForeignStateAsync(id);
            values[id] = state && state.val !== null && state.val !== undefined ? state.val : undefined;
        } catch {
            values[id] = undefined;
        }
    }

    let i = 0;
    return text.replace(PLACEHOLDER_RE, () => {
        const tokens = tokenized[i++];

        // Exactly one single id token, no operators -> unchanged old behavior
        // (boolean/date formatting), so existing templates stay exactly the same.
        if (tokens.length === 1 && tokens[0].type === 'id') {
            const raw = values[tokens[0].value];
            return formatPlaceholderValue(raw === undefined ? '–' : raw, settings);
        }

        const result = evaluateExpression(tokens, values);
        if (result === null) {
            return '–';
        }
        return typeof result === 'number' ? String(Math.round(result)) : String(result);
    });
}

// Resolves the "status-dependent" emoji from the editor: reads the status
// datapoint, matches it against the rules, otherwise falls back to the
// default emoji.
async function resolveIcon(adapter, iconConfig, fallbackEmoji) {
    if (!iconConfig || !iconConfig.datapoint) {
        return fallbackEmoji || '';
    }

    try {
        const state = await adapter.getForeignStateAsync(iconConfig.datapoint);
        const val = state ? String(state.val) : '';
        const rule = (iconConfig.rules || []).find(r => matchesRuleValue(r.value, val));
        return rule ? rule.emoji : iconConfig.fallback || fallbackEmoji || '';
    } catch {
        return iconConfig.fallback || fallbackEmoji || '';
    }
}

// Like resolveIcon, but returns the WHOLE matching rule (not only the emoji) -
// for the multi-status switch, which also needs the label and target datapoint
// per status.
// Compares a rule value with the actual datapoint value. Allows either an
// exact match ("50", "true", "cooling") OR a comparison operator as prefix
// ("<50", ">=20.5") for numeric ranges.
function matchesRuleValue(ruleValue, actualValStr) {
    const rv = String(ruleValue).trim();
    const m = rv.match(/^(<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)$/);
    if (m) {
        const num = Number(actualValStr);
        if (Number.isNaN(num)) {
            return false;
        }
        const threshold = Number(m[2]);
        switch (m[1]) {
            case '<':
                return num < threshold;
            case '<=':
                return num <= threshold;
            case '>':
                return num > threshold;
            case '>=':
                return num >= threshold;
            default:
                return false;
        }
    }
    return rv === actualValStr;
}

async function resolveIconRule(adapter, iconConfig) {
    if (!iconConfig || !iconConfig.datapoint) {
        return null;
    }
    try {
        const state = await adapter.getForeignStateAsync(iconConfig.datapoint);
        const val = state ? String(state.val) : '';
        return (iconConfig.rules || []).find(r => matchesRuleValue(r.value, val)) || null;
    } catch {
        return null;
    }
}

module.exports = { resolveTemplate, resolveIcon, resolveIconRule, matchesRuleValue };
