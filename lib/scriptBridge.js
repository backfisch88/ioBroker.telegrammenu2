'use strict';

const { ensureDynamicState } = require('./states');

const SCRIPTS_STATE = 'scriptBridge.handlers'; // JSON: { cmdPrefix: scriptId }
const CALL_TIMEOUT_MS = 8000;

// Short name ("myScript") -> full script id (script.js.<folder>.myScript).
// The folder comes from the adapter instance config (default: "Telegram").
// If a full ID is given (starts with "script.js."), leave it unchanged.
function resolveScriptId(adapter, id) {
    if (!id) {
        return id;
    }
    if (id.startsWith('script.js.')) {
        return id;
    }
    const folder = adapter.config.scriptFolder || 'Telegram';
    return `script.js.${folder}.${id}`;
}

// Replaces the old cmd/render state bridge in the long run: scripts register
// themselves ONCE on start ("I can handle TG:FUEL"), afterwards the core calls
// them directly via onMessage/toScript and gets the answer via callback -
// no buffering/observing of states any more.

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
                // Backwards compatible: the old form was a plain string (scriptId only).
                handlers[prefix] = typeof entry === 'string' ? { scriptId: entry, perm: '' } : entry;
            }
        } catch (e) {
            adapter.log.warn(`scriptBridge: could not read ${SCRIPTS_STATE}: ${e.message}`);
        }
    }

    // perm (optional): which permission is required for this command prefix -
    // passed on registration instead of being maintained separately in the
    // editor. Applies to ALL commands with this prefix.
    async function register(cmdPrefix, scriptId, perm = '') {
        handlers[cmdPrefix] = { scriptId, perm };
        await persist();
        adapter.log.info(
            `scriptBridge: "${cmdPrefix}" -> ${scriptId}${perm ? ` (permission: ${perm})` : ''} registered`,
        );
    }

    async function unregister(cmdPrefix) {
        delete handlers[cmdPrefix];
        await persist();
    }

    function findScriptFor(cmd) {
        const prefix = Object.keys(handlers).find(p => cmd.startsWith(p));
        return prefix ? handlers[prefix] : null;
    }

    // Calls the script via onMessage/toScript and waits for its callback().
    // If the script does not answer within the timeout, resolves with null -
    // the router then falls back to the old bridge (see lib/base.js).
    function callScript(scriptId, cmd, data) {
        const fullScriptId = resolveScriptId(adapter, scriptId);
        const jsInstance = adapter.config.javascriptInstance || 'javascript.0';
        return new Promise(resolve => {
            let settled = false;
            const timer = adapter.setTimeout(() => {
                if (!settled) {
                    settled = true;
                    adapter.log.warn(
                        `scriptBridge: ${fullScriptId} did not respond to "${cmd}" within ${CALL_TIMEOUT_MS}ms`,
                    );
                    resolve(null);
                }
            }, CALL_TIMEOUT_MS);

            adapter.sendTo(jsInstance, 'toScript', { script: fullScriptId, message: cmd, data }, res => {
                if (settled) {
                    return;
                }
                settled = true;
                adapter.clearTimeout(timer);
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
