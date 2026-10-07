'use strict';

const { ensureDynamicState } = require('./states');

// Toggelt die eigene Benachrichtigungs-Präferenz des klickenden Nutzers.
// Kein Admin-Check nötig – jeder darf seine eigenen Benachrichtigungen
// ein/ausschalten (der Zugriff aufs Einstellungen-Menü selbst ist schon
// über perm: 'settings' auf Menü-Ebene geschützt).
async function handleNotifyToggle(adapter, cmd, requestUser, requestUserKey, renderMenuFn) {
    // Bereich für 24h pausieren/Pause aufheben - gilt für ALLE Nutzer (nicht
    // nur den Klickenden), da eine Pause eine Aussage über den BEREICH selbst
    // ist ("gerade Bauarbeiten am Fenster"), nicht über persönliche Präferenzen.
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

    // Zusammengefasste Zeile (mehrere area/type-Paare mit identischem
    // Anzeigenamen) - alle gemeinsam auf denselben neuen Wert schalten.
    if (cmd && cmd.startsWith('TG:SETTINGS:NOTIFY:TOGGLEGROUP:')) {
        const rest = cmd.slice('TG:SETTINGS:NOTIFY:TOGGLEGROUP:'.length);
        const pairs = rest.split(',').map(p => {
            const [area, type] = p.split('|');
            return { area, type };
        });

        // "an", wenn aktuell ALLE Einträge an sind - dann gemeinsam ausschalten, sonst gemeinsam einschalten.
        let allEnabled = true;
        for (const { area, type } of pairs) {
            const state = await adapter.getStateAsync(`users.${requestUserKey}.notify.${area}.${type}`);
            const enabled = state ? state.val === true || state.val === 'true' : true;
            if (!enabled) {
                allEnabled = false;
            }
        }
        const newVal = !allEnabled;
        for (const { area, type } of pairs) {
            const id = `users.${requestUserKey}.notify.${area}.${type}`;
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

    const id = `users.${requestUserKey}.notify.${area}.${type}`;
    const state = await adapter.getStateAsync(id);
    const currentlyOn = state ? state.val === true || state.val === 'true' : true; // Default: an, wie in autoMenus.js
    await ensureDynamicState(adapter, id, true, 'indicator');
    await adapter.setStateAsync(id, { val: !currentlyOn, ack: true });

    // settings_notify ist ein Auto-Menü (source: notifyPrefs) – rows werden bei
    // jedem renderMenu()-Aufruf frisch aus dem aktuellen Stand gebaut, kein
    // setMenu() nötig wie beim statischen admin_user_detail.
    await renderMenuFn(requestUser, 'settings_notify');
    return true;
}

module.exports = { handleNotifyToggle };
