'use strict';

const utils = require('@iobroker/adapter-core');
const { ensureCoreStates, ensureDynamicState } = require('./core/states');
const { createNotifyEngine } = require('./core/notify');
const { createRouter } = require('./core/base');
const { loadModules } = require('./core/moduleLoader');
const { createScriptBridge } = require('./core/scriptBridge');
const { importRegistry, listMenuKeys, getMenu, setMenu, resetRegistry, deleteMenus } = require('./core/registry');
const { setupEventTriggers, handleEventTriggerStateChange } = require('./core/eventTriggers');
const defaultRegistry = require('./core/defaultRegistry');

class TelegramMenu2 extends utils.Adapter {
    constructor(options) {
        super({ ...options, name: 'telegrammenu2' });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        await ensureCoreStates(this);

        this.telegramInstance = this.config.telegramInstance || 'telegram.0';

        // notify() ist ab jetzt eine ganz normale Methode auf dem Adapter, kein
        // sendTo-Umweg mehr nötig für Module, die im selben Prozess laufen.
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
        this.notify.deleteArea = notifyEngine.deleteArea;
        this._notifyEngine = notifyEngine;
        await notifyEngine.init();

        this.scriptBridge = createScriptBridge(this);
        await this.scriptBridge.init();

        this.router = createRouter(this);

        // Fachmodule aus modules/ laden (Plugin-System) – neue Datei rein,
        // fertig, kein Core-Code anfassen.
        this.modules = await loadModules(this);
        this.log.info(`${this.modules.length} Modul(e) geladen: ${this.modules.map(m => m.id).join(', ') || '–'}`);

        const existingMenus = await listMenuKeys(this);
        if (!existingMenus.length) {
            await importRegistry(this, defaultRegistry);
            this.log.info(
                'Standard-Registry importiert (Hauptmenü + Einstellungen) – kein manueller Import nötig für den ersten Start.',
            );
        }

        // Läuft bei JEDEM Start (nicht nur beim ersten) - stellt sicher, dass
        // neu hinzugekommene Standard-Untermenüs auch auf bestehenden Installationen
        // auftauchen, ohne die restliche Registry anzufassen/zu überschreiben.
        if (!existingMenus.includes('settings_notify_pause')) {
            await setMenu(this, 'settings_notify_pause', defaultRegistry.settings_notify_pause);
            this.log.info('Neues Untermenü "settings_notify_pause" ergänzt.');
        }

        await this.subscribeForeignStatesAsync(`${this.telegramInstance}.communicate.request`);

        // Event-Listener -> automatisches Menü: Registry nach menuDef.trigger
        // durchsuchen und die entsprechenden Datenpunkte abonnieren. Zusätzlich
        // eigene registry.*-States abonnieren, damit ein im Editor gespeicherter
        // (neuer/geänderter) Trigger sofort wirksam wird, ohne den Adapter neu
        // starten zu müssen.
        await setupEventTriggers(this);
        await this.subscribeStatesAsync('registry.*');

        this.log.info(`telegramMenu2 bereit, hört auf ${this.telegramInstance}.communicate.request`);
    }

    onStateChange(id, state) {
        if (id.startsWith(`${this.namespace}.registry.`)) {
            setupEventTriggers(this).catch(e =>
                this.log.warn(`setupEventTriggers (Rescan nach Registry-Änderung): ${e.message}`),
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
        ).catch(e => this.log.warn(`Event-Listener-Verarbeitung für ${id}: ${e.message}`));
    }

    // Übergangs-Bridge: solange noch nicht-portierte Skripte im JS-Adapter
    // laufen, können die per sendTo('telegrammenu2.0', 'notify', {...}) senden.
    // Module, die schon in diesem Adapter laufen, rufen stattdessen direkt
    // this.notify(...) auf – kein sendTo nötig.
    // Erkennt den Event-Typ aus dem Nachrichtentext, falls kein eigenes Feld
    // dafür mitgeschickt wird (wie bei LaundryLens/washdata), und entfernt die
    // Markierung aus dem Text, der tatsächlich in Telegram landet.
    // Reihenfolge: ::notify::TYPE:: (empfohlen, in LaundryLens' eigenen
    // Nachricht-Vorlagen voranstellen) > [TYPE] > Stichwort-Fallback.
    detectTypeFromText(text) {
        const notifyMarker = text.match(/^\s*::notify::(\w+)::\s*/i);
        if (notifyMarker) {
            return { type: notifyMarker[1].toLowerCase(), text: text.slice(notifyMarker[0].length) };
        }

        const bracketMarker = text.match(/^\s*\[(\w+)\]\s*/i);
        if (bracketMarker) {
            return { type: bracketMarker[1].toLowerCase(), text: text.slice(bracketMarker[0].length) };
        }

        if (/läuft/i.test(text)) {
            return { type: 'start', text };
        }
        if (/update/i.test(text)) {
            return { type: 'update', text };
        }
        if (/fertig/i.test(text)) {
            return { type: 'done', text };
        }
        return { type: 'message', text };
    }

    onMessage(obj) {
        if (!obj) {
            return;
        }

        // Skript-Bridge: ein Skript meldet sich EINMAL selbst an (z. B. beim
        // eigenen Start) - "ich beantworte alle Commands mit diesem Präfix,
        // brauche dafür Recht X, und nutze diese Benachrichtigungs-Bereiche".
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
                            { ok: false, error: 'cmdPrefix und scriptId erforderlich' },
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
            })();
            return;
        }

        if (obj.command === 'unregisterScriptCommand') {
            const { cmdPrefix } = obj.message || {};
            (async () => {
                await this.scriptBridge.unregister(cmdPrefix);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
                }
            })();
            return;
        }

        // Skript löst SELBST (ohne vorherigen Knopfdruck) eine Rückfrage aus -
        // z. B. weil ein Gerätestatus sich geändert hat, nicht weil jemand
        // getippt hat. sendTo('telegrammenu2.0', 'awaitReply', {
        //   user: chatId, scriptId: 'balkon', cmd: 'CalibHeight', text: '📏 ...',
        //   menuKey: 'balcony_calib' (optional, für die Antwort danach)
        // })
        if (obj.command === 'awaitReply') {
            const { user, scriptId, cmd, text, menuKey, keyboard } = obj.message || {};
            (async () => {
                if (!user || !scriptId || !cmd) {
                    if (obj.callback) {
                        this.sendTo(
                            obj.from,
                            obj.command,
                            { ok: false, error: 'user, scriptId und cmd erforderlich' },
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
            })();
            return;
        }

        if (obj.command === 'getScriptCommands') {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { ok: true, handlers: this.scriptBridge.getAll() }, obj.callback);
            }
            return;
        }

        // Kompatibilitäts-Shim: Adapter wie LaundryLens/washdata erkennen jeden
        // Adapter-Namen, der mit "telegram" beginnt, per String-Vergleich als
        // kompatibel (siehe washdata/main.js) - und schicken dann OHNE eigenes
        // command-Feld: entweder einen nackten String, oder {text, chatId}.
        if (!obj.command || obj.command === 'send') {
            // obj.from sieht bei ioBroker so aus: "system.adapter.laundrylens.0" -
            // der reine Adaptername steckt im DRITTEN Segment, nicht im ersten
            // (das ist immer nur das Wort "system").
            const fromParts = (obj.from || '').split('.');
            const fromAdapter =
                fromParts[0] === 'system' && fromParts[1] === 'adapter' && fromParts[2]
                    ? fromParts[2]
                    : fromParts[0] || 'external';

            if (typeof obj.message === 'string' && obj.message) {
                const { type, text } = this.detectTypeFromText(obj.message);
                this.log.info(
                    `Kompatibilitäts-Nachricht von ${fromAdapter} (String, Typ "${type}") - über notify() geroutet`,
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
                        `Kompatibilitäts-Nachricht von ${fromAdapter} mit explizitem Ziel (${target}) - direkt weitergeleitet`,
                    );
                    this.sendToAsync(this.telegramInstance, { text: obj.message.text, user: target })
                        .then(() => {
                            if (obj.callback) {
                                this.sendTo(obj.from, obj.command || 'send', { ok: true }, obj.callback);
                            }
                        })
                        .catch(e => {
                            this.log.warn(`Weiterleitung an ${this.telegramInstance} fehlgeschlagen: ${e.message}`);
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
                        `Kompatibilitäts-Nachricht von ${fromAdapter} (Objekt, kein Ziel, Typ "${type}") - über notify() geroutet`,
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
            this.log.info(`Message ohne "command" empfangen - Inhalt: ${JSON.stringify(obj)}`);
            return;
        }

        if (obj.command === 'notify') {
            // Datei-Anhang: "file" gesetzt = text wird automatisch zur
            // Bildunterschrift (bei einer Datei zeigt Telegram sowieso nur die
            // Caption an, nie zusätzlichen separaten Text - daher kein eigenes
            // "caption"-Feld mehr nötig, ein Parameter weniger im sendTo-Block).
            const { area, type, text, file, extra } = obj.message || {};
            const fileExtra = file ? { file, caption: text } : extra;
            this.notify(area, type, text, fileExtra);
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
            }
            return;
        }

        // Positionen der Knoten im Editor-Tab speichern/laden, damit sich der
        // Graph beim erneuten Öffnen nicht jedes Mal neu anordnet.
        if (obj.command === 'saveLayout') {
            const { layout } = obj.message || {};
            (async () => {
                await ensureDynamicState(this, 'registry._layout', '{}', 'json');
                await this.setStateAsync('registry._layout', { val: JSON.stringify(layout || {}), ack: true });
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
                }
            })();
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
            })();
            return;
        }

        // Gezielt einzelne Menüs löschen (nicht die ganze Registry wie resetRegistry) -
        // sendTo('telegrammenu2.0', 'deleteRegistryMenus', { keys: ['test_menu', ...] })
        if (obj.command === 'deleteRegistryMenus') {
            const { keys } = obj.message || {};
            (async () => {
                const removed = await deleteMenus(this, Array.isArray(keys) ? keys : []);
                if (removed.length) {
                    this.log.info(`Menüs entfernt (nicht mehr im Editor vorhanden): ${removed.join(', ')}`);
                }
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: true, removed }, obj.callback);
                }
            })();
            return;
        }

        // Räumt alle registry.*-States weg (z. B. Leichen aus früheren Tests) -
        // sendTo('telegrammenu2.0', 'resetRegistry') - danach neu importieren.
        if (obj.command === 'resetRegistry') {
            (async () => {
                const removed = await resetRegistry(this);
                this.log.info(`Registry zurückgesetzt - entfernt: ${removed.join(', ') || '(leer)'}`);
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

        // Komplette Registry für den Editor-Tab abrufen (automatisches Laden
        // beim Öffnen, statt immer mit dem Demo-Graphen zu starten).
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
            })();
            return;
        }

        // Live-Bereichsliste für den Editor-Tab abrufen (nicht nur, was dort
        // manuell eingetragen wurde): sendTo('telegrammenu2.0', 'getNotifyAreas')
        if (obj.command === 'getNotifyAreas') {
            const areas = this.notify.getValidAreas();
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { ok: true, areas }, obj.callback);
            }
            return;
        }

        // Noch nicht freigeschaltete, automatisch entdeckte Bereiche (z. B.
        // Testnachrichten fremder Adapter) - tauchen erst nach approveNotifyArea
        // im "Benachrichtigungen"-Menü auf.
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
            })();
            return;
        }

        // Markiert area+type als "kann nicht abgeschaltet werden" (Override) -
        // sendTo('telegrammenu2.0', 'setNotifyOverride', {area, type, override: true})
        if (obj.command === 'setNotifyOverride') {
            const { area, type, override } = obj.message || {};
            (async () => {
                await this.notify.setOverride(area, type, !!override);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
                }
            })();
            return;
        }

        // Voller Datensatz aller Bereiche (Typen, Anzeigenamen, Override, Freigabe)
        // für den Editor-Tab, damit beim Nachladen wirklich alles wiederhergestellt
        // wird statt nur Bereich+Typen.
        if (obj.command === 'getNotifyAreasFull') {
            const areas = this.notify.getAllAreasFull();
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, { ok: true, areas }, obj.callback);
            }
            return;
        }

        // Bereich komplett löschen (nicht nur ausblenden) -
        // sendTo('telegrammenu2.0', 'deleteNotifyArea', {area})
        if (obj.command === 'deleteNotifyArea') {
            const { area } = obj.message || {};
            (async () => {
                const ok = await this.notify.deleteArea(area);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok }, obj.callback);
                }
            })();
            return;
        }

        // Anzeigename für den BEREICH selbst setzen (z. B. "system" -> "Tests") -
        // sendTo('telegrammenu2.0', 'setNotifyAreaLabel', {area, label})
        if (obj.command === 'setNotifyAreaLabel') {
            const { area, label } = obj.message || {};
            (async () => {
                await this.notify.setAreaLabel(area, label);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
                }
            })();
            return;
        }

        // Anzeigename statt technischem Typ (z. B. "priceChange") setzen -
        // sendTo('telegrammenu2.0', 'setNotifyTypeLabel', {area, type, label})
        if (obj.command === 'setNotifyTypeLabel') {
            const { area, type, label } = obj.message || {};
            (async () => {
                await this.notify.setTypeLabel(area, type, label);
                if (obj.callback) {
                    this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
                }
            })();
            return;
        }

        // Notify-Bereiche direkt aus dem Editor-Tab eintragen (grafisch statt
        // Objekte-Editor): sendTo('telegrammenu2.0', 'registerNotifyAreas', { area: ['typ1','typ2'], ... })
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

        // Fängt alles ab, was wir (noch) nicht kennen - z. B. Adapter wie
        // LaundryLens, die telegrammenu2 als "telegram-kompatibel" erkennen und
        // in einem eigenen Format senden. Zeigt im Log genau, was ankommt, damit
        // wir den passenden Handler dafür bauen können, statt zu raten.
        this.log.info(
            `Unbekannter/nicht behandelter Message-Command: "${obj.command}" - Inhalt: ${JSON.stringify(obj.message)}`,
        );
        if (obj.callback) {
            this.sendTo(
                obj.from,
                obj.command,
                { ok: false, error: `Command "${obj.command}" wird noch nicht unterstützt` },
                obj.callback,
            );
        }
    }

    async onUnload(callback) {
        try {
            // Wartende (gebündelte) Nachrichten SOFORT ausliefern statt nur zu
            // verwerfen - sonst geht z. B. der Balkon-Tagesbericht verloren, wenn
            // ein Adapter-Update zufällig genau in die 15-Sekunden-Sammelphase fällt.
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
