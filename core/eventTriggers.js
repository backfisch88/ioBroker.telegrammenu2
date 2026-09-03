'use strict';

const { hasPermission, isApproved, listUsers } = require('./users');
const { matchesRuleValue } = require('./template');

// datapoint -> [{ menuKey, trigger, perm }] - mehrere Menüs können denselben
// Datenpunkt beobachten (z. B. verschiedene Schwellwerte).
let subscribedMap = {};

// menuDef.trigger = { datapoint, value, ackOnly }
// "value" nutzt dieselbe Vergleichslogik wie die Status-abhängigen Icons
// (exakter String-Vergleich ODER Operator-Prefix wie "<20", ">=50").
function matchesTrigger(trigger, state) {
  if (!state || state.val === undefined || state.val === null) return false;
  if (trigger.ackOnly && state.ack !== true) return false;
  return matchesRuleValue(trigger.value, String(state.val));
}

// Scannt die komplette Registry nach Menüs mit gesetztem "trigger" und baut
// die Datenpunkt->Menü-Zuordnung neu auf. Enumeriert bewusst DIREKT per
// Pattern (registry.*) statt über listMenuKeys()/registry._index - der
// Editor pflegt "_index" beim Speichern EINZELNER Menüs nicht zuverlässig
// mit, nur beim initialen Voll-Import. Direktes Pattern-Matching ist robust
// unabhängig davon, ob "_index" gerade aktuell ist.
async function setupEventTriggers(adapter) {
  const nextMap = {};
  let states;
  try {
    states = await adapter.getStatesAsync('registry.*');
  } catch (e) {
    adapter.log.warn(`Event-Listener: registry.* konnte nicht gelesen werden: ${e.message}`);
    return;
  }

  for (const fullId of Object.keys(states || {})) {
    const key = fullId.replace(`${adapter.namespace}.registry.`, '');
    if (key === '_index' || !states[fullId] || states[fullId].val === undefined || states[fullId].val === null) continue;

    let def;
    try {
      def = typeof states[fullId].val === 'string' ? JSON.parse(states[fullId].val) : states[fullId].val;
    } catch (e) {
      continue;
    }
    if (!def || !def.trigger || !def.trigger.datapoint || def.trigger.value === undefined || def.trigger.value === '') continue;

    const dp = def.trigger.datapoint;
    nextMap[dp] = nextMap[dp] || [];
    nextMap[dp].push({ menuKey: key, trigger: def.trigger, perm: def.perm });
  }

  // Nur NEU hinzugekommene Datenpunkte abonnieren - subscribeForeignStatesAsync
  // ist idempotent, aber wir vermeiden trotzdem unnötige Calls bei jedem Rescan.
  for (const dp of Object.keys(nextMap)) {
    if (!subscribedMap[dp]) {
      try {
        await adapter.subscribeForeignStatesAsync(dp);
      } catch (e) {
        adapter.log.warn(`Event-Listener: Konnte ${dp} nicht abonnieren: ${e.message}`);
      }
    }
  }

  subscribedMap = nextMap;
  const total = Object.values(subscribedMap).reduce((a, arr) => a + arr.length, 0);
  adapter.log.info(`Event-Listener: ${Object.keys(subscribedMap).length} Datenpunkt(e) beobachtet, ${total} Menü-Trigger aktiv.`);
}

// Bei jeder eingehenden State-Änderung aufgerufen (aus onStateChange). Prüft
// nur Datenpunkte, die tatsächlich als Trigger konfiguriert sind - für alle
// anderen ist die Funktion ein no-op (schneller Map-Lookup).
async function handleEventTriggerStateChange(adapter, id, state, renderMenu) {
  const entries = subscribedMap[id];
  if (!entries || !entries.length) return;

  for (const entry of entries) {
    if (!matchesTrigger(entry.trigger, state)) continue;

    const userKeys = await listUsers(adapter);
    for (const userKey of userKeys) {
      if (!(await isApproved(adapter, userKey))) continue;
      if (entry.perm && !(await hasPermission(adapter, entry.perm, userKey))) continue;

      const chatState = await adapter.getStateAsync(`users.${userKey}.chatId`);
      const chatId = chatState && chatState.val;
      if (!chatId) continue;

      try {
        await renderMenu(chatId, entry.menuKey);
      } catch (e) {
        adapter.log.warn(`Event-Listener: Menü "${entry.menuKey}" konnte nicht an ${chatId} gesendet werden: ${e.message}`);
      }
    }
  }
}

module.exports = { setupEventTriggers, handleEventTriggerStateChange };
