'use strict';

const { getMenu, setMenu, listMenuKeys } = require('./registry');
const { isAdmin } = require('./users');
const { permLabel } = require('./permLabels');
const { ensureDynamicState } = require('./states');

// Sammelt alle im Editor tatsächlich verwendeten perm-Namen (Menüs + Buttons),
// damit hier keine Liste doppelt gepflegt werden muss.
async function collectKnownPerms(adapter) {
    const keys = await listMenuKeys(adapter);
    const perms = new Set();
    for (const key of keys) {
        const def = await getMenu(adapter, key);
        if (!def) {
            continue;
        }
        if (def.perm && def.perm !== 'admin') {
            perms.add(def.perm);
        }
        for (const row of def.rows || []) {
            for (const btn of row) {
                if (btn.perm && btn.perm !== 'admin') {
                    perms.add(btn.perm);
                }
            }
        }
    }
    // Auch Benachrichtigungs-Bereiche zählen als Rechte (z. B. "washdata" von
    // externen Adaptern), sonst tauchen sie hier nie auf und lassen sich nur
    // per Objekte-Editor freischalten.
    for (const area of Object.keys(adapter.notify.getValidAreas())) {
        perms.add(area);
    }
    return [...perms].sort();
}

async function buildUserDetailMenu(adapter, targetUserKey) {
    const roleState = await adapter.getStateAsync(`users.${targetUserKey}.role`);
    const role = roleState?.val || 'guest';
    const perms = await collectKnownPerms(adapter);

    const rows = [
        [
            {
                text: `${role === 'admin' ? '👑' : '👤'} Rolle: ${role} (antippen zum Wechseln)`,
                cmd: `TG:ADMIN:USER:${targetUserKey}:ROLE:TOGGLE`,
            },
        ],
    ];

    for (const perm of perms) {
        const permState = await adapter.getStateAsync(`users.${targetUserKey}.permissions.${perm}`);
        const on = permState?.val === true || permState?.val === 'true';
        // Anzeigename aus den Benachrichtigungen mitbenutzen, falls der
        // Berechtigungsname zufällig mit einem Bereichsnamen übereinstimmt (z. B.
        // "laundrylens" -> "Wäsche") - so muss der Anzeigename nicht doppelt
        // gepflegt werden. Sonst normale permLabel()-Übersetzung/Fallback.
        const label = adapter.notify.getAreaLabel(perm) || permLabel(perm);
        rows.push([{ text: `${on ? '✅' : '❌'} ${label}`, cmd: `TG:ADMIN:USER:${targetUserKey}:TOGGLE:${perm}` }]);
    }

    rows.push([
        { text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' },
        { text: '🏠 Hauptmenü', cmd: 'TG:NAV:MAIN' },
    ]);

    return { title: `👤 Nutzer: ${targetUserKey}`, parent: 'admin_main', perm: 'admin', rows };
}

// Übernimmt jeden TG:ADMIN:USER:*-Command. Gibt true zurück, wenn er
// verarbeitet wurde (Router soll dann nicht an Module/Legacy-Bridge weiterreichen).
async function handleAdminCommand(adapter, cmd, requestUser, requestUserKey, renderMenuFn, sendTextFn) {
    if (!cmd || !cmd.startsWith('TG:ADMIN:USER:')) {
        return false;
    }

    if (!(await isAdmin(adapter, requestUserKey))) {
        adapter.log.debug(`handleAdminCommand: ${requestUserKey} ist kein Admin (role-State geprüft)`);
        await sendTextFn(requestUser, '⛔ Nur für Admins.');
        return true;
    }

    const rest = cmd.slice('TG:ADMIN:USER:'.length);
    const parts = rest.split(':');
    const targetUserKey = parts[0];

    if (parts[1] === 'ROLE' && parts[2] === 'TOGGLE') {
        const roleId = `users.${targetUserKey}.role`;
        const roleState = await adapter.getStateAsync(roleId);
        const nextRole = roleState?.val === 'admin' ? 'user' : 'admin';
        await ensureDynamicState(adapter, roleId, 'guest', 'text');
        await adapter.setStateAsync(roleId, { val: nextRole, ack: true });
    } else if (parts[1] === 'TOGGLE') {
        const perm = parts.slice(2).join(':');
        const permId = `users.${targetUserKey}.permissions.${perm}`;
        const permState = await adapter.getStateAsync(permId);
        const currentlyOn = permState?.val === true || permState?.val === 'true';
        await ensureDynamicState(adapter, permId, false, 'indicator');
        await adapter.setStateAsync(permId, { val: !currentlyOn, ack: true });
    }
    // parts.length === 1 -> nur Detailansicht öffnen, nichts togglen

    const menuDef = await buildUserDetailMenu(adapter, targetUserKey);
    await setMenu(adapter, 'admin_user_detail', menuDef);
    await renderMenuFn(requestUser, 'admin_user_detail');
    return true;
}

module.exports = { handleAdminCommand, collectKnownPerms };
