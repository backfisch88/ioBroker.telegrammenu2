'use strict';

const { ensureDynamicState } = require('./states');
const { toPermId } = require('./idUtil');

// Toggles the clicking user's own notification preference.
// No admin check needed - everyone may switch their own notifications on/off
// (access to the settings menu itself is already protected by perm: 'settings'
// on menu level).
async function handleNotifyToggle(adapter, cmd, requestUser, requestUserKey, renderMenuFn) {
    // Pause an area for 24h / resume - applies to ALL users (not only the
    // clicker), because a pause is a statement about the AREA itself
    // ("construction work at the window right now"), not a personal preference.
    if (cmd && cmd.startsWith('TG:SETTINGS:NOTIFY:PAUSE:')) {
        const area = cmd.slice('TG:SETTINGS:NOTIFY:PAUSE:'.length);
        await adapter.notify.pauseArea(area, 24);
        await renderMenuFn(requestUser, 'settings_notify_pause');
        return true;
    }
    if (cmd && cmd.startsWith('TG:SETTINGS:NOTIFY:UNPAUSE:')) {
        const area = cmd.slice('TG:SETTINGS:NOTIFY:UNPAUSE:'.length);
        await adapter.notify.unpauseArea(area);
        await renderMenuFn(requestUser, 'settings_notify_pause');
        return true;
    }

    // Grouped row (several area/type pairs with an identical display name) -
    // switch all of them to the same new value.
    if (cmd && cmd.startsWith('TG:SETTINGS:NOTIFY:TOGGLEGROUP:')) {
        const rest = cmd.slice('TG:SETTINGS:NOTIFY:TOGGLEGROUP:'.length);
        const pairs = rest.split(',').map(p => {
            const [area, type] = p.split('|');
            return { area, type };
        });

        // "on" if ALL entries are currently on - then switch off together, otherwise switch on together.
        let allEnabled = true;
        for (const { area, type } of pairs) {
            const state = await adapter.getStateAsync(
                `users.${requestUserKey}.notify.${toPermId(area)}.${toPermId(type)}`,
            );
            const enabled = state ? state.val === true || state.val === 'true' : true;
            if (!enabled) {
                allEnabled = false;
            }
        }
        const newVal = !allEnabled;
        for (const { area, type } of pairs) {
            const id = `users.${requestUserKey}.notify.${toPermId(area)}.${toPermId(type)}`;
            await ensureDynamicState(adapter, id, true, 'indicator');
            await adapter.setStateAsync(id, { val: newVal, ack: true });
        }
        await renderMenuFn(requestUser, 'settings_notify');
        return true;
    }

    if (!cmd || !cmd.startsWith('TG:SETTINGS:NOTIFY:TOGGLE:')) {
        return false;
    }

    const rest = cmd.slice('TG:SETTINGS:NOTIFY:TOGGLE:'.length);
    const parts = rest.split(':');
    const type = parts.pop();
    const area = parts.join(':');

    const id = `users.${requestUserKey}.notify.${toPermId(area)}.${toPermId(type)}`;
    const state = await adapter.getStateAsync(id);
    const currentlyOn = state ? state.val === true || state.val === 'true' : true; // Default: an, wie in autoMenus.js
    await ensureDynamicState(adapter, id, true, 'indicator');
    await adapter.setStateAsync(id, { val: !currentlyOn, ack: true });

    // settings_notify is an auto menu (source: notifyPrefs) - rows are rebuilt
    // freshly from the current state on every renderMenu() call, no setMenu()
    // needed as with the static admin_user_detail.
    await renderMenuFn(requestUser, 'settings_notify');
    return true;
}

module.exports = { handleNotifyToggle };
