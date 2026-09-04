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

// Erkennt eine einfache Rechenoperation im Platzhalter, z.B.
// "{{...FlowSeconds / 60}}" oder sogar verkettet "{{...Ms / 1000 / 60}}".
// Der Datenpunkt-Teil darf keine Leerzeichen enthalten (haben ioBroker-IDs
// nie), die Operation(en) werden per Leerzeichen davon getrennt erkannt.
function parsePlaceholder(raw) {
    const parts = raw.trim().split(/\s+/);
    const id = parts[0];
    const ops = [];
    for (let i = 1; i + 1 < parts.length; i += 2) {
        const op = parts[i];
        const num = Number(parts[i + 1]);
        if (['+', '-', '*', '/'].includes(op) && !Number.isNaN(num)) {
            ops.push([op, num]);
        }
    }
    return { id, ops };
}

// Wendet die erkannten Operationen der Reihe nach an und rundet auf eine
// ganze Zahl (der Hauptfall dafür ist "Sekunden durch 60 = Minuten,
// gerundet"). Gibt null zurück, wenn der Wert keine Zahl ist (dann bleibt
// der Platzhalter unverändert - kein Rechnen mit Text möglich).
function applyPlaceholderMath(val, ops) {
    const n = Number(val);
    if (Number.isNaN(n)) {
        return null;
    }
    let result = n;
    for (const [op, num] of ops) {
        if (op === '+') {
            result += num;
        } else if (op === '-') {
            result -= num;
        } else if (op === '*') {
            result *= num;
        } else if (op === '/') {
            result = num !== 0 ? result / num : result;
        }
    }
    return Math.round(result);
}

async function resolveTemplate(adapter, text) {
    if (!text || !text.includes('{{')) {
        return text || '';
    }

    const settings = await getGlobalPlaceholderSettings(adapter);
    const matches = [...text.matchAll(PLACEHOLDER_RE)];
    const parsed = matches.map(m => parsePlaceholder(m[1]));
    const values = {};

    for (const id of [...new Set(parsed.map(p => p.id))]) {
        try {
            const state = await adapter.getForeignStateAsync(id);
            values[id] = state && state.val !== null && state.val !== undefined ? state.val : '–';
        } catch {
            values[id] = '–';
        }
    }

    let i = 0;
    return text.replace(PLACEHOLDER_RE, () => {
        const { id, ops } = parsed[i++];
        const raw = values[id] ?? '–';

        if (ops.length > 0) {
            const computed = applyPlaceholderMath(raw, ops);
            if (computed !== null) {
                return String(computed);
            }
        }

        return formatPlaceholderValue(raw, settings);
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
