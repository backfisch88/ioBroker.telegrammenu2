'use strict';

const { listMenuKeys, registryStateId } = require('./registry');
const { ensureDynamicState } = require('./states');
const { toPermId, legacyMenuId } = require('./idUtil');

/**
 * One-time migration to ASCII-only, case-unique object ids.
 * Safe to run on every start: it does nothing once everything is migrated.
 *   1. registry.<menuKey> states move to the new id scheme
 *   2. runtime.lastRows.* (pure cache) with non-canonical ids are dropped
 *   3. users.<u>.permissions.* and users.<u>.notify.* states move to ASCII ids
 *
 * @param {object} adapter adapter instance
 */
async function migrateAsciiObjectIds(adapter) {
    const prefix = `${adapter.namespace}.`;
    let movedRegistry = 0;
    let movedUsers = 0;
    let droppedCache = 0;

    try {
        // 1. registry
        const keys = await listMenuKeys(adapter);
        const newIds = new Set(keys.map(registryStateId));
        for (const key of keys) {
            const legacyId = `registry.${legacyMenuId(key)}`;
            const nextId = registryStateId(key);
            if (legacyId === nextId || newIds.has(legacyId)) {
                continue;
            }
            const legacyObj = await adapter.getObjectAsync(legacyId);
            if (!legacyObj) {
                continue;
            }
            const legacyState = await adapter.getStateAsync(legacyId);
            const nextState = await adapter.getStateAsync(nextId);
            if (legacyState && !nextState) {
                await ensureDynamicState(adapter, nextId, '{}', 'json');
                await adapter.setStateAsync(nextId, { val: legacyState.val, ack: true });
            }
            await adapter.delObjectAsync(legacyId);
            movedRegistry++;
        }

        const allObjects = (await adapter.getAdapterObjectsAsync()) || {};

        // 2. lastRows cache
        const lastRowsPrefix = `${prefix}runtime.lastRows.`;
        for (const fullId of Object.keys(allObjects)) {
            if (!fullId.startsWith(lastRowsPrefix)) {
                continue;
            }
            const segment = fullId.slice(lastRowsPrefix.length);
            if (!/^[a-z0-9_-]+$/.test(segment)) {
                await adapter.delObjectAsync(fullId.slice(prefix.length));
                droppedCache++;
            }
        }

        // 3. users: permissions + notify preferences
        for (const fullId of Object.keys(allObjects)) {
            const obj = allObjects[fullId];
            if (!fullId.startsWith(`${prefix}users.`) || obj?.type !== 'state') {
                continue;
            }
            const id = fullId.slice(prefix.length);
            const seg = id.split('.');
            let nextId = null;
            if (seg[2] === 'permissions' && seg.length >= 4) {
                nextId = `users.${seg[1]}.permissions.${toPermId(seg.slice(3).join('_'))}`;
            } else if (seg[2] === 'notify' && seg.length >= 5) {
                nextId = `users.${seg[1]}.notify.${toPermId(seg[3])}.${toPermId(seg.slice(4).join('_'))}`;
            }
            if (!nextId || nextId === id) {
                continue;
            }
            const oldState = await adapter.getStateAsync(id);
            const existing = await adapter.getStateAsync(nextId);
            if (!existing) {
                await ensureDynamicState(adapter, nextId, oldState ? oldState.val : false, 'indicator');
                if (oldState) {
                    await adapter.setStateAsync(nextId, { val: oldState.val, ack: true });
                }
            }
            await adapter.delObjectAsync(id);
            movedUsers++;
        }

        // Remove now-empty channels with non-ASCII names below users.*
        const after = (await adapter.getAdapterObjectsAsync()) || {};
        for (const fullId of Object.keys(after)) {
            if (!fullId.startsWith(`${prefix}users.`) || after[fullId]?.type !== 'channel') {
                continue;
            }
            const id = fullId.slice(prefix.length);
            const last = id.split('.').pop();
            if (/[^a-zA-Z0-9_-]/.test(last)) {
                await adapter.delObjectAsync(id, { recursive: true });
            }
        }
    } catch (e) {
        adapter.log.warn(`ASCII id migration failed: ${e.message}`);
        return;
    }

    if (movedRegistry || movedUsers || droppedCache) {
        adapter.log.info(
            `ID migration: ${movedRegistry} registry state(s) and ${movedUsers} user state(s) moved, ${droppedCache} cache state(s) dropped.`,
        );
    }
}

module.exports = { migrateAsciiObjectIds };
