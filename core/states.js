'use strict';

// Entspricht mod_base.js' ensureStateSimple()-Block, nur als Adapter-States
// statt 0_userdata.0.telegramMenu2.* States des JavaScript-Adapters.

const CORE_STATES = [
    { id: 'runtime.lastChatId', def: '', role: 'text' },
    { id: 'runtime.lastUserKey', def: '', role: 'text' },
    { id: 'runtime.currentMenu', def: 'main', role: 'text' },
    { id: 'runtime.historyJson', def: '[]', role: 'json' },
    { id: 'runtime.inputMode', def: '', role: 'text' },
    { id: 'runtime.inputContext', def: '', role: 'text' },
    { id: 'runtime.confirmAction', def: '', role: 'text' },
    { id: 'runtime.confirmPayload', def: '', role: 'text' },

    { id: 'cmd.id', def: '', role: 'text' },
    { id: 'cmd.value', def: '', role: 'text' },
    { id: 'cmd.ts', def: 0, role: 'value', write: false },

    { id: 'render.menuKey', def: '', role: 'text' },
    { id: 'render.text', def: '', role: 'text' },
    { id: 'render.ts', def: 0, role: 'value', write: false },
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
        await adapter.setObjectNotExistsAsync(s.id, {
            type: 'state',
            common: {
                name: s.id,
                type: typeof s.def === 'number' ? 'number' : 'string',
                role: s.role,
                read: true,
                write: s.write === undefined ? true : s.write,
            },
            native: {},
        });
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
        await adapter.setObjectNotExistsAsync(id, {
            type: 'state',
            common: {
                name: id,
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

module.exports = { ensureCoreStates, ensureDynamicState, ensureChannelPath, CORE_STATES };
