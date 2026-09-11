'use strict';

const { getMenu } = require('./registry');

const PLACEHOLDER_RE = /\{\{([^}]+)\}\}/g;
const DATE_ONLY_RE = /^(\d{4}-\d{2}-\d{2})$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

// Unterscheidet "nur Datum" (2026-07-19) von "Datum mit Uhrzeit"
// (2026-07-19T14:30) - damit jeweils das passende Format greift, statt bei
// reinen Datumswerten eine erfundene 00:00-Uhrzeit mit anzuzeigen.
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

// Für reine Datumswerte (YYYY-MM-DD) OHNE Umweg über new Date() formatieren -
// sonst würde der String als UTC-Mitternacht interpretiert und je nach
// Server-Zeitzone als 01:00/02:00 lokal auftauchen statt exakt 00:00.
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

// Liest die globalen Platzhalter-Einstellungen aus dem Hauptmenü-Knoten
// (Menü-Schlüssel "main") - dort im Editor unter "⚙️ Globale Einstellungen"
// konfigurierbar. Fällt auf sinnvolle Standardwerte zurück, wenn nichts
// eingestellt wurde.
async function getGlobalPlaceholderSettings(adapter) {
    try {
        const mainDef = await getMenu(adapter, 'main');
        return {
            boolEnabled: mainDef?.boolTranslateEnabled !== false,
            trueText: mainDef?.boolTrueText || '✅ an',
            falseText: mainDef?.boolFalseText || '⛔ aus',
            dateEnabled: mainDef?.dateTranslateEnabled !== false,
            dateFormat: mainDef?.dateFormat || 'DD.MM.YYYY',
            dateTimeFormat: mainDef?.dateTimeFormat || 'DD.MM.YYYY HH:mm',
        };
    } catch {
        return {
            boolEnabled: true,
            trueText: '✅ an',
            falseText: '⛔ aus',
            dateEnabled: true,
            dateFormat: 'DD.MM.YYYY',
            dateTimeFormat: 'DD.MM.YYYY HH:mm',
        };
    }
}

// Löst {{0_userdata.0.Bereich.Datenpunkt}} im Nachricht-Feld aus dem Editor
// gegen den aktuellen State-Wert auf. Boolesche Werte und Datums-/Zeit-Werte
// werden automatisch übersetzt/formatiert (beides global ein-/ausschaltbar
// und mit eigenem Text/Format konfigurierbar, siehe getGlobalPlaceholderSettings).
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

// Tokenizer für Ausdrücke innerhalb von {{...}}: Zahlen, Datenpunkt-IDs
// (alles, was keine Zahl/Operator/String ist), Rechenoperatoren, Klammern,
// Vergleichsoperatoren und '...'-String-Literale für den Ternary-Teil.
// Bewusst KEIN eval() - das hier ist ein kleiner, sicherer, selbst
// geschriebener Ausdrucks-Parser, auch wenn die Templates nur vom Admin im
// Editor gesetzt werden.
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

// Sammelt alle Datenpunkt-Referenzen (id-Tokens) aus einem Ausdruck, damit
// resolveTemplate sie in einem Rutsch (dedupliziert) auflösen kann, bevor
// der Ausdruck ausgewertet wird.
function collectIds(tokens) {
    return tokens.filter(t => t.type === 'id').map(t => t.value);
}

// Kleiner rekursiver Abstiegsparser mit der üblichen Priorität (Punkt vor
// Strich, Vergleiche danach, "? 'a' : 'b'" ganz zuletzt) - erlaubt jetzt
// mehrere Datenpunkte in einem Ausdruck, z.B. "(A - B) / B * 100" oder
// "A - B > 0 ? '📈' : '📉'". Gibt bei einem Fehler (fehlender Wert, falsche
// Syntax) null zurück statt zu werfen - resolveTemplate zeigt dann '–'.
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
                throw new Error('schließende Klammer fehlt');
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

    // Ein Zweig nach "?" oder ":" ist entweder ein 'string'-Literal oder -
    // für Verkettungen wie "wenn X dann A, sonst wenn Y dann B, sonst C" -
    // wieder ein vollständiger (verschachtelter) Ternary-Ausdruck.
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

        // Genau ein einzelnes id-Token, keine Operatoren -> unverändertes
        // altes Verhalten (Bool-/Datums-Formatierung), damit bestehende
        // Templates exakt gleich bleiben.
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

// Löst das "Status-abhängig"-Emoji aus dem Editor auf: liest den
// Status-Datenpunkt, matcht gegen die Regeln, fällt sonst auf das
// Standard-Emoji zurück.
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

// Wie resolveIcon, gibt aber die GANZE passende Regel zurück (nicht nur das
// Emoji) - für den Multi-Status-Schalter, der auch Bezeichnung und
// Ziel-Datenpunkt pro Status braucht.
// Vergleicht einen Regel-Wert mit dem tatsächlichen Datenpunkt-Wert. Erlaubt
// entweder exakte Übereinstimmung ("50", "true", "cooling") ODER einen
// Vergleichsoperator als Prefix ("<50", ">=20.5") für numerische Bereiche.
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
