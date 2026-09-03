'use strict';

const { ensureDynamicState } = require('./states');

const SCRIPTS_STATE = 'scriptBridge.handlers'; // JSON: { cmdPrefix: scriptId }
const CALL_TIMEOUT_MS = 8000;

// Kurzname ("meinSkript") -> volle Skript-ID (script.js.<Ordner>.meinSkript),
// Ordner kommt aus der Adapter-Instanz-Config (Standard: "Telegram").
// Ist schon eine volle ID angegeben (fängt mit "script.js." an), unverändert lassen.
function resolveScriptId(adapter, id) {
  if (!id) return id;
  if (id.startsWith('script.js.')) return id;
  const folder = adapter.config.scriptFolder || 'Telegram';
  return `script.js.${folder}.${id}`;
}

// Ersetzt langfristig die alte cmd/render-State-Bridge: Skripte melden sich
// EINMAL beim Start selbst an ("ich kann TG:FUEL"), der Core ruft sie danach
// direkt über onMessage/toScript auf und bekommt die Antwort per callback -
// kein Zwischenspeichern/Beobachten von States mehr nötig.

function createScriptBridge(adapter) {
  const handlers = {}; // cmdPrefix -> { scriptId, perm }

  async function persist() {
    await ensureDynamicState(adapter, SCRIPTS_STATE, '{}', 'json');
    await adapter.setStateAsync(SCRIPTS_STATE, { val: JSON.stringify(handlers), ack: true });
  }

  async function init() {
    await ensureDynamicState(adapter, SCRIPTS_STATE, '{}', 'json');
    const state = await adapter.getStateAsync(SCRIPTS_STATE);
    try {
      const obj = JSON.parse(state?.val || '{}');
      for (const [prefix, entry] of Object.entries(obj)) {
        // Abwärtskompatibel: alte Form war ein reiner String (nur scriptId).
        handlers[prefix] = typeof entry === 'string' ? { scriptId: entry, perm: '' } : entry;
      }
    } catch (e) {
      adapter.log.warn(`scriptBridge: ${SCRIPTS_STATE} konnte nicht gelesen werden: ${e.message}`);
    }
  }

  // perm (optional): welches Recht für diesen Command-Präfix nötig ist -
  // wird direkt bei der Anmeldung mitgegeben, statt separat im Editor
  // gepflegt werden zu müssen. Gilt für ALLE Commands mit diesem Präfix.
  async function register(cmdPrefix, scriptId, perm = '') {
    handlers[cmdPrefix] = { scriptId, perm };
    await persist();
    adapter.log.info(`scriptBridge: "${cmdPrefix}" -> ${scriptId}${perm ? ` (Recht: ${perm})` : ''} registriert`);
  }

  async function unregister(cmdPrefix) {
    delete handlers[cmdPrefix];
    await persist();
  }

  function findScriptFor(cmd) {
    const prefix = Object.keys(handlers).find((p) => cmd.startsWith(p));
    return prefix ? handlers[prefix] : null;
  }

  // Ruft das Skript per onMessage/toScript auf und wartet auf dessen callback().
  // Antwortet das Skript nicht innerhalb des Timeouts, resolved mit null -
  // der Router fällt dann auf die alte Bridge zurück (siehe core/base.js).
  function callScript(scriptId, cmd, data) {
    const fullScriptId = resolveScriptId(adapter, scriptId);
    const jsInstance = adapter.config.javascriptInstance || 'javascript.0';
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          adapter.log.warn(`scriptBridge: ${fullScriptId} hat auf "${cmd}" nicht innerhalb von ${CALL_TIMEOUT_MS}ms geantwortet`);
          resolve(null);
        }
      }, CALL_TIMEOUT_MS);

      adapter.sendTo(jsInstance, 'toScript', { script: fullScriptId, message: cmd, data }, (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res);
      });
    });
  }

  function getAll() {
    return { ...handlers };
  }

  return { init, register, unregister, findScriptFor, callScript, getAll };
}

module.exports = { createScriptBridge, resolveScriptId };
