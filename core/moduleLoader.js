'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Erwartetes Modul-Interface (siehe modules/example.js):
//   module.exports = {
//     id: 'dieter',
//     cmdPrefixes: ['TG:DIETER', 'TG:NAV:DIETER'],
//     notifyAreas: { dieter: ['error'] },
//     groupableAreas: [],                 // optional
//     onCommand(cmd, value, ctx) {...},   // ctx: siehe core/base.js buildContext()
//     init(adapter) {...}                 // optional, einmalig beim Laden
//   }

async function loadModules(adapter) {
    const dir = path.join(__dirname, '..', 'modules');
    if (!fs.existsSync(dir)) {
        return [];
    }

    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
    const loaded = [];

    for (const file of files) {
        try {
            const mod = require(path.join(dir, file));
            if (!mod || !mod.id || typeof mod.onCommand !== 'function') {
                adapter.log.warn(`Modul ${file} hat kein gültiges Interface (id/onCommand fehlt) – übersprungen`);
                continue;
            }

            if (mod.notifyAreas) {
                await adapter.notify.registerAreas(mod.id, mod.notifyAreas, mod.groupableAreas || []);
            }

            if (typeof mod.init === 'function') {
                await mod.init(adapter);
            }

            loaded.push(mod);
            adapter.log.debug(`Modul geladen: ${mod.id} (${(mod.cmdPrefixes || []).join(', ')})`);
        } catch (e) {
            adapter.log.error(`Modul ${file} konnte nicht geladen werden: ${e.message}`);
        }
    }

    return loaded;
}

// Findet das zuständige Modul für einen Command anhand seiner cmdPrefixes.
function findModuleForCommand(modules, cmd) {
    return modules.find(m => (m.cmdPrefixes || []).some(p => cmd.startsWith(p)));
}

module.exports = { loadModules, findModuleForCommand };
