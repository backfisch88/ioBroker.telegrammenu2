'use strict';

// Entspricht mod_base.js' ensureStateSimple()-Block, nur als Adapter-States
// statt 0_userdata.0.telegramMenu2.* States des JavaScript-Adapters.

const CORE_STATES = [
    { id: 'runtime.lastChatId', def: '', role: 'text', name: 'Last Telegram chat ID' },
    { id: 'runtime.lastUserKey', def: '', role: 'text', name: 'Last user key' },
    { id: 'runtime.currentMenu', def: 'main', role: 'text', name: 'Currently active menu' },
    { id: 'runtime.historyJson', def: '[]', role: 'json', name: 'Menu navigation history (JSON)' },
    { id: 'runtime.inputMode', def: '', role: 'text', name: 'Current text input mode' },
    { id: 'runtime.inputContext', def: '', role: 'text', name: 'Current text input context' },
    { id: 'runtime.confirmAction', def: '', role: 'text', name: 'Pending confirmation action' },
    { id: 'runtime.confirmPayload', def: '', role: 'text', name: 'Pending confirmation payload' },

    { id: 'cmd.id', def: '', role: 'text', name: 'Last dispatched command ID', write: false },
    { id: 'cmd.value', def: '', role: 'text', name: 'Last dispatched command value', write: false },
    { id: 'cmd.ts', def: 0, role: 'value.time', unit: 'ms', name: 'Last dispatched command timestamp', write: false },

    { id: 'render.menuKey', def: '', role: 'text', name: 'Last rendered menu key' },
    { id: 'render.text', def: '', role: 'text', name: 'Last rendered message text' },
    { id: 'render.ts', def: 0, role: 'value.time', unit: 'ms', name: 'Last rendered menu timestamp', write: false },
];

// Roles that ioBroker's state-role convention (see stateroles.md) requires
// to be read-only from the outside. We still write these ourselves from
// within the adapter (setState doesn't care about common.write - that flag
// only governs external/UI writes), so this is purely a metadata fix.
const READONLY_ROLES = new Set(['value', 'indicator']);

// Creates every missing intermediate "channel" object for a dotted state id,
// e.g. for "users.foo.permissions.bar" this ensures "users", "users.foo" and
// "users.foo.permissions" all exist as channel objects. Without this, ioBroker
// (and the repository checker) considers the object tree broken - states are
// leaf nodes and every path segment above them needs a real object.
async function ensureChannelPath(adapter, id) {
    const segments = id.split('.');
    let path = '';
    // The last segment is the state itself, not a channel - stop before it.
    for (let i = 0; i < segments.length - 1; i++) {
        path = path ? `${path}.${segments[i]}` : segments[i];
        await adapter.setObjectNotExistsAsync(path, {
            type: 'channel',
            common: { name: segments[i] },
            native: {},
        });
    }
}

async function ensureCoreStates(adapter) {
    for (const s of CORE_STATES) {
        await ensureChannelPath(adapter, s.id);
        const common = {
            name: s.name || s.id,
            type: typeof s.def === 'number' ? 'number' : 'string',
            role: s.role,
            read: true,
            write: s.write === undefined ? true : s.write,
        };
        if (s.unit) {
            common.unit = s.unit;
        }
        await adapter.setObjectNotExistsAsync(s.id, { type: 'state', common, native: {} });
        const current = await adapter.getStateAsync(s.id);
        if (!current) {
            await adapter.setStateAsync(s.id, { val: s.def, ack: true });
        }
    }
}

// Legt (falls nötig) einen einzelnen dynamischen State an, z. B. für
// Nutzer-Rechte oder Menü-Registry-Einträge, die vorab nicht bekannt sind.
async function ensureDynamicState(adapter, id, def, role = 'state') {
    const exists = await adapter.getObjectAsync(id);
    if (!exists) {
        await ensureChannelPath(adapter, id);
        // Letztes ID-Segment als Anzeigename statt der vollen, verschachtelten ID -
        // z. B. "Wäsche" statt "users.henrik123.permissions.Wäsche".
        const lastSegment = id.split('.').pop();
        await adapter.setObjectNotExistsAsync(id, {
            type: 'state',
            common: {
                name: lastSegment,
                type: typeof def === 'number' ? 'number' : typeof def === 'boolean' ? 'boolean' : 'string',
                role,
                read: true,
                write: !READONLY_ROLES.has(role),
            },
            native: {},
        });
        await adapter.setStateAsync(id, { val: def, ack: true });
    }
}

// One-time migration for installations that already have states created by
// an older adapter version (before ensureChannelPath/the write-flag fix
// existed) - walks every existing object under this adapter instance and:
//   (a) backfills any missing parent channel objects
//   (b) corrects common.write on existing "value"/"indicator" states that
//       were created before READONLY_ROLES existed (setObjectNotExistsAsync
//       never touches an object that already exists, so that earlier fix
//       only applied to brand-new states, not ones from before the fix).
// Safe to run on every start: both operations are no-ops once corrected.
async function migrateChannelObjects(adapter) {
    let allObjects;
    try {
        allObjects = await adapter.getAdapterObjectsAsync();
    } catch (e) {
        adapter.log.warn(`Object migration skipped: ${e.message}`);
        return;
    }

    const prefix = `${adapter.namespace}.`;
    const stateIds = Object.keys(allObjects || {})
        .filter(fullId => allObjects[fullId]?.type === 'state' && fullId.startsWith(prefix))
        .map(fullId => fullId.slice(prefix.length));

    // Permission-/Notify-Toggles sind immer "indicator" (boolean, read-only
    // von außen) - manche sehr alte Installationen (vor dieser Konvention,
    // oder durch eine fehlerhafte Zwischenversion) haben hier stattdessen
    // eine ungültige Pseudo-Rolle wie "boolean" stehen, die gar nicht im
    // offiziellen ioBroker-Rollenkatalog existiert.
    const INDICATOR_PATH_RE = /^users\.[^.]+\.(?:permissions\.[^.]+|notify\.[^.]+\.[^.]+)$/;

    let channelsCreated = 0;
    let writeFlagsFixed = 0;
    let rolesFixed = 0;

    for (const id of stateIds) {
        const segments = id.split('.');
        for (let i = 0; i < segments.length - 1; i++) {
            const path = segments.slice(0, i + 1).join('.');
            if (!allObjects[`${prefix}${path}`]) {
                await adapter.setObjectNotExistsAsync(path, {
                    type: 'channel',
                    common: { name: segments[i] },
                    native: {},
                });
                channelsCreated++;
            }
        }

        const obj = allObjects[`${prefix}${id}`];
        const role = obj?.common?.role;

        if (INDICATOR_PATH_RE.test(id) && role !== 'indicator') {
            await adapter.extendObjectAsync(id, { common: { role: 'indicator', write: false } });
            rolesFixed++;
            continue;
        }

        if (READONLY_ROLES.has(role) && obj.common.write !== false) {
            await adapter.extendObjectAsync(id, { common: { write: false } });
            writeFlagsFixed++;
        }
    }

    if (channelsCreated || writeFlagsFixed || rolesFixed) {
        adapter.log.info(
            `Object migration: ${channelsCreated} missing intermediate object(s) added, ${writeFlagsFixed} write flag(s) corrected, ${rolesFixed} stale role(s) corrected.`,
        );
    }
}

// One-time migration for installations where a CORE_STATES entry's metadata
// (role/name/unit/write) was changed in a later adapter version - e.g. the
// cmd.ts/render.ts role: 'value' -> 'value.time' + unit: 'ms' fix, or the
// write: true -> false fix for cmd.id/cmd.value. ensureCoreStates() alone
// can't apply these to already-existing objects, since setObjectNotExistsAsync
// is a no-op once the object exists. Safe to run on every start: it's a
// no-op once every state's metadata already matches CORE_STATES.
async function migrateCoreStateMetadata(adapter) {
    let fixed = 0;
    for (const s of CORE_STATES) {
        const existing = await adapter.getObjectAsync(s.id);
        if (!existing || !existing.common) {
            continue;
        }
        const wantWrite = s.write === undefined ? true : s.write;
        const wantName = s.name || s.id;
        const patch = {};
        if (existing.common.role !== s.role) {
            patch.role = s.role;
        }
        if (existing.common.name !== wantName) {
            patch.name = wantName;
        }
        if (s.unit && existing.common.unit !== s.unit) {
            patch.unit = s.unit;
        }
        if (existing.common.write !== wantWrite) {
            patch.write = wantWrite;
        }
        if (Object.keys(patch).length) {
            await adapter.extendObjectAsync(s.id, { common: patch });
            fixed++;
        }
    }
    if (fixed) {
        adapter.log.info(
            `Object migration: ${fixed} core state(s) had their metadata (role/name/unit/write) corrected.`,
        );
    }
}

module.exports = {
    ensureCoreStates,
    ensureDynamicState,
    ensureChannelPath,
    migrateChannelObjects,
    migrateCoreStateMetadata,
    CORE_STATES,
};
