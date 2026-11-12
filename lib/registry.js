'use strict';

const { ensureDynamicState } = require('./states');
const { toMenuId } = require('./idUtil');

// A registry entry corresponds 1:1 to what the node editor produces per menu:
// { title, rows, perm?, icon?, source? }.

// Object ids must be ASCII-only and unique case-insensitively, see idUtil.js.
function sanitizeMenuKey(menuKey) {
    return toMenuId(menuKey);
}

function registryStateId(menuKey) {
    return `registry.${toMenuId(menuKey)}`;
}

async function getMenu(adapter, menuKey) {
    try {
        const state = await adapter.getStateAsync(registryStateId(menuKey));
        if (!state || !state.val) {
            return null;
        }
        const obj = typeof state.val === 'string' ? JSON.parse(state.val) : state.val;
        return obj || null;
    } catch (e) {
        adapter.log.warn(`registry.getMenu(${menuKey}): ${e.message}`);
        return null;
    }
}

async function setMenu(adapter, menuKey, def) {
    const id = registryStateId(menuKey);
    await ensureDynamicState(adapter, id, '{}', 'json');
    await adapter.setStateAsync(id, { val: JSON.stringify(def), ack: true });
}

// Takes the complete JSON delivered by the node editor via "Export"
// ({ menuKey: { title, rows, ... }, menuKey2: {...} }) and writes each
// entry as its own registry.<menuKey> state, so the editor export reaches
// the adapter 1:1 without manual work.
async function listMenuKeys(adapter) {
    const state = await adapter.getStateAsync('registry._index');
    try {
        return JSON.parse(state?.val || '[]');
    } catch {
        return [];
    }
}

async function importRegistry(adapter, exportedJson) {
    const menus = typeof exportedJson === 'string' ? JSON.parse(exportedJson) : exportedJson;
    const keys = Object.keys(menus);
    for (const menuKey of keys) {
        await setMenu(adapter, menuKey, menus[menuKey]);
    }

    const existingKeys = await listMenuKeys(adapter);
    const merged = [...new Set([...existingKeys, ...keys])];
    await ensureDynamicState(adapter, 'registry._index', '[]', 'json');
    await adapter.setStateAsync('registry._index', { val: JSON.stringify(merged), ack: true });

    adapter.log.info(`Registry imported: ${keys.length} menu(s) - ${keys.join(', ')}`);
    return keys;
}

async function deleteMenus(adapter, keys) {
    const removed = [];
    for (const key of keys) {
        const id = registryStateId(key);
        const exists = await adapter.getObjectAsync(id);
        if (!exists) {
            continue;
        }
        await adapter.delObjectAsync(id).catch(() => {});
        removed.push(key);
    }
    if (removed.length) {
        const existingKeys = await listMenuKeys(adapter);
        const remaining = existingKeys.filter(k => !removed.includes(k));
        await adapter.setStateAsync('registry._index', { val: JSON.stringify(remaining), ack: true });
    }
    return removed;
}

async function resetRegistry(adapter) {
    const keys = await listMenuKeys(adapter);
    for (const key of keys) {
        const id = registryStateId(key);
        await adapter.delObjectAsync(id).catch(() => {});
    }
    await adapter.setStateAsync('registry._index', { val: '[]', ack: true });
    return keys;
}

module.exports = {
    getMenu,
    setMenu,
    importRegistry,
    registryStateId,
    listMenuKeys,
    resetRegistry,
    deleteMenus,
    sanitizeMenuKey,
};
