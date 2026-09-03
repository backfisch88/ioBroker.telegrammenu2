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
  { id: 'cmd.ts', def: 0, role: 'value' },

  { id: 'render.menuKey', def: '', role: 'text' },
  { id: 'render.text', def: '', role: 'text' },
  { id: 'render.ts', def: 0, role: 'value' },
];

async function ensureCoreStates(adapter) {
  for (const s of CORE_STATES) {
    await adapter.setObjectNotExistsAsync(s.id, {
      type: 'state',
      common: {
        name: s.id,
        type: typeof s.def === 'number' ? 'number' : 'string',
        role: s.role,
        read: true,
        write: true,
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
    await adapter.setObjectNotExistsAsync(id, {
      type: 'state',
      common: {
        name: id,
        type: typeof def === 'number' ? 'number' : typeof def === 'boolean' ? 'boolean' : 'string',
        role,
        read: true,
        write: true,
      },
      native: {},
    });
    await adapter.setStateAsync(id, { val: def, ack: true });
  }
}

module.exports = { ensureCoreStates, ensureDynamicState, CORE_STATES };
