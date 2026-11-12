'use strict';

const { listUsers, isAdmin } = require('./users');
const { permLabel } = require('./permLabels');
const { getMenu } = require('./registry');
const { t } = require('./botI18n');
const { toPermId } = require('./idUtil');

// Combines a flat button list into rows (width configurable via the global
// "buttons per row" setting on the main menu node, default 2 - as before).
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

const backMainRow = () => [
    { text: t('bot.back'), cmd: 'TG:NAV:BACK' },
    { text: t('bot.mainMenu'), cmd: 'TG:NAV:MAIN' },
];

// Builds the buttons of an auto menu at runtime from the editor
// ({ source: 'users' | 'notifyPrefs' | 'notifyPause' }). Replaces the "rows"
// otherwise hard-wired via edges in the registry.

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
            return [[{ text: t('bot.unknownAutoSource'), cmd: 'TG:NAV:BACK' }]];
    }
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

// Predefined value submenus (similar to "menu:percent10:..." /
// "menu:number1-20-2-unit:..." of ioBroker.telegram-menu): creates a row of
// buttons over a value range as an INLINE keyboard (see renderMenu/sendInlineMenu
// in base.js). A tap writes the value directly to the configured datapoint (via
// TG:VALSET:<menuKey>|<value>, see lib/valueSubmenus.js). "menuKey" is used
// instead of the full datapoint path in callback_data, because Telegram limits
// it to 64 bytes - the handler looks up the datapoint by menu key on the server.
// The currently active value is read live from the datapoint and marked with ✅.
// An extra "✏️ Custom value" button covers values outside the fixed steps
// (e.g. 3.5 instead of only 3/4) - it uses the same numeric keypad as the
// normal number input.
//
// menuDef fields: datapoint (required), min, max, step, unit, rowLength
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
        return [[{ text: t('bot.noDatapointConfigured'), cmd: 'TG:NAV:BACK' }]];
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

    // min > max is allowed (descending order, like "20-1" in ioBroker.telegram-menu)
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
        rows.push([{ text: t('bot.noValueRange'), cmd: 'TG:NAV:BACK' }]);
    }
    rows.push([{ text: t('bot.customValue'), cmd: `TG:VALCUSTOM:${menuKey}` }]);
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
        rows.push([{ text: t('bot.noUsers'), cmd: 'TG:NAV:BACK' }]);
    }
    rows.push(backMainRow());
    return rows;
}

// Collects all (area,type) pairs with their display name, filtered to what the
// user may see. Shared by the two submenus (toggle, pause) so both have the
// same view of the areas.
async function collectVisibleAreaTypes(adapter, userKey) {
    const areas = adapter.notify.getValidAreas();

    const groups = new Map(); // "Anzeigename" -> [{area, type}]
    const areaSet = new Set();

    for (const [area, types] of Object.entries(areas)) {
        const permState = await adapter.getStateAsync(`users.${userKey}.permissions.${toPermId(area)}`);
        const allowed = permState?.val === true || permState?.val === 'true';
        if (!allowed) {
            continue;
        }
        areaSet.add(area);

        const typeList = types.length ? types : ['general'];
        for (const type of typeList) {
            // Override types (cannot be switched off) do not show up in the menu at
            // all - no misleading toggle that does nothing.
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
        // "on" only if ALL grouped entries are on - one tap then switches all of them
        // to the same new value (see settings.js TOGGLEGROUP).
        let allEnabled = true;
        for (const { area, type } of pairs) {
            const enabledState = await adapter.getStateAsync(
                `users.${userKey}.notify.${toPermId(area)}.${toPermId(type)}`,
            );
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
        rows.push([{ text: t('bot.noNotifyAreas'), cmd: 'TG:NAV:BACK' }]);
    }
    rows.push([{ text: t('bot.pause'), cmd: 'TG:NAV:SETTINGS:NOTIFY:PAUSE', nextMenu: 'settings_notify_pause' }]);
    rows.push(backMainRow());
    return rows;
}

// Separate submenu only for the pause toggles (one button per AREA, not per
// type) - so the main notification list is not cluttered with pause buttons.
async function buildNotifyPauseRows(adapter, userKey, buttonsPerRow) {
    const { areaSet } = await collectVisibleAreaTypes(adapter, userKey);

    const buttons = [];
    for (const area of areaSet) {
        const paused = adapter.notify.isAreaPaused(area);
        const areaLabel = (adapter.notify.getAreaLabel && adapter.notify.getAreaLabel(area)) || permLabel(area);
        buttons.push({
            text: paused ? t('bot.resumeArea', { area: areaLabel }) : t('bot.pauseArea', { area: areaLabel }),
            cmd: paused ? `TG:SETTINGS:NOTIFY:UNPAUSE:${area}` : `TG:SETTINGS:NOTIFY:PAUSE:${area}`,
        });
    }

    const rows = chunkButtons(buttons, buttonsPerRow);
    if (!rows.length) {
        rows.push([{ text: t('bot.noAreas'), cmd: 'TG:NAV:BACK' }]);
    }
    rows.push(backMainRow());
    return rows;
}

module.exports = { buildAutoRows };
