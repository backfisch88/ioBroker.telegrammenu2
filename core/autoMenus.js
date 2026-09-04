'use strict';

const { listUsers, isAdmin } = require('./users');
const { permLabel } = require('./permLabels');
const { getMenu } = require('./registry');

// Fasst eine flache Button-Liste zu Reihen zusammen (Breite konfigurierbar
// über die globale Einstellung "Buttons pro Zeile" am Hauptmenü-Knoten,
// Standard 2 - wie bisher).
function chunkButtons(buttons, perRow) {
    const n = Number(perRow) > 0 ? Number(perRow) : 2;
    const rows = [];
    for (let i = 0; i < buttons.length; i += n) {
        rows.push(buttons.slice(i, i + n));
    }
    return rows;
}

async function getGlobalButtonsPerRow(adapter) {
    try {
        const mainDef = await getMenu(adapter, 'main');
        return mainDef && Number(mainDef.buttonsPerRow) > 0 ? Number(mainDef.buttonsPerRow) : 2;
    } catch {
        return 2;
    }
}

const BACK_MAIN_ROW = [
    { text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' },
    { text: '🏠 Hauptmenü', cmd: 'TG:NAV:MAIN' },
];

// Baut zur Laufzeit die Buttons für ein Auto-Menü aus dem Editor
// ({ source: 'users' | 'notifyPrefs' | 'notifyPause' }). Ersetzt die sonst
// per Kante fest verdrahteten "rows" aus der Registry.

async function buildAutoRows(adapter, menuDef, userKey, menuKey) {
    const buttonsPerRow = await getGlobalButtonsPerRow(adapter);
    switch (menuDef.source) {
        case 'users':
            return buildUserRows(adapter, buttonsPerRow);
        case 'notifyPrefs':
            return buildNotifyPrefRows(adapter, userKey, buttonsPerRow);
        case 'notifyPause':
            return buildNotifyPauseRows(adapter, userKey, buttonsPerRow);
        case 'percentRange':
            return buildPercentRangeRows(adapter, menuDef, menuKey);
        case 'numberRange':
            return buildNumberRangeRows(adapter, menuDef, menuKey);
        default:
            return [[{ text: '⚠️ Unbekannte Auto-Quelle', cmd: 'TG:NAV:BACK' }]];
    }
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

// Vordefinierte Wert-Submenüs (analog "menu:percent10:..." /
// "menu:number1-20-2-unit:..." aus ioBroker.telegram-menu): erzeugt eine
// Reihe von Buttons über einen Wertebereich als INLINE-Keyboard (siehe
// renderMenu/sendInlineMenu in base.js). Ein Tap schreibt den Wert direkt
// auf den konfigurierten Datenpunkt (per TG:VALSET:<menuKey>|<value>, siehe
// core/valueSubmenus.js). "menuKey" statt des vollen Datenpunktpfads im
// callback_data, weil Telegram dafür ein 64-Byte-Limit hat - der Handler
// schlägt den Datenpunkt anhand des Menü-Schlüssels serverseitig nach. Der
// aktuell aktive Wert wird live aus dem Datenpunkt gelesen und mit ✅
// markiert. Extra-Button "✏️ Eigener Wert" für Werte außerhalb der festen
// Schritte (z. B. 3,5 statt nur 3/4) - nutzt denselben Ziffernblock wie die
// normale Zahleneingabe.
//
// menuDef-Felder: datapoint (Pflicht), min, max, step, unit, rowLength
async function buildPercentRangeRows(adapter, menuDef, menuKey) {
    const min = Number.isFinite(Number(menuDef.min)) ? Number(menuDef.min) : 0;
    const max = Number.isFinite(Number(menuDef.max)) ? Number(menuDef.max) : 100;
    const step = Number(menuDef.step) > 0 ? Number(menuDef.step) : 10;
    const unit = menuDef.unit || '%';
    const rowLength = Number(menuDef.rowLength) > 0 ? Number(menuDef.rowLength) : 5;
    return buildValueRangeRows(adapter, menuDef.datapoint, min, max, step, unit, rowLength, menuKey);
}

async function buildNumberRangeRows(adapter, menuDef, menuKey) {
    const min = Number.isFinite(Number(menuDef.min)) ? Number(menuDef.min) : 0;
    const max = Number.isFinite(Number(menuDef.max)) ? Number(menuDef.max) : 100;
    const step = Number(menuDef.step) > 0 ? Number(menuDef.step) : 1;
    const unit = menuDef.unit || '';
    const rowLength = Number(menuDef.rowLength) > 0 ? Number(menuDef.rowLength) : 4;
    return buildValueRangeRows(adapter, menuDef.datapoint, min, max, step, unit, rowLength, menuKey);
}

async function buildValueRangeRows(adapter, datapoint, min, max, step, unit, rowLength, menuKey) {
    if (!datapoint) {
        return [[{ text: '⚠️ Kein Datenpunkt konfiguriert', cmd: 'TG:NAV:BACK' }]];
    }

    let current = null;
    try {
        const state = await adapter.getForeignStateAsync(datapoint);
        if (state && state.val !== null && state.val !== undefined) {
            current = Number(state.val);
        }
    } catch {
        current = null;
    }

    // min > max erlaubt (absteigende Reihenfolge, wie "20-1" in ioBroker.telegram-menu)
    const ascending = max >= min;
    const s = Math.abs(step) || 1;

    const values = [];
    if (ascending) {
        for (let v = min; v <= max + 1e-9; v = round2(v + s)) {
            values.push(round2(v));
        }
    } else {
        for (let v = min; v >= max - 1e-9; v = round2(v - s)) {
            values.push(round2(v));
        }
    }

    const buttons = values.map(v => {
        const isCurrent = current !== null && !isNaN(current) && Math.abs(current - v) < 1e-9;
        return { text: `${isCurrent ? '✅ ' : ''}${v}${unit}`, cmd: `TG:VALSET:${menuKey}|${v}` };
    });

    const rows = [];
    for (let i = 0; i < buttons.length; i += rowLength) {
        rows.push(buttons.slice(i, i + rowLength));
    }
    if (!rows.length) {
        rows.push([{ text: '⚠️ Kein Wertebereich konfiguriert', cmd: 'TG:NAV:BACK' }]);
    }
    rows.push([{ text: '✏️ Eigener Wert', cmd: `TG:VALCUSTOM:${menuKey}` }]);
    return rows;
}

async function buildUserRows(adapter, buttonsPerRow) {
    const users = await listUsers(adapter);
    const buttons = [];
    for (const userKey of users) {
        const admin = await isAdmin(adapter, userKey);
        buttons.push({ text: `${admin ? '👑' : '👤'} ${userKey}`, cmd: `TG:ADMIN:USER:${userKey}` });
    }
    const rows = chunkButtons(buttons, buttonsPerRow);
    if (!rows.length) {
        rows.push([{ text: 'Noch keine Nutzer registriert', cmd: 'TG:NAV:BACK' }]);
    }
    rows.push(BACK_MAIN_ROW);
    return rows;
}

// Sammelt alle (area,type)-Paare mit ihrem Anzeigenamen, gefiltert auf das,
// was der Nutzer sehen darf. Wird von den zwei Untermenüs (Umschalten,
// Pausieren) gemeinsam genutzt, damit beide dieselbe Sicht auf die
// Bereiche haben.
async function collectVisibleAreaTypes(adapter, userKey) {
    const areas = adapter.notify.getValidAreas();
    const admin = await isAdmin(adapter, userKey);

    const groups = new Map(); // "Anzeigename" -> [{area, type}]
    const areaSet = new Set();

    for (const [area, types] of Object.entries(areas)) {
        if (!admin) {
            const permState = await adapter.getStateAsync(`users.${userKey}.permissions.${area}`);
            const allowed = permState?.val === true || permState?.val === 'true';
            if (!allowed) {
                continue;
            }
        }
        areaSet.add(area);

        const typeList = types.length ? types : ['general'];
        for (const type of typeList) {
            // Override-Typen (können nicht ausgeschaltet werden) tauchen im Menü
            // gar nicht erst auf - kein irreführender Umschalter, der nichts bewirkt.
            if (adapter.notify.isOverride && adapter.notify.isOverride(area, type)) {
                continue;
            }

            const typeLabel = adapter.notify.getLabel ? adapter.notify.getLabel(area, type) : type;
            const areaLabel = (adapter.notify.getAreaLabel && adapter.notify.getAreaLabel(area)) || permLabel(area);
            const displayText = `${areaLabel}: ${typeLabel}`;
            if (!groups.has(displayText)) {
                groups.set(displayText, []);
            }
            groups.get(displayText).push({ area, type });
        }
    }

    return { groups, areaSet };
}

async function buildNotifyPrefRows(adapter, userKey, buttonsPerRow) {
    const { groups } = await collectVisibleAreaTypes(adapter, userKey);

    const buttons = [];
    for (const [displayText, pairs] of groups) {
        // "an" nur, wenn ALLE zusammengefassten Einträge an sind - ein Tippen
        // schaltet dann alle gemeinsam auf denselben neuen Wert (siehe settings.js TOGGLEGROUP).
        let allEnabled = true;
        for (const { area, type } of pairs) {
            const enabledState = await adapter.getStateAsync(`users.${userKey}.notify.${area}.${type}`);
            const enabled = enabledState ? enabledState.val === true || enabledState.val === 'true' : true;
            if (!enabled) {
                allEnabled = false;
            }
        }
        if (pairs.length === 1) {
            buttons.push({
                text: `${allEnabled ? '🔔' : '🔕'} ${displayText}`,
                cmd: `TG:SETTINGS:NOTIFY:TOGGLE:${pairs[0].area}:${pairs[0].type}`,
            });
        } else {
            const cmdPairs = pairs.map(p => `${p.area}|${p.type}`).join(',');
            buttons.push({
                text: `${allEnabled ? '🔔' : '🔕'} ${displayText}`,
                cmd: `TG:SETTINGS:NOTIFY:TOGGLEGROUP:${cmdPairs}`,
            });
        }
    }

    const rows = chunkButtons(buttons, buttonsPerRow);
    if (!rows.length) {
        rows.push([{ text: 'Keine Benachrichtigungsbereiche verfügbar', cmd: 'TG:NAV:BACK' }]);
    }
    rows.push([{ text: '⏸ Pausieren', cmd: 'TG:NAV:SETTINGS:NOTIFY:PAUSE', nextMenu: 'settings_notify_pause' }]);
    rows.push(BACK_MAIN_ROW);
    return rows;
}

// Eigenes Untermenü nur für die Pause-Schalter (ein Knopf pro BEREICH, nicht
// pro Typ) - damit die Haupt-Benachrichtigungsliste nicht mit Pause-Buttons
// zugestellt wird.
async function buildNotifyPauseRows(adapter, userKey, buttonsPerRow) {
    const { areaSet } = await collectVisibleAreaTypes(adapter, userKey);

    const buttons = [];
    for (const area of areaSet) {
        const paused = adapter.notify.isAreaPaused(area);
        const areaLabel = (adapter.notify.getAreaLabel && adapter.notify.getAreaLabel(area)) || permLabel(area);
        buttons.push({
            text: paused ? `▶️ ${areaLabel}: Pause aufheben` : `⏸ ${areaLabel}: 24h pausieren`,
            cmd: paused ? `TG:SETTINGS:NOTIFY:UNPAUSE:${area}` : `TG:SETTINGS:NOTIFY:PAUSE:${area}`,
        });
    }

    const rows = chunkButtons(buttons, buttonsPerRow);
    if (!rows.length) {
        rows.push([{ text: 'Keine Bereiche verfügbar', cmd: 'TG:NAV:BACK' }]);
    }
    rows.push(BACK_MAIN_ROW);
    return rows;
}

module.exports = { buildAutoRows };
