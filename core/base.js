'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getMenu } = require('./registry');
const {
    ensureUser,
    userToKey,
    hasPermission,
    isAdmin,
    isApproved,
    approveUser,
    denyUser,
    notifyAdminsAboutPendingUser,
} = require('./users');
const { resolveTemplate, resolveIcon, resolveIconRule } = require('./template');
const { buildAutoRows } = require('./autoMenus');
const { findModuleForCommand } = require('./moduleLoader');
const { handleAdminCommand } = require('./admin');
const { handleNotifyToggle } = require('./settings');
const { handleValueSetCommand, handleValueCustomCommand } = require('./valueSubmenus');
const { ensureDynamicState } = require('./states');

// Wandelt Texteingaben aus dem Editor (On/Off-Wert-Felder) in den passenden
// JS-Typ um, damit z. B. "true"/"false"/Zahlen nicht versehentlich als
// String im Datenpunkt landen.
function coerceValue(raw) {
    if (raw === 'true') {
        return true;
    }
    if (raw === 'false') {
        return false;
    }
    if (raw !== '' && !isNaN(Number(raw))) {
        return Number(raw);
    }
    return raw;
}

// Echter Ziffernblock als Telegram-Tastatur für Zahleneingabe - Texteingabe
// bleibt normales Tippen über die Handy-Tastatur.
const NUMPAD_ROWS = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['.', '0', '⌫'],
    ['✅ Fertig', '❌ Abbrechen'],
];

function numpadPromptText(prompt, buffer) {
    return `${prompt}\n\nEingabe: ${buffer || '_'}`;
}

function createRouter(adapter) {
    async function getHistory() {
        const s = await adapter.getStateAsync('runtime.historyJson');
        try {
            return JSON.parse(s?.val || '[]');
        } catch {
            return [];
        }
    }

    async function setHistory(arr) {
        await adapter.setStateAsync('runtime.historyJson', { val: JSON.stringify(arr || []), ack: true });
    }

    async function pushMenu(menuKey) {
        const h = await getHistory();
        h.push(menuKey);
        await setHistory(h);
    }

    async function setInputMode(mode, context = '') {
        await adapter.setStateAsync('runtime.inputMode', { val: mode || '', ack: true });
        await adapter.setStateAsync('runtime.inputContext', { val: context || '', ack: true });
    }

    async function clearInputMode() {
        await setInputMode('', '');
    }

    // Verarbeitet die Antwort auf eine Zahlen-/Texteingabe-Anfrage (siehe
    // "Datenpunkt (direkt lesen/schreiben)" bei Zahlen-/Text-Knoten im Editor).
    async function handleDatapointInput(user, userKey, rawText) {
        const contextState = await adapter.getStateAsync('runtime.inputContext');
        let ctx;
        try {
            ctx = JSON.parse(contextState?.val || '{}');
        } catch {
            ctx = {};
        }
        await clearInputMode();

        if (!ctx.datapoint) {
            await sendText(user, '⚠️ Eingabe-Kontext verloren, bitte Button erneut antippen.');
            return;
        }

        let value = rawText;
        if (ctx.inputType === 'number') {
            const num = Number(String(rawText).replace(',', '.'));
            if (Number.isNaN(num)) {
                await sendText(user, '⚠️ Das ist keine gültige Zahl. Bitte Button erneut antippen.');
                return;
            }
            if (ctx.min !== undefined && ctx.min !== '' && num < Number(ctx.min)) {
                await sendText(user, `⚠️ Wert muss mindestens ${ctx.min} sein. Bitte Button erneut antippen.`);
                return;
            }
            if (ctx.max !== undefined && ctx.max !== '' && num > Number(ctx.max)) {
                await sendText(user, `⚠️ Wert darf höchstens ${ctx.max} sein. Bitte Button erneut antippen.`);
                return;
            }
            value = num;
        }

        try {
            await adapter.setForeignStateAsync(ctx.datapoint, { val: value, ack: false });
            const confirmText = ctx.message ? await resolveTemplate(adapter, ctx.message) : `✅ Gespeichert: ${value}`;
            if (ctx.menuKey) {
                await renderMenu(user, ctx.menuKey, confirmText);
            } else {
                await sendText(user, confirmText);
            }
        } catch (e) {
            adapter.log.warn(`Eingabe-Datenpunkt ${ctx.datapoint} fehlgeschlagen: ${e.message}`);
            await sendText(user, `⚠️ Datenpunkt ${ctx.datapoint} konnte nicht geschrieben werden.`);
        }
    }

    // Verarbeitet jeden Tastendruck auf dem Ziffernblock (Zahlen-Eingabe-Modus).
    async function handleNumpadInput(user, userKey, key) {
        const contextState = await adapter.getStateAsync('runtime.inputContext');
        let ctx;
        try {
            ctx = JSON.parse(contextState?.val || '{}');
        } catch {
            ctx = {};
        }

        if (!ctx.datapoint) {
            await clearInputMode();
            await sendText(user, '⚠️ Eingabe-Kontext verloren, bitte Button erneut antippen.');
            return;
        }

        if (key === '❌ Abbrechen') {
            await clearInputMode();
            if (ctx.menuKey) {
                await renderMenu(user, ctx.menuKey, '❌ Abgebrochen.');
            } else {
                await sendText(user, '❌ Abgebrochen.');
            }
            return;
        }

        if (key === '✅ Fertig') {
            const num = Number(String(ctx.buffer || '').replace(',', '.'));
            if (!ctx.buffer || Number.isNaN(num)) {
                // Ungültig -> komplett zurücksetzen, von vorne beginnen (wie gewünscht).
                await setInputMode('datapoint_numpad', JSON.stringify({ ...ctx, buffer: '' }));
                await sendMenu(
                    user,
                    numpadPromptText(`⚠️ Ungültige Zahl, bitte neu eingeben. ${ctx.prompt || ''}`, ''),
                    NUMPAD_ROWS,
                );
                return;
            }
            if (ctx.min !== undefined && ctx.min !== '' && num < Number(ctx.min)) {
                await setInputMode('datapoint_numpad', JSON.stringify({ ...ctx, buffer: '' }));
                await sendMenu(
                    user,
                    numpadPromptText(`⚠️ Mindestens ${ctx.min}, bitte neu eingeben. ${ctx.prompt || ''}`, ''),
                    NUMPAD_ROWS,
                );
                return;
            }
            if (ctx.max !== undefined && ctx.max !== '' && num > Number(ctx.max)) {
                await setInputMode('datapoint_numpad', JSON.stringify({ ...ctx, buffer: '' }));
                await sendMenu(
                    user,
                    numpadPromptText(`⚠️ Höchstens ${ctx.max}, bitte neu eingeben. ${ctx.prompt || ''}`, ''),
                    NUMPAD_ROWS,
                );
                return;
            }
            await clearInputMode();
            try {
                await adapter.setForeignStateAsync(ctx.datapoint, { val: num, ack: false });
                const confirmText = ctx.message
                    ? await resolveTemplate(adapter, ctx.message.replace(/\{value\}/g, String(num)))
                    : `✅ Gespeichert: ${num}`;
                if (ctx.menuKey) {
                    await renderMenu(user, ctx.menuKey, confirmText);
                } else {
                    await sendText(user, confirmText);
                }
            } catch (e) {
                adapter.log.warn(`Eingabe-Datenpunkt ${ctx.datapoint} fehlgeschlagen: ${e.message}`);
                await sendText(user, `⚠️ Datenpunkt ${ctx.datapoint} konnte nicht geschrieben werden.`);
            }
            return;
        }

        // Ziffer/Punkt/Löschen: nur still im Hintergrund puffern, KEINE Antwort
        // schicken - sonst eine Bot-Nachricht pro Tastendruck (Spam). Die
        // Zahlen-Tastatur bleibt vom ersten Senden an ohnehin sichtbar, muss
        // dafür nicht erneut geschickt werden.
        let buffer = ctx.buffer || '';
        if (key === '⌫') {
            buffer = buffer.slice(0, -1);
        } else if (key === '.') {
            if (!buffer.includes('.')) {
                buffer += '.';
            }
        } else if (/^[0-9]$/.test(key)) {
            buffer += key;
        } else {
            return;
        } // unbekannte Eingabe (z. B. versehentlich Text) -> ignorieren, kein State-Update nötig

        await setInputMode('datapoint_numpad', JSON.stringify({ ...ctx, buffer }));
    }

    // Verarbeitet die Antwort auf eine Skript-Rückfrage (callback({text, awaitReply:true})).
    // Ruft dasselbe Skript/denselben Command nochmal auf, diesmal mit data.isReply=true
    // und dem getippten Text als data.value - das Skript entscheidet selbst, ob es
    // fertig ist oder nochmal nachfragt (verkettbar für mehrstufige Abläufe).
    async function handleScriptReply(user, userKey, text) {
        const contextState = await adapter.getStateAsync('runtime.inputContext');
        let ctx;
        try {
            ctx = JSON.parse(contextState?.val || '{}');
        } catch {
            ctx = {};
        }
        await clearInputMode();

        if (!ctx.scriptId || !ctx.cmd) {
            await sendText(user, '⚠️ Eingabe-Kontext verloren, bitte Button erneut antippen.');
            return;
        }

        const result = await adapter.scriptBridge.callScript(ctx.scriptId, ctx.cmd, {
            value: text,
            user,
            isReply: true,
        });
        if (!result || !result.text) {
            adapter.log.warn(`Skript ${ctx.scriptId} hat auf Antwort zu "${ctx.cmd}" nicht reagiert`);
            await sendText(user, '⚠️ Keine Antwort vom Skript erhalten.');
            return;
        }
        const html = !!result.html;
        const noPreview = !!(result.noPreview || result.disablePreview);
        const opts = { html, noPreview };

        if (result.awaitReply) {
            await setInputMode(
                'script_await',
                JSON.stringify({ scriptId: ctx.scriptId, cmd: ctx.cmd, menuKey: ctx.menuKey }),
            );
            if (result.keyboard) {
                await sendMenu(user, result.text, result.keyboard, opts);
            } else {
                await sendTextNoKeyboard(user, result.text, opts);
            }
            return;
        }

        if (result.menuKey) {
            await renderMenu(user, result.menuKey, result.text, opts);
        } else if (ctx.menuKey) {
            await renderMenu(user, ctx.menuKey, result.text, opts);
        } else {
            await sendText(user, result.text, opts);
        }
    }

    async function buildButtonText(btn) {
        if (!btn.icon) {
            return resolveTemplate(adapter, btn.text);
        }
        const rule = await resolveIconRule(adapter, btn.icon);
        if (rule && rule.label) {
            const emoji = rule.emoji || (await resolveIcon(adapter, btn.icon, ''));
            return resolveTemplate(adapter, `${emoji} ${rule.label}`.trim());
        }
        const emoji = await resolveIcon(adapter, btn.icon, '');
        const resolvedText = await resolveTemplate(adapter, btn.text);
        if (!emoji) {
            return resolvedText;
        }
        // Text beginnt direkt mit einem Platzhalter (kein fest getippter Emoji
        // davor) -> Emoji voranstellen statt das erste Wort des AUFGELÖSTEN
        // Texts zu zerstören (sonst würde z. B. "in 3 Tagen" zu "3 Tagen").
        if (
            String(btn.text || '')
                .trim()
                .startsWith('{{')
        ) {
            return `${emoji} ${resolvedText}`.trim();
        }
        const parts = String(resolvedText || '').split(' ');
        parts[0] = emoji;
        return parts.join(' ');
    }

    // rows aus der Registry stehen schon fertig formatiert (emoji+text kommen
    // vom Editor), buildButtonText wird nur für dynamische Status-Icons
    // gebraucht, die den fest eingetragenen Emoji im Text überschreiben.
    async function buildKeyboard(rows, userKey) {
        const out = [];
        for (const row of rows || []) {
            const filtered = [];
            for (const btn of row) {
                if (!btn || !btn.text) {
                    continue;
                }
                if (btn.perm && !(await hasPermission(adapter, btn.perm, userKey))) {
                    continue;
                }
                const text = btn.icon ? await buildButtonText(btn) : await resolveTemplate(adapter, btn.text);
                filtered.push(text);
            }
            if (filtered.length) {
                out.push(filtered);
            }
        }
        return out;
    }

    // Wandelt den Wert eines Bild-Datenpunkts (URL, Dateipfad oder Base64) in
    // einen versendbaren Dateipfad um. Bei Base64 wird kurz eine temporäre
    // Datei geschrieben, weil der Telegram-Adapter nur Pfade/URLs direkt
    // verschicken kann, kein Base64. Wird sowohl für Button- als auch für
    // Menü-Bilder gebraucht.
    async function resolveImagePath(imageDatapoint) {
        const state = await adapter.getForeignStateAsync(imageDatapoint);
        const raw = state?.val;
        if (!raw) {
            return null;
        }
        const source = String(raw);
        if (source.startsWith('http://') || source.startsWith('https://') || source.startsWith('/')) {
            return source;
        }
        // data:image/...;base64,XXXX ODER reines Base64 ohne Prefix
        const base64Data = source.includes(',') ? source.split(',')[1] : source;
        const buffer = Buffer.from(base64Data, 'base64');
        const filePath = path.join(os.tmpdir(), `telegrammenu2_${Date.now()}.jpg`);
        fs.writeFileSync(filePath, buffer);
        return filePath;
    }

    // Normalisiert die Format-Optionen für einen Versand: akzeptiert entweder
    // ein einfaches Boolean (Abwärtskompatibilität - "html an/aus") oder ein
    // Objekt { html, noPreview }. noPreview unterdrückt Telegrams automatische
    // Link-Vorschau-Karte unter der Nachricht (disable_web_page_preview).
    function normalizeSendOpts(opts) {
        if (typeof opts === 'boolean') {
            return { html: opts, noPreview: false };
        }
        return { html: !!(opts && opts.html), noPreview: !!(opts && (opts.noPreview || opts.disablePreview)) };
    }

    async function sendMenu(user, text, keyboard, opts = false) {
        const { html, noPreview } = normalizeSendOpts(opts);
        const payload = {
            text,
            user,
            reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: false },
        };
        if (html) {
            payload.parse_mode = 'HTML';
        }
        if (noPreview) {
            payload.disable_web_page_preview = true;
        }
        await adapter.sendToAsync(adapter.telegramInstance, payload);
    }

    // Bild + Tastatur zusammen als EINE Nachricht - Text wird zur Bildunterschrift.
    async function sendMenuWithImage(user, imageDatapoint, caption, keyboard, opts = false) {
        const { html, noPreview } = normalizeSendOpts(opts);
        const filePath = await resolveImagePath(imageDatapoint);
        if (!filePath) {
            await sendMenu(user, `⚠️ Kein Bild im Datenpunkt gefunden.\n\n${caption || ''}`.trim(), keyboard, opts);
            return;
        }
        const payload = {
            text: filePath,
            caption,
            user,
            reply_markup: { keyboard, resize_keyboard: true, one_time_keyboard: false },
        };
        if (html) {
            payload.parse_mode = 'HTML';
        }
        if (noPreview) {
            payload.disable_web_page_preview = true;
        }
        await adapter.sendToAsync(adapter.telegramInstance, payload);
    }

    async function sendText(user, text, opts = false) {
        const { html, noPreview } = normalizeSendOpts(opts);
        const payload = { text, user };
        if (html) {
            payload.parse_mode = 'HTML';
        }
        if (noPreview) {
            payload.disable_web_page_preview = true;
        }
        await adapter.sendToAsync(adapter.telegramInstance, payload);
    }

    // Entfernt die Menü-Tastatur explizit, damit das Handy automatisch die
    // normale Tastatur zum Tippen zeigt (z. B. beim Fragen nach Texteingabe).
    async function sendTextNoKeyboard(user, text, opts = false) {
        const { html, noPreview } = normalizeSendOpts(opts);
        const payload = { text, user, reply_markup: { remove_keyboard: true } };
        if (html) {
            payload.parse_mode = 'HTML';
        }
        if (noPreview) {
            payload.disable_web_page_preview = true;
        }
        await adapter.sendToAsync(adapter.telegramInstance, payload);
    }

    // Inline-Keyboard-Variante von sendMenu: Buttons bleiben an der Nachricht
    // "kleben" (wie beim Nutzer-Freischalten), statt in der normalen Tastatur
    // zu erscheinen. cmd wird 1:1 zu callback_data, kommt über denselben Weg
    // wie ein normaler Tastendruck (dispatchCommand) zurück.
    async function sendInlineMenu(user, text, inlineRows, opts = false) {
        const { html, noPreview } = normalizeSendOpts(opts);
        const payload = {
            text,
            user,
            reply_markup: {
                inline_keyboard: inlineRows.map(row => row.map(btn => ({ text: btn.text, callback_data: btn.cmd }))),
            },
        };
        if (html) {
            payload.parse_mode = 'HTML';
        }
        if (noPreview) {
            payload.disable_web_page_preview = true;
        }
        await adapter.sendToAsync(adapter.telegramInstance, payload);
    }

    // Startet den Ziffernblock-Eingabemodus für einen Datenpunkt - genutzt vom
    // normalen "Zahleneingabe"-Button UND vom "✏️ Eigener Wert"-Button der
    // Prozent-Stufen/Zahlenbereich-Auto-Menüs (siehe core/valueSubmenus.js).
    async function startNumpadInput(user, { datapoint, min, max, menuKey, prompt, message }) {
        const currentMenuKey = menuKey || (await adapter.getStateAsync('runtime.currentMenu'))?.val || 'main';
        const finalPrompt = prompt || 'Bitte Zahl eingeben:';
        await setInputMode(
            'datapoint_numpad',
            JSON.stringify({
                datapoint,
                min,
                max,
                menuKey: currentMenuKey,
                prompt: finalPrompt,
                message: message || '',
                buffer: '',
            }),
        );
        await sendMenu(user, numpadPromptText(finalPrompt, ''), NUMPAD_ROWS);
    }

    async function renderMenu(user, menuKey, customText, customOpts = false) {
        const userKey = userToKey(user);
        const menuDef = await getMenu(adapter, menuKey);

        if (!menuDef) {
            await sendText(user, `⚠️ Menü "${menuKey}" nicht gefunden.`);
            return;
        }

        if (menuDef.perm && !(await hasPermission(adapter, menuDef.perm, userKey))) {
            await sendText(user, `⛔ Keine Berechtigung für ${menuDef.title || menuKey}.`);
            await renderMenu(user, 'main');
            return;
        }

        const rows = menuDef.source ? await buildAutoRows(adapter, menuDef, userKey, menuKey) : menuDef.rows || [];
        // Prozent-Stufen/Zahlenbereich kommen als Inline-Keyboard (bleibt an der
        // Nachricht "kleben", wie beim Nutzer-Freischalten) statt der normalen
        // Tastatur - daher hier KEIN buildKeyboard()/normaler Tastatur-Versand.
        const useInlineKeyboard = menuDef.source === 'percentRange' || menuDef.source === 'numberRange';
        const keyboard = useInlineKeyboard ? null : await buildKeyboard(rows, userKey);

        // Nur als "aktuelles Menü" merken, wenn es wirklich Buttons hat. Ein
        // Menü ohne Rows (z. B. ein Geister-Eintrag aus einem alten,
        // nicht-migrierten Legacy-Skript, das nur per tmRender() einen Text
        // anzeigt) darf unsere Navigation nicht kaputt machen - sonst würde
        // JEDER folgende Tastendruck ins Leere laufen, weil gegen 0 Buttons
        // verglichen wird, bis der Nutzer manuell /menu oder Hauptmenü drückt.
        if (rows.length > 0) {
            await adapter.setStateAsync('runtime.currentMenu', { val: menuKey, ack: true });
        } else {
            adapter.log.warn(
                `renderMenu: "${menuKey}" hat keine Buttons - currentMenu bleibt unverändert, um Navigation nicht zu blockieren.`,
            );
        }

        let title = customText;
        let titleOpts = customOpts;
        if (title === undefined) {
            if (menuDef.scriptId && menuDef.cmd) {
                const result = await adapter.scriptBridge.callScript(menuDef.scriptId, menuDef.cmd, { user });
                if (result && result.text) {
                    title = result.text;
                    titleOpts = { html: !!result.html, noPreview: !!(result.noPreview || result.disablePreview) };
                } else {
                    adapter.log.warn(
                        `Skript ${menuDef.scriptId} hat auf "${menuDef.cmd}" nicht geantwortet - Menü-Titel fällt auf Antworttext/Titel zurück.`,
                    );
                }
            }
            if (title === undefined && menuDef.message) {
                title = await resolveTemplate(adapter, menuDef.message);
            } else if (title === undefined) {
                title = await resolveTemplate(adapter, menuDef.title || 'Menü');
                if (menuDef.icon) {
                    const emoji = await resolveIcon(adapter, menuDef.icon, '');
                    if (emoji) {
                        title = title.replace(/^\S+/, emoji);
                    }
                }
            }
        }

        if (useInlineKeyboard) {
            await sendInlineMenu(user, title, rows, titleOpts);
        } else if (menuDef.imageDatapoint) {
            await sendMenuWithImage(user, menuDef.imageDatapoint, title, keyboard, titleOpts);
        } else {
            await sendMenu(user, title, keyboard, titleOpts);
        }

        // rows zwischenspeichern, damit findButtonByText() bei Auto-Menüs
        // (deren Inhalt sich pro Aufruf ändert) den zuletzt gezeigten Stand kennt
        const lastRowsId = `runtime.lastRows.${menuKey}`;
        await ensureDynamicState(adapter, lastRowsId, '[]', 'json');
        await adapter.setStateAsync(lastRowsId, { val: JSON.stringify(rows), ack: true }).catch(() => {});
    }

    async function findButtonByText(menuKey, text, _userKey) {
        const menuDef = await getMenu(adapter, menuKey);
        if (!menuDef) {
            return null;
        }

        let rows = menuDef.rows || [];
        if (menuDef.source) {
            const cached = await adapter.getStateAsync(`runtime.lastRows.${menuKey}`).catch(() => null);
            try {
                rows = JSON.parse(cached?.val || '[]');
            } catch {
                rows = [];
            }
        }

        for (const row of rows) {
            for (const btn of row) {
                if (btn.text === text) {
                    return btn;
                }
                if (btn.icon && (await buildButtonText(btn)) === text) {
                    return btn;
                }
                if (btn.text && btn.text.includes('{{') && (await resolveTemplate(adapter, btn.text)) === text) {
                    return btn;
                }
            }
        }
        adapter.log.debug(`findButtonByText: verglichen mit ${JSON.stringify(rows.flat().map(b => b.text))}`);
        return null;
    }

    async function dispatchCommand(cmd, value, user, userKey) {
        // Für Beobachtbarkeit / Kompatibilität weiterhin als State sichtbar
        await adapter.setStateAsync('cmd.id', { val: cmd || '', ack: true });
        await adapter.setStateAsync('cmd.value', { val: value == null ? '' : String(value), ack: true });
        await adapter.setStateAsync('cmd.ts', { val: Date.now(), ack: true });

        if (cmd === 'TG:NAV:BACK') {
            await clearInputMode();
            const current = (await adapter.getStateAsync('runtime.currentMenu'))?.val || 'main';
            const menuDef = await getMenu(adapter, current);
            await renderMenu(user, (menuDef && menuDef.parent) || 'main');
            return;
        }

        if (cmd === 'TG:NAV:MAIN') {
            await setHistory([]);
            await clearInputMode();
            await renderMenu(user, 'main');
            return;
        }

        if (await handleAdminCommand(adapter, cmd, user, userKey, renderMenu, sendText)) {
            return;
        }
        if (await handleNotifyToggle(adapter, cmd, user, userKey, renderMenu)) {
            return;
        }
        if (await handleValueSetCommand(adapter, cmd, user, userKey, renderMenu)) {
            return;
        }
        if (await handleValueCustomCommand(adapter, cmd, user, userKey, startNumpadInput)) {
            return;
        }

        const modules = adapter.modules || [];
        const mod = findModuleForCommand(modules, cmd || '');

        const ctx = {
            adapter,
            user,
            userKey,
            value,
            render: (menuKey, text) => renderMenu(user, menuKey, text),
            pushMenu,
        };

        if (mod) {
            try {
                await mod.onCommand(cmd, value, ctx);
            } catch (e) {
                adapter.log.error(`Modul "${mod.id}" warf bei ${cmd}: ${e.message}`);
                await sendText(user, '⚠️ Interner Fehler, bitte später erneut versuchen.');
            }
            return;
        }

        // Neue Skript-Bridge: hat sich ein Skript für diesen Command angemeldet
        // (registerScriptCommand), direkt per onMessage/toScript aufrufen und auf
        // die Antwort warten - kein State-Umweg, sofortige Antwort per callback.
        const scriptEntry = adapter.scriptBridge && adapter.scriptBridge.findScriptFor(cmd);
        if (scriptEntry) {
            if (scriptEntry.perm && !(await hasPermission(adapter, scriptEntry.perm, userKey))) {
                await sendText(user, `⛔ Keine Berechtigung für ${scriptEntry.perm}.`);
                return;
            }
            const result = await adapter.scriptBridge.callScript(scriptEntry.scriptId, cmd, { value, user });
            if (result && result.text) {
                const opts = { html: !!result.html, noPreview: !!(result.noPreview || result.disablePreview) };
                if (result.menuKey) {
                    await renderMenu(user, result.menuKey, result.text, opts);
                } else {
                    await sendText(user, result.text, opts);
                }
                return;
            }
            adapter.log.debug(`scriptBridge: ${scriptEntry.scriptId} hat für ${cmd} nicht mit Text geantwortet`);
        }

        adapter.log.debug(`Kein Modul für Command ${cmd} gefunden`);
    }

    async function handleIncoming(raw) {
        const trimmed = String(raw || '').trim();
        const match = trimmed.match(/^\[([^\]]+)\](.*)$/);
        if (!match) {
            return;
        }

        const user = match[1].trim();
        const text = match[2].trim();
        if (!user || !text) {
            return;
        }

        const { key: userKey, isNew } = await ensureUser(adapter, user);

        await adapter.setStateAsync('runtime.lastChatId', { val: user, ack: true });
        await adapter.setStateAsync('runtime.lastUserKey', { val: userKey, ack: true });

        // Klick auf einen Inline-Button (Erlauben/Nicht erlauben für neue
        // Benachrichtigungs-Bereiche) - kommt über denselben State wie normale
        // Nachrichten, läuft aber UNABHÄNGIG vom aktuellen inputMode, damit es
        // die laufende Unterhaltung (falls gerade eine läuft) nicht stört.
        if (text.startsWith('TG:ADMIN:APPROVEAREA:') || text.startsWith('TG:ADMIN:DENYAREA:')) {
            const isApprove = text.startsWith('TG:ADMIN:APPROVEAREA:');
            const area = text.slice((isApprove ? 'TG:ADMIN:APPROVEAREA:' : 'TG:ADMIN:DENYAREA:').length);
            if (!(await isAdmin(adapter, userKey))) {
                await sendText(user, '⛔ Nur Admins dürfen das.');
                return;
            }
            if (isApprove) {
                await adapter.notify.approveArea(area);
                await adapter.sendToAsync(adapter.telegramInstance, {
                    user,
                    answerCallbackQuery: { text: `"${area}" freigeschaltet`, showAlert: false },
                });
                await sendText(user, `✅ Bereich "${area}" freigeschaltet.`);
            } else {
                await adapter.notify.deleteArea(area);
                await adapter.sendToAsync(adapter.telegramInstance, {
                    user,
                    answerCallbackQuery: { text: `"${area}" abgelehnt`, showAlert: false },
                });
                await sendText(user, `❌ Bereich "${area}" abgelehnt und entfernt.`);
            }
            return;
        }

        // Klick auf einen Inline-Button (Erlauben/Ablehnen für einen wartenden
        // neuen Nutzer) - läuft nach demselben Muster wie die Bereich-Freischaltung
        // oben, unabhängig vom eigenen Freischalt-Status oder inputMode des Admins.
        if (text.startsWith('TG:ADMIN:APPROVEUSER:') || text.startsWith('TG:ADMIN:DENYUSER:')) {
            const isApprove = text.startsWith('TG:ADMIN:APPROVEUSER:');
            const targetKey = text.slice((isApprove ? 'TG:ADMIN:APPROVEUSER:' : 'TG:ADMIN:DENYUSER:').length);
            if (!(await isAdmin(adapter, userKey))) {
                await sendText(user, '⛔ Nur Admins dürfen das.');
                return;
            }
            if (isApprove) {
                const chatState = await adapter.getStateAsync(`users.${targetKey}.chatId`);
                await approveUser(adapter, targetKey);
                await adapter.sendToAsync(adapter.telegramInstance, {
                    user,
                    answerCallbackQuery: { text: `"${targetKey}" freigeschaltet`, showAlert: false },
                });
                await sendText(user, `✅ Nutzer "${targetKey}" freigeschaltet.`);
                // Freigeschalteter Nutzer bekommt sofort Bescheid und sein Hauptmenü,
                // statt erst bei der nächsten eigenen Nachricht davon zu erfahren.
                if (chatState?.val) {
                    await sendText(chatState.val, '✅ Du wurdest vom Admin freigeschaltet!');
                    await setHistory([]);
                    await clearInputMode();
                    await renderMenu(chatState.val, 'main');
                }
            } else {
                await denyUser(adapter, targetKey);
                await adapter.sendToAsync(adapter.telegramInstance, {
                    user,
                    answerCallbackQuery: { text: `"${targetKey}" abgelehnt`, showAlert: false },
                });
                await sendText(user, `❌ Nutzer "${targetKey}" abgelehnt und entfernt.`);
            }
            return;
        }

        // Freischalt-Gate: ein neuer oder noch nicht freigeschalteter Nutzer sieht
        // NUR die Warte-Nachricht statt des Hauptmenüs - keine Buttons, keine
        // Berechtigungen, bis ein Admin per Inline-Button "Erlauben" antippt.
        // Admins selbst sind über isApproved() immer automatisch durchgelassen.
        if (!(await isApproved(adapter, userKey))) {
            if (isNew) {
                await notifyAdminsAboutPendingUser(adapter, userKey, user);
            }
            await sendText(user, '⏳ Warte auf Freischaltung durch den Admin.');
            return;
        }

        // Klick auf einen Inline-Button der Prozent-Stufen/Zahlenbereich-Menüs
        // (Wert-Preset ODER "✏️ Eigener Wert") - kommt als callback_data, NICHT
        // als sichtbarer Button-Text, daher direkt an dispatchCommand statt über
        // findButtonByText() weiter unten (das würde nie einen Treffer finden).
        if (text.startsWith('TG:VALSET:') || text.startsWith('TG:VALCUSTOM:')) {
            await dispatchCommand(text, '', user, userKey);
            return;
        }

        if (text === '/start' || text === '/menu') {
            await setHistory([]);
            await clearInputMode();
            await renderMenu(user, 'main');
            return;
        }

        const inputMode = (await adapter.getStateAsync('runtime.inputMode'))?.val;
        if (inputMode === 'script_await') {
            await handleScriptReply(user, userKey, text);
            return;
        }
        if (inputMode === 'datapoint_numpad') {
            await handleNumpadInput(user, userKey, text);
            return;
        }
        if (inputMode === 'datapoint_input') {
            await handleDatapointInput(user, userKey, text);
            return;
        }
        if (inputMode) {
            await dispatchCommand(`INPUT:${inputMode}`, text, user, userKey);
            return;
        }

        const currentMenu = (await adapter.getStateAsync('runtime.currentMenu'))?.val || 'main';
        adapter.log.debug(`handleIncoming: user=${user} text="${text}" currentMenu="${currentMenu}"`);
        const button = await findButtonByText(currentMenu, text, userKey);

        if (!button) {
            adapter.log.debug(`findButtonByText: kein Treffer für "${text}" in Menü "${currentMenu}"`);
            await sendText(user, '🤷 Unbekannter Befehl oder keine Berechtigung.');
            await renderMenu(user, currentMenu);
            return;
        }

        if (button.perm && !(await hasPermission(adapter, button.perm, userKey))) {
            await sendText(user, `⛔ Keine Berechtigung für ${button.perm}.`);
            await renderMenu(user, currentMenu);
            return;
        }

        if (button.nextMenu) {
            const targetDef = await getMenu(adapter, button.nextMenu);
            if (targetDef && targetDef.perm && !(await hasPermission(adapter, targetDef.perm, userKey))) {
                await sendText(user, `⛔ Keine Berechtigung für ${targetDef.title || button.nextMenu}.`);
                await renderMenu(user, currentMenu);
                return;
            }
            await pushMenu(currentMenu);
            await renderMenu(user, button.nextMenu);
        }

        // Bild aus Datenpunkt: Wert kann URL, Dateipfad oder Base64 sein - bei
        // Base64 wird kurz eine temporäre Datei geschrieben, weil der
        // Telegram-Adapter nur Pfade/URLs direkt verschicken kann, kein Base64.
        // Ist ZUSÄTZLICH ein Skript gesetzt, kommt die Bildunterschrift aus der
        // Skript-Antwort statt aus dem festen "Nachricht"-Feld - z. B. wenn ein
        // Statustext dynamisch vom Skript kommt (siehe VacuumStatus-Beispiel).
        if (button.imageDatapoint) {
            try {
                const filePath = await resolveImagePath(button.imageDatapoint);
                if (!filePath) {
                    await sendText(user, '⚠️ Kein Bild im Datenpunkt gefunden.');
                    return;
                }
                let caption = button.message ? await resolveTemplate(adapter, button.message) : undefined;
                let captionHtml = false;
                let captionNoPreview = false;
                if (button.scriptId && button.cmd) {
                    const result = await adapter.scriptBridge.callScript(button.scriptId, button.cmd, {
                        value: button.text,
                        user,
                    });
                    if (result && result.text) {
                        caption = result.text;
                        captionHtml = !!result.html;
                        captionNoPreview = !!(result.noPreview || result.disablePreview);
                    } else {
                        adapter.log.warn(
                            `Skript ${button.scriptId} hat auf "${button.cmd}" nicht geantwortet - Bild wird ohne Skript-Text gesendet.`,
                        );
                    }
                } else if (button.datapoint && !button.inputType) {
                    // Ein/Aus-Toggle zusätzlich zum Bild ausführen (nicht nur Bild senden
                    // und den eigentlichen Knopf-Zweck ignorieren).
                    const onVal =
                        button.onValue !== undefined && button.onValue !== '' ? coerceValue(button.onValue) : true;
                    const offVal =
                        button.offValue !== undefined && button.offValue !== '' ? coerceValue(button.offValue) : false;
                    try {
                        const current = await adapter.getForeignStateAsync(button.datapoint);
                        const isOn = current
                            ? current.val === onVal || current.val === true || String(current.val) === String(onVal)
                            : false;
                        const nextVal = isOn ? offVal : onVal;
                        await adapter.setForeignStateAsync(button.datapoint, { val: nextVal, ack: false });
                        if (!caption) {
                            caption = `${isOn ? '❌' : '✅'} ${button.text || ''} → ${nextVal}`.trim();
                        }
                    } catch (e) {
                        adapter.log.warn(
                            `Datenpunkt-Toggle für ${button.datapoint} (mit Bild) fehlgeschlagen: ${e.message}`,
                        );
                    }
                }
                const imgPayload = { text: filePath, caption, user };
                if (captionHtml) {
                    imgPayload.parse_mode = 'HTML';
                }
                if (captionNoPreview) {
                    imgPayload.disable_web_page_preview = true;
                }
                await adapter.sendToAsync(adapter.telegramInstance, imgPayload);
            } catch (e) {
                adapter.log.warn(`Bild aus Datenpunkt ${button.imageDatapoint} fehlgeschlagen: ${e.message}`);
                await sendText(user, `⚠️ Bild konnte nicht gesendet werden.`);
            }
            return;
        }

        // Multi-Status-Schalter: Status-Datenpunkt bestimmt, WELCHER andere
        // Datenpunkt mit welchem Wert beschrieben wird (z. B. "Status kühlt" ->
        // schreibt ac_off, "Status aus" -> schreibt quick_cool). Hat Vorrang vor
        // dem einfachen Datenpunkt-Toggle unten, falls beides gesetzt ist.
        if (button.icon && button.icon.datapoint) {
            const rule = await resolveIconRule(adapter, button.icon);
            if (rule && rule.writeDatapoint) {
                try {
                    const writeVal = coerceValue(
                        rule.writeValue !== undefined && rule.writeValue !== '' ? rule.writeValue : 'true',
                    );
                    await adapter.setForeignStateAsync(rule.writeDatapoint, { val: writeVal, ack: false });
                    // {status} im Nachricht-Feld wird durch den pro-Regel definierten
                    // "Status-Text" ersetzt (z. B. "aktiv"/"nicht aktiv" statt true/false).
                    let confirmText;
                    if (button.message) {
                        const withStatus = button.message.replace(
                            /\{status\}/g,
                            rule.statusText || rule.label || String(writeVal),
                        );
                        confirmText = await resolveTemplate(adapter, withStatus);
                    } else {
                        confirmText =
                            `✅ ${rule.label || button.text || ''}${rule.statusText ? ` ${rule.statusText}` : ` → ${writeVal}`}`.trim();
                    }
                    // Tastatur direkt mit-aktualisieren, damit ein evtl. anderer Button-Text
                    // (nächster Status) sofort sichtbar ist - keine zweite Nachricht nötig.
                    const currentMenuKey = (await adapter.getStateAsync('runtime.currentMenu'))?.val || 'main';
                    await renderMenu(user, currentMenuKey, confirmText);
                } catch (e) {
                    adapter.log.warn(`Multi-Status-Schreiben für ${rule.writeDatapoint} fehlgeschlagen: ${e.message}`);
                    await sendText(user, `⚠️ Datenpunkt ${rule.writeDatapoint} konnte nicht geschrieben werden.`);
                }
                return;
            }
        }

        // HTTP-Request-Button aus dem Editor - kein Skript, kein Modul nötig.
        // Feuert einen HTTP-Call (GET/POST, optional Basic-Auth) und zeigt danach
        // eine Bestätigung mit Status-Code an. {status} und {response} im
        // Nachricht-Feld werden durch HTTP-Status bzw. (gekürzten) Antworttext ersetzt.
        if (button.httpUrl) {
            const method = (button.httpMethod || 'GET').toUpperCase();
            const headers = {};
            if (button.httpAuthUser) {
                headers.Authorization = `Basic ${Buffer.from(`${button.httpAuthUser}:${button.httpAuthPass || ''}`).toString('base64')}`;
            }
            if (button.httpBody && method !== 'GET') {
                headers['Content-Type'] = 'application/json';
            }

            try {
                const resp = await fetch(button.httpUrl, {
                    method,
                    headers,
                    body: button.httpBody && method !== 'GET' ? button.httpBody : undefined,
                });
                const bodyText = await resp.text().catch(() => '');
                const truncated = bodyText.length > 300 ? `${bodyText.slice(0, 300)}…` : bodyText;

                let confirmText;
                if (button.message) {
                    const withPlaceholders = button.message
                        .replace(/\{status\}/g, String(resp.status))
                        .replace(/\{response\}/g, truncated);
                    confirmText = await resolveTemplate(adapter, withPlaceholders);
                } else {
                    confirmText = `${resp.ok ? '✅' : '⚠️'} ${button.text || ''} → HTTP ${resp.status}`.trim();
                }
                const currentMenuKey = (await adapter.getStateAsync('runtime.currentMenu'))?.val || 'main';
                await renderMenu(user, currentMenuKey, confirmText);
            } catch (e) {
                adapter.log.warn(`HTTP-Request-Button (${button.httpUrl}) fehlgeschlagen: ${e.message}`);
                await sendText(user, `⚠️ HTTP-Request fehlgeschlagen: ${e.message}`);
            }
            return;
        }

        // Direkter Datenpunkt-Bezug aus dem Editor - kein Skript, kein Modul nötig.
        if (button.datapoint) {
            // Festwert setzen: schreibt IMMER genau diesen Wert, unabhängig vom
            // aktuellen Stand (z. B. Modus-Auswahl "auto"/"manual"/"off", feste
            // Presets) - im Unterschied zum Toggle unten, der zwischen zwei
            // Werten umschaltet.
            if (button.fixedValue !== undefined && button.fixedValue !== '') {
                try {
                    const val = coerceValue(button.fixedValue);
                    await adapter.setForeignStateAsync(button.datapoint, { val, ack: false });
                    const confirmText = button.message
                        ? await resolveTemplate(adapter, button.message)
                        : `✅ ${button.text || ''} → ${val}`.trim();
                    const currentMenuKey = (await adapter.getStateAsync('runtime.currentMenu'))?.val || 'main';
                    await renderMenu(user, currentMenuKey, confirmText);
                } catch (e) {
                    adapter.log.warn(`Festwert-Schreiben für ${button.datapoint} fehlgeschlagen: ${e.message}`);
                    await sendText(user, `⚠️ Datenpunkt ${button.datapoint} konnte nicht geschrieben werden.`);
                }
                return;
            }

            if (button.inputType === 'number') {
                // Zahleneingabe: echter Ziffernblock statt freiem Tippen. Nachricht
                // wird NICHT als Frage verwendet, sondern erst nach dem Schreiben
                // als Bestätigung aufgelöst (damit {{datapunkt.id}} den NEUEN Wert zeigt).
                const currentMenuKey = (await adapter.getStateAsync('runtime.currentMenu'))?.val || 'main';
                await startNumpadInput(user, {
                    datapoint: button.datapoint,
                    min: button.min,
                    max: button.max,
                    menuKey: currentMenuKey,
                    prompt: button.prompt,
                    message: button.message,
                });
                return;
            }

            if (button.inputType === 'text') {
                // Texteingabe: normales Tippen über die Handy-Tastatur. Nachricht wird
                // NICHT als Frage verwendet, sondern erst nach dem Schreiben als
                // Bestätigung aufgelöst (damit {{datapunkt.id}} den NEUEN Wert zeigt).
                const currentMenuKey = (await adapter.getStateAsync('runtime.currentMenu'))?.val || 'main';
                await setInputMode(
                    'datapoint_input',
                    JSON.stringify({
                        datapoint: button.datapoint,
                        inputType: button.inputType,
                        min: button.min,
                        max: button.max,
                        menuKey: currentMenuKey,
                        message: button.message || '',
                    }),
                );
                await sendTextNoKeyboard(user, button.prompt || 'Bitte einen Text eingeben:');
                return;
            }

            // Toggle: sofort lesen, umschalten, zurückschreiben.
            const onVal = button.onValue !== undefined && button.onValue !== '' ? coerceValue(button.onValue) : true;
            const offVal =
                button.offValue !== undefined && button.offValue !== '' ? coerceValue(button.offValue) : false;
            try {
                const current = await adapter.getForeignStateAsync(button.datapoint);
                const isOn = current
                    ? current.val === onVal || current.val === true || String(current.val) === String(onVal)
                    : false;
                const nextVal = isOn ? offVal : onVal;
                await adapter.setForeignStateAsync(button.datapoint, { val: nextVal, ack: false });
                // Eigene Nachricht hat Vorrang vor der generischen "✅/❌ → Wert"-Bestätigung.
                const confirmText = button.message
                    ? await resolveTemplate(adapter, button.message)
                    : `${isOn ? '❌' : '✅'} ${button.text || ''} → ${nextVal}`.trim();
                const currentMenuKey = (await adapter.getStateAsync('runtime.currentMenu'))?.val || 'main';
                await renderMenu(user, currentMenuKey, confirmText);
            } catch (e) {
                adapter.log.warn(`Datenpunkt-Toggle für ${button.datapoint} fehlgeschlagen: ${e.message}`);
                await sendText(user, `⚠️ Datenpunkt ${button.datapoint} konnte nicht geschaltet werden.`);
            }
            return;
        }

        // Direkte Skript-Zuordnung aus dem Editor: "dieser Button ruft Funktion
        // <cmd> in Skript <scriptId> auf" - komplett im Editor konfiguriert,
        // keine sendTo-Selbstanmeldung im Skript nötig. Das Skript braucht nur:
        //   onMessage('<cmd>', (data, callback) => { ...; callback({text}); });
        if (button.scriptId && button.cmd) {
            const result = await adapter.scriptBridge.callScript(button.scriptId, button.cmd, {
                value: button.text,
                user,
            });
            if (result && result.text) {
                const opts = { html: !!result.html, noPreview: !!(result.noPreview || result.disablePreview) };
                if (result.awaitReply) {
                    // Skript will eine Antwort auf seine Frage - nächste Nachricht (Freitext
                    // oder Tastendruck auf ein eigenes keyboard) geht zurück an DASSELBE
                    // Skript/Command (data.isReply = true).
                    const currentMenuKey = (await adapter.getStateAsync('runtime.currentMenu'))?.val || 'main';
                    await setInputMode(
                        'script_await',
                        JSON.stringify({ scriptId: button.scriptId, cmd: button.cmd, menuKey: currentMenuKey }),
                    );
                    if (result.keyboard) {
                        await sendMenu(user, result.text, result.keyboard, opts);
                    } else {
                        await sendTextNoKeyboard(user, result.text, opts);
                    }
                } else if (result.menuKey) {
                    await renderMenu(user, result.menuKey, result.text, opts);
                } else {
                    await sendText(user, result.text, opts);
                }
            } else {
                adapter.log.warn(`Skript ${button.scriptId} hat auf "${button.cmd}" nicht geantwortet`);
                await sendText(user, '⚠️ Keine Antwort vom Skript erhalten.');
            }
            return;
        }

        // Nachricht-Template aus dem Editor: wird direkt gerendert, sobald
        // gesetzt - kein extra Häkchen mehr nötig, wie früher "Core übernimmt
        // komplett". Datenpunkt/Skript oben haben Vorrang, falls beides gesetzt ist.
        if (button.message) {
            const resolved = await resolveTemplate(adapter, button.message);
            await sendText(user, resolved);
            return;
        }

        if (button.cmd) {
            await dispatchCommand(button.cmd, button.text, user, userKey);
        }
    }

    return {
        handleIncoming,
        renderMenu,
        dispatchCommand,
        setInputMode,
        sendTextNoKeyboard,
        sendMenu,
        startNumpadInput,
    };
}

module.exports = { createRouter };
