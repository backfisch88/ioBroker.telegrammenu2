'use strict';

const { ensureDynamicState } = require('./states');

function userToKey(user) {
  return String(user || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

// Legt einen neuen Nutzer an, falls er noch nicht existiert.
// Überschreibt nie bestehende Rechte – identisches Verhalten zu tmEnsureUser().
// Neue Nutzer starten mit approved=false (siehe isApproved/approveUser/denyUser) -
// erst nach Admin-Freischaltung sieht er das echte Hauptmenü.
// Gibt { key, isNew } zurück, damit der Aufrufer weiß, ob GERADE JETZT neu
// registriert wurde (für die einmalige Admin-Benachrichtigung).
async function ensureUser(adapter, user) {
  const key = userToKey(user);
  if (!key) return { key: null, isNew: false };

  const roleId = `users.${key}.role`;
  const exists = await adapter.getObjectAsync(roleId);
  if (!exists) {
    await ensureDynamicState(adapter, roleId, 'guest', 'text');
    await ensureDynamicState(adapter, `users.${key}.chatId`, String(user), 'text');
    await ensureDynamicState(adapter, `users.${key}.approved`, false, 'indicator');
    await addUserToIndex(adapter, key);
    adapter.log.info(`Neuer Telegram-Nutzer registriert: ${key} (wartet auf Freischaltung)`);
    return { key, isNew: true };
  }
  return { key, isNew: false };
}

// Freigegeben ist ein Nutzer, wenn entweder explizit freigeschaltet (approved=true)
// ODER er bereits Admin ist - so bleiben bestehende Admin-Konten (von vor dieser
// Funktion) sowie der allererste, manuell in den States gesetzte Admin nutzbar,
// ohne sich selbst erst freischalten zu müssen.
async function isApproved(adapter, userKey) {
  if (await isAdmin(adapter, userKey)) return true;
  const state = await adapter.getStateAsync(`users.${userKey}.approved`);
  return state?.val === true || state?.val === 'true';
}

async function approveUser(adapter, userKey) {
  await ensureDynamicState(adapter, `users.${userKey}.approved`, false, 'indicator');
  await adapter.setStateAsync(`users.${userKey}.approved`, { val: true, ack: true });
  return true;
}

// Lehnt einen wartenden Nutzer ab - löscht ihn komplett (Rolle, chatId,
// Freischalt-Status, Index-Eintrag), damit er bei der nächsten Nachricht
// wieder als brandneuer Nutzer behandelt wird (identisch zu deleteArea()).
async function denyUser(adapter, userKey) {
  for (const suffix of ['role', 'chatId', 'approved']) {
    const id = `users.${userKey}.${suffix}`;
    if (await adapter.getObjectAsync(id)) await adapter.delObjectAsync(id);
  }
  const idxId = 'runtime.usersJson';
  const state = await adapter.getStateAsync(idxId);
  let arr = [];
  try { arr = JSON.parse(state?.val || '[]'); } catch (e) { arr = []; }
  arr = arr.filter((k) => k !== userKey);
  await adapter.setStateAsync(idxId, { val: JSON.stringify(arr), ack: true });
  return true;
}

// Schickt allen Admins eine Nachricht mit Inline-Buttons "Erlauben"/"Ablehnen"
// für einen neu registrierten, wartenden Nutzer - analog zu
// notifyAdminsAboutPendingArea() in notify.js.
async function notifyAdminsAboutPendingUser(adapter, userKey, chatId) {
  try {
    const chatIds = await listAdminChatIds(adapter);
    if (!chatIds.length) return;
    const text = `👤 Neuer Telegram-Nutzer "${userKey}" wartet auf Freischaltung.\n\nErlauben?`;
    const keyboard = {
      inline_keyboard: [[
        { text: '✅ Erlauben', callback_data: `TG:ADMIN:APPROVEUSER:${userKey}` },
        { text: '❌ Ablehnen', callback_data: `TG:ADMIN:DENYUSER:${userKey}` },
      ]],
    };
    for (const adminChatId of chatIds) {
      await adapter.sendToAsync(adapter.telegramInstance, { text, user: adminChatId, reply_markup: keyboard });
    }
  } catch (e) {
    adapter.log.warn(`users: Admin-Benachrichtigung für neuen Nutzer "${userKey}" fehlgeschlagen: ${e.message}`);
  }
}

async function addUserToIndex(adapter, key) {
  const id = 'runtime.usersJson';
  await ensureDynamicState(adapter, id, '[]', 'json');
  const state = await adapter.getStateAsync(id);
  let arr = [];
  try { arr = JSON.parse(state?.val || '[]'); } catch (e) { arr = []; }
  if (!arr.includes(key)) {
    arr.push(key);
    await adapter.setStateAsync(id, { val: JSON.stringify(arr), ack: true });
  }
}

async function listUsers(adapter) {
  const state = await adapter.getStateAsync('runtime.usersJson');
  try { return JSON.parse(state?.val || '[]'); } catch (e) { return []; }
}

async function isAdmin(adapter, userKey) {
  const state = await adapter.getStateAsync(`users.${userKey}.role`);
  return String(state?.val || 'guest') === 'admin';
}

async function hasPermission(adapter, perm, userKey) {
  if (!perm) return true;
  if (perm === 'admin') return isAdmin(adapter, userKey);
  const state = await adapter.getStateAsync(`users.${userKey}.permissions.${perm}`);
  const v = state?.val;
  return v === true || v === 'true' || v === 1 || v === '1';
}

// Chat-IDs aller Admins - für proaktive Nachrichten, die JEDEN Admin
// erreichen sollen (z. B. "neuer Bereich wartet auf Freischaltung").
async function listAdminChatIds(adapter) {
  const keys = await listUsers(adapter);
  const chatIds = [];
  for (const key of keys) {
    if (await isAdmin(adapter, key)) {
      const chatState = await adapter.getStateAsync(`users.${key}.chatId`);
      if (chatState?.val) chatIds.push(chatState.val);
    }
  }
  return chatIds;
}

module.exports = { userToKey, ensureUser, listUsers, isAdmin, hasPermission, listAdminChatIds, isApproved, approveUser, denyUser, notifyAdminsAboutPendingUser };
