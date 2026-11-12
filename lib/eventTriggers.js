'use strict';

const { hasPermission, isApproved, listUsers } = require('./users');
const { matchesRuleValue } = require('./template');

// IMPORTANT (compact mode safety): subscribedMap deliberately does NOT live on
// module level but on the adapter object itself (adapter._eventTriggerMap).
// Module-wide state would be shared between two instances of this adapter if
// both run in the same process (compact: true) - this exact pattern caused a
// real bug in another adapter.

// menuDef.trigger = { datapoint, value, ackOnly }
// "value" uses the same comparison logic as the status-dependent icons
// (exact string comparison OR operator prefix like "<20", ">=50").
function matchesTrigger(trigger, state) {
    if (!state || state.val === undefined || state.val === null) {
        return false;
    }
    if (trigger.ackOnly && state.ack !== true) {
        return false;
    }
    return matchesRuleValue(trigger.value, String(state.val));
}

// Scans the whole registry for menus with a "trigger" set and rebuilds the
// datapoint -> menu mapping. Deliberately enumerates DIRECTLY via the pattern
// (registry.*) instead of listMenuKeys()/registry._index - the editor does not
// reliably maintain "_index" when saving SINGLE menus, only on the initial
// full import. Direct pattern matching is robust regardless of whether
// "_index" is current.
async function setupEventTriggers(adapter) {
    const prevMap = adapter._eventTriggerMap || {};
    const nextMap = {};
    let states;
    try {
        states = await adapter.getStatesAsync('registry.*');
    } catch (e) {
        adapter.log.warn(`Event listeners: could not read registry.*: ${e.message}`);
        return;
    }

    for (const fullId of Object.keys(states || {})) {
        const key = fullId.replace(`${adapter.namespace}.registry.`, '');
        if (key === '_index' || !states[fullId] || states[fullId].val === undefined || states[fullId].val === null) {
            continue;
        }

        let def;
        try {
            def = typeof states[fullId].val === 'string' ? JSON.parse(states[fullId].val) : states[fullId].val;
        } catch {
            continue;
        }
        if (
            !def ||
            !def.trigger ||
            !def.trigger.datapoint ||
            def.trigger.value === undefined ||
            def.trigger.value === ''
        ) {
            continue;
        }

        const dp = def.trigger.datapoint;
        nextMap[dp] = nextMap[dp] || [];
        nextMap[dp].push({ menuKey: key, trigger: def.trigger, perm: def.perm });
    }

    // Only subscribe NEWLY added datapoints - subscribeForeignStatesAsync is
    // idempotent, but we still avoid unnecessary calls on every rescan.
    for (const dp of Object.keys(nextMap)) {
        if (!prevMap[dp]) {
            try {
                await adapter.subscribeForeignStatesAsync(dp);
            } catch (e) {
                adapter.log.warn(`Event listeners: could not subscribe to ${dp}: ${e.message}`);
            }
        }
    }

    adapter._eventTriggerMap = nextMap;
    const total = Object.values(nextMap).reduce((a, arr) => a + arr.length, 0);
    adapter.log.info(
        `Event listeners: ${Object.keys(nextMap).length} datapoint(s) watched, ${total} menu trigger(s) active.`,
    );
}

// Called on every incoming state change (from onStateChange). Only checks
// datapoints that are actually configured as triggers - for all others the
// function is a no-op (fast map lookup).
async function handleEventTriggerStateChange(adapter, id, state, renderMenu) {
    const entries = (adapter._eventTriggerMap || {})[id];
    if (!entries || !entries.length) {
        return;
    }

    for (const entry of entries) {
        if (!matchesTrigger(entry.trigger, state)) {
            continue;
        }

        const userKeys = await listUsers(adapter);
        for (const userKey of userKeys) {
            if (!(await isApproved(adapter, userKey))) {
                continue;
            }
            if (entry.perm && !(await hasPermission(adapter, entry.perm, userKey))) {
                continue;
            }

            const chatState = await adapter.getStateAsync(`users.${userKey}.chatId`);
            const chatId = chatState && chatState.val;
            if (!chatId) {
                continue;
            }

            try {
                await renderMenu(chatId, entry.menuKey);
            } catch (e) {
                adapter.log.warn(
                    `Event listeners: menu "${entry.menuKey}" could not be sent to ${chatId}: ${e.message}`,
                );
            }
        }
    }
}

module.exports = { setupEventTriggers, handleEventTriggerStateChange };
