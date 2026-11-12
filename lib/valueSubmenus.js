'use strict';

const { getMenu } = require('./registry');
const { hasPermission } = require('./users');
const { resolveTemplate } = require('./template');
const { t } = require('./botI18n');

// Handles button presses from the predefined value submenus
// (source: 'percentRange' / 'numberRange' in autoMenus.js) that are sent as an
// inline keyboard (see sendInlineMenu in base.js).
//
// The button cmd has the format "TG:VALSET:<menuKey>|<value>" or
// "TG:VALCUSTOM:<menuKey>" - deliberately the MENU KEY instead of the full
// datapoint path, because Telegram limits callback_data to 64 bytes and long
// datapoint IDs would exceed it. The datapoint (and min/max) is looked up here
// on the server by menu key.

async function buildConfirmText(adapter, menuDef, value) {
    const unit = menuDef.unit || (menuDef.source === 'percentRange' ? '%' : '');
    if (menuDef.confirmMessage) {
        const withPlaceholders = menuDef.confirmMessage.replace(/\{value\}/g, String(value)).replace(/\{unit\}/g, unit);
        return resolveTemplate(adapter, withPlaceholders);
    }
    return t('bot.valueSetConfirm', { value, unit });
}

async function handleValueSetCommand(adapter, cmd, user, userKey, renderMenu) {
    if (!cmd || !cmd.startsWith('TG:VALSET:')) {
        return false;
    }

    const rest = cmd.slice('TG:VALSET:'.length);
    const sepIdx = rest.lastIndexOf('|');
    if (sepIdx === -1) {
        adapter.log.warn(`TG:VALSET: invalid format (no "|" found): ${cmd}`);
        return true;
    }

    const menuKey = rest.slice(0, sepIdx);
    const rawValue = rest.slice(sepIdx + 1);
    const value = Number(rawValue);

    const menuDef = await getMenu(adapter, menuKey);
    const datapoint = menuDef && menuDef.datapoint;

    if (!datapoint || isNaN(value)) {
        adapter.log.warn(`TG:VALSET: invalid menu/value: "${cmd}"`);
        return true;
    }

    // Direct dispatch (see handleIncoming) bypasses findButtonByText(), which would
    // otherwise have checked the menu permission automatically - so it is done
    // explicitly here, otherwise a user could reach a foreign, protected menu with
    // a crafted cmd.
    if (menuDef.perm && !(await hasPermission(adapter, menuDef.perm, userKey))) {
        return true;
    }

    try {
        await adapter.setForeignStateAsync(datapoint, { val: value, ack: false });
    } catch (e) {
        adapter.log.warn(`TG:VALSET: writing to ${datapoint} failed: ${e.message}`);
    }

    // Instead of showing the inline menu again, go straight back to the parent
    // menu with a confirmation ("✅ 60% set." or custom text from menuDef.message,
    // placeholders {value}/{unit} available) - shorter path for the user.
    const confirmText = await buildConfirmText(adapter, menuDef, value);
    await renderMenu(user, menuDef.parent || 'main', confirmText);

    return true;
}

async function handleValueCustomCommand(adapter, cmd, user, userKey, startNumpadInput) {
    if (!cmd || !cmd.startsWith('TG:VALCUSTOM:')) {
        return false;
    }

    const menuKey = cmd.slice('TG:VALCUSTOM:'.length);
    const menuDef = await getMenu(adapter, menuKey);

    if (!menuDef || !menuDef.datapoint) {
        adapter.log.warn(`TG:VALCUSTOM: menu/datapoint not found: "${cmd}"`);
        return true;
    }

    if (menuDef.perm && !(await hasPermission(adapter, menuDef.perm, userKey))) {
        return true;
    }

    // menuKey here is deliberately the PARENT MENU (not the value menu itself) -
    // after "✅ Done" the keypad lands there directly, with the same {value}/{unit}
    // confirmation as with a direct preset tap ("{value}" cannot be resolved yet -
    // the value is only known after the keypad input - so pass it on as a
    // placeholder, see handleNumpadInput in base.js).
    const unit = menuDef.unit || (menuDef.source === 'percentRange' ? '%' : '');
    const message = menuDef.confirmMessage
        ? menuDef.confirmMessage.replace(/\{unit\}/g, unit)
        : t('bot.valueSetConfirm', { unit });

    await startNumpadInput(user, {
        datapoint: menuDef.datapoint,
        min: menuDef.min,
        max: menuDef.max,
        menuKey: menuDef.parent || 'main',
        prompt: t('bot.enterValuePrompt', { unitSuffix: unit ? ` (${unit})` : '' }),
        message,
    });

    return true;
}

module.exports = { handleValueSetCommand, handleValueCustomCommand };
