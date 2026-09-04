'use strict';

// Simulierter Adapter (kein echter ioBroker-Host nötig) – prüft, ob
// Router + Notify + Registry-Import + Modul-Loader tatsächlich
// zusammenspielen, nicht nur syntaktisch korrekt sind.

const fs = require('fs');
const path = require('path');
const { ensureCoreStates } = require('../core/states');
const { createNotifyEngine } = require('../core/notify');
const { createRouter } = require('../core/base');
const { loadModules } = require('../core/moduleLoader');
const { importRegistry, setMenu } = require('../core/registry');

const store = new Map();
const sentMessages = [];

const fakeAdapter = {
    config: { telegramInstance: 'telegram.0', scriptFolder: 'Telegram', javascriptInstance: 'javascript.5' },
    telegramInstance: 'telegram.0',
    setTimeout: (fn, ms, ...args) => setTimeout(fn, ms, ...args),
    clearTimeout: t => clearTimeout(t),
    log: {
        info: m => console.log('[info]', m),
        warn: m => console.log('[warn]', m),
        error: m => console.log('[error]', m),
        debug: m => console.log('[debug]', m),
    },
    namespace: 'telegrammenu2.0',
    async getObjectAsync(id) {
        const k = `${this.namespace}.${id}`;
        return store.has(`obj:${k}`) ? store.get(`obj:${k}`) : null;
    },
    async setObjectNotExistsAsync(id, obj) {
        const k = `${this.namespace}.${id}`;
        if (!store.has(`obj:${k}`)) {
            store.set(`obj:${k}`, obj);
        }
    },
    async delObjectAsync(id) {
        const k = `${this.namespace}.${id}`;
        store.delete(`obj:${k}`);
        store.delete(`state:${k}`);
    },
    async getStateAsync(id) {
        const k = `${this.namespace}.${id}`;
        return store.has(`state:${k}`) ? store.get(`state:${k}`) : null;
    },
    async getStatesAsync(pattern) {
        // Einfache Glob-Emulation (nur "*" als Wildcard) für Pattern wie "registry.*"
        const prefix = `${this.namespace}.`;
        const regex = new RegExp(`^${pattern.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`);
        const out = {};
        for (const [k, v] of store.entries()) {
            if (!k.startsWith('state:')) {
                continue;
            }
            const id = k.slice('state:'.length);
            if (!id.startsWith(prefix)) {
                continue;
            }
            const rel = id.slice(prefix.length);
            if (regex.test(rel)) {
                out[id] = v;
            }
        }
        return out;
    },
    async getForeignStateAsync(id) {
        return store.has(`state:${id}`) ? store.get(`state:${id}`) : null;
    },
    async setStateAsync(id, val) {
        const k = `${this.namespace}.${id}`;
        store.set(`state:${k}`, val);
        return val;
    },
    async setForeignStateAsync(id, val) {
        store.set(`state:${id}`, val);
        return val;
    },
    async subscribeForeignStatesAsync(_pattern) {
        /* no-op im Test - kein echter Subscription-Mechanismus nötig */
    },
    async subscribeStatesAsync(_pattern) {
        /* no-op im Test */
    },
    async sendToAsync(instance, payload) {
        sentMessages.push({ instance, payload });
    },
    sendTo(instance, command, message, callback) {
        // Simuliert javascript.X 'toScript': das Test-Skript "antwortet" hier direkt.
        if (instance === this.config.javascriptInstance && command === 'toScript') {
            if (
                message.script === 'script.js.Test.respond' ||
                message.script === 'script.js.Telegram.mod_shortname_test'
            ) {
                callback({ text: `Antwort vom simulierten Skript für ${message.message}` });
            } else if (message.script === 'script.js.Test.htmlrespond') {
                callback({ text: '<b>Fett</b> aus dem Skript', html: true });
            } else if (message.script === 'script.js.Test.noPreviewRespond') {
                callback({ text: 'https://maps.apple.com/?q=Test', noPreview: true });
            } else if (message.script === 'script.js.Test.timeout') {
                // absichtlich nie callback() aufrufen, um den Timeout-Pfad zu testen
            } else {
                callback(null);
            }
        }
    },
};

async function run() {
    await ensureCoreStates(fakeAdapter);

    const notifyEngine = createNotifyEngine(fakeAdapter);
    fakeAdapter.notify = (a, t, x, e) => notifyEngine.send(a, t, x, e);
    fakeAdapter.notify.registerAreas = notifyEngine.registerAreas;
    fakeAdapter._flushAllPendingNotify = notifyEngine.flushAllPending;
    fakeAdapter.notify.pauseArea = notifyEngine.pauseArea;
    fakeAdapter.notify.unpauseArea = notifyEngine.unpauseArea;
    fakeAdapter.notify.isAreaPaused = notifyEngine.isAreaPaused;
    fakeAdapter.notify.getAreaPausedUntil = notifyEngine.getAreaPausedUntil;
    fakeAdapter.notify.getValidAreas = notifyEngine.getValidAreas;
    fakeAdapter.notify.getPendingAreas = notifyEngine.getPendingAreas;
    fakeAdapter.notify.approveArea = notifyEngine.approveArea;
    fakeAdapter.notify.setOverride = notifyEngine.setOverride;
    fakeAdapter.notify.isOverride = notifyEngine.isOverride;
    fakeAdapter.notify.setTypeLabel = notifyEngine.setTypeLabel;
    fakeAdapter.notify.getLabel = notifyEngine.getLabel;
    fakeAdapter.notify.setAreaLabel = notifyEngine.setAreaLabel;
    fakeAdapter.notify.getAreaLabel = notifyEngine.getAreaLabel;
    fakeAdapter.notify.deleteArea = notifyEngine.deleteArea;
    fakeAdapter._clearNotifyTimers = notifyEngine.clearTimers;
    fakeAdapter.notify.getAllAreasFull = notifyEngine.getAllAreasFull;
    await notifyEngine.init();

    const { createScriptBridge } = require('../core/scriptBridge');
    fakeAdapter.scriptBridge = createScriptBridge(fakeAdapter);
    await fakeAdapter.scriptBridge.init();

    fakeAdapter.router = createRouter(fakeAdapter);
    fakeAdapter.modules = await loadModules(fakeAdapter);
    console.log(
        'Module geladen:',
        fakeAdapter.modules.map(m => m.id),
    );

    // Frischer Zustand wie nach Neuinstallation: KEIN manueller Import.
    // main.js würde hier automatisch defaultRegistry importieren.
    const defaultRegistry = require('../core/defaultRegistry');
    const existingMenus = await require('../core/registry').listMenuKeys(fakeAdapter);
    if (!existingMenus.length) {
        await importRegistry(fakeAdapter, defaultRegistry);
        console.log('Standard-Registry automatisch importiert (frische Installation simuliert)');
    }

    // Simuliert den Admin-Bootstrap: dieser Test-Nutzer gilt als bereits manuell
    // freigeschaltet, damit die BESTEHENDEN Menü-/Rechte-Tests unten unverändert
    // funktionieren. Das neue Freischalt-Gate für frische Nutzer wird weiter
    // unten separat mit einer eigenen Chat-ID getestet.
    await fakeAdapter.setObjectNotExistsAsync('users.123456.approved', {
        type: 'state',
        common: { name: 'approved', type: 'boolean', role: 'indicator', read: true, write: true },
        native: {},
    });
    await fakeAdapter.setStateAsync('users.123456.approved', { val: true, ack: true });

    await fakeAdapter.router.handleIncoming('[123456] /start');
    console.log('--- gesendete Nachrichten nach /start (frische Installation, kein manueller Import) ---');
    console.log(JSON.stringify(sentMessages.at(-1), null, 2));
    if (!sentMessages.at(-1)?.payload?.reply_markup?.keyboard?.flat().includes('⚙️ Settings')) {
        throw new Error('Standard-Hauptmenü (⚙️ Settings) fehlt nach frischer Installation!');
    }

    const registryJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'registryExample.json'), 'utf8'));
    const imported = await importRegistry(fakeAdapter, registryJson);
    console.log('Vollständige Registry zusätzlich importiert:', imported);

    // Simuliert eingehende Telegram-Nachricht: neuer Nutzer, /start
    await fakeAdapter.router.handleIncoming('[123456] /start');
    console.log('--- gesendete Nachrichten nach /start (frischer Nutzer, keine Rechte) ---');
    console.log(JSON.stringify(sentMessages.at(-1), null, 2));

    // Admin gibt sich selbst alle Rechte (das würde später die Benutzerverwaltung übernehmen)
    await fakeAdapter.setStateAsync('users.123456.role', { val: 'admin', ack: true });
    await fakeAdapter.setStateAsync('users.123456.permissions.weather', { val: true, ack: true });
    await fakeAdapter.setStateAsync('users.123456.permissions.vacuum', { val: true, ack: true });
    await fakeAdapter.setStateAsync('users.123456.permissions.vacuumControl', { val: true, ack: true });
    await fakeAdapter.setStateAsync('users.123456.permissions.settings', { val: true, ack: true });
    await fakeAdapter.setStateAsync('0_userdata.0.Vacuum.status', { val: 'error', ack: true }).catch(() => {});

    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] /start');
    console.log('--- gesendete Nachrichten nach /start (mit Rechten, Status-Icon "error") ---');
    console.log(JSON.stringify(sentMessages.at(-1), null, 2));

    // Simuliert Klick auf "🌤️ Weather" (Nachricht-Template mit {{datapunkt.id}}-Platzhaltern)
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 🌤️ Weather');
    console.log('--- gesendete Nachrichten nach Klick "Weather" ---');
    console.log(JSON.stringify(sentMessages.at(-1), null, 2));

    // Simuliert Klick auf "👤 Users" (Auto-Menü, source=users)
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] /menu');
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 👤 Users');
    console.log('--- gesendete Nachrichten nach Klick "Users" (Auto-Menü) ---');
    console.log(JSON.stringify(sentMessages.at(-1), null, 2));

    // Klick auf einen Command, für den es weder Modul noch Skript gibt -> darf
    // nicht abstürzen und schickt (mangels Legacy-Bridge) einfach nichts.
    sentMessages.length = 0;
    await fakeAdapter.router.dispatchCommand('TG:VACUUM:START', '', '123456', '123456');
    console.log('--- Unbehandelter Command (kein Modul/Skript) - darf nicht abstürzen ---', sentMessages.length);

    // Nutzer-Detail öffnen (Klick auf "👑 123456" im Auto-Menü "Users")
    sentMessages.length = 0;
    await fakeAdapter.router.dispatchCommand('TG:ADMIN:USER:123456', '', '123456', '123456');
    console.log('--- Nutzer-Detail nach Öffnen ---');
    console.log(JSON.stringify(sentMessages.at(-1)?.payload?.reply_markup?.keyboard, null, 2));

    // Ein Recht antippen (z. B. "⬜ balcony" -> sollte auf ✅ wechseln)
    await fakeAdapter.router.dispatchCommand('TG:ADMIN:USER:123456:TOGGLE:balcony', '', '123456', '123456');
    const permAfter = await fakeAdapter.getStateAsync('users.123456.permissions.balcony');
    console.log('--- users.123456.permissions.balcony nach Toggle ---', permAfter);
    if (permAfter?.val !== true) {
        throw new Error('Rechte-Toggle hat nicht geschrieben!');
    }

    // Ab hier testen wir Zustellungs-Zeitpunkt/Präferenzen - dafür müssen
    // "priceChange" und "irgendwas" von der NEUEN Standard-Bündelung (alles
    // außer warn/error) ausgenommen werden, sonst verzögert das diese
    // Timing-unabhängigen Tests künstlich. Einmal zentral hier festgelegt.
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Test',
        groupableExcludeTypes: ['warn', 'error', 'priceChange', 'irgendwas'],
        rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]],
    });

    // notify(): Recht vorhanden, aber Benachrichtigung explizit abgeschaltet -> keine Nachricht
    await fakeAdapter.setStateAsync('users.123456.chatId', { val: '123456', ack: true });
    await fakeAdapter.notify.registerAreas('weather_test', { weather: ['priceChange'] });
    await fakeAdapter.setStateAsync('users.123456.notify.weather.priceChange', { val: false, ack: true });
    sentMessages.length = 0;
    await fakeAdapter.notify('weather', 'priceChange', 'Sollte NICHT ankommen');
    console.log('--- notify() mit abgeschalteter Präferenz, gesendete Nachrichten ---', sentMessages.length);
    if (sentMessages.length !== 0) {
        throw new Error('notify() hat trotz abgeschalteter Präferenz gesendet!');
    }

    // Präferenz wieder an -> Nachricht kommt an
    await fakeAdapter.setStateAsync('users.123456.notify.weather.priceChange', { val: true, ack: true });
    sentMessages.length = 0;
    await fakeAdapter.notify('weather', 'priceChange', 'Sollte ankommen');
    console.log('--- notify() mit eingeschalteter Präferenz, gesendete Nachrichten ---', sentMessages.length);
    if (sentMessages.length !== 1) {
        throw new Error('notify() hat trotz eingeschalteter Präferenz NICHT gesendet!');
    }

    // Automatische Bereichs-Registrierung: völlig neuer, nie angemeldeter Bereich
    const areasBefore = fakeAdapter.notify.getValidAreas();
    console.log('--- Bereiche VOR erstem Aufruf ---', Object.keys(areasBefore));
    if (areasBefore.spontanBereich) {
        throw new Error('Bereich existierte schon vor dem ersten Aufruf - Test unbrauchbar');
    }

    await fakeAdapter.notify('spontanBereich', 'irgendwas', 'Testnachricht für automatische Registrierung');

    // Automatisch entdeckt, aber NOCH NICHT freigeschaltet -> darf nicht in getValidAreas() auftauchen
    const areasAfterDiscovery = fakeAdapter.notify.getValidAreas();
    console.log(
        '--- getValidAreas() nach Auto-Entdeckung (sollte spontanBereich NICHT enthalten) ---',
        Object.keys(areasAfterDiscovery),
    );
    if (areasAfterDiscovery.spontanBereich) {
        throw new Error('Unfreigeschalteter Bereich taucht fälschlich in getValidAreas() auf!');
    }

    const pending = fakeAdapter.notify.getPendingAreas();
    console.log('--- getPendingAreas() ---', Object.keys(pending));
    if (!pending.spontanBereich) {
        throw new Error('Bereich fehlt in getPendingAreas()!');
    }

    const persistedState = await fakeAdapter.getStateAsync('notify.areas');
    const persisted = JSON.parse(persistedState?.val || '{}');
    console.log('--- Persistierter State telegrammenu2.0.notify.areas ---', persisted);
    if (!persisted.spontanBereich) {
        throw new Error('Bereich wurde nicht in notify.areas persistiert!');
    }

    // Nachricht an unfreigeschalteten Bereich darf trotz Recht NICHT ankommen
    await fakeAdapter.setStateAsync('users.123456.permissions.spontanBereich', { val: true, ack: true });
    sentMessages.length = 0;
    await fakeAdapter.notify('spontanBereich', 'irgendwas', 'Sollte nicht ankommen, weil nicht freigeschaltet');
    console.log('--- Nachrichten an unfreigeschalteten Bereich ---', sentMessages.length);
    if (sentMessages.length !== 0) {
        throw new Error('Unfreigeschalteter Bereich hat trotzdem zugestellt!');
    }

    // Nach Freischaltung kommt es an und taucht in der Liste auf
    await fakeAdapter.notify.approveArea('spontanBereich');
    sentMessages.length = 0;
    await fakeAdapter.notify('spontanBereich', 'irgendwas', 'Sollte jetzt ankommen');
    console.log('--- Nachrichten nach Freischaltung ---', sentMessages.length);
    if (sentMessages.length !== 1) {
        throw new Error('Freigeschalteter Bereich liefert nicht zu!');
    }

    // Override: Präferenz ausgeschaltet -> normalerweise blockiert, mit Override trotzdem zugestellt
    await fakeAdapter.setStateAsync('users.123456.notify.spontanBereich.irgendwas', { val: false, ack: true });
    sentMessages.length = 0;
    await fakeAdapter.notify('spontanBereich', 'irgendwas', 'Ohne Override sollte das blockiert sein');
    console.log('--- Nachrichten trotz ausgeschalteter Präferenz (kein Override) ---', sentMessages.length);
    if (sentMessages.length !== 0) {
        throw new Error('Ausgeschaltete Präferenz wurde ignoriert (sollte blockieren)!');
    }

    await fakeAdapter.notify.setOverride('spontanBereich', 'irgendwas', true);
    sentMessages.length = 0;
    await fakeAdapter.notify('spontanBereich', 'irgendwas', 'Mit Override sollte das ankommen');
    console.log('--- Nachrichten trotz ausgeschalteter Präferenz (MIT Override) ---', sentMessages.length);
    if (sentMessages.length !== 1) {
        throw new Error('Override hat die ausgeschaltete Präferenz nicht überschrieben!');
    }

    // Präferenz wieder an, damit nachfolgende Sichtbarkeits-Checks (Admin-Liste,
    // Bereichsname) diese Zeile normal sehen - Override-Sichtbarkeits-Check kommt weiter unten isoliert.
    await fakeAdapter.setStateAsync('users.123456.notify.spontanBereich.irgendwas', { val: true, ack: true });
    await fakeAdapter.notify.setOverride('spontanBereich', 'irgendwas', false);

    // Admin soll freigeschaltete Benachrichtigungs-Bereiche sehen, auch ohne explizites permissions.<area>
    await fakeAdapter.setStateAsync('users.123456.permissions.spontanBereich', { val: false, ack: true });
    const { buildAutoRows } = require('../core/autoMenus');
    const notifyRows = await buildAutoRows(fakeAdapter, { source: 'notifyPrefs' }, '123456');
    const notifyTexts = notifyRows.flat().map(b => b.text);
    console.log('--- Benachrichtigungen-Liste für Admin ---', notifyTexts);
    if (!notifyTexts.some(t => t.includes('spontanBereich') || t.includes('Weather'))) {
        throw new Error('Admin sieht Bereich ohne explizites Recht nicht - Fix hat nicht gegriffen!');
    }

    // Anzeigename statt technischem Typ
    await fakeAdapter.notify.setTypeLabel('weather', 'priceChange', 'Preisänderung');
    const notifyRows2 = await buildAutoRows(fakeAdapter, { source: 'notifyPrefs' }, '123456');
    const notifyTexts2 = notifyRows2.flat().map(b => b.text);
    console.log('--- Benachrichtigungen-Liste mit Anzeigename ---', notifyTexts2);
    if (!notifyTexts2.some(t => t.includes('Preisänderung'))) {
        throw new Error('Anzeigename wurde nicht verwendet!');
    }
    if (notifyTexts2.some(t => t.includes('priceChange'))) {
        throw new Error('Roher Typ-Name taucht trotz Label noch auf!');
    }

    // Bereichsname überschreiben (z. B. "system" -> "Tests")
    await fakeAdapter.notify.setAreaLabel('spontanBereich', 'Testbereich');
    const notifyRows3 = await buildAutoRows(fakeAdapter, { source: 'notifyPrefs' }, '123456');
    const notifyTexts3 = notifyRows3.flat().map(b => b.text);
    console.log('--- Benachrichtigungen-Liste mit Bereichsname ---', notifyTexts3);
    if (!notifyTexts3.some(t => t.includes('Testbereich'))) {
        throw new Error('Bereichsname wurde nicht verwendet!');
    }

    // Voller Datensatz enthält alles, was gesetzt wurde
    await fakeAdapter.notify.setOverride('spontanBereich', 'irgendwas', true);
    const full = fakeAdapter.notify.getAllAreasFull();
    console.log('--- getAllAreasFull() für spontanBereich ---', full.spontanBereich);
    if (full.spontanBereich.areaLabel !== 'Testbereich') {
        throw new Error('areaLabel fehlt in getAllAreasFull()!');
    }
    if (!full.spontanBereich.override.includes('irgendwas')) {
        throw new Error('override fehlt in getAllAreasFull()!');
    }

    // Override-Typ darf im Menü gar nicht erst auftauchen (Override ist gerade aktiv)
    const rowsWithOverride = await buildAutoRows(fakeAdapter, { source: 'notifyPrefs' }, '123456');
    const textsWithOverride = rowsWithOverride.flat().map(b => b.text);
    console.log('--- Menü mit Override-Typ (sollte "irgendwas" NICHT enthalten) ---', textsWithOverride);
    if (textsWithOverride.some(t => t.includes('irgendwas'))) {
        throw new Error('Override-Typ taucht trotzdem im Menü auf!');
    }

    // Löschen entfernt den Bereich wirklich, nicht nur aus der Sichtliste
    const deleted = await fakeAdapter.notify.deleteArea('spontanBereich');
    console.log('--- deleteArea() Ergebnis ---', deleted);
    if (!deleted) {
        throw new Error('deleteArea() meldet Fehlschlag!');
    }
    const fullAfterDelete = fakeAdapter.notify.getAllAreasFull();
    if (fullAfterDelete.spontanBereich) {
        throw new Error('Bereich existiert nach deleteArea() immer noch!');
    }

    // --- Vordefinierte Submenüs: Prozent-Stufen ---
    await fakeAdapter.setForeignStateAsync('0_userdata.0.TestRollo', { val: 40, ack: true });
    const percentRows = await buildAutoRows(
        fakeAdapter,
        { source: 'percentRange', datapoint: '0_userdata.0.TestRollo', step: 20, rowLength: 3 },
        '123456',
    );
    const percentTexts = percentRows.flat().map(b => b.text);
    console.log('--- Prozent-Stufen (Schritt 20, aktuell 40) ---', percentTexts);
    if (!percentTexts.includes('0%') || !percentTexts.includes('100%')) {
        throw new Error('Prozent-Range hat nicht 0-100 erzeugt!');
    }
    if (!percentTexts.includes('✅ 40%')) {
        throw new Error('Aktueller Wert (40%) wurde nicht mit ✅ markiert!');
    }
    if (percentTexts.filter(t => t.startsWith('✅')).length !== 1) {
        throw new Error('Mehr als ein Wert wurde als aktuell markiert!');
    }
    if (percentTexts.some(t => t.includes('Zurück') || t.includes('Hauptmenü'))) {
        throw new Error(
            'Prozent-Stufen-Menü hat noch Zurück/Hauptmenü-Buttons - die wurden bewusst entfernt (Bestätigung springt direkt zurück)!',
        );
    }
    // rowLength: 3 -> erste Zeile hat 3 Buttons (0,20,40)
    if (percentRows[0].length !== 3) {
        throw new Error('rowLength wurde bei Prozent-Stufen nicht beachtet!');
    }

    // --- Vordefinierte Submenüs: Zahlenbereich mit Schritt+Einheit (auch absteigend) ---
    await fakeAdapter.setForeignStateAsync('0_userdata.0.TestSoll', { val: 24, ack: true });
    const numberRows = await buildAutoRows(
        fakeAdapter,
        {
            source: 'numberRange',
            datapoint: '0_userdata.0.TestSoll',
            min: 16,
            max: 28,
            step: 4,
            unit: '°C',
            rowLength: 4,
        },
        '123456',
    );
    const numberTexts = numberRows.flat().map(b => b.text);
    console.log('--- Zahlenbereich 16-28°C Schritt 4 (aktuell 24°C) ---', numberTexts);
    if (!numberTexts.includes('16°C') || !numberTexts.includes('28°C')) {
        throw new Error('Zahlenbereich hat nicht die erwarteten Grenzwerte erzeugt!');
    }
    if (!numberTexts.includes('✅ 24°C')) {
        throw new Error('Aktueller Wert (24°C) wurde nicht markiert!');
    }

    const numberRowsDesc = await buildAutoRows(
        fakeAdapter,
        { source: 'numberRange', datapoint: '0_userdata.0.TestSoll', min: 28, max: 16, step: 4, unit: '°C' },
        '123456',
    );
    const numberTextsDesc = numberRowsDesc.flat().map(b => b.text);
    console.log('--- Zahlenbereich absteigend 28->16 ---', numberTextsDesc);
    if (numberTextsDesc[0] !== '28°C') {
        throw new Error('Absteigender Zahlenbereich beginnt nicht beim höheren Wert!');
    }

    // --- TG:VALSET: schreibt den Wert und springt DIREKT ins Elternmenü mit
    // Bestätigungstext, statt das Inline-Menü erneut zu zeigen ---
    await setMenu(fakeAdapter, 'test_percent_menu', {
        title: 'Rollo',
        source: 'percentRange',
        datapoint: '0_userdata.0.TestRollo',
        step: 20,
        parent: 'main',
    });
    await fakeAdapter.setStateAsync('runtime.currentMenu', { val: 'test_percent_menu', ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.dispatchCommand('TG:VALSET:test_percent_menu|60', '', '123456', '123456');
    const rolloState = await fakeAdapter.getForeignStateAsync('0_userdata.0.TestRollo');
    console.log('--- TG:VALSET: Datenpunkt nach Aufruf ---', rolloState?.val, '| ack ---', rolloState?.ack);
    if (rolloState?.val !== 60) {
        throw new Error('TG:VALSET: hat den Wert nicht auf den Datenpunkt geschrieben!');
    }
    if (rolloState?.ack !== false) {
        throw new Error('TG:VALSET: hätte mit ack:false schreiben müssen!');
    }
    const afterSetMsg = sentMessages.at(-1);
    console.log(
        '--- Nach TG:VALSET: Text/Tastatur ---',
        afterSetMsg?.payload?.text,
        '| inline_keyboard? ---',
        !!afterSetMsg?.payload?.reply_markup?.inline_keyboard,
    );
    if (afterSetMsg?.payload?.text !== '✅ 60% gesetzt.') {
        throw new Error('TG:VALSET: Standard-Bestätigungstext ("✅ 60% gesetzt.") stimmt nicht!');
    }
    if (afterSetMsg?.payload?.reply_markup?.inline_keyboard) {
        throw new Error('TG:VALSET: Bestätigung landet fälschlich wieder im Inline-Menü statt im Elternmenü (main)!');
    }
    const currentMenuAfterSet = await fakeAdapter.getStateAsync('runtime.currentMenu');
    if (currentMenuAfterSet?.val !== 'main') {
        throw new Error('TG:VALSET: currentMenu wurde nicht auf das Elternmenü ("main") gesetzt!');
    }

    // Frei wählbarer Bestätigungstext mit {value}/{unit}-Platzhaltern
    await setMenu(fakeAdapter, 'test_number_menu_msg', {
        title: 'Solltemp',
        source: 'numberRange',
        datapoint: '0_userdata.0.TestSoll',
        unit: '°C',
        confirmMessage: '🌡️ Solltemperatur auf {value}{unit} gestellt.',
        parent: 'main',
    });
    await fakeAdapter.setStateAsync('runtime.currentMenu', { val: 'test_number_menu_msg', ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.dispatchCommand('TG:VALSET:test_number_menu_msg|22', '', '123456', '123456');
    const customMsgResult = sentMessages.at(-1);
    console.log('--- TG:VALSET mit eigenem Bestätigungstext ---', customMsgResult?.payload?.text);
    if (customMsgResult?.payload?.text !== '🌡️ Solltemperatur auf 22°C gestellt.') {
        throw new Error('TG:VALSET hat den frei wählbaren Bestätigungstext ({value}/{unit}) nicht korrekt aufgelöst!');
    }

    // Regression: normales Öffnen des Menüs (renderMenu OHNE customText, wie
    // beim Draufteppen auf den Reply-Keyboard-Button) darf NICHT die
    // confirmMessage mit unaufgelösten {value}/{unit}-Platzhaltern zeigen -
    // genau das war der gemeldete Bug (confirmMessage wurde fälschlich auch
    // als normaler Menü-Titel benutzt).
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'test_number_menu_msg');
    const plainOpenMsg = sentMessages.at(-1);
    console.log('--- Normales Öffnen des Menüs (kein VALSET) ---', plainOpenMsg?.payload?.text);
    if (plainOpenMsg?.payload?.text?.includes('{value}') || plainOpenMsg?.payload?.text?.includes('{unit}')) {
        throw new Error(
            'Normales Öffnen des Menüs zeigt unaufgelöste {value}/{unit}-Platzhalter aus confirmMessage - Bug ist zurück!',
        );
    }

    // --- Derselbe Ablauf, aber END-TO-END über handleIncoming() statt direkt
    // über dispatchCommand() - genau der Weg, den ein echter Tastendruck auf
    // einen Inline-Button nimmt (callback_data kommt über denselben
    // "[chatId]cmd"-Kanal wie normaler Text). Ein Bug hier wurde vom obigen
    // direkten dispatchCommand()-Test NICHT erkannt, weil der die
    // handleIncoming-Routing-Logik komplett umgeht. ---
    await fakeAdapter.setStateAsync('runtime.currentMenu', { val: 'test_percent_menu', ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456]TG:VALSET:test_percent_menu|80');
    const rolloStateE2E = await fakeAdapter.getForeignStateAsync('0_userdata.0.TestRollo');
    console.log('--- TG:VALSET über handleIncoming(): Datenpunkt ---', rolloStateE2E?.val);
    if (rolloStateE2E?.val !== 80) {
        throw new Error('TG:VALSET über handleIncoming() (echter Inline-Button-Tap) hat NICHT funktioniert!');
    }
    const e2eMsg = sentMessages.at(-1);
    if (e2eMsg?.payload?.text?.includes('Unbekannter Befehl')) {
        throw new Error(
            'handleIncoming() hat den Inline-Button-Tap als "Unbekannter Befehl" abgelehnt statt an dispatchCommand weiterzuleiten!',
        );
    }

    // Ungültiger Menü-Schlüssel -> kein Crash, sauber ignoriert
    await fakeAdapter.router.dispatchCommand('TG:VALSET:nicht_vorhanden|60', '', '123456', '123456');

    // --- TG:VALCUSTOM: startet den Ziffernblock für einen freien Wert, landet
    // nach "✅ Fertig" ebenfalls direkt im Elternmenü mit Bestätigung ---
    // (über handleIncoming, wie ein echter Inline-Button-Tap - siehe Kommentar
    // beim TG:VALSET-Test oben, warum das wichtig ist)
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456]TG:VALCUSTOM:test_percent_menu');
    const numpadModeState = await fakeAdapter.getStateAsync('runtime.inputMode');
    console.log('--- TG:VALCUSTOM: inputMode nach Aufruf ---', numpadModeState?.val);
    if (numpadModeState?.val !== 'datapoint_numpad') {
        throw new Error('TG:VALCUSTOM hat nicht den Ziffernblock-Eingabemodus gestartet!');
    }
    const numpadCtx = JSON.parse((await fakeAdapter.getStateAsync('runtime.inputContext'))?.val || '{}');
    if (numpadCtx.datapoint !== '0_userdata.0.TestRollo') {
        throw new Error('TG:VALCUSTOM hat den falschen Datenpunkt im Eingabekontext hinterlegt!');
    }
    if (numpadCtx.menuKey !== 'main') {
        throw new Error('TG:VALCUSTOM hat nicht das Elternmenü ("main") als Rücksprungziel hinterlegt!');
    }
    const numpadMsg = sentMessages.at(-1);
    console.log('--- TG:VALCUSTOM: Ziffernblock-Prompt ---', numpadMsg?.payload?.text);
    if (!numpadMsg?.payload?.reply_markup?.keyboard) {
        throw new Error('TG:VALCUSTOM hat keinen Ziffernblock (normale Tastatur) geschickt!');
    }

    // Freitext-Eingabe über den Ziffernblock abschließen (Ziffern + Bestätigen)
    // und prüfen, dass der Wert wirklich geschrieben UND im Elternmenü mit
    // Bestätigung ("{value}" aufgelöst) gelandet wird.
    for (const digit of ['3', '5']) {
        await fakeAdapter.router.handleIncoming(`[123456] ${digit}`);
    }
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] ✅ Fertig');
    const rolloStateAfterNumpad = await fakeAdapter.getForeignStateAsync('0_userdata.0.TestRollo');
    console.log('--- TG:VALCUSTOM: Datenpunkt nach Ziffernblock-Eingabe "35" ---', rolloStateAfterNumpad?.val);
    if (rolloStateAfterNumpad?.val !== 35) {
        throw new Error('TG:VALCUSTOM hat den per Ziffernblock eingegebenen Wert nicht korrekt geschrieben!');
    }
    const numpadConfirmMsg = sentMessages.at(-1);
    console.log('--- TG:VALCUSTOM: Bestätigung nach Eingabe ---', numpadConfirmMsg?.payload?.text);
    if (numpadConfirmMsg?.payload?.text !== '✅ 35% gesetzt.') {
        throw new Error('TG:VALCUSTOM hat den Standard-Bestätigungstext ({value}/{unit}) nicht korrekt aufgelöst!');
    }

    // --- Berechtigungsprüfung: Menü mit perm gesetzt darf ein Nutzer OHNE
    // diese Berechtigung nicht per (ggf. selbst gebautem) TG:VALSET-Aufruf
    // umgehen - der Direkt-Dispatch-Weg läuft an findButtonByText() vorbei,
    // das die Prüfung sonst automatisch übernommen hätte.
    await setMenu(fakeAdapter, 'test_percent_menu_admin', {
        title: 'Admin-Only Rollo',
        source: 'percentRange',
        datapoint: '0_userdata.0.TestRolloAdmin',
        perm: 'admin',
        parent: 'main',
    });
    const { key: unprivKey } = await require('../core/users').ensureUser(fakeAdapter, '333333');
    await fakeAdapter.setStateAsync(`users.${unprivKey}.approved`, { val: true, ack: true });
    await fakeAdapter.setStateAsync(`users.${unprivKey}.role`, { val: 'guest', ack: true });
    await fakeAdapter.router.handleIncoming('[333333]TG:VALSET:test_percent_menu_admin|50');
    const adminRolloState = await fakeAdapter.getForeignStateAsync('0_userdata.0.TestRolloAdmin');
    console.log('--- TG:VALSET auf perm="admin"-Menü von nicht-privilegiertem Nutzer ---', adminRolloState);
    if (adminRolloState) {
        throw new Error(
            'TG:VALSET hat die Menü-Berechtigung (perm) nicht durchgesetzt - unprivilegierter Nutzer konnte schreiben!',
        );
    }

    // Registry-Menü gezielt löschen (Sync-Delete beim Speichern) - Demo-Menü
    // simulieren, das nicht mehr im Graphen ist, aber noch im Index steht
    const { deleteMenus, listMenuKeys: listMenuKeysCheck } = require('../core/registry');
    const beforeDelete = await listMenuKeysCheck(fakeAdapter);
    console.log('--- Registry-Menüs vor gezieltem Löschen ---', beforeDelete);
    const removedMenus = await deleteMenus(fakeAdapter, ['test_menu']);
    console.log('--- Gezielt entfernte Menüs ---', removedMenus);
    const afterDelete = await listMenuKeysCheck(fakeAdapter);
    console.log('--- Registry-Menüs nach gezieltem Löschen ---', afterDelete);
    if (afterDelete.includes('test_menu')) {
        throw new Error('test_menu wurde nicht aus dem Index entfernt!');
    }
    if (!afterDelete.includes('main')) {
        throw new Error('main wurde fälschlich mit entfernt!');
    }
    const testMenuState = await fakeAdapter.getStateAsync('registry.test_menu');
    if (testMenuState) {
        throw new Error('registry.test_menu-State existiert nach Löschen noch!');
    }

    // Skript-Bridge: Skript meldet sich an, Command wird direkt per onMessage/callback beantwortet
    await fakeAdapter.scriptBridge.register('TG:TESTSCRIPT', 'script.js.Test.respond');
    sentMessages.length = 0;
    await fakeAdapter.router.dispatchCommand('TG:TESTSCRIPT:SHOW', '', '123456', '123456');
    console.log('--- Antwort über Skript-Bridge ---', sentMessages.at(-1)?.payload?.text);
    if (!sentMessages.at(-1)?.payload?.text?.includes('TG:TESTSCRIPT:SHOW')) {
        throw new Error('Skript-Bridge hat nicht wie erwartet geantwortet!');
    }

    // Skript-Callback mit html:true -> parse_mode:'HTML' muss beim Versand gesetzt werden
    await fakeAdapter.scriptBridge.register('TG:HTMLTEST', 'script.js.Test.htmlrespond');
    sentMessages.length = 0;
    await fakeAdapter.router.dispatchCommand('TG:HTMLTEST:SHOW', '', '123456', '123456');
    const htmlCallbackMsg = sentMessages.at(-1);
    console.log(
        '--- Skript-Callback mit html:true: parse_mode ---',
        htmlCallbackMsg?.payload?.parse_mode,
        '|',
        htmlCallbackMsg?.payload?.text,
    );
    if (htmlCallbackMsg?.payload?.parse_mode !== 'HTML') {
        throw new Error('Skript-Callback mit html:true hat parse_mode nicht gesetzt!');
    }
    if (!htmlCallbackMsg?.payload?.text?.includes('<b>Fett</b>')) {
        throw new Error('HTML-Text aus dem Skript kam nicht unverändert an!');
    }

    // Skript-Callback mit noPreview:true -> disable_web_page_preview muss gesetzt werden
    await fakeAdapter.scriptBridge.register('TG:NOPREVIEWTEST', 'script.js.Test.noPreviewRespond');
    sentMessages.length = 0;
    await fakeAdapter.router.dispatchCommand('TG:NOPREVIEWTEST:SHOW', '', '123456', '123456');
    const noPreviewCallbackMsg = sentMessages.at(-1);
    console.log(
        '--- Skript-Callback mit noPreview:true: disable_web_page_preview ---',
        noPreviewCallbackMsg?.payload?.disable_web_page_preview,
    );
    if (noPreviewCallbackMsg?.payload?.disable_web_page_preview !== true) {
        throw new Error('Skript-Callback mit noPreview:true hat disable_web_page_preview nicht gesetzt!');
    }

    // Skript-Bridge mit Recht: ohne Berechtigung wird das Skript gar nicht erst aufgerufen
    await fakeAdapter.scriptBridge.register('TG:SECURETEST', 'script.js.Test.respond', 'secureArea');
    sentMessages.length = 0;
    await fakeAdapter.router.dispatchCommand('TG:SECURETEST:SHOW', '', '123456', '123456');
    console.log('--- Skript-Bridge ohne Recht ---', sentMessages.at(-1)?.payload?.text);
    if (!sentMessages.at(-1)?.payload?.text?.includes('Keine Berechtigung')) {
        throw new Error('Skript-Bridge hat Rechteprüfung nicht durchgesetzt!');
    }
    await fakeAdapter.setStateAsync('users.123456.permissions.secureArea', { val: true, ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.dispatchCommand('TG:SECURETEST:SHOW', '', '123456', '123456');
    console.log('--- Skript-Bridge MIT Recht ---', sentMessages.at(-1)?.payload?.text);
    if (!sentMessages.at(-1)?.payload?.text?.includes('TG:SECURETEST:SHOW')) {
        throw new Error('Skript-Bridge hat trotz Recht nicht geantwortet!');
    }

    // Skript antwortet nicht -> fällt sauber auf Legacy-Bridge zurück, kein Hänger
    await fakeAdapter.scriptBridge.register('TG:TIMEOUTTEST', 'script.js.Test.timeout');
    const timeoutStart = Date.now();
    await fakeAdapter.router.dispatchCommand('TG:TIMEOUTTEST:SHOW', '', '123456', '123456');
    console.log(
        '--- Skript-Bridge-Timeout-Test abgeschlossen nach',
        Date.now() - timeoutStart,
        'ms (Fallback griff) ---',
    );

    // Neuer Weg: Button hat scriptId direkt gesetzt (im Editor konfiguriert),
    // keine Skript-Selbstanmeldung nötig - handleIncoming ruft direkt auf.
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [[{ text: '⛽ Direkt-Skript-Test', cmd: 'TG:DIRECTSCRIPT:SHOW', scriptId: 'script.js.Test.respond' }]],
    });
    await fakeAdapter.setStateAsync('runtime.currentMenu', { val: 'main', ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] ⛽ Direkt-Skript-Test');
    console.log('--- Direkte Skript-Zuordnung (kein Anmelde-Aufruf nötig) ---', sentMessages.at(-1)?.payload?.text);
    if (!sentMessages.at(-1)?.payload?.text?.includes('TG:DIRECTSCRIPT:SHOW')) {
        throw new Error('Direkte Skript-Zuordnung aus dem Button hat nicht funktioniert!');
    }

    // Kurzname statt voller ID: "mod_shortname_test" -> script.js.Telegram.mod_shortname_test,
    // auf der in der Config hinterlegten JS-Instanz (javascript.5, nicht hartkodiert javascript.0)
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [[{ text: '🧩 Kurzname-Test', cmd: 'TG:SHORTNAME:SHOW', scriptId: 'mod_shortname_test' }]],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 🧩 Kurzname-Test');
    console.log(
        '--- Kurzname-Auflösung (script.js.Telegram.mod_shortname_test, javascript.5) ---',
        sentMessages.at(-1)?.payload?.text,
    );
    if (!sentMessages.at(-1)?.payload?.text?.includes('TG:SHORTNAME:SHOW')) {
        throw new Error('Kurzname-Auflösung hat nicht funktioniert!');
    }

    // Datenpunkt-Toggle direkt aus dem Editor - kein Skript, kein Modul
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [[{ text: '💡 Licht', cmd: '', datapoint: '0_userdata.0.TestLicht' }]],
    });
    await fakeAdapter.setForeignStateAsync('0_userdata.0.TestLicht', { val: false, ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 💡 Licht');
    console.log('--- Toggle 1 (aus -> an) ---', sentMessages.at(-1)?.payload?.text);
    let dpState = await fakeAdapter.getForeignStateAsync('0_userdata.0.TestLicht');
    if (dpState?.val !== true) {
        throw new Error('Toggle hat nicht auf true geschaltet!');
    }

    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 💡 Licht');
    console.log('--- Toggle 2 (an -> aus) ---', sentMessages.at(-1)?.payload?.text);
    dpState = await fakeAdapter.getForeignStateAsync('0_userdata.0.TestLicht');
    if (dpState?.val !== false) {
        throw new Error('Toggle hat nicht zurück auf false geschaltet!');
    }

    // Zahleneingabe mit Datenpunkt-Bezug: Button zeigt echten Ziffernblock
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [
            [
                {
                    text: '🌡️ Zieltemperatur',
                    cmd: '',
                    datapoint: '0_userdata.0.Zieltemp',
                    inputType: 'number',
                    min: '10',
                    max: '30',
                },
            ],
        ],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 🌡️ Zieltemperatur');
    console.log(
        '--- Ziffernblock nach Tastendruck ---',
        sentMessages.at(-1)?.payload?.text,
        JSON.stringify(sentMessages.at(-1)?.payload?.reply_markup?.keyboard),
    );
    const inputModeState = await fakeAdapter.getStateAsync('runtime.inputMode');
    if (inputModeState?.val !== 'datapoint_numpad') {
        throw new Error('inputMode wurde nicht auf datapoint_numpad gesetzt!');
    }
    if (!sentMessages.at(-1)?.payload?.reply_markup?.keyboard?.flat().includes('⌫')) {
        throw new Error('Ziffernblock-Tastatur wurde nicht mitgeschickt!');
    }

    // Ziffer für Ziffer "205" eintippen -> darf KEINE einzige Bot-Antwort auslösen (kein Spam)
    const countBefore = sentMessages.length;
    await fakeAdapter.router.handleIncoming('[123456] 2');
    await fakeAdapter.router.handleIncoming('[123456] 0');
    await fakeAdapter.router.handleIncoming('[123456] 5');
    console.log('--- Nachrichten während Ziffern-Eingabe (sollte 0 sein) ---', sentMessages.length - countBefore);
    if (sentMessages.length !== countBefore) {
        throw new Error('Bot hat auf einzelne Ziffern geantwortet - genau der Spam, der vermieden werden sollte!');
    }

    // Außerhalb Min/Max -> EINE Fehlermeldung, Puffer wird komplett zurückgesetzt (von vorne)
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] ✅ Fertig');
    console.log('--- Wert außerhalb Min/Max (Puffer wird zurückgesetzt) ---', sentMessages.at(-1)?.payload?.text);
    let dpState2 = await fakeAdapter.getForeignStateAsync('0_userdata.0.Zieltemp');
    if (dpState2) {
        throw new Error('Ungültiger Wert wurde trotzdem geschrieben!');
    }
    const ctxAfterReset = JSON.parse((await fakeAdapter.getStateAsync('runtime.inputContext'))?.val || '{}');
    if (ctxAfterReset.buffer !== '') {
        throw new Error('Puffer wurde bei ungültiger Eingabe nicht komplett zurückgesetzt!');
    }

    // Neu eintippen "20", bestätigen
    await fakeAdapter.router.handleIncoming('[123456] 2');
    await fakeAdapter.router.handleIncoming('[123456] 0');
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] ✅ Fertig');
    console.log('--- Gültiger Wert über Ziffernblock ---', sentMessages.at(-1)?.payload?.text);
    dpState2 = await fakeAdapter.getForeignStateAsync('0_userdata.0.Zieltemp');
    if (dpState2?.val !== 20) {
        throw new Error('Ziffernblock-Wert wurde nicht korrekt geschrieben!');
    }

    // Abbrechen-Test
    await fakeAdapter.router.handleIncoming('[123456] 🌡️ Zieltemperatur');
    await fakeAdapter.router.handleIncoming('[123456] 5');
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] ❌ Abbrechen');
    console.log('--- Abbrechen ---', sentMessages.at(-1)?.payload?.text);
    const inputModeAfterCancel = await fakeAdapter.getStateAsync('runtime.inputMode');
    if (inputModeAfterCancel?.val) {
        throw new Error('inputMode wurde nach Abbrechen nicht geleert!');
    }

    // Eigene Frage statt Standardtext
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [
            [
                {
                    text: '🌡️ Zieltemperatur2',
                    cmd: '',
                    datapoint: '0_userdata.0.Zieltemp2',
                    inputType: 'number',
                    prompt: 'Wie warm soll es werden?',
                },
            ],
        ],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 🌡️ Zieltemperatur2');
    console.log('--- Eigene Frage (Zahl) ---', sentMessages.at(-1)?.payload?.text);
    if (!sentMessages.at(-1)?.payload?.text?.startsWith('Wie warm soll es werden?')) {
        throw new Error('Eigene Frage wurde bei Zahleneingabe nicht verwendet!');
    }
    await fakeAdapter.setStateAsync('runtime.inputMode', { val: '', ack: true }); // aufräumen

    // Datenpunkt als Titel-Platzhalter: Titel zeigt live den Wert, Erkennung beim Antippen funktioniert trotzdem
    await fakeAdapter.setForeignStateAsync('0_userdata.0.Aussentemp', { val: 18.3, ack: true });
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [[{ text: '🌡️ Außen: {{0_userdata.0.Aussentemp}}°C', cmd: 'TG:TEMP:SHOW' }]],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'main');
    const sentKeyboard = sentMessages.at(-1)?.payload?.reply_markup?.keyboard;
    console.log('--- Titel mit Datenpunkt-Platzhalter (gesendete Tastatur) ---', sentKeyboard);
    if (!sentKeyboard?.flat().includes('🌡️ Außen: 18.3°C')) {
        throw new Error('Platzhalter im Button-Titel wurde nicht aufgelöst!');
    }
    sentMessages.length = 0;
    await fakeAdapter.scriptBridge.register('TG:TEMP:SHOW', 'script.js.Test.respond');
    await fakeAdapter.router.handleIncoming('[123456] 🌡️ Außen: 18.3°C');
    const tempReply = sentMessages.at(-1)?.payload?.text;
    console.log('--- Button mit aufgelöstem Titel erkannt? --- Antwort:', tempReply);
    if (!tempReply?.includes('TG:TEMP:SHOW')) {
        throw new Error('Button mit Platzhalter-Titel wurde beim Antippen nicht erkannt!');
    }

    // Menü-Antworttext mit Platzhalter - beim Öffnen des Menüs
    await fakeAdapter.setForeignStateAsync('leapmotor.0.status.battery', { val: 82, ack: true });
    await setMenu(fakeAdapter, 'auto_menu', {
        title: '🚗 Auto',
        parent: 'main',
        message: 'Batterie: {{leapmotor.0.status.battery}}%',
        rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'auto_menu');
    console.log('--- Menü-Antworttext mit Platzhalter ---', sentMessages.at(-1)?.payload?.text);
    if (sentMessages.at(-1)?.payload?.text !== 'Batterie: 82%') {
        throw new Error('Menü-Antworttext wurde nicht korrekt aufgelöst!');
    }

    // Ohne Antworttext -> bleibt wie bisher (nur Titel)
    await setMenu(fakeAdapter, 'auto_menu2', {
        title: '🚗 Auto2',
        parent: 'main',
        rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'auto_menu2');
    console.log('--- Ohne Antworttext (Fallback auf Titel) ---', sentMessages.at(-1)?.payload?.text);
    if (sentMessages.at(-1)?.payload?.text !== '🚗 Auto2') {
        throw new Error('Fallback auf Titel funktioniert nicht mehr wie bisher!');
    }
    await fakeAdapter.setStateAsync('runtime.currentMenu', { val: 'main', ack: true }); // Test-Aufräumen

    // Texteingabe: Tastatur muss explizit entfernt werden (remove_keyboard), damit
    // das Handy die normale Tastatur zeigt statt der alten Menü-Tastatur
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [[{ text: '📝 Notiz', cmd: '', datapoint: '0_userdata.0.Notiz', inputType: 'text' }]],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 📝 Notiz');
    console.log('--- Texteingabe-Prompt reply_markup ---', JSON.stringify(sentMessages.at(-1)?.payload?.reply_markup));
    if (!sentMessages.at(-1)?.payload?.reply_markup?.remove_keyboard) {
        throw new Error('Texteingabe-Prompt hat die Tastatur nicht entfernt!');
    }
    await fakeAdapter.setStateAsync('runtime.inputMode', { val: '', ack: true }); // Test-Aufräumen, sonst stört's nachfolgende Tests

    // Bugfix-Test: Datenpunkt + eigene Nachricht zusammen -> eigene Nachricht muss verwendet werden,
    // nicht die generische "✅/❌ -> Wert"-Bestätigung
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [
            [
                {
                    text: '❄️ Schnellkühlen',
                    cmd: '',
                    datapoint: '0_userdata.0.QuickCool',
                    onValue: 'true',
                    offValue: 'false',
                    message: 'Schnellkühlen für 20 Minuten aktiv',
                },
            ],
        ],
    });
    await fakeAdapter.setForeignStateAsync('0_userdata.0.QuickCool', { val: false, ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] ❄️ Schnellkühlen');
    console.log('--- Datenpunkt + eigene Nachricht ---', sentMessages.at(-1)?.payload?.text);
    if (sentMessages.at(-1)?.payload?.text !== 'Schnellkühlen für 20 Minuten aktiv') {
        throw new Error('Eigene Nachricht wurde nicht verwendet - Datenpunkt-Branch hat sie überdeckt!');
    }
    const quickCoolState = await fakeAdapter.getForeignStateAsync('0_userdata.0.QuickCool');
    if (quickCoolState?.val !== true) {
        throw new Error('Datenpunkt wurde trotz eigener Nachricht nicht geschaltet!');
    }

    // Multi-Status-Schalter: Status bestimmt Anzeige UND Ziel-Datenpunkt (Henrik's Klima-Beispiel)
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [
            [
                {
                    text: '❄️ Schnellkühlen',
                    cmd: '',
                    icon: {
                        datapoint: 'leapmotor.0.status.ac_cooling_heating',
                        rules: [
                            {
                                value: 'off',
                                emoji: '❄️',
                                label: 'Schnellkühlen',
                                writeDatapoint: 'leapmotor.0.cmd.quick_cool',
                                writeValue: 'true',
                            },
                            {
                                value: 'cooling',
                                emoji: '🌀',
                                label: 'AC aus',
                                writeDatapoint: 'leapmotor.0.cmd.ac_off',
                                writeValue: 'true',
                            },
                        ],
                        fallback: '❄️',
                    },
                },
            ],
        ],
    });

    // Status = "off" -> Button soll "Schnellkühlen" zeigen und quick_cool schreiben
    await fakeAdapter.setForeignStateAsync('leapmotor.0.status.ac_cooling_heating', { val: 'off', ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] ❄️ Schnellkühlen');
    console.log('--- Status "off": Antwort auf "Schnellkühlen" ---', sentMessages.at(-1)?.payload?.text);
    const quickCool2 = await fakeAdapter.getForeignStateAsync('leapmotor.0.cmd.quick_cool');
    if (quickCool2?.val !== true) {
        throw new Error('Multi-Status-Schalter hat im Status "off" nicht quick_cool geschrieben!');
    }

    // Status = "cooling" -> Button soll jetzt "AC aus" zeigen und ac_off schreiben (anderer Command!)
    await fakeAdapter.setForeignStateAsync('leapmotor.0.status.ac_cooling_heating', { val: 'cooling', ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 🌀 AC aus');
    console.log('--- Status "cooling": Antwort auf "AC aus" ---', sentMessages.at(-1)?.payload?.text);
    const acOff = await fakeAdapter.getForeignStateAsync('leapmotor.0.cmd.ac_off');
    if (acOff?.val !== true) {
        throw new Error('Multi-Status-Schalter hat im Status "cooling" nicht ac_off geschrieben!');
    }

    // {status}-Platzhalter in der Nachricht wird pro Regel durch statusText ersetzt
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [
            [
                {
                    text: '❄️ Schnellkühlen',
                    cmd: '',
                    message: 'Schnellkühlen {status}',
                    icon: {
                        datapoint: 'leapmotor.0.status.ac_on2',
                        rules: [
                            {
                                value: 'false',
                                emoji: '❄️',
                                label: 'Schnellkühlen',
                                writeDatapoint: 'leapmotor.0.cmd.quick_cool2',
                                writeValue: 'true',
                                statusText: 'aktiv',
                            },
                            {
                                value: 'true',
                                emoji: '🌀',
                                label: 'AC aus',
                                writeDatapoint: 'leapmotor.0.cmd.ac_off2',
                                writeValue: 'true',
                                statusText: 'nicht aktiv',
                            },
                        ],
                        fallback: '❄️',
                    },
                },
            ],
        ],
    });
    await fakeAdapter.setForeignStateAsync('leapmotor.0.status.ac_on2', { val: 'false', ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] ❄️ Schnellkühlen');
    console.log('--- {status}-Platzhalter ersetzt ---', sentMessages.at(-1)?.payload?.text);
    if (sentMessages.at(-1)?.payload?.text !== 'Schnellkühlen aktiv') {
        throw new Error('{status}-Platzhalter wurde nicht korrekt ersetzt!');
    }

    // Zusammenfassung gleicher Anzeigenamen (LaundryLens-Fall: 3 Typen, alle "Info")
    await fakeAdapter.notify.registerAreas('test', { waesche: ['start', 'update', 'done'] });
    await fakeAdapter.notify.setAreaLabel('waesche', 'Wäsche');
    await fakeAdapter.notify.setTypeLabel('waesche', 'start', 'Info');
    await fakeAdapter.notify.setTypeLabel('waesche', 'update', 'Info');
    await fakeAdapter.notify.setTypeLabel('waesche', 'done', 'Info');
    await fakeAdapter.setStateAsync('users.123456.permissions.waesche', { val: true, ack: true });
    const { buildAutoRows: buildAutoRowsMerge } = require('../core/autoMenus');
    const mergedRows = await buildAutoRowsMerge(fakeAdapter, { source: 'notifyPrefs' }, '123456');
    const mergedTexts = mergedRows.flat().map(b => b.text);
    console.log('--- Zusammengefasste Benachrichtigungen ---', mergedTexts);
    const waescheCount = mergedTexts.filter(t => t.includes('Wäsche: Info')).length;
    if (waescheCount !== 1) {
        throw new Error(`Erwartete genau 1 zusammengefasste "Wäsche: Info"-Zeile, gefunden: ${waescheCount}`);
    }

    // Gemeinsames Umschalten: einmal antippen -> alle 3 zugrundeliegenden Typen gemeinsam aus
    const waescheBtn = mergedRows.flat().find(b => b.text.includes('Wäsche: Info'));
    console.log('--- Gruppen-Command ---', waescheBtn.cmd);
    const { handleNotifyToggle } = require('../core/settings');
    await handleNotifyToggle(fakeAdapter, waescheBtn.cmd, '123456', '123456', fakeAdapter.router.renderMenu);
    const startPref = await fakeAdapter.getStateAsync('users.123456.notify.waesche.start');
    const updatePref = await fakeAdapter.getStateAsync('users.123456.notify.waesche.update');
    const donePref = await fakeAdapter.getStateAsync('users.123456.notify.waesche.done');
    console.log('--- Einzelwerte nach Gruppen-Toggle ---', startPref?.val, updatePref?.val, donePref?.val);
    if (startPref?.val !== false || updatePref?.val !== false || donePref?.val !== false) {
        throw new Error('Gruppen-Toggle hat nicht alle 3 zugrundeliegenden Typen gemeinsam umgeschaltet!');
    }

    // Status-abhängig NUR fürs Emoji (keine Regel hat einen Ziel-Datenpunkt) ->
    // muss auf das einfache Datenpunkt-Feld zurückfallen (Kombination beider Felder)
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [
            [
                {
                    text: '💡 Licht',
                    cmd: '',
                    datapoint: '0_userdata.0.LichtCombo',
                    onValue: 'true',
                    offValue: 'false',
                    icon: {
                        datapoint: '0_userdata.0.LichtStatus',
                        rules: [
                            { value: 'true', emoji: '💡' },
                            { value: 'false', emoji: '🌑' },
                        ],
                        fallback: '💡',
                    },
                },
            ],
        ],
    });
    await fakeAdapter.setForeignStateAsync('0_userdata.0.LichtStatus', { val: 'false', ack: true });
    await fakeAdapter.setForeignStateAsync('0_userdata.0.LichtCombo', { val: false, ack: true });
    await fakeAdapter.setStateAsync('runtime.currentMenu', { val: 'main', ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 🌑 Licht');
    console.log(
        '--- Status-abhängig (nur Emoji) + einfacher Datenpunkt-Fallback ---',
        sentMessages.at(-1)?.payload?.text,
    );
    const comboState = await fakeAdapter.getForeignStateAsync('0_userdata.0.LichtCombo');
    if (comboState?.val !== true) {
        throw new Error('Fallback auf einfachen Datenpunkt hat bei reinem Anzeige-Status-abhängig nicht funktioniert!');
    }

    // Regression: Menü-Icon (nicht Button-Icon) muss Operator-Regeln ("<25")
    // genauso unterstützen wie Button-Icons - resolveIcon() nutzte früher nur
    // exakten String-Vergleich, matchesRuleValue() (Buttons) konnte Operatoren.
    await setMenu(fakeAdapter, 'car_menu', {
        title: '🚗 Auto',
        parent: 'main',
        icon: { datapoint: '0_userdata.0.Auto.batterySoc', rules: [{ value: '<25', emoji: '⚡️' }], fallback: '🚗' },
        rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]],
    });
    await fakeAdapter.setForeignStateAsync('0_userdata.0.Auto.batterySoc', { val: 18, ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'car_menu');
    const carTitleLow = sentMessages.at(-1)?.payload?.text;
    console.log('--- Menü-Icon mit Operator-Regel (Akku 18%, Regel "<25") ---', carTitleLow);
    if (!carTitleLow?.startsWith('⚡️')) {
        throw new Error('Menü-Icon-Operator-Regel ("<25") greift nicht - zeigt weiter Fallback statt ⚡️!');
    }

    await fakeAdapter.setForeignStateAsync('0_userdata.0.Auto.batterySoc', { val: 80, ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'car_menu');
    const carTitleHigh = sentMessages.at(-1)?.payload?.text;
    console.log('--- Menü-Icon mit Operator-Regel (Akku 80%, außerhalb "<25") ---', carTitleHigh);
    if (!carTitleHigh?.startsWith('🚗')) {
        throw new Error('Menü-Icon-Fallback greift nicht mehr, wenn keine Regel passt!');
    }

    // Menü-Titel selbst mit Platzhalter (ohne Antworttext-Feld) - genau der gemeldete Fall
    await fakeAdapter.setForeignStateAsync('0_userdata.0.Pflanzen.Strelitzie.nextWaterDueText', {
        val: 'in 3 Tagen',
        ack: true,
    });
    await setMenu(fakeAdapter, 'pflanzen_menu', {
        title: '🌿 Nächste Gießung: {{0_userdata.0.Pflanzen.Strelitzie.nextWaterDueText}}',
        parent: 'main',
        rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'pflanzen_menu');
    console.log('--- Menü-Titel mit Platzhalter (ohne Antworttext) ---', sentMessages.at(-1)?.payload?.text);
    if (sentMessages.at(-1)?.payload?.text !== '🌿 Nächste Gießung: in 3 Tagen') {
        throw new Error('Platzhalter im Menü-Titel wurde nicht aufgelöst!');
    }

    // Festwert setzen (Modus-Auswahl-Fall): Button schreibt IMMER denselben Wert, egal was aktuell drinsteht
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [
            [
                { text: '🤖 Auto', cmd: '', datapoint: '0_userdata.0.Balkon.Modus', fixedValue: 'auto' },
                { text: '👤 Manuell', cmd: '', datapoint: '0_userdata.0.Balkon.Modus', fixedValue: 'manual' },
            ],
        ],
    });
    await fakeAdapter.setForeignStateAsync('0_userdata.0.Balkon.Modus', { val: 'off', ack: true });
    await fakeAdapter.setStateAsync('runtime.currentMenu', { val: 'main', ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 🤖 Auto');
    let modeState = await fakeAdapter.getForeignStateAsync('0_userdata.0.Balkon.Modus');
    console.log('--- Festwert "Auto" gesetzt ---', modeState?.val, sentMessages.at(-1)?.payload?.text);
    if (modeState?.val !== 'auto') {
        throw new Error('Festwert wurde nicht korrekt geschrieben!');
    }

    // Nochmal denselben Button drücken -> muss weiterhin "auto" bleiben (nicht umschalten wie beim Toggle)
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 🤖 Auto');
    modeState = await fakeAdapter.getForeignStateAsync('0_userdata.0.Balkon.Modus');
    if (modeState?.val !== 'auto') {
        throw new Error('Festwert hat sich beim zweiten Antippen fälschlich geändert (sollte nicht toggeln)!');
    }

    // Anderen Festwert-Button drücken -> überschreibt mit "manual"
    await fakeAdapter.router.handleIncoming('[123456] 👤 Manuell');
    modeState = await fakeAdapter.getForeignStateAsync('0_userdata.0.Balkon.Modus');
    console.log('--- Festwert "Manuell" gesetzt ---', modeState?.val);
    if (modeState?.val !== 'manual') {
        throw new Error('Zweiter Festwert-Button hat nicht korrekt überschrieben!');
    }

    // Icon-Button (Status-abhängig) MIT Platzhalter im Text - genau der zweite gemeldete Fall
    await fakeAdapter.setForeignStateAsync('0_userdata.0.Pflanzen.Strelitzie.wetterStatus', { val: 'ok', ack: true });
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [
            [
                {
                    text: '{{0_userdata.0.Pflanzen.Strelitzie.nextWaterDueText}}',
                    cmd: 'TG:PLANT:SHOW',
                    icon: {
                        datapoint: '0_userdata.0.Pflanzen.Strelitzie.wetterStatus',
                        rules: [{ value: 'ok', emoji: '💧' }],
                        fallback: '💧',
                    },
                },
            ],
        ],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'main');
    const iconBtnKeyboard = sentMessages.at(-1)?.payload?.reply_markup?.keyboard;
    console.log('--- Icon-Button mit Platzhalter (gesendete Tastatur) ---', iconBtnKeyboard);
    if (!iconBtnKeyboard?.flat().includes('💧 in 3 Tagen')) {
        throw new Error('Platzhalter im Icon-Button-Text wurde nicht aufgelöst!');
    }

    // Mehrstufiger Dialog rein über onMessage (kein Legacy-Bridge mehr nötig):
    // Skript fragt, wartet auf Antwort, validiert, fragt ggf. nochmal.
    await fakeAdapter.scriptBridge.register('TG:SCHEDULEADD', 'script.js.Test.scheduleAdd');
    fakeAdapter.sendTo = function (instance, command, message, callback) {
        if (
            instance === this.config.javascriptInstance &&
            command === 'toScript' &&
            message.script === 'script.js.Telegram.scheduleAdd'
        ) {
            if (!message.data.isReply) {
                callback({ text: 'Bitte Uhrzeit im Format HH:MM eingeben:', awaitReply: true });
            } else {
                const m = String(message.data.value || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
                if (!m) {
                    callback({ text: '⚠️ Ungültiges Format, bitte nochmal HH:MM eingeben:', awaitReply: true });
                } else {
                    callback({ text: `✅ Termin angelegt: ${message.data.value}` });
                }
            }
        }
    };
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [[{ text: '➕ Termin hinzufügen', cmd: 'ScheduleAdd', scriptId: 'scheduleAdd' }]],
    });
    await fakeAdapter.setStateAsync('runtime.currentMenu', { val: 'main', ack: true });

    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] ➕ Termin hinzufügen');
    console.log(
        '--- Skript-Dialog Schritt 1 (Frage) ---',
        sentMessages.at(-1)?.payload?.text,
        JSON.stringify(sentMessages.at(-1)?.payload?.reply_markup),
    );
    if (sentMessages.at(-1)?.payload?.text !== 'Bitte Uhrzeit im Format HH:MM eingeben:') {
        throw new Error('Skript-Frage kam nicht an!');
    }
    if (!sentMessages.at(-1)?.payload?.reply_markup?.remove_keyboard) {
        throw new Error('Tastatur wurde bei Skript-Rückfrage nicht entfernt!');
    }

    // Ungültige Eingabe -> Skript fragt nochmal (Verkettung)
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] abc');
    console.log('--- Skript-Dialog Schritt 2 (ungültig, erneut gefragt) ---', sentMessages.at(-1)?.payload?.text);
    if (!sentMessages.at(-1)?.payload?.text?.includes('Ungültiges Format')) {
        throw new Error('Verkettung bei ungültiger Eingabe hat nicht funktioniert!');
    }

    // Gültige Eingabe -> Skript ist fertig
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 10:30');
    console.log('--- Skript-Dialog Schritt 3 (fertig) ---', sentMessages.at(-1)?.payload?.text);
    if (!sentMessages.at(-1)?.payload?.text?.includes('10:30')) {
        throw new Error('Finale Bestätigung kam nicht korrekt an!');
    }
    const inputModeAfterDialog = await fakeAdapter.getStateAsync('runtime.inputMode');
    if (inputModeAfterDialog?.val) {
        throw new Error('inputMode wurde nach Dialog-Ende nicht geleert!');
    }

    // Proaktive Skript-Rückfrage (kein vorheriger Knopfdruck, z. B. durch
    // Gerätestatus-Änderung ausgelöst) - direkt über den Router-Aufruf simuliert,
    // wie main.js es beim 'awaitReply'-Command tun würde.
    fakeAdapter.sendTo = function (instance, command, message, callback) {
        if (
            instance === this.config.javascriptInstance &&
            command === 'toScript' &&
            message.script === 'script.js.Telegram.calib'
        ) {
            if (!message.data.isReply) {
                callback({ text: 'Bitte erste Höhe eingeben:', awaitReply: true });
            } else {
                callback({ text: `✅ Höhe gespeichert: ${message.data.value} cm` });
            }
        }
    };
    await fakeAdapter.scriptBridge.register('TG:CALIBHEIGHT', 'script.js.Test.calib');
    await setMenu(fakeAdapter, 'balcony_calib', {
        title: '🧪 Kalibrieren',
        parent: 'main',
        rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]],
    });
    await fakeAdapter.router.setInputMode(
        'script_await',
        JSON.stringify({ scriptId: 'calib', cmd: 'CalibHeight', menuKey: 'balcony_calib' }),
    );
    await fakeAdapter.router.sendTextNoKeyboard('123456', '📏 Bitte erste Höhe eingeben:');
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 28.5');
    console.log('--- Proaktive Skript-Rückfrage beantwortet ---', sentMessages.at(-1)?.payload?.text);
    if (!sentMessages.at(-1)?.payload?.text?.includes('28.5')) {
        throw new Error('Proaktive Rückfrage wurde nicht korrekt verarbeitet!');
    }

    // Ja/Nein-Tastatur bei einer Skript-Rückfrage statt Freitext
    fakeAdapter.sendTo = function (instance, command, message, callback) {
        if (
            instance === this.config.javascriptInstance &&
            command === 'toScript' &&
            message.script === 'script.js.Telegram.delconfirm'
        ) {
            if (!message.data.isReply) {
                callback({ text: 'Wirklich löschen?', awaitReply: true, keyboard: [['✅ Ja', '❌ Nein']] });
            } else {
                callback({ text: message.data.value === '✅ Ja' ? '🗑 Gelöscht' : '❌ Abgebrochen' });
            }
        }
    };
    await fakeAdapter.scriptBridge.register('TG:DELCONFIRM', 'script.js.Test.delconfirm');
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [[{ text: '🗑 Löschen', cmd: 'DelConfirm', scriptId: 'delconfirm' }]],
    });
    await fakeAdapter.setStateAsync('runtime.currentMenu', { val: 'main', ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 🗑 Löschen');
    console.log(
        '--- Ja/Nein-Tastatur bei Rückfrage ---',
        sentMessages.at(-1)?.payload?.text,
        JSON.stringify(sentMessages.at(-1)?.payload?.reply_markup?.keyboard),
    );
    if (!sentMessages.at(-1)?.payload?.reply_markup?.keyboard?.flat().includes('✅ Ja')) {
        throw new Error('Ja/Nein-Tastatur wurde nicht mitgeschickt!');
    }
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] ✅ Ja');
    console.log('--- Antwort nach Ja/Nein-Tastendruck ---', sentMessages.at(-1)?.payload?.text);
    if (sentMessages.at(-1)?.payload?.text !== '🗑 Gelöscht') {
        throw new Error('Ja/Nein-Antwort wurde nicht korrekt verarbeitet!');
    }

    // Admin-Benachrichtigung mit Inline-Keyboard bei neuem Bereich
    await fakeAdapter.setStateAsync('users.123456.role', { val: 'admin', ack: true });
    sentMessages.length = 0;
    await fakeAdapter.notify('brandneuerBereich', 'info', 'Testnachricht für neuen Bereich');
    const adminMsg = sentMessages.find(m => m.payload?.reply_markup?.inline_keyboard);
    console.log(
        '--- Admin-Benachrichtigung bei neuem Bereich ---',
        adminMsg?.payload?.text,
        JSON.stringify(adminMsg?.payload?.reply_markup?.inline_keyboard),
    );
    if (!adminMsg) {
        throw new Error('Admin wurde nicht mit Inline-Keyboard benachrichtigt!');
    }
    const approveCallback = adminMsg.payload.reply_markup.inline_keyboard[0][0].callback_data;
    if (approveCallback !== 'TG:ADMIN:APPROVEAREA:brandneuerBereich') {
        throw new Error('Falsches callback_data für Erlauben-Button!');
    }

    // Admin tippt auf "Erlauben" -> Bereich wird freigeschaltet + answerCallbackQuery gesendet
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming(`[123456] ${approveCallback}`);
    const ackMsg = sentMessages.find(m => m.payload?.answerCallbackQuery);
    console.log('--- answerCallbackQuery gesendet? ---', !!ackMsg, sentMessages.at(-1)?.payload?.text);
    if (!ackMsg) {
        throw new Error('answerCallbackQuery wurde nicht gesendet - Ladekreis würde ewig drehen!');
    }
    const approvedAreas = fakeAdapter.notify.getValidAreas();
    if (!approvedAreas.brandneuerBereich) {
        throw new Error('Bereich wurde nach "Erlauben" nicht tatsächlich freigeschaltet!');
    }

    // Nicht-Admin darf nicht genehmigen
    await fakeAdapter.notify('zweiterNeuerBereich', 'info', 'Test');
    await fakeAdapter.setStateAsync('users.999999.role', { val: 'guest', ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[999999] TG:ADMIN:APPROVEAREA:zweiterNeuerBereich');
    console.log('--- Nicht-Admin-Versuch ---', sentMessages.at(-1)?.payload?.text);
    if (!sentMessages.at(-1)?.payload?.text?.includes('Nur Admins')) {
        throw new Error('Nicht-Admin konnte trotzdem freischalten!');
    }
    if (fakeAdapter.notify.getValidAreas().zweiterNeuerBereich) {
        throw new Error('Bereich wurde trotz fehlender Admin-Rechte freigeschaltet!');
    }

    // Bild aus Datenpunkt (Base64, ein winziges 1x1-PNG)
    const tinyPngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    await fakeAdapter.setForeignStateAsync('0_userdata.0.TestBild', {
        val: `data:image/png;base64,${tinyPngBase64}`,
        ack: true,
    });
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [[{ text: '📷 Testbild', cmd: '', imageDatapoint: '0_userdata.0.TestBild', message: 'Ein Testbild' }]],
    });
    await fakeAdapter.setStateAsync('runtime.currentMenu', { val: 'main', ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 📷 Testbild');
    const imgMsg = sentMessages.at(-1);
    console.log('--- Bild aus Base64-Datenpunkt ---', imgMsg?.payload?.caption, imgMsg?.payload?.text);
    if (!imgMsg?.payload?.text?.endsWith('.jpg') || !fs.existsSync(imgMsg.payload.text)) {
        throw new Error('Base64-Bild wurde nicht korrekt als temporäre Datei geschrieben!');
    }
    const writtenBuffer = fs.readFileSync(imgMsg.payload.text);
    if (writtenBuffer.length === 0) {
        throw new Error('Temporäre Bilddatei ist leer!');
    }
    if (imgMsg?.payload?.caption !== 'Ein Testbild') {
        throw new Error('Bildunterschrift wurde nicht korrekt übernommen!');
    }
    fs.unlinkSync(imgMsg.payload.text); // aufräumen

    // Globale Option "Typen bündeln" (versteckt im Hauptmenü-Knoten)
    await fakeAdapter.notify.registerAreas('test', { grouptest: ['info', 'error'] });
    await fakeAdapter.setStateAsync('users.123456.permissions.grouptest', { val: true, ack: true });

    // Standard OHNE jede Konfiguration: alles außer warn/error wird automatisch gebündelt
    await setMenu(fakeAdapter, 'main', { title: '🏠 Hauptmenü', rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]] });
    sentMessages.length = 0;
    await fakeAdapter.notify('grouptest', 'info', 'Nachricht A');
    await fakeAdapter.notify('grouptest', 'info', 'Nachricht B');
    console.log('--- Standard: "info" automatisch gebündelt? (sollte 0 sein, wartet) ---', sentMessages.length);
    if (sentMessages.length !== 0) {
        throw new Error('"info" hätte per Standard automatisch gebündelt werden müssen!');
    }

    sentMessages.length = 0;
    await fakeAdapter.notify('grouptest', 'error', 'Fehler A');
    console.log('--- Standard: "error" bleibt sofort einzeln? ---', sentMessages.length);
    if (sentMessages.length !== 1) {
        throw new Error('"error" hätte per Standard NICHT gebündelt werden dürfen!');
    }

    // Eigene Ausschlussliste: "info" jetzt auch ausschließen -> bleibt einzeln
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        groupableExcludeTypes: ['warn', 'error', 'info'],
        rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]],
    });
    sentMessages.length = 0;
    await fakeAdapter.notify('grouptest', 'info', 'Nachricht C');
    console.log('--- "info" explizit ausgeschlossen: sofort einzeln? ---', sentMessages.length);
    if (sentMessages.length !== 1) {
        throw new Error('Explizit ausgeschlossenes "info" hätte sofort ankommen müssen!');
    }

    // Nachricht in der Sammelphase - vor dem 15s-Timer "verschwindet" der Adapter
    // (Neustart) -> darf NICHT verloren gehen, muss beim Shutdown sofort raus.
    await setMenu(fakeAdapter, 'main', { title: '🏠 Hauptmenü', rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]] }); // zurück auf Standard-Bündelung
    sentMessages.length = 0;
    await fakeAdapter.notify('grouptest', 'info', 'Wird gerade gesammelt, dann kommt der Neustart');
    console.log('--- Direkt nach dem Senden (noch in der Sammelphase) ---', sentMessages.length);
    if (sentMessages.length !== 0) {
        throw new Error('Testaufbau falsch - Nachricht hätte gerade erst gepuffert werden müssen!');
    }
    await fakeAdapter._flushAllPendingNotify();
    console.log('--- Nach Flush beim Adapter-Stopp ---', sentMessages.length, sentMessages.at(-1)?.payload?.text);
    if (sentMessages.length !== 1) {
        throw new Error(
            'Gepufferte Nachricht wurde beim Shutdown-Flush NICHT ausgeliefert - würde bei echtem Neustart verloren gehen!',
        );
    }

    // Bereich pausieren: "info" wird blockiert, "warn" kommt trotzdem durch
    // ("open" von der Standard-Bündelung ausschließen, damit die Zeitpunkt-Tests hier nicht verfälscht werden)
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        groupableExcludeTypes: ['warn', 'error', 'open'],
        rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]],
    });
    await fakeAdapter.notify.registerAreas('fenster_test', { Fenster: ['open', 'reminder'] });
    await fakeAdapter.notify.approveArea('Fenster');
    await fakeAdapter.setStateAsync('users.123456.permissions.Fenster', { val: true, ack: true });
    await fakeAdapter.notify.pauseArea('Fenster', 24);
    sentMessages.length = 0;
    await fakeAdapter.notify('Fenster', 'open', 'Fenster ist offen');
    console.log('--- Pausiert: "open" blockiert? ---', sentMessages.length);
    if (sentMessages.length !== 0) {
        throw new Error('Pausierter Bereich hat trotzdem "open" zugestellt!');
    }

    sentMessages.length = 0;
    await fakeAdapter.notify('Fenster', 'warn', 'Gewitterwarnung trotz Pause');
    console.log('--- Pausiert: "warn" kommt trotzdem durch? ---', sentMessages.length);
    if (sentMessages.length !== 1) {
        throw new Error('"warn" hätte trotz Pause ankommen müssen!');
    }

    // Pause aufheben -> "open" kommt wieder an
    await fakeAdapter.notify.unpauseArea('Fenster');
    sentMessages.length = 0;
    await fakeAdapter.notify('Fenster', 'open', 'Fenster ist wieder offen');
    console.log('--- Nach Pause-Aufhebung: "open" kommt wieder an? ---', sentMessages.length);
    if (sentMessages.length !== 1) {
        throw new Error('Nach Aufhebung hätte "open" wieder ankommen müssen!');
    }

    // Haupt-Benachrichtigungsliste verlinkt jetzt auf ein eigenes Pause-Untermenü,
    // statt die Pause-Buttons direkt mit reinzumischen
    await fakeAdapter.notify.pauseArea('Fenster', 24);
    const mainListRows = await buildAutoRows(fakeAdapter, { source: 'notifyPrefs' }, '123456');
    const mainListTexts = mainListRows.flat().map(b => b.text);
    console.log('--- Hauptliste: Pause-Buttons NICHT direkt drin, nur Link ---', mainListTexts);
    if (mainListTexts.some(t => t.includes('pausieren') || t.includes('Pause aufheben'))) {
        throw new Error('Pause-Buttons stecken noch direkt in der Hauptliste statt im Untermenü!');
    }
    if (!mainListTexts.some(t => t.includes('⏸ Pausieren'))) {
        throw new Error('Link zum Pause-Untermenü fehlt in der Hauptliste!');
    }
    if (!mainListTexts.includes('⬅️ Zurück') || !mainListTexts.includes('🏠 Hauptmenü')) {
        throw new Error('Kombi-Button Zurück+Hauptmenü fehlt in der Hauptliste!');
    }

    // Eigenes Pause-Untermenü zeigt die eigentlichen Pause-Buttons
    const pausedRows = await buildAutoRows(fakeAdapter, { source: 'notifyPause' }, '123456');
    const pausedTexts = pausedRows.flat().map(b => b.text);
    console.log('--- Pause-Untermenü ---', pausedTexts);
    if (!pausedTexts.some(t => t.includes('▶️') && t.includes('Pause aufheben'))) {
        throw new Error('Pause-Untermenü zeigt bei aktiver Pause nicht den "Pause aufheben"-Button!');
    }
    if (!pausedTexts.includes('⬅️ Zurück') || !pausedTexts.includes('🏠 Hauptmenü')) {
        throw new Error('Kombi-Button Zurück+Hauptmenü fehlt im Pause-Untermenü!');
    }

    // Benutzer-Liste: Zweier-Reihen + Kombi-Button
    await fakeAdapter.setStateAsync('users.777777.role', { val: 'guest', ack: true });
    const userListRows = await buildAutoRows(fakeAdapter, { source: 'users' }, '123456');
    console.log('--- Benutzer-Liste (Zweier-Reihen?) ---', userListRows);
    const nonFinalRows = userListRows.slice(0, -1);
    if (nonFinalRows.some(row => row.length > 2)) {
        throw new Error('Benutzer-Liste hat eine Zeile mit mehr als 2 Buttons!');
    }
    const lastUserRow = userListRows.at(-1).map(b => b.text);
    if (!lastUserRow.includes('⬅️ Zurück') || !lastUserRow.includes('🏠 Hauptmenü')) {
        throw new Error('Kombi-Button Zurück+Hauptmenü fehlt in der Benutzer-Liste!');
    }

    // Globale Einstellung "Buttons pro Zeile" (am Hauptmenü) wirkt sich auch auf
    // die Auto-Menüs aus (nicht nur auf manuell verdrahtete Menüs im Editor).
    // Braucht mind. 3 Nutzer, um eine 3er-Zeile überhaupt zeigen zu können.
    await require('../core/users').ensureUser(fakeAdapter, '888888');
    await require('../core/users').ensureUser(fakeAdapter, '888889');
    await fakeAdapter.setStateAsync('users.888888.role', { val: 'guest', ack: true });
    await fakeAdapter.setStateAsync('users.888889.role', { val: 'guest', ack: true });
    const mainBefore = await require('../core/registry').getMenu(fakeAdapter, 'main');
    await setMenu(fakeAdapter, 'main', { ...mainBefore, buttonsPerRow: 3 });
    const userListRows3 = await buildAutoRows(fakeAdapter, { source: 'users' }, '123456');
    console.log('--- Benutzer-Liste mit buttonsPerRow=3 ---', userListRows3);
    const nonFinalRows3 = userListRows3.slice(0, -1);
    if (!nonFinalRows3.some(row => row.length === 3)) {
        throw new Error('Globale Einstellung "Buttons pro Zeile"=3 wurde bei Auto-Menüs nicht angewendet!');
    }
    await setMenu(fakeAdapter, 'main', mainBefore); // zurücksetzen, damit spätere Tests unbeeinflusst bleiben

    // Benutzer-Detail (admin.js): Kombi-Button statt nur Zurück
    const { handleAdminCommand: handleAdminCommandForCombo } = require('../core/admin');
    await handleAdminCommandForCombo(
        fakeAdapter,
        'TG:ADMIN:USER:123456',
        '123456',
        '123456',
        fakeAdapter.router.renderMenu,
    );
    const { getMenu: getMenuForCombo } = require('../core/registry');
    const userDetailDef = await getMenuForCombo(fakeAdapter, 'admin_user_detail');
    const lastDetailRow = (userDetailDef?.rows || []).at(-1).map(b => b.text);
    console.log('--- Benutzer-Detail letzte Zeile ---', lastDetailRow);
    if (!lastDetailRow.includes('⬅️ Zurück') || !lastDetailRow.includes('🏠 Hauptmenü')) {
        throw new Error('Kombi-Button Zurück+Hauptmenü fehlt im Benutzer-Detail!');
    }

    // Bild-Datenpunkt + Toggle kombiniert (Ein/Aus-Typ): beides muss passieren, nicht nur das Bild
    await fakeAdapter.setForeignStateAsync('0_userdata.0.ToggleBild', {
        val: `data:image/png;base64,${tinyPngBase64}`,
        ack: true,
    });
    await fakeAdapter.setForeignStateAsync('0_userdata.0.LichtToggle', { val: false, ack: true });
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [
            [
                {
                    text: '💡 Licht',
                    cmd: '',
                    datapoint: '0_userdata.0.LichtToggle',
                    imageDatapoint: '0_userdata.0.ToggleBild',
                },
            ],
        ],
    });
    await fakeAdapter.setStateAsync('runtime.currentMenu', { val: 'main', ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 💡 Licht');
    const toggleImgMsg = sentMessages.at(-1);
    const lightState = await fakeAdapter.getForeignStateAsync('0_userdata.0.LichtToggle');
    console.log(
        '--- Bild + Toggle kombiniert: Toggle geschaltet? Bild dabei? ---',
        lightState?.val,
        !!toggleImgMsg?.payload?.text?.endsWith('.jpg'),
        toggleImgMsg?.payload?.caption,
    );
    if (lightState?.val !== true) {
        throw new Error('Toggle wurde beim Bild-Fall NICHT ausgeführt - genau der gemeldete Bug!');
    }
    if (!toggleImgMsg?.payload?.text?.endsWith('.jpg')) {
        throw new Error('Bild wurde nicht mitgeschickt!');
    }
    fs.unlinkSync(toggleImgMsg.payload.text);

    // Menü-Skript für Antworttext: normale nextMenu-Navigation, Skript liefert
    // nur den Text, Tastatur kommt weiterhin aus den eigenen "rows" des Menüs
    // (genau der Vacuum-Wartung-Fall: vacuum_maint als echtes Menü mit Reset-Buttons)
    fakeAdapter.sendTo = function (instance, command, message, callback) {
        if (
            instance === this.config.javascriptInstance &&
            command === 'toScript' &&
            message.script === 'script.js.Telegram.vacuum'
        ) {
            callback({ text: '🛠️ Vacuum Maintenance\n\nFilter: 1h 44m\nHauptbürste: 1h 47m' });
        }
    };
    await fakeAdapter.scriptBridge.register('TG:VACUUMMAINT', 'script.js.Test.vacuum');
    await setMenu(fakeAdapter, 'vacuum_maint', {
        title: '🛠️ Wartung',
        parent: 'main',
        scriptId: 'vacuum',
        cmd: 'VacuumMaint',
        rows: [
            [{ text: '🧼 Filter zurücksetzen', cmd: 'TG:VACUUM:RESET:FILTER' }],
            [
                { text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' },
                { text: '🏠 Hauptmenü', cmd: 'TG:NAV:MAIN' },
            ],
        ],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'vacuum_maint');
    const maintMsg = sentMessages.at(-1);
    console.log(
        '--- Menü-Skript: Text vom Skript, Tastatur vom Menü ---',
        maintMsg?.payload?.text,
        JSON.stringify(maintMsg?.payload?.reply_markup?.keyboard),
    );
    if (!maintMsg?.payload?.text?.includes('Filter: 1h 44m')) {
        throw new Error('Skript-Text wurde nicht als Menü-Antworttext verwendet!');
    }
    if (!maintMsg?.payload?.reply_markup?.keyboard?.flat().includes('🧼 Filter zurücksetzen')) {
        throw new Error('Menü-eigene Tastatur (Reset-Buttons) fehlt!');
    }
    if (!maintMsg?.payload?.reply_markup?.keyboard?.flat().includes('🏠 Hauptmenü')) {
        throw new Error('Kombi-Button fehlt in der Menü-eigenen Tastatur!');
    }

    // Geister-Menü ohne Rows (Legacy-Skript, das nur tmRender() mit einem
    // Menü-Schlüssel ohne echte Buttons aufruft) darf currentMenu nicht kaputt machen
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [[{ text: '⛽️ Benzin', cmd: '', message: 'Bericht folgt gleich' }]],
    });
    await fakeAdapter.setStateAsync('runtime.currentMenu', { val: 'main', ack: true });
    await setMenu(fakeAdapter, 'Menu_Weather', { title: 'Weather-Ergebnis', rows: [] }); // Geister-Menü, keine Buttons
    await fakeAdapter.router.renderMenu('123456', 'Menu_Weather', 'Top 3 Preise...');
    const currentMenuAfterGhost = await fakeAdapter.getStateAsync('runtime.currentMenu');
    console.log('--- currentMenu nach Geister-Menü-Render ---', currentMenuAfterGhost?.val);
    if (currentMenuAfterGhost?.val !== 'main') {
        throw new Error('currentMenu wurde fälschlich auf das leere Geister-Menü gesetzt - genau der gemeldete Bug!');
    }

    // Nächster echter Knopfdruck muss wieder normal funktionieren
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] ⛽️ Benzin');
    console.log(
        '--- Knopfdruck nach Geister-Menü funktioniert wieder? ---',
        sentMessages.length > 0 ? 'ja' : 'NEIN, immer noch blockiert',
    );
    if (sentMessages.length === 0) {
        throw new Error('Navigation blieb nach dem Geister-Menü blockiert!');
    }

    // Boolesche Platzhalter-Werte werden automatisch übersetzt statt roh true/false
    await fakeAdapter.setForeignStateAsync('0_userdata.0.TestBool', { val: true, ack: true });
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        message: 'Status: {{0_userdata.0.TestBool}}',
        rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'main');
    console.log('--- Boolean-Platzhalter (true) ---', sentMessages.at(-1)?.payload?.text);
    if (sentMessages.at(-1)?.payload?.text !== 'Status: ✅ an') {
        throw new Error('Boolean "true" wurde nicht automatisch übersetzt!');
    }

    await fakeAdapter.setForeignStateAsync('0_userdata.0.TestBool', { val: false, ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'main');
    console.log('--- Boolean-Platzhalter (false) ---', sentMessages.at(-1)?.payload?.text);
    if (sentMessages.at(-1)?.payload?.text !== 'Status: ⛔ aus') {
        throw new Error('Boolean "false" wurde nicht automatisch übersetzt!');
    }

    // Eigener Text für an/aus
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        boolTrueText: 'JA',
        boolFalseText: 'NEIN',
        message: 'Status: {{0_userdata.0.TestBool}}',
        rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'main');
    console.log('--- Eigener Bool-Text ---', sentMessages.at(-1)?.payload?.text);
    if (sentMessages.at(-1)?.payload?.text !== 'Status: NEIN') {
        throw new Error('Eigener Bool-Text wurde nicht verwendet!');
    }

    // Bool-Umwandlung komplett ausschalten -> roh true/false
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        boolTranslateEnabled: false,
        message: 'Status: {{0_userdata.0.TestBool}}',
        rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'main');
    console.log('--- Bool-Umwandlung ausgeschaltet ---', sentMessages.at(-1)?.payload?.text);
    if (sentMessages.at(-1)?.payload?.text !== 'Status: false') {
        throw new Error('Bool-Umwandlung hätte ausgeschaltet sein müssen!');
    }

    // Datums-Umwandlung mit eigenem Format
    await fakeAdapter.setForeignStateAsync('0_userdata.0.TestDatum', { val: '2026-07-19', ack: true });
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        dateFormat: 'DD.MM.YYYY',
        message: 'Datum: {{0_userdata.0.TestDatum}}',
        rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'main');
    console.log('--- Datums-Umwandlung ---', sentMessages.at(-1)?.payload?.text);
    if (sentMessages.at(-1)?.payload?.text !== 'Datum: 19.07.2026') {
        throw new Error('Datum wurde nicht korrekt umgewandelt!');
    }

    // Wert MIT echter Uhrzeit -> eigenes Format (dateTimeFormat), nicht das reine Datumsformat
    await fakeAdapter.setForeignStateAsync('0_userdata.0.TestDatumZeit', { val: '2026-07-19T14:30:00', ack: true });
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        dateFormat: 'DD.MM.YYYY',
        dateTimeFormat: 'DD.MM.YYYY um HH:mm',
        message: 'Zeit: {{0_userdata.0.TestDatumZeit}}',
        rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'main');
    console.log('--- Datum MIT Uhrzeit (eigenes Format) ---', sentMessages.at(-1)?.payload?.text);
    if (sentMessages.at(-1)?.payload?.text !== 'Zeit: 19.07.2026 um 14:30') {
        throw new Error('Datum+Uhrzeit wurde nicht korrekt umgewandelt!');
    }

    // Reines Datum bleibt exakt 00:00, keine Zeitzonen-Verschiebung
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        dateFormat: 'DD.MM.YYYY HH:mm',
        message: 'Datum: {{0_userdata.0.TestDatum}}',
        rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'main');
    console.log('--- Reines Datum mit HH:mm im Format (muss exakt 00:00 sein) ---', sentMessages.at(-1)?.payload?.text);
    if (sentMessages.at(-1)?.payload?.text !== 'Datum: 19.07.2026 00:00') {
        throw new Error('Reines Datum zeigt nicht exakt 00:00 - Zeitzonen-Drift!');
    }

    // Datums-Umwandlung ausgeschaltet -> roh
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        dateTranslateEnabled: false,
        message: 'Datum: {{0_userdata.0.TestDatum}}',
        rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'main');
    console.log('--- Datums-Umwandlung ausgeschaltet ---', sentMessages.at(-1)?.payload?.text);
    if (sentMessages.at(-1)?.payload?.text !== 'Datum: 2026-07-19') {
        throw new Error('Datums-Umwandlung hätte ausgeschaltet sein müssen!');
    }

    // Hauptschalter komplett aus -> auch "info" bleibt sofort einzeln, egal was in der Ausschlussliste steht
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        groupingEnabled: false,
        rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]],
    });
    sentMessages.length = 0;
    await fakeAdapter.notify('grouptest', 'info', 'Nachricht D');
    console.log('--- Bündelung komplett ausgeschaltet: sofort einzeln? ---', sentMessages.length);
    if (sentMessages.length !== 1) {
        throw new Error('Mit ausgeschaltetem Hauptschalter hätte "info" trotzdem sofort ankommen müssen!');
    }

    // Berechtigungs-Liste soll Anzeigenamen aus den Benachrichtigungen mitbenutzen
    const { getMenu } = require('../core/registry');
    const { handleAdminCommand } = require('../core/admin');
    await fakeAdapter.notify.registerAreas('laundrylens', { laundrylens: ['done'] });
    await fakeAdapter.notify.approveArea('laundrylens');
    await fakeAdapter.notify.setAreaLabel('laundrylens', 'Wäsche');
    await fakeAdapter.setStateAsync('users.123456.permissions.laundrylens', { val: true, ack: true });
    await fakeAdapter.setStateAsync('users.123456.role', { val: 'admin', ack: true });
    await handleAdminCommand(fakeAdapter, 'TG:ADMIN:USER:123456', '123456', '123456', fakeAdapter.router.renderMenu);
    const permMenuDef = await getMenu(fakeAdapter, 'admin_user_detail');
    const permTexts = (permMenuDef?.rows || []).flat().map(b => b.text);
    console.log('--- Berechtigungs-Liste mit Anzeigename-Fallback ---', permTexts);
    if (!permTexts.some(t => t.includes('Wäsche'))) {
        throw new Error('Anzeigename aus Benachrichtigungen wurde in der Berechtigungs-Liste nicht übernommen!');
    }

    // Vergleichsoperator als Status-Regel-Wert (z. B. "<50")
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [
            [
                {
                    text: 'Akku',
                    cmd: 'TG:BATTERY:SHOW',
                    icon: {
                        datapoint: '0_userdata.0.Akku',
                        rules: [
                            { value: '<50', emoji: '🪫', label: 'Akku schwach' },
                            { value: '>=50', emoji: '🔋', label: 'Akku ok' },
                        ],
                    },
                },
            ],
        ],
    });
    await fakeAdapter.setStateAsync('runtime.currentMenu', { val: 'main', ack: true });
    await fakeAdapter.setForeignStateAsync('0_userdata.0.Akku', { val: 30, ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'main');
    let keyboard = sentMessages.at(-1)?.payload?.reply_markup?.keyboard;
    console.log('--- Vergleichsoperator "<50" bei Wert 30 ---', keyboard);
    if (!keyboard?.flat().includes('🪫 Akku schwach')) {
        throw new Error('"<50" hat bei Wert 30 nicht gematcht!');
    }

    await fakeAdapter.setForeignStateAsync('0_userdata.0.Akku', { val: 80, ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'main');
    keyboard = sentMessages.at(-1)?.payload?.reply_markup?.keyboard;
    console.log('--- Vergleichsoperator ">=50" bei Wert 80 ---', keyboard);
    if (!keyboard?.flat().includes('🔋 Akku ok')) {
        throw new Error('">=50" hat bei Wert 80 nicht gematcht!');
    }

    // Menü mit Bild-Datenpunkt: Bild + Antworttext (als Bildunterschrift) + Tastatur in EINER Nachricht
    await fakeAdapter.setForeignStateAsync('0_userdata.0.KameraBild', {
        val: `data:image/png;base64,${tinyPngBase64}`,
        ack: true,
    });
    await setMenu(fakeAdapter, 'kamera_menu', {
        title: '📷 Kamera',
        parent: 'main',
        message: 'Letztes Bild von der Kamera',
        imageDatapoint: '0_userdata.0.KameraBild',
        rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'kamera_menu');
    const menuImgMsg = sentMessages.at(-1);
    console.log(
        '--- Menü mit Bild: caption + Tastatur ---',
        menuImgMsg?.payload?.caption,
        JSON.stringify(menuImgMsg?.payload?.reply_markup?.keyboard),
    );
    if (menuImgMsg?.payload?.caption !== 'Letztes Bild von der Kamera') {
        throw new Error('Menü-Antworttext wurde nicht als Bildunterschrift verwendet!');
    }
    if (!menuImgMsg?.payload?.reply_markup?.keyboard?.flat().includes('⬅️ Zurück')) {
        throw new Error('Tastatur fehlt bei Bild+Menü-Nachricht!');
    }
    if (!menuImgMsg?.payload?.text?.endsWith('.jpg') || !fs.existsSync(menuImgMsg.payload.text)) {
        throw new Error('Bild wurde nicht korrekt als Datei geschrieben!');
    }
    fs.unlinkSync(menuImgMsg.payload.text);

    // Bild-Datenpunkt + Skript kombiniert: Skript-Antwort wird zur Bildunterschrift (Vacuum-Status-Fall)
    fakeAdapter.sendTo = function (instance, command, message, callback) {
        if (
            instance === this.config.javascriptInstance &&
            command === 'toScript' &&
            message.script === 'script.js.Telegram.vacuum'
        ) {
            callback({ text: '🤖 Vacuum Status\n\nOnline: ✅ ja\nAkku: 87 %' });
        }
    };
    await fakeAdapter.scriptBridge.register('TG:VACUUMSTATUS', 'script.js.Test.vacuum');
    await fakeAdapter.setForeignStateAsync('0_userdata.0.VacuumImage', {
        val: `data:image/png;base64,${tinyPngBase64}`,
        ack: true,
    });
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        rows: [
            [
                {
                    text: '📊 Vacuum Status',
                    cmd: 'VacuumStatus',
                    scriptId: 'vacuum',
                    imageDatapoint: '0_userdata.0.VacuumImage',
                },
            ],
        ],
    });
    await fakeAdapter.setStateAsync('runtime.currentMenu', { val: 'main', ack: true });
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 📊 Vacuum Status');
    const vacuumImgMsg = sentMessages.at(-1);
    console.log('--- Bild + Skript kombiniert: caption aus Skript-Antwort ---', vacuumImgMsg?.payload?.caption);
    if (!vacuumImgMsg?.payload?.caption?.includes('Akku: 87 %')) {
        throw new Error('Skript-Antwort wurde nicht als Bildunterschrift verwendet!');
    }
    if (!vacuumImgMsg?.payload?.text?.endsWith('.jpg')) {
        throw new Error('Bild wurde nicht mitgeschickt!');
    }
    fs.unlinkSync(vacuumImgMsg.payload.text);

    // notify() mit Datei-Anhang (Entgeld/Post-Fall) - korrektes Schema:
    // text=Dateipfad, caption=eigentlicher Text, kommt sofort (keine Bündelung)
    await fakeAdapter.notify.registerAreas('post_test', { private: ['post.p1'] });
    await fakeAdapter.notify.approveArea('private');
    await fakeAdapter.setStateAsync('users.123456.permissions.private', { val: true, ack: true });
    sentMessages.length = 0;
    await fakeAdapter.notify('private', 'post.p1', '✉️ Ein Brief ist unterwegs.', {
        file: '/home/pi/iobroker/brief.png',
        caption: '✉️ Ein Brief ist unterwegs.',
    });
    const fileMsg = sentMessages.at(-1);
    console.log('--- notify() mit Datei-Anhang ---', fileMsg?.payload?.text, '|', fileMsg?.payload?.caption);
    if (fileMsg?.payload?.text !== '/home/pi/iobroker/brief.png') {
        throw new Error('Dateipfad landete nicht im "text"-Feld - falsches Schema!');
    }
    if (fileMsg?.payload?.caption !== '✉️ Ein Brief ist unterwegs.') {
        throw new Error('Bildunterschrift falsch!');
    }

    // HTML-Opt-in: Standard (kein extra.html) bleibt ohne parse_mode.
    // Typ "error" ist standardmäßig von der Bündelung ausgeschlossen, kommt
    // also sofort an (wie bei den Datei-Tests oben) statt erst nach der
    // Sammelphase.
    sentMessages.length = 0;
    await fakeAdapter.notify('private', 'error', 'Normaler Text ohne HTML');
    const plainMsg = sentMessages.at(-1);
    console.log('--- notify() ohne extra.html: parse_mode gesetzt? ---', plainMsg?.payload?.parse_mode);
    if (plainMsg?.payload?.parse_mode) {
        throw new Error('parse_mode wurde ohne extra.html trotzdem gesetzt!');
    }

    // Mit extra.html=true: parse_mode:'HTML' muss gesetzt sein.
    sentMessages.length = 0;
    await fakeAdapter.notify('private', 'error', '<b>Fett</b> und normal', { html: true });
    const htmlMsg = sentMessages.at(-1);
    console.log(
        '--- notify() mit extra.html=true: parse_mode ---',
        htmlMsg?.payload?.parse_mode,
        '|',
        htmlMsg?.payload?.text,
    );
    if (htmlMsg?.payload?.parse_mode !== 'HTML') {
        throw new Error('parse_mode:"HTML" wurde mit extra.html=true nicht gesetzt!');
    }
    if (htmlMsg?.payload?.text !== '<b>Fett</b> und normal') {
        throw new Error('HTML-Text wurde unerwartet verändert!');
    }

    // Kurzform extra: 'html' (statt {html: true}) muss gleichwertig funktionieren.
    sentMessages.length = 0;
    await fakeAdapter.notify('private', 'error', '<i>Kurzform</i>', 'html');
    const htmlShorthandMsg = sentMessages.at(-1);
    console.log('--- notify() mit extra="html" (Kurzform): parse_mode ---', htmlShorthandMsg?.payload?.parse_mode);
    if (htmlShorthandMsg?.payload?.parse_mode !== 'HTML') {
        throw new Error('Kurzform extra:"html" hat parse_mode nicht gesetzt!');
    }

    // noPreview via Kurzform "nopreview"
    sentMessages.length = 0;
    await fakeAdapter.notify('private', 'error', 'https://maps.apple.com/?q=Test', 'nopreview');
    const noPreviewMsg = sentMessages.at(-1);
    console.log(
        '--- notify() mit extra="nopreview": disable_web_page_preview ---',
        noPreviewMsg?.payload?.disable_web_page_preview,
    );
    if (noPreviewMsg?.payload?.disable_web_page_preview !== true) {
        throw new Error('Kurzform extra:"nopreview" hat disable_web_page_preview nicht gesetzt!');
    }

    // html + noPreview kombiniert via Kurzform "html,nopreview"
    sentMessages.length = 0;
    await fakeAdapter.notify(
        'private',
        'error',
        '<a href="https://maps.apple.com/?q=Test">Route</a>',
        'html,nopreview',
    );
    const combinedMsg = sentMessages.at(-1);
    console.log(
        '--- notify() mit extra="html,nopreview" ---',
        combinedMsg?.payload?.parse_mode,
        combinedMsg?.payload?.disable_web_page_preview,
    );
    if (combinedMsg?.payload?.parse_mode !== 'HTML' || combinedMsg?.payload?.disable_web_page_preview !== true) {
        throw new Error('Kombinierte Kurzform "html,nopreview" hat nicht beide Optionen gesetzt!');
    }

    // Der Blockly-sendTo-Block hat KEIN eigenes caption-Feld mehr - text wird
    // automatisch zur Bildunterschrift, simuliert hier den main.js-Zusammenbau direkt.
    const simulateNotifyMessage = msg => {
        const { area, type, text, file, extra } = msg || {};
        const fileExtra = file ? { file, caption: text } : extra;
        return { area, type, text, fileExtra };
    };
    const simulated = simulateNotifyMessage({
        area: 'private',
        type: 'salary.p1',
        text: 'Entgeltnachweis da',
        file: '/x.pdf',
    });
    console.log('--- Ohne eigenes caption-Feld: text wird automatisch Bildunterschrift ---', simulated.fileExtra);
    if (simulated.fileExtra.caption !== 'Entgeltnachweis da') {
        throw new Error('text wurde nicht automatisch zur Bildunterschrift!');
    }

    // Rechenoperation direkt im Platzhalter: Sekunden -> Minuten, gerundet
    await fakeAdapter.setForeignStateAsync('0_userdata.0.TestSekunden', { val: 125, ack: true });
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        message: 'Laufzeit: {{0_userdata.0.TestSekunden / 60}} Minuten',
        rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'main');
    console.log('--- Rechenoperation im Platzhalter (125/60 gerundet) ---', sentMessages.at(-1)?.payload?.text);
    if (sentMessages.at(-1)?.payload?.text !== 'Laufzeit: 2 Minuten') {
        throw new Error('Rechenoperation im Platzhalter falsch!');
    }

    // Verkettete Operation: Millisekunden -> Minuten
    await fakeAdapter.setForeignStateAsync('0_userdata.0.TestMs', { val: 185000, ack: true });
    await setMenu(fakeAdapter, 'main', {
        title: '🏠 Hauptmenü',
        message: '{{0_userdata.0.TestMs / 1000 / 60}} min',
        rows: [[{ text: '⬅️ Zurück', cmd: 'TG:NAV:BACK' }]],
    });
    sentMessages.length = 0;
    await fakeAdapter.router.renderMenu('123456', 'main');
    console.log('--- Verkettete Rechenoperation (185000/1000/60) ---', sentMessages.at(-1)?.payload?.text);
    if (sentMessages.at(-1)?.payload?.text !== '3 min') {
        throw new Error('Verkettete Rechenoperation falsch!');
    }

    // --- Freischalt-Gate für neue Nutzer ---
    // Frischer, noch nie gesehener Chat -> statt Hauptmenü nur die Warte-Nachricht.
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[555555] /start');
    const pendingMsg = sentMessages.find(m => m.payload?.user === '555555');
    console.log('--- Warte-Nachricht für frischen Nutzer ---', pendingMsg?.payload?.text);
    if (pendingMsg?.payload?.text !== '⏳ Warte auf Freischaltung durch den Admin.') {
        throw new Error('Frischer Nutzer hat nicht die Warte-Nachricht bekommen!');
    }

    // Admin (123456) muss dafür eine Nachricht mit Inline-Keyboard bekommen haben.
    const adminUserMsg = sentMessages.find(
        m => m.payload?.user === '123456' && m.payload?.reply_markup?.inline_keyboard,
    );
    console.log(
        '--- Admin-Benachrichtigung bei neuem Nutzer ---',
        adminUserMsg?.payload?.text,
        JSON.stringify(adminUserMsg?.payload?.reply_markup?.inline_keyboard),
    );
    if (!adminUserMsg) {
        throw new Error('Admin wurde nicht über wartenden Nutzer benachrichtigt!');
    }
    const approveUserCallback = adminUserMsg.payload.reply_markup.inline_keyboard[0][0].callback_data;
    if (approveUserCallback !== 'TG:ADMIN:APPROVEUSER:555555') {
        throw new Error('Falsches callback_data für Nutzer-Erlauben-Button!');
    }

    // Erneute Nachricht VOR Freischaltung -> weiterhin nur die Warte-Nachricht,
    // keine erneute Admin-Benachrichtigung (kein Spam bei wiederholten Versuchen).
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[555555] Irgendwas');
    console.log('--- Nachricht vor Freischaltung (2. Versuch) ---', sentMessages.at(-1)?.payload?.text);
    if (sentMessages.at(-1)?.payload?.text !== '⏳ Warte auf Freischaltung durch den Admin.') {
        throw new Error('Wartender Nutzer kam trotzdem durch!');
    }
    if (sentMessages.some(m => m.payload?.reply_markup?.inline_keyboard)) {
        throw new Error('Admin wurde beim 2. Versuch erneut benachrichtigt - sollte nur einmalig sein!');
    }

    // Admin tippt auf "Erlauben" -> Nutzer sofort freigeschaltet + bekommt sein Hauptmenü
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming(`[123456] ${approveUserCallback}`);
    const newUserMenu = sentMessages.find(m => m.payload?.user === '555555');
    console.log('--- Nutzer nach Freischaltung ---', newUserMenu?.payload?.text);
    if (!newUserMenu || newUserMenu.payload.text === '⏳ Warte auf Freischaltung durch den Admin.') {
        throw new Error('Nutzer hat nach Freischaltung nicht sein Hauptmenü bekommen!');
    }

    // Jetzt normale Nutzung möglich (aber weiterhin ohne jede perm-Berechtigung, Rolle bleibt "guest")
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[555555] /menu');
    console.log('--- Freigeschalteter Nutzer, /menu ---', sentMessages.at(-1)?.payload?.text);
    if (sentMessages.at(-1)?.payload?.text === '⏳ Warte auf Freischaltung durch den Admin.') {
        throw new Error('Freigeschalteter Nutzer wird immer noch blockiert!');
    }

    // Zweiter frischer Nutzer wird stattdessen ABGELEHNT -> komplett gelöscht,
    // eine erneute Nachricht behandelt ihn wieder als brandneuen Nutzer.
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[666666] /start');
    const denyMsg = sentMessages.find(m => m.payload?.reply_markup?.inline_keyboard && m.payload?.user === '123456');
    const denyCallback = denyMsg.payload.reply_markup.inline_keyboard[0][1].callback_data;
    if (denyCallback !== 'TG:ADMIN:DENYUSER:666666') {
        throw new Error('Falsches callback_data für Nutzer-Ablehnen-Button!');
    }
    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming(`[123456] ${denyCallback}`);
    const deniedUserObj = await fakeAdapter.getObjectAsync('users.666666.role');
    console.log('--- Nutzer-Objekt nach Ablehnung noch vorhanden? ---', !!deniedUserObj);
    if (deniedUserObj) {
        throw new Error('Abgelehnter Nutzer wurde nicht gelöscht!');
    }

    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[666666] /start');
    console.log('--- Erneuter Kontakt nach Ablehnung (wieder brandneu?) ---', sentMessages.at(-1)?.payload?.text);
    if (sentMessages.at(-1)?.payload?.text !== '⏳ Warte auf Freischaltung durch den Admin.') {
        throw new Error('Nutzer wurde nach Ablehnung nicht wieder als brandneu behandelt!');
    }

    fakeAdapter._clearNotifyTimers();
    // --- Event-Listener -> automatisches Menü ---
    const { setupEventTriggers, handleEventTriggerStateChange } = require('../core/eventTriggers');
    const { ensureUser } = require('../core/users');

    const { key: triggerUserKey } = await ensureUser(fakeAdapter, '777777');
    await fakeAdapter.setStateAsync(`users.${triggerUserKey}.approved`, { val: true, ack: true });

    await importRegistry(fakeAdapter, {
        trigger_test_menu: { title: 'Alarm', trigger: { datapoint: '0_userdata.0.Test.Alarm', value: 'true' } },
        trigger_test_menu_gt: { title: 'Zu heiß', trigger: { datapoint: '0_userdata.0.Test.Temp', value: '>25' } },
    });

    await setupEventTriggers(fakeAdapter);

    const triggeredCalls = [];
    const mockRenderMenu = async (chatId, menuKey) => triggeredCalls.push({ chatId, menuKey });

    // Exakter Treffer
    await handleEventTriggerStateChange(
        fakeAdapter,
        '0_userdata.0.Test.Alarm',
        { val: true, ack: true },
        mockRenderMenu,
    );
    console.log('--- Event-Trigger (exakt, true) ---', triggeredCalls);
    if (!triggeredCalls.some(c => c.menuKey === 'trigger_test_menu' && c.chatId === '777777')) {
        throw new Error('Event-Trigger (exakter Wert) hat das Menü nicht ausgelöst!');
    }

    // Kein Treffer (falscher Wert)
    triggeredCalls.length = 0;
    await handleEventTriggerStateChange(
        fakeAdapter,
        '0_userdata.0.Test.Alarm',
        { val: false, ack: true },
        mockRenderMenu,
    );
    if (triggeredCalls.length) {
        throw new Error('Event-Trigger hat trotz falschem Wert ausgelöst!');
    }

    // Operator-Vergleich (>25)
    triggeredCalls.length = 0;
    await handleEventTriggerStateChange(fakeAdapter, '0_userdata.0.Test.Temp', { val: 27, ack: true }, mockRenderMenu);
    console.log('--- Event-Trigger (>25, Wert 27) ---', triggeredCalls);
    if (!triggeredCalls.some(c => c.menuKey === 'trigger_test_menu_gt')) {
        throw new Error('Event-Trigger mit Operator ">25" hat bei 27 nicht ausgelöst!');
    }

    triggeredCalls.length = 0;
    await handleEventTriggerStateChange(fakeAdapter, '0_userdata.0.Test.Temp', { val: 20, ack: true }, mockRenderMenu);
    if (triggeredCalls.length) {
        throw new Error('Event-Trigger mit Operator ">25" hat bei 20 fälschlich ausgelöst!');
    }

    // Nicht abonnierter Datenpunkt -> no-op, kein Fehler
    await handleEventTriggerStateChange(
        fakeAdapter,
        '0_userdata.0.Irrelevant.Datenpunkt',
        { val: true, ack: true },
        mockRenderMenu,
    );

    // Nicht freigeschalteter Nutzer bekommt das Menü nicht
    await ensureUser(fakeAdapter, '777778');
    triggeredCalls.length = 0;
    await handleEventTriggerStateChange(
        fakeAdapter,
        '0_userdata.0.Test.Alarm',
        { val: true, ack: true },
        mockRenderMenu,
    );
    if (triggeredCalls.some(c => c.chatId === '777778')) {
        throw new Error('Event-Trigger hat einen nicht freigeschalteten Nutzer benachrichtigt!');
    }
    if (!triggeredCalls.some(c => c.chatId === '777777')) {
        throw new Error(
            'Event-Trigger hat den freigeschalteten Nutzer bei erneutem Treffer nicht mehr benachrichtigt!',
        );
    }

    // --- HTTP-Request-Button ---
    const fetchCalls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
        fetchCalls.push({ url, opts });
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ hello: 'world' }),
        };
    };

    await setMenu(fakeAdapter, 'http_test_menu', {
        title: 'HTTP Test',
        rows: [
            [
                {
                    text: '🌐 Webhook auslösen',
                    httpUrl: 'https://example.invalid/webhook',
                    httpMethod: 'POST',
                    httpBody: '{"x":1}',
                },
                {
                    text: '🔐 Mit Auth',
                    httpUrl: 'https://example.invalid/secure',
                    httpAuthUser: 'bob',
                    httpAuthPass: 'secret',
                    message: 'Status: {status} | {response}',
                },
            ],
        ],
    });
    await fakeAdapter.setStateAsync('runtime.currentMenu', { val: 'http_test_menu', ack: true });

    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 🌐 Webhook auslösen');
    console.log('--- HTTP-Button: fetch aufgerufen mit ---', fetchCalls.at(-1));
    if (fetchCalls.at(-1)?.url !== 'https://example.invalid/webhook') {
        throw new Error('HTTP-Button hat die falsche URL aufgerufen!');
    }
    if (fetchCalls.at(-1)?.opts?.method !== 'POST') {
        throw new Error('HTTP-Button hat nicht die konfigurierte Methode (POST) verwendet!');
    }
    if (fetchCalls.at(-1)?.opts?.body !== '{"x":1}') {
        throw new Error('HTTP-Button hat den Body nicht mitgeschickt!');
    }
    const httpConfirmMsg = sentMessages.at(-1);
    console.log('--- HTTP-Button Bestätigung ---', httpConfirmMsg?.payload?.text);
    if (!httpConfirmMsg?.payload?.text?.includes('HTTP 200')) {
        throw new Error('HTTP-Button-Bestätigung zeigt nicht den Status-Code!');
    }

    sentMessages.length = 0;
    await fakeAdapter.router.handleIncoming('[123456] 🔐 Mit Auth');
    const authHeader = fetchCalls.at(-1)?.opts?.headers?.Authorization;
    console.log('--- HTTP-Button mit Auth: Authorization-Header ---', authHeader);
    const expectedAuth = `Basic ${Buffer.from('bob:secret').toString('base64')}`;
    if (authHeader !== expectedAuth) {
        throw new Error('HTTP-Button hat den Basic-Auth-Header nicht korrekt gesetzt!');
    }
    const authConfirmMsg = sentMessages.at(-1);
    console.log('--- HTTP-Button mit Auth, eigene Nachricht mit Platzhaltern ---', authConfirmMsg?.payload?.text);
    if (!authConfirmMsg?.payload?.text?.includes('Status: 200') || !authConfirmMsg?.payload?.text?.includes('hello')) {
        throw new Error('HTTP-Button hat {status}/{response}-Platzhalter nicht korrekt ersetzt!');
    }

    // Fehlerfall: fetch wirft -> freundliche Fehlermeldung statt Absturz
    global.fetch = async () => {
        throw new Error('ECONNREFUSED');
    };
    sentMessages.length = 0;
    await setMenu(fakeAdapter, 'http_test_menu', {
        title: 'HTTP Test',
        rows: [[{ text: '💥 Kaputter Endpunkt', httpUrl: 'https://example.invalid/down' }]],
    });
    await fakeAdapter.router.handleIncoming('[123456] 💥 Kaputter Endpunkt');
    const httpErrorMsg = sentMessages.at(-1);
    console.log('--- HTTP-Button Fehlerfall ---', httpErrorMsg?.payload?.text);
    if (!httpErrorMsg?.payload?.text?.includes('fehlgeschlagen')) {
        throw new Error('HTTP-Button hat den Fehlerfall nicht sauber abgefangen!');
    }

    global.fetch = originalFetch;

    console.log('\n✅ Smoke-Test durchgelaufen ohne Exception.');
}

run().catch(e => {
    console.error('❌ Smoke-Test fehlgeschlagen:', e);
    process.exit(1);
});
