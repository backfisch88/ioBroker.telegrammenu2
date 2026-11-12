'use strict';

const utils = require('@iobroker/adapter-core');
const {
    ensureCoreStates,
    ensureDynamicState,
    migrateChannelObjects,
    migrateCoreStateMetadata,
} = require('./lib/states');
const { createNotifyEngine } = require('./lib/notify');
const { createRouter } = require('./lib/base');
const { createScriptBridge } = require('./lib/scriptBridge');
const { importRegistry, listMenuKeys, getMenu, setMenu, resetRegistry, deleteMenus } = require('./lib/registry');
const { setupEventTriggers, handleEventTriggerStateChange } = require('./lib/eventTriggers');
const { initBotI18n } = require('./lib/botI18n');
const { migrateAsciiObjectIds } = require('./lib/migrate');
const defaultRegistry = require('./lib/defaultRegistry');

class TelegramMenu2 extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'telegrammenu2' });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await initBotI18n(this);
        await migrateChannelObjects(this);
        await migrateCoreStateMetadata(this);
        await migrateAsciiObjectIds(this);
        await ensureCoreStates(this);

        this.telegramInstance = this.config.telegramInstance || 'telegram.0';

        // notify() is a plain method on the adapter now, no sendTo detour needed
        // for code running in the same process.
        const notifyEngine = createNotifyEngine(this);
        this.notify = (area, type, text, extra) => notifyEngine.send(area, type, text, extra);
        this.notify.registerAreas = notifyEngine.registerAreas;
        this.notify.getValidAreas = notifyEngine.getValidAreas;
        this.notify.getPendingAreas = notifyEngine.getPendingAreas;
        this.notify.approveArea = notifyEngine.approveArea;
        this.notify.setOverride = notifyEngine.setOverride;
        this.notify.setTypeLabel = notifyEngine.setTypeLabel;
        this.notify.getLabel = notifyEngine.getLabel;
        this.notify.setAreaLabel = notifyEngine.setAreaLabel;
        this.notify.getAreaLabel = notifyEngine.getAreaLabel;
        this.notify.pauseArea = notifyEngine.pauseArea;
        this.notify.unpauseArea = notifyEngine.unpauseArea;
        this.notify.isAreaPaused = notifyEngine.isAreaPaused;
        this.notify.getAreaPausedUntil = notifyEngine.getAreaPausedUntil;
        this.notify.deleteArea = notifyEngine.deleteArea;
        this.notify.getAllAreasFull = notifyEngine.getAllAreasFull;
        this.notify.isOverride = notifyEngine.isOverride;
        this._notifyEngine = notifyEngine;
        await notifyEngine.init();

        this.scriptBridge = createScriptBridge(this);
        await this.scriptBridge.init();

        this.router = createRouter(this);

        const existingMenus = await listMenuKeys(this);
        if (!existingMenus.length) {
            await importRegistry(this, defaultRegistry);
            this.log.info(
                'Default registry imported (main menu + settings) - no manual import needed for first start.',
            );
        }

        // Runs on EVERY start (not only the first one) - makes sure newly added
        // default submenus also appear on existing installations without touching
        // or overwriting the rest of the registry.
        if (!existingMenus.includes('settings_notify_pause')) {
            await setMenu(this, 'settings_notify_pause', defaultRegistry.settings_notify_pause);
            this.log.info('New sub-menu "settings_notify_pause" added.');
        }

        await this.subscribeForeignStatesAsync(`${this.telegramInstance}.communicate.request`);

        // Mirror the connection state of the telegram instance
        await this.setObjectNotExistsAsync('info', { type: 'channel', common: { name: 'Information' }, native: {} });
        await this.setObjectNotExistsAsync('info.connection', {
            type: 'state',
            common: {
                name: 'Telegram instance connected',
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
        await this.subscribeForeignStatesAsync(`${this.telegramInstance}.info.connection`);
        const tgConn = await this.getForeignStateAsync(`${this.telegramInstance}.info.connection`);
        await this.setStateAsync('info.connection', { val: !!tgConn?.val, ack: true });

        // Event listener -> automatic menu: scan the registry for menuDef.trigger
        // and subscribe the matching datapoints. Also subscribe to our own registry.*
        // states so a trigger saved in the editor takes effect immediately without
        // restarting the adapter.
        await setupEventTriggers(this);
        await this.subscribeStatesAsync('registry.*');

        this.log.info(`telegramMenu2 ready, listening on ${this.telegramInstance}.communicate.request`);
    }

    onStateChange(id, state) {
        if (id === `${this.telegramInstance}.info.connection`) {
            this.setState('info.connection', { val: !!state?.val, ack: true });
            return;
        }
        if (id.startsWith(`${this.namespace}.registry.`)) {
            setupEventTriggers(this).catch(e =>
                this.log.warn(`setupEventTriggers (rescan after registry change): ${e.message}`),
            );
            return;
        }
        if (!state || state.val === undefined || state.val === null) {
            return;
        }
        if (id === `${this.telegramInstance}.communicate.request`) {
            this.router.handleIncoming(String(state.val)).catch(e => this.log.error(`handleIncoming: ${e.message}`));
            return;
        }
        handleEventTriggerStateChange(this, id, state, (chatId, menuKey) =>
            this.router.renderMenu(chatId, menuKey),
        ).catch(e => this.log.warn(`Event listener processing for ${id}: ${e.message}`));
    }

    // Transition bridge: scripts running in the JavaScript adapter can send via
    // sendTo('telegrammenu2.0', 'notify', {...}). Code inside this adapter calls
    // this.notify(...) directly instead.
    // Detects the event type from the message text if no dedicated field is sent
    // (as LaundryLens/washdata do) and strips the marker from the text that
    // actually reaches Telegram.
    // Order: ::notify::TYPE:: (recommended, prepend it in LaundryLens' own
    // message templates) > [TYPE] > keyword fallback.
    detectTypeFromText(text) {
        const notifyMarker = text.match(/^\s*::notify::(\w+)::\s*/i);
        if (notifyMarker) {
            return { type: notifyMarker[1].toLowerCase(), text: text.slice(notifyMarker[0].length) };
        }

        const bracketMarker = text.match(/^\s*\[(\w+)\]\s*/i);
        if (bracketMarker) {
            return { type: bracketMarker[1].toLowerCase(), text: text.slice(bracketMarker[0].length) };
        }

        if (/running|started|\bstart\b/i.test(text)) {
            return { type: 'start', text };
        }
        if (/update/i.test(text)) {
            return { type: 'update', text };
        }
        if (/done|finished|completed/i.test(text)) {
            return { type: 'done', text };
        }
        return { type: 'message', text };
    }

    onMessage(obj) {
        if (!obj) {
            return;
        }

        // Script bridge: a script registers itself ONCE (e.g. on its own start) -
        // "I answer all commands with this prefix, need permission X for it and use
        // these notification areas".
        // sendTo('telegrammenu2.0', 'registerScriptCommand', {
        //   cmdPrefix: 'TG:EXAMPLE', scriptId: 'script.js.Telegram.myScript',
        //   perm: 'example', notifyAreas: { example: ['info'] }
        // })
        if (obj.command === 'registerScriptCommand') {
            const { cmdPrefix, scriptId, perm, notifyAreas } = obj.message || {};
            (async () => {
                if (!cmdPrefix || !scriptId) {
                    if (obj.callback) {
                        this.sendTo(
                            obj.from,
                            obj.command,
                            { ok: false, error: 'cmdPrefix and scriptId are required' },
                            obj.callback,
                        );
                    }
                    return;
                }
                await this.scriptBridge.register(cmdPrefix, scriptId, perm || '');
                if (notifyAreas) {
                    await this.notify.registerAreas(scriptId, notifyAreas);
                }
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
                }
            })().catch(e => this.log.error(`Unhandled error in message handler: ${e.message}`));
            return;
        }

        if (obj.command === 'unregisterScriptCommand') {
            const { cmdPrefix } = obj.message || {};
            (async () => {
                await this.scriptBridge.unregister(cmdPrefix);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
                }
            })().catch(e => this.log.error(`Unhandled error in message handler: ${e.message}`));
            return;
        }

        // A script itself (without a previous button press) triggers a follow-up
        // question - e.g. because a device state changed, not because someone tapped.
        // sendTo('telegrammenu2.0', 'awaitReply', {
        //   user: chatId, scriptId: 'balkon', cmd: 'CalibHeight', text: '📏 ...',
        //   menuKey: 'balcony_calib' (optional, used for the reply afterwards)
        // })
        if (obj.command === 'awaitReply') {
            const { user, scriptId, cmd, text, menuKey, keyboard } = obj.message || {};
            (async () => {
                if (!user || !scriptId || !cmd) {
                    if (obj.callback) {
                        this.sendTo(
                            obj.from,
                            obj.command,
                            { ok: false, error: 'user, scriptId and cmd are required' },
                            obj.callback,
                        );
                    }
                    return;
                }
                await this.router.setInputMode(
                    'script_await',
                    JSON.stringify({ scriptId, cmd, menuKey: menuKey || '' }),
                );
                if (text && keyboard) {
                    await this.router.sendMenu(user, text, keyboard);
                } else if (text) {
                    await this.router.sendTextNoKeyboard(user, text);
                }
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
                }
            })().catch(e => this.log.error(`Unhandled error in message handler: ${e.message}`));
            return;
        }

        if (obj.command === 'getScriptCommands') {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { ok: true, handlers: this.scriptBridge.getAll() }, obj.callback);
            }
            return;
        }

        // Compatibility shim: adapters like LaundryLens/washdata treat every adapter
        // name starting with "telegram" as compatible (string comparison, see
        // washdata/main.js) and then send WITHOUT their own command field: either a
        // bare string or {text, chatId}.
        if (!obj.command || obj.command === 'send') {
            // obj.from looks like "system.adapter.laundrylens.0" in ioBroker -
            // the plain adapter name is the THIRD segment, not the first
            // (which is always just the word "system").
            const fromParts = (obj.from || '').split('.');
            const fromAdapter =
                fromParts[0] === 'system' && fromParts[1] === 'adapter' && fromParts[2]
                    ? fromParts[2]
                    : fromParts[0] || 'external';

            if (typeof obj.message === 'string' && obj.message) {
                const { type, text } = this.detectTypeFromText(obj.message);
                this.log.info(
                    `Compatibility message from ${fromAdapter} (string, type "${type}") - routed via notify()`,
                );
                this.notify(fromAdapter, type, text);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command || 'send', { ok: true }, obj.callback);
                }
                return;
            }

            if (obj.message && typeof obj.message === 'object' && obj.message.text) {
                const target = obj.message.chatId || obj.message.user;
                if (target) {
                    this.log.info(
                        `Compatibility message from ${fromAdapter} with explicit target (${target}) - forwarded directly`,
                    );
                    this.sendToAsync(this.telegramInstance, { text: obj.message.text, user: target })
                        .then(() => {
                            if (obj.callback) {
                                this.sendTo(obj.from, obj.command || 'send', { ok: true }, obj.callback);
                            }
                        })
                        .catch(e => {
                            this.log.warn(`Forwarding to ${this.telegramInstance} failed: ${e.message}`);
                            if (obj.callback) {
                                this.sendTo(
                                    obj.from,
                                    obj.command || 'send',
                                    { ok: false, error: e.message },
                                    obj.callback,
                                );
                            }
                        });
                } else {
                    const { type, text } = this.detectTypeFromText(obj.message.text);
                    this.log.info(
                        `Compatibility message from ${fromAdapter} (object, no target, type "${type}") - routed via notify()`,
                    );
                    this.notify(fromAdapter, type, text);
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command || 'send', { ok: true }, obj.callback);
                    }
                }
                return;
            }
        }

        if (!obj.command) {
            this.log.info(`Message received without "command" - content: ${JSON.stringify(obj)}`);
            return;
        }

        if (obj.command === 'notify') {
            // File attachment: with "file" set, text automatically becomes the caption
            // (Telegram only shows the caption for a file, never a separate text, so no
            // dedicated "caption" field is needed - one parameter less in sendTo).
            const { area, type, text, file, extra } = obj.message || {};
            const fileExtra = file ? { file, caption: text } : extra;
            this.notify(area, type, text, fileExtra);
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
            }
            return;
        }

        // Save/load node positions of the editor tab so the graph is not
        // rearranged every time it is reopened.
        if (obj.command === 'saveLayout') {
            const { layout } = obj.message || {};
            (async () => {
                await ensureDynamicState(this, 'registry._layout', '{}', 'json');
                await this.setStateAsync('registry._layout', { val: JSON.stringify(layout || {}), ack: true });
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
                }
            })().catch(e => this.log.error(`Unhandled error in message handler: ${e.message}`));
            return;
        }

        if (obj.command === 'getLayout') {
            (async () => {
                const state = await this.getStateAsync('registry._layout');
                let layout = {};
                try {
                    layout = JSON.parse(state?.val || '{}');
                } catch {
                    layout = {};
                }
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: true, layout }, obj.callback);
                }
            })().catch(e => this.log.error(`Unhandled error in message handler: ${e.message}`));
            return;
        }

        // Delete individual menus (not the whole registry like resetRegistry) -
        // sendTo('telegrammenu2.0', 'deleteRegistryMenus', { keys: ['test_menu', ...] })
        if (obj.command === 'deleteRegistryMenus') {
            const { keys } = obj.message || {};
            (async () => {
                const removed = await deleteMenus(this, Array.isArray(keys) ? keys : []);
                if (removed.length) {
                    this.log.info(`Menus removed (no longer present in editor): ${removed.join(', ')}`);
                }
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: true, removed }, obj.callback);
                }
            })().catch(e => this.log.error(`Unhandled error in message handler: ${e.message}`));
            return;
        }

        // Removes all registry.* states (e.g. leftovers from earlier tests) -
        // sendTo('telegrammenu2.0', 'resetRegistry') - then import again.
        if (obj.command === 'resetRegistry') {
            (async () => {
                const removed = await resetRegistry(this);
                this.log.info(`Registry reset - removed: ${removed.join(', ') || '(empty)'}`);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: true, removed }, obj.callback);
                }
            })().catch(e => {
                this.log.error(`resetRegistry: ${e.message}`);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: false, error: e.message }, obj.callback);
                }
            });
            return;
        }

        // Fetch the complete registry for the editor tab (automatic load on open
        // instead of always starting with the demo graph).
        if (obj.command === 'getRegistry') {
            (async () => {
                try {
                    const keys = await listMenuKeys(this);
                    const out = {};
                    for (const key of keys) {
                        const def = await getMenu(this, key);
                        if (def) {
                            out[key] = def;
                        }
                    }
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, { ok: true, registry: out }, obj.callback);
                    }
                } catch (e) {
                    this.log.error(`getRegistry: ${e.message}`);
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, { ok: false, error: e.message }, obj.callback);
                    }
                }
            })().catch(e => this.log.error(`Unhandled error in message handler: ${e.message}`));
            return;
        }

        // Fetch the live area list for the editor tab (not only what is
        // was entered manually): sendTo('telegrammenu2.0', 'getNotifyAreas')
        if (obj.command === 'getNotifyAreas') {
            const areas = this.notify.getValidAreas();
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { ok: true, areas }, obj.callback);
            }
            return;
        }

        // Areas that were discovered automatically but are not approved yet (e.g.
        // test messages of foreign adapters) - they only show up in the
        // "Notifications" menu after approveNotifyArea.
        if (obj.command === 'getPendingNotifyAreas') {
            const areas = this.notify.getPendingAreas();
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { ok: true, areas }, obj.callback);
            }
            return;
        }

        if (obj.command === 'approveNotifyArea') {
            const { area } = obj.message || {};
            (async () => {
                const ok = await this.notify.approveArea(area);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok }, obj.callback);
                }
            })().catch(e => this.log.error(`Unhandled error in message handler: ${e.message}`));
            return;
        }

        // Marks area+type as "cannot be switched off" (override) -
        // sendTo('telegrammenu2.0', 'setNotifyOverride', {area, type, override: true})
        if (obj.command === 'setNotifyOverride') {
            const { area, type, override } = obj.message || {};
            (async () => {
                await this.notify.setOverride(area, type, !!override);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
                }
            })().catch(e => this.log.error(`Unhandled error in message handler: ${e.message}`));
            return;
        }

        // Full record of all areas (types, display names, override, approval)
        // for the editor tab, so everything is really restored on reload
        // instead of only area + types.
        if (obj.command === 'getNotifyAreasFull') {
            const areas = this.notify.getAllAreasFull();
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { ok: true, areas }, obj.callback);
            }
            return;
        }

        // Delete an area completely (not just hide it) -
        // sendTo('telegrammenu2.0', 'deleteNotifyArea', {area})
        if (obj.command === 'deleteNotifyArea') {
            const { area } = obj.message || {};
            (async () => {
                const ok = await this.notify.deleteArea(area);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok }, obj.callback);
                }
            })().catch(e => this.log.error(`Unhandled error in message handler: ${e.message}`));
            return;
        }

        // Set the display name for the AREA itself (e.g. "system" -> "Tests") -
        // sendTo('telegrammenu2.0', 'setNotifyAreaLabel', {area, label})
        if (obj.command === 'setNotifyAreaLabel') {
            const { area, label } = obj.message || {};
            (async () => {
                await this.notify.setAreaLabel(area, label);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
                }
            })().catch(e => this.log.error(`Unhandled error in message handler: ${e.message}`));
            return;
        }

        // Set a display name instead of the technical type (e.g. "priceChange") -
        // sendTo('telegrammenu2.0', 'setNotifyTypeLabel', {area, type, label})
        if (obj.command === 'setNotifyTypeLabel') {
            const { area, type, label } = obj.message || {};
            (async () => {
                await this.notify.setTypeLabel(area, type, label);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
                }
            })().catch(e => this.log.error(`Unhandled error in message handler: ${e.message}`));
            return;
        }

        // Register notify areas directly from the editor tab (graphical instead of
        // object editor): sendTo('telegrammenu2.0', 'registerNotifyAreas', { area: ['type1','type2'], ... })
        if (obj.command === 'registerNotifyAreas') {
            const areasMap = obj.message || {};
            (async () => {
                for (const [area, types] of Object.entries(areasMap)) {
                    await this.notify.registerAreas('editor', { [area]: Array.isArray(types) ? types : [] });
                }
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: true, areas: Object.keys(areasMap) }, obj.callback);
                }
            })().catch(e => {
                this.log.error(`registerNotifyAreas: ${e.message}`);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: false, error: e.message }, obj.callback);
                }
            });
            return;
        }
        if (obj.command === 'importRegistry') {
            importRegistry(this, obj.message)
                .then(keys => {
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, { ok: true, imported: keys }, obj.callback);
                    }
                })
                .catch(e => {
                    this.log.error(`importRegistry: ${e.message}`);
                    if (obj.callback) {
                        this.sendTo(obj.from, obj.command, { ok: false, error: e.message }, obj.callback);
                    }
                });
            return;
        }

        // Catches everything we do not know (yet) - e.g. adapters like LaundryLens
        // that detect telegrammenu2 as "telegram-compatible" and send in their own
        // format. The log shows exactly what arrives, so a matching handler can be
        // built instead of guessing.
        this.log.info(`Unknown/unhandled message command: "${obj.command}" - content: ${JSON.stringify(obj.message)}`);
        if (obj.callback) {
            this.sendTo(
                obj.from,
                obj.command,
                { ok: false, error: `Command "${obj.command}" is not supported yet` },
                obj.callback,
            );
        }
    }

    async onUnload(callback) {
        try {
            await this.setStateAsync('info.connection', { val: false, ack: true });
            // Deliver pending (grouped) messages IMMEDIATELY instead of discarding them
            // - otherwise e.g. the balcony daily report is lost when an adapter update
            // happens to fall into the 15-second collection window.
            if (this._notifyEngine) {
                await this._notifyEngine.flushAllPending();
            }
            callback();
        } catch {
            callback();
        }
    }
}

if (require.main !== module) {
    module.exports = options => new TelegramMenu2(options);
} else {
    new TelegramMenu2();
}
