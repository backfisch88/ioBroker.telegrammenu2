'use strict';

const { ensureDynamicState } = require('./states');
const { t } = require('./botI18n');
const { toPermId } = require('./idUtil');

function userToKey(user) {
    return String(user || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Creates a new user if it does not exist yet.
// Never overwrites existing permissions - same behavior as tmEnsureUser().
// New users start with approved=false (see isApproved/approveUser/denyUser) -
// they only see the real main menu after admin approval.
// Returns { key, isNew } so the caller knows whether the user was registered
// JUST NOW (for the one-time admin notification).
async function ensureUser(adapter, user) {
    const key = userToKey(user);
    if (!key) {
        return { key: null, isNew: false };
    }

    const roleId = `users.${key}.role`;
    const exists = await adapter.getObjectAsync(roleId);
    if (!exists) {
        await ensureDynamicState(adapter, roleId, 'guest', 'text');
        await ensureDynamicState(adapter, `users.${key}.chatId`, String(user), 'text');
        await ensureDynamicState(adapter, `users.${key}.approved`, false, 'indicator');
        await addUserToIndex(adapter, key);
        adapter.log.info(`New Telegram user registered: ${key} (awaiting approval)`);
        return { key, isNew: true };
    }
    return { key, isNew: false };
}

// A user is approved if explicitly approved (approved=true) OR already an
// admin - so existing admin accounts (from before this function) and the very
// first admin set manually in the states stay usable without having to
// approve themselves first.
async function isApproved(adapter, userKey) {
    if (await isAdmin(adapter, userKey)) {
        return true;
    }
    const state = await adapter.getStateAsync(`users.${userKey}.approved`);
    return state?.val === true || state?.val === 'true';
}

async function approveUser(adapter, userKey) {
    await ensureDynamicState(adapter, `users.${userKey}.approved`, false, 'indicator');
    await adapter.setStateAsync(`users.${userKey}.approved`, { val: true, ack: true });
    return true;
}

// Rejects a waiting user - deletes it completely (role, chatId, approval
// status, index entry) so it is treated as a brand-new user on its next
// message (identical to deleteArea()).
async function denyUser(adapter, userKey) {
    for (const suffix of ['role', 'chatId', 'approved']) {
        const id = `users.${userKey}.${suffix}`;
        if (await adapter.getObjectAsync(id)) {
            await adapter.delObjectAsync(id);
        }
    }
    const idxId = 'runtime.usersJson';
    const state = await adapter.getStateAsync(idxId);
    let arr = [];
    try {
        arr = JSON.parse(state?.val || '[]');
    } catch {
        arr = [];
    }
    arr = arr.filter(k => k !== userKey);
    await adapter.setStateAsync(idxId, { val: JSON.stringify(arr), ack: true });
    return true;
}

// Sends all admins a message with inline buttons "Allow"/"Reject" for a
// newly registered, waiting user - analogous to
// notifyAdminsAboutPendingArea() in notify.js.
async function notifyAdminsAboutPendingUser(adapter, userKey, _chatId) {
    try {
        const chatIds = await listAdminChatIds(adapter);
        if (!chatIds.length) {
            return;
        }
        const text = t('bot.newUserRequest', { userKey });
        const keyboard = {
            inline_keyboard: [
                [
                    { text: t('bot.allow'), callback_data: `TG:ADMIN:APPROVEUSER:${userKey}` },
                    { text: t('bot.reject'), callback_data: `TG:ADMIN:DENYUSER:${userKey}` },
                ],
            ],
        };
        for (const adminChatId of chatIds) {
            await adapter.sendToAsync(adapter.telegramInstance, { text, user: adminChatId, reply_markup: keyboard });
        }
    } catch (e) {
        adapter.log.warn(`users: admin notification for new user "${userKey}" failed: ${e.message}`);
    }
}

async function addUserToIndex(adapter, key) {
    const id = 'runtime.usersJson';
    await ensureDynamicState(adapter, id, '[]', 'json');
    const state = await adapter.getStateAsync(id);
    let arr = [];
    try {
        arr = JSON.parse(state?.val || '[]');
    } catch {
        arr = [];
    }
    if (!arr.includes(key)) {
        arr.push(key);
        await adapter.setStateAsync(id, { val: JSON.stringify(arr), ack: true });
    }
}

async function listUsers(adapter) {
    const state = await adapter.getStateAsync('runtime.usersJson');
    try {
        return JSON.parse(state?.val || '[]');
    } catch {
        return [];
    }
}

async function isAdmin(adapter, userKey) {
    const state = await adapter.getStateAsync(`users.${userKey}.role`);
    return String(state?.val || 'guest') === 'admin';
}

async function hasPermission(adapter, perm, userKey) {
    if (!perm) {
        return true;
    }
    if (perm === 'admin') {
        return isAdmin(adapter, userKey);
    }
    const state = await adapter.getStateAsync(`users.${userKey}.permissions.${toPermId(perm)}`);
    const v = state?.val;
    return v === true || v === 'true' || v === 1 || v === '1';
}

// Chat IDs of all admins - for proactive messages that must reach EVERY
// admin (e.g. "new area waiting for approval").
async function listAdminChatIds(adapter) {
    const keys = await listUsers(adapter);
    const chatIds = [];
    for (const key of keys) {
        if (await isAdmin(adapter, key)) {
            const chatState = await adapter.getStateAsync(`users.${key}.chatId`);
            if (chatState?.val) {
                chatIds.push(chatState.val);
            }
        }
    }
    return chatIds;
}

module.exports = {
    userToKey,
    ensureUser,
    listUsers,
    isAdmin,
    hasPermission,
    listAdminChatIds,
    isApproved,
    approveUser,
    denyUser,
    notifyAdminsAboutPendingUser,
};
