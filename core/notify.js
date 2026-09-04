'use strict';

const { ensureDynamicState } = require('./states');
const { listAdminChatIds } = require('./users');
const { getMenu } = require('./registry');

const GROUP_WINDOW_MS = 15000;
const AREAS_STATE = 'notify.areas';

function createNotifyEngine(adapter) {
    const buffers = {}; // userKey -> [{area, type, text}]
    const timers = {}; // userKey -> Timeout
    // area -> { types: Set, approved: bool, override: Set(types) }
    const validAreas = {};
    const groupable = {}; // area -> Set(types) -- welche Typen gesammelt statt sofort gesendet werden

    function ensureAreaEntry(area, approvedDefault) {
        if (!validAreas[area]) {
            validAreas[area] = {
                types: new Set(),
                approved: approvedDefault,
                override: new Set(),
                labels: {},
                areaLabel: '',
                pausedUntil: 0,
            };
        }
        return validAreas[area];
    }

    // Persistiert den aktuellen Stand in telegrammenu2.0.notify.areas - dort
    // kannst du auch selbst Bereiche eintragen (JSON-State direkt in Admin
    // bearbeiten), bevor irgendein notify()-Aufruf oder Modul sie kennt.
    async function persist() {
        const obj = {};
        for (const [area, entry] of Object.entries(validAreas)) {
            obj[area] = {
                types: [...entry.types],
                approved: !!entry.approved,
                override: [...entry.override],
                labels: entry.labels || {},
                areaLabel: entry.areaLabel || '',
                pausedUntil: entry.pausedUntil || 0,
            };
        }
        await ensureDynamicState(adapter, AREAS_STATE, '{}', 'json');
        await adapter.setStateAsync(AREAS_STATE, { val: JSON.stringify(obj), ack: true });
    }

    // Beim Adapter-Start aufgerufen: lädt vorher gespeicherte/manuell
    // eingetragene Bereiche, bevor Module ihre eigenen registrieren.
    async function init() {
        await ensureDynamicState(adapter, AREAS_STATE, '{}', 'json');
        const state = await adapter.getStateAsync(AREAS_STATE);
        try {
            const obj = JSON.parse(state?.val || '{}');
            for (const [area, entry] of Object.entries(obj)) {
                // Abwärtskompatibel: alte Form war einfach ein Array von Typen.
                if (Array.isArray(entry)) {
                    validAreas[area] = {
                        types: new Set(entry),
                        approved: true,
                        override: new Set(),
                        labels: {},
                        areaLabel: '',
                        pausedUntil: 0,
                    };
                } else {
                    validAreas[area] = {
                        types: new Set(entry.types || []),
                        approved: !!entry.approved,
                        override: new Set(entry.override || []),
                        labels: entry.labels || {},
                        areaLabel: entry.areaLabel || '',
                        pausedUntil: entry.pausedUntil || 0,
                    };
                }
            }
        } catch (e) {
            adapter.log.warn(`notify: ${AREAS_STATE} konnte nicht gelesen werden: ${e.message}`);
        }
    }

    // Module rufen das beim Laden auf (core/moduleLoader.js) oder der Editor-Tab
    // beim expliziten Eintragen - beides gilt als vertrauenswürdig und wird
    // sofort freigegeben (approved), im Gegensatz zum automatischen Entdecken
    // bei send() (siehe unten), das erst manuell freigeschaltet werden muss.
    async function registerAreas(moduleId, areas, groupableTypes = []) {
        for (const [area, types] of Object.entries(areas || {})) {
            const entry = ensureAreaEntry(area, true);
            entry.approved = true;
            types.forEach(t => entry.types.add(t));
            if (groupableTypes.includes(area)) {
                groupable[area] = entry.types;
            }
        }
        await persist();
    }

    async function approveArea(area) {
        const entry = validAreas[area];
        if (!entry) {
            return false;
        }
        entry.approved = true;
        await persist();
        return true;
    }

    async function setOverride(area, type, isOverride) {
        const entry = ensureAreaEntry(area, true);
        if (isOverride) {
            entry.override.add(type);
        } else {
            entry.override.delete(type);
        }
        await persist();
    }

    async function setTypeLabel(area, type, label) {
        const entry = ensureAreaEntry(area, true);
        if (label) {
            entry.labels[type] = label;
        } else {
            delete entry.labels[type];
        }
        await persist();
    }

    async function setAreaLabel(area, label) {
        const entry = ensureAreaEntry(area, true);
        entry.areaLabel = label || '';
        await persist();
    }

    async function deleteArea(area) {
        if (!validAreas[area]) {
            return false;
        }
        delete validAreas[area];
        delete groupable[area];
        await persist();
        return true;
    }

    function getAllAreasFull() {
        const out = {};
        for (const [area, entry] of Object.entries(validAreas)) {
            out[area] = {
                types: [...entry.types],
                approved: !!entry.approved,
                override: [...entry.override],
                labels: entry.labels || {},
                areaLabel: entry.areaLabel || '',
            };
        }
        return out;
    }

    function getLabel(area, type) {
        return validAreas[area]?.labels?.[type] || type;
    }

    function isOverride(area, type) {
        return !!validAreas[area]?.override?.has(type);
    }

    function getAreaLabel(area) {
        return validAreas[area]?.areaLabel || '';
    }

    // Nur freigegebene Bereiche - das ist es, was im "Benachrichtigungen"-Menü
    // und im Editor standardmäßig auftaucht.
    function getValidAreas() {
        const out = {};
        for (const [area, entry] of Object.entries(validAreas)) {
            if (!entry.approved) {
                continue;
            }
            out[area] = [...entry.types];
        }
        return out;
    }

    // Automatisch entdeckte, aber noch nicht freigeschaltete Bereiche - z. B.
    // Testnachrichten von fremden Adaptern, die noch nicht überall auftauchen sollen.
    function getPendingAreas() {
        const out = {};
        for (const [area, entry] of Object.entries(validAreas)) {
            if (entry.approved) {
                continue;
            }
            out[area] = [...entry.types];
        }
        return out;
    }

    async function deliverToUser(userChatId, text, html = false, noPreview = false) {
        try {
            const payload = { text, user: userChatId };
            if (html) {
                payload.parse_mode = 'HTML';
            }
            if (noPreview) {
                payload.disable_web_page_preview = true;
            }
            await adapter.sendToAsync(adapter.telegramInstance, payload);
        } catch (e) {
            adapter.log.warn(`notify: Senden an ${userChatId} fehlgeschlagen: ${e.message}`);
        }
    }

    async function flush(userKey, userChatId) {
        const items = buffers[userKey] || [];
        delete buffers[userKey];
        delete timers[userKey];
        if (!items.length) {
            return;
        }
        const text = items.map(i => i.text).join('\n\n');
        // Nur wenn ALLE gebündelten Nachrichten html/noPreview angefordert haben,
        // wird das für die ganze zusammengefasste Nachricht übernommen - sonst
        // könnte z.B. ein "<"/">" aus einer unbeteiligten Plain-Text-Nachricht im
        // selben Bündel versehentlich als kaputtes HTML-Tag interpretiert werden.
        const allHtml = items.every(i => i.html);
        const allNoPreview = items.every(i => i.noPreview);
        await deliverToUser(userChatId, text, allHtml, allNoPreview);
    }

    // Bereich für X Stunden pausieren - "warn"/"error" kommen trotzdem durch
    // (wichtige Sachen wie Wetterwarnungen sollen nicht mitpausiert werden,
    // nur die informativen/erinnernden Meldungen).
    async function pauseArea(area, hours = 24) {
        const entry = ensureAreaEntry(area, true);
        entry.pausedUntil = Date.now() + hours * 3600000;
        await persist();
    }

    async function unpauseArea(area) {
        const entry = validAreas[area];
        if (!entry) {
            return;
        }
        entry.pausedUntil = 0;
        await persist();
    }

    function isAreaPaused(area) {
        const entry = validAreas[area];
        return !!(entry && entry.pausedUntil && entry.pausedUntil > Date.now());
    }

    function getAreaPausedUntil(area) {
        const entry = validAreas[area];
        return entry && entry.pausedUntil > Date.now() ? entry.pausedUntil : 0;
    }

    // Schickt allen Admins eine Nachricht mit Inline-Buttons "Erlauben"/"Nicht
    // erlauben" - unabhängig von der laufenden Unterhaltung (Inline-Buttons
    // stören die normale Tastatur/Eingabe-Warteschlange nicht, siehe callback_query).
    async function notifyAdminsAboutPendingArea(area, type) {
        try {
            const chatIds = await listAdminChatIds(adapter);
            if (!chatIds.length) {
                return;
            }
            const text = `🔔 Ein Adapter möchte Benachrichtigungen im Bereich "${area}"${type ? ` (Typ: ${type})` : ''} senden.\n\nErlauben?`;
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: '✅ Erlauben', callback_data: `TG:ADMIN:APPROVEAREA:${area}` },
                        { text: '❌ Nicht erlauben', callback_data: `TG:ADMIN:DENYAREA:${area}` },
                    ],
                ],
            };
            for (const chatId of chatIds) {
                await adapter.sendToAsync(adapter.telegramInstance, { text, user: chatId, reply_markup: keyboard });
            }
        } catch (e) {
            adapter.log.warn(`notify: Admin-Benachrichtigung für neuen Bereich "${area}" fehlgeschlagen: ${e.message}`);
        }
    }

    // Globale Option "diese Typen NICHT bündeln" - frei definierbar, versteckt
    // im Hauptmenü-Knoten im Editor (Menü-Schlüssel "main"). Alles, was NICHT
    // in dieser Liste steht, wird standardmäßig gebündelt (Ausschluss- statt
    // Einschluss-Liste) - Default ohne jede Konfiguration: warn,error bleiben
    // sofort einzeln, alles andere (z. B. info) wird gesammelt.
    async function isGloballyGroupableType(type) {
        try {
            const mainDef = await getMenu(adapter, 'main');
            const groupingEnabled = mainDef?.groupingEnabled !== false; // Standard: an, außer explizit ausgeschaltet
            if (!groupingEnabled) {
                return false;
            }
            const excludeTypes = Array.isArray(mainDef?.groupableExcludeTypes)
                ? mainDef.groupableExcludeTypes
                : ['warn', 'error'];
            return !excludeTypes.includes(type);
        } catch {
            return false;
        }
    }

    // send(area, type, text) — gleiche Signatur wie das alte notify(area, type, text, extra)
    async function send(area, type, text, extra = null) {
        if (!text || !area) {
            return;
        }

        // Opt-in Formatierung über "extra": entweder als Objekt {html, noPreview}
        // ODER als Kurzform-String, z.B. 'html', 'nopreview' oder kombiniert
        // 'html,nopreview'. Standard (kein extra bzw. andere Werte) bleibt reiner
        // Text mit normaler Link-Vorschau wie bisher.
        let html = false;
        let noPreview = false;
        if (typeof extra === 'string') {
            const parts = extra.split(',').map(s => s.trim().toLowerCase());
            html = parts.includes('html');
            noPreview = parts.includes('nopreview') || parts.includes('no-preview');
        } else if (extra && typeof extra === 'object') {
            html = !!extra.html;
            noPreview = !!(extra.noPreview || extra.disablePreview);
        }

        // Bereich taucht NICHT sofort in der "Benachrichtigungen"-Liste auf, wenn
        // er zum ersten Mal automatisch entdeckt wird (z. B. Testnachrichten von
        // fremden Adaptern) - muss erst per approveArea() freigeschaltet werden.
        // Module/Editor-Eintragungen sind davon ausgenommen (siehe registerAreas).
        const isNewArea = !validAreas[area];
        const entry = ensureAreaEntry(area, false);
        let changed = isNewArea;
        if (type && !entry.types.has(type)) {
            entry.types.add(type);
            changed = true;
        }
        if (changed) {
            if (!entry.approved) {
                adapter.log.info(
                    `notify: neuer Bereich "${area}" automatisch entdeckt, wartet auf Freischaltung (approveArea)`,
                );
            }
            await persist();
        }
        if (isNewArea && !entry.approved) {
            await notifyAdminsAboutPendingArea(area, type);
        }

        // Unfreigeschaltete Bereiche liefern gar nicht erst zu - nicht nur
        // "unsichtbar im Menü", sondern wirklich blockiert, bis approveArea()
        // aufgerufen wurde. So spammen Testnachrichten fremder Adapter niemanden voll.
        if (!entry.approved) {
            adapter.log.debug(`notify: Bereich "${area}" noch nicht freigeschaltet - Nachricht verworfen`);
            return;
        }

        // Pausierter Bereich: nur "warn"/"error" kommen trotzdem durch (echte
        // Warnungen sollen nicht mitpausiert werden), alles andere wird verworfen.
        if (isAreaPaused(area) && type !== 'warn' && type !== 'error') {
            adapter.log.debug(
                `notify: Bereich "${area}" pausiert bis ${new Date(entry.pausedUntil).toISOString()} - Nachricht verworfen`,
            );
            return;
        }

        const users = await adapter.getStateAsync('runtime.usersJson');
        let userKeys = [];
        try {
            userKeys = JSON.parse(users?.val || '[]');
        } catch {
            userKeys = [];
        }

        for (const userKey of userKeys) {
            const permState = await adapter.getStateAsync(`users.${userKey}.permissions.${area}`);
            const allowed = permState?.val === true || permState?.val === 'true' || permState?.val === 1;
            if (!allowed) {
                continue;
            }

            // Override-Typen ignorieren die Benachrichtigungs-Präferenz komplett -
            // "kann nicht ausgeschaltet werden", solange das Zugriffsrecht besteht.
            const isOverride = entry.override.has(type);
            if (!isOverride) {
                const notifyType = type || 'general';
                const notifyPrefState = await adapter.getStateAsync(`users.${userKey}.notify.${area}.${notifyType}`);
                const notifyEnabled = notifyPrefState
                    ? notifyPrefState.val === true || notifyPrefState.val === 'true'
                    : true;
                if (!notifyEnabled) {
                    continue;
                }
            }

            const chatState = await adapter.getStateAsync(`users.${userKey}.chatId`);
            const chatId = chatState?.val;
            if (!chatId) {
                continue;
            }

            const isGroupable = (groupable[area] && groupable[area].has(type)) || (await isGloballyGroupableType(type));

            if (extra && extra.file) {
                const filePayload = {
                    text: extra.file,
                    caption: extra.caption || text,
                    user: chatId,
                };
                if (html) {
                    filePayload.parse_mode = 'HTML';
                }
                if (noPreview) {
                    filePayload.disable_web_page_preview = true;
                }
                await adapter.sendToAsync(adapter.telegramInstance, filePayload);
                continue;
            }

            if (!isGroupable) {
                await deliverToUser(chatId, text, html, noPreview);
                continue;
            }

            buffers[userKey] = buffers[userKey] || [];
            buffers[userKey].push({ area, type, text, html, noPreview });

            if (!timers[userKey]) {
                timers[userKey] = adapter.setTimeout(() => flush(userKey, chatId), GROUP_WINDOW_MS);
            }
        }
    }

    function clearTimers() {
        Object.values(timers).forEach(t => adapter.clearTimeout(t));
    }

    // Liefert alle gerade gesammelten (gebündelten, aber noch nicht
    // verschickten) Nachrichten SOFORT aus - wird beim Adapter-Stopp
    // aufgerufen, damit nichts verloren geht, nur weil ein Update/Neustart
    // genau in die 15-Sekunden-Sammelphase fällt (buffers/timers leben nur im
    // Arbeitsspeicher, ein Neustart ohne diesen Flush würde sie sonst stillschweigend verwerfen).
    async function flushAllPending() {
        const userKeys = Object.keys(buffers);
        for (const userKey of userKeys) {
            const chatState = await adapter.getStateAsync(`users.${userKey}.chatId`);
            const chatId = chatState?.val;
            if (chatId) {
                await flush(userKey, chatId);
            }
        }
        clearTimers();
    }

    return {
        init,
        send,
        registerAreas,
        getValidAreas,
        getPendingAreas,
        approveArea,
        setOverride,
        isOverride,
        setTypeLabel,
        getLabel,
        setAreaLabel,
        getAreaLabel,
        deleteArea,
        getAllAreasFull,
        clearTimers,
        flushAllPending,
        pauseArea,
        unpauseArea,
        isAreaPaused,
        getAreaPausedUntil,
    };
}

module.exports = { createNotifyEngine };
