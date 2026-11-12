'use strict';

const { getMenu, setMenu, listMenuKeys } = require('./registry');
const { isAdmin } = require('./users');
const { permLabel } = require('./permLabels');
const { ensureDynamicState } = require('./states');
const { t } = require('./botI18n');
const { toPermId } = require('./idUtil');

// Collects all perm names actually used in the editor (menus + buttons)
// so no list has to be maintained twice.
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
    // Notification areas also count as permissions (e.g. "washdata" of
    // external adapters), otherwise they never show up here and can only be
    // enabled via the object editor.
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
                text: t('bot.roleLine', { icon: role === 'admin' ? '👑' : '👤', role }),
                cmd: `TG:ADMIN:USER:${targetUserKey}:ROLE:TOGGLE`,
            },
        ],
    ];

    for (const perm of perms) {
        const permState = await adapter.getStateAsync(`users.${targetUserKey}.permissions.${toPermId(perm)}`);
        const on = permState?.val === true || permState?.val === 'true';
        // Reuse the display name from the notifications if the permission name
        // happens to match an area name (e.g. "laundrylens" -> "Laundry") - so the
        // display name does not have to be maintained twice. Otherwise the normal
        // permLabel() translation/fallback.
        const label = adapter.notify.getAreaLabel(perm) || permLabel(perm);
        rows.push([{ text: `${on ? '✅' : '❌'} ${label}`, cmd: `TG:ADMIN:USER:${targetUserKey}:TOGGLE:${perm}` }]);
    }

    rows.push([
        { text: t('bot.back'), cmd: 'TG:NAV:BACK' },
        { text: t('bot.mainMenu'), cmd: 'TG:NAV:MAIN' },
    ]);

    return { title: t('bot.userTitle', { user: targetUserKey }), parent: 'admin_main', perm: 'admin', rows };
}

// Handles every TG:ADMIN:USER:* command. Returns true if it was
// processed (the router must then not pass it on to the script bridge).
async function handleAdminCommand(adapter, cmd, requestUser, requestUserKey, renderMenuFn, sendTextFn) {
    if (!cmd || !cmd.startsWith('TG:ADMIN:USER:')) {
        return false;
    }

    if (!(await isAdmin(adapter, requestUserKey))) {
        adapter.log.debug(`handleAdminCommand: ${requestUserKey} is not an admin (checked role state)`);
        await sendTextFn(requestUser, t('bot.adminsOnly'));
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
        const permId = `users.${targetUserKey}.permissions.${toPermId(perm)}`;
        const permState = await adapter.getStateAsync(permId);
        const currentlyOn = permState?.val === true || permState?.val === 'true';
        await ensureDynamicState(adapter, permId, false, 'indicator');
        await adapter.setStateAsync(permId, { val: !currentlyOn, ack: true });
    }
    // parts.length === 1 -> only open the detail view, toggle nothing

    const menuDef = await buildUserDetailMenu(adapter, targetUserKey);
    await setMenu(adapter, 'admin_user_detail', menuDef);
    await renderMenuFn(requestUser, 'admin_user_detail');
    return true;
}

module.exports = { handleAdminCommand, collectKnownPerms };
