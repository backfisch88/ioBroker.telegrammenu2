'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getMenu, sanitizeMenuKey } = require('./registry');
const { t, allTranslations } = require('./botI18n');
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
const { handleAdminCommand } = require('./admin');
const { handleNotifyToggle } = require('./settings');
const { handleValueSetCommand, handleValueCustomCommand } = require('./valueSubmenus');
const { ensureDynamicState } = require('./states');

// Converts text input from the editor (on/off value fields) to the matching
// JS type, so e.g. "true"/"false"/numbers do not accidentally end up as a
// string in the datapoint.
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

// Real numeric keypad as Telegram keyboard for number input - text input
// stays normal typing on the phone keyboard.
const NUMPAD_ROWS = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['.', '0', '⌫'],
];

// A function instead of a module constant, because the last row needs translated
// button texts - the language is only known after initBotI18n() in onReady(),
// i.e. AFTER this module is require()d.
function getNumpadRows() {
    return [...NUMPAD_ROWS, [t('bot.done'), t('bot.cancel')]];
}

function numpadPromptText(prompt, buffer) {
    return `${prompt}\n\n${t('bot.inputLabel')}: ${buffer || '_'}`;
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

    // Handles the reply to a number/text input request (see "datapoint (read/write
    // directly)" on number/text nodes in the editor).
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
            await sendText(user, t('bot.inputContextLost'));
            return;
        }

        let value = rawText;
        if (ctx.inputType === 'number') {
            const num = Number(String(rawText).replace(',', '.'));
            if (Number.isNaN(num)) {
                await sendText(user, t('bot.invalidNumber'));
                return;
            }
            if (ctx.min !== undefined && ctx.min !== '' && num < Number(ctx.min)) {
                await sendText(user, t('bot.valueTooLow', { min: String(ctx.min) }));
                return;
            }
            if (ctx.max !== undefined && ctx.max !== '' && num > Number(ctx.max)) {
                await sendText(user, t('bot.valueTooHigh', { max: String(ctx.max) }));
                return;
            }
            value = num;
        }

        try {
            await adapter.setForeignStateAsync(ctx.datapoint, { val: value, ack: false });
            const confirmText = ctx.message
                ? await resolveTemplate(adapter, ctx.message)
                : t('bot.savedValue', { value: String(value) });
            if (ctx.menuKey) {
                await renderMenu(user, ctx.menuKey, confirmText);
            } else {
                await sendText(user, confirmText);
            }
        } catch (e) {
            adapter.log.warn(`Input write to datapoint ${ctx.datapoint} failed: ${e.message}`);
            await sendText(user, t('bot.writeFailed', { datapoint: ctx.datapoint }));
        }
    }

    // Handles every key press on the numeric keypad (number input mode).
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
            await sendText(user, t('bot.inputContextLost'));
            return;
        }

        if (allTranslations('bot.cancel').includes(key)) {
            await clearInputMode();
            if (ctx.menuKey) {
                await renderMenu(user, ctx.menuKey, t('bot.cancelled'));
            } else {
                await sendText(user, t('bot.cancelled'));
            }
            return;
        }

        if (allTranslations('bot.done').includes(key)) {
            const num = Number(String(ctx.buffer || '').replace(',', '.'));
            if (!ctx.buffer || Number.isNaN(num)) {
                // Invalid -> reset completely and start over (as requested).
                await setInputMode('datapoint_numpad', JSON.stringify({ ...ctx, buffer: '' }));
                await sendMenu(
                    user,
                    numpadPromptText(t('bot.numInvalidRetry', { prompt: ctx.prompt || '' }), ''),
                    getNumpadRows(),
                );
                return;
            }
            if (ctx.min !== undefined && ctx.min !== '' && num < Number(ctx.min)) {
                await setInputMode('datapoint_numpad', JSON.stringify({ ...ctx, buffer: '' }));
                await sendMenu(
                    user,
                    numpadPromptText(t('bot.numMinRetry', { min: String(ctx.min), prompt: ctx.prompt || '' }), ''),
                    getNumpadRows(),
                );
                return;
            }
            if (ctx.max !== undefined && ctx.max !== '' && num > Number(ctx.max)) {
                await setInputMode('datapoint_numpad', JSON.stringify({ ...ctx, buffer: '' }));
                await sendMenu(
                    user,
                    numpadPromptText(t('bot.numMaxRetry', { max: String(ctx.max), prompt: ctx.prompt || '' }), ''),
                    getNumpadRows(),
                );
                return;
            }
            await clearInputMode();
            try {
                await adapter.setForeignStateAsync(ctx.datapoint, { val: num, ack: false });
                const confirmText = ctx.message
                    ? await resolveTemplate(adapter, ctx.message.replace(/\{value\}/g, String(num)))
                    : t('bot.savedValue', { value: String(num) });
                if (ctx.menuKey) {
                    await renderMenu(user, ctx.menuKey, confirmText);
                } else {
                    await sendText(user, confirmText);
                }
            } catch (e) {
                adapter.log.warn(`Input write to datapoint ${ctx.datapoint} failed: ${e.message}`);
                await sendText(user, t('bot.writeFailed', { datapoint: ctx.datapoint }));
            }
            return;
        }

        // Digit/dot/delete: only buffer silently in the background, send NO reply -
        // otherwise there would be one bot message per key press (spam). The numeric
        // keypad stays visible from the first send anyway, so it does not have to be
        // sent again.
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

    // Handles the reply to a script follow-up question (callback({text, awaitReply:true})).
    // Calls the same script/command again, this time with data.isReply=true and the
    // typed text as data.value - the script decides itself whether it is done or
    // asks again (chainable for multi-step flows).
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
            await sendText(user, t('bot.inputContextLost'));
            return;
        }

        const result = await adapter.scriptBridge.callScript(ctx.scriptId, ctx.cmd, {
            value: text,
            user,
            isReply: true,
        });
        if (!result || !result.text) {
            adapter.log.warn(`Script ${ctx.scriptId} did not respond to "${ctx.cmd}"`);
            await sendText(user, t('bot.noScriptResponse'));
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
        // Text starts directly with a placeholder (no hand-typed emoji in front) ->
        // prepend the emoji instead of destroying the first word of the RESOLVED text
        // (otherwise e.g. "in 3 days" would become "3 days").
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

    // rows from the registry are already formatted (emoji+text come from the
    // editor), buildButtonText is only needed for dynamic status icons that
    // override the hand-entered emoji in the text.
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

    // Converts the value of an image datapoint (URL, file path or base64) into a
    // sendable file path. For base64 a temporary file is written briefly, because
    // the Telegram adapter can only send paths/URLs directly, not base64. Needed
    // for both button and menu images.
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
        // data:image/...;base64,XXXX OR plain base64 without prefix
        const base64Data = source.includes(',') ? source.split(',')[1] : source;
        const buffer = Buffer.from(base64Data, 'base64');
        const filePath = path.join(
            os.tmpdir(),
            `telegrammenu2_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`,
        );
        fs.writeFileSync(filePath, buffer);
        // Unique file per call (no overwriting - otherwise a race condition if two
        // users request an image at the same time). Clean up with a delay instead:
        // 60s is plenty for telegram.0 to read the file before it is deleted - so
        // nothing accumulates in /tmp.
        adapter.setTimeout(() => fs.unlink(filePath, () => {}), 60000);
        return filePath;
    }

    // Normalizes the format options for a send: accepts either a plain boolean
    // (backwards compatibility - "html on/off") or an object { html, noPreview }.
    // noPreview suppresses Telegram's automatic link preview card below the message
    // (disable_web_page_preview).
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

    // Image + keyboard together as ONE message - text becomes the caption.
    async function sendMenuWithImage(user, imageDatapoint, caption, keyboard, opts = false) {
        const { html, noPreview } = normalizeSendOpts(opts);
        const filePath = await resolveImagePath(imageDatapoint);
        if (!filePath) {
            await sendMenu(user, `${t('bot.noImage')}\n\n${caption || ''}`.trim(), keyboard, opts);
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

    // Explicitly removes the menu keyboard, so the phone automatically shows the
    // normal typing keyboard (e.g. when asking for text input).
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

    // Inline keyboard variant of sendMenu: buttons stay attached to the message
    // (as with user approval) instead of appearing in the normal keyboard. cmd
    // becomes callback_data 1:1 and comes back the same way as a normal key press
    // (dispatchCommand).
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

    // Starts the numeric keypad input mode for a datapoint - used by the normal
    // "number input" button AND by the "✏️ Custom value" button of the
    // percent-step/number-range auto menus (see lib/valueSubmenus.js).
    async function startNumpadInput(user, { datapoint, min, max, menuKey, prompt, message }) {
        const currentMenuKey = menuKey || (await adapter.getStateAsync('runtime.currentMenu'))?.val || 'main';
        const finalPrompt = prompt || t('bot.enterNumberPrompt');
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
        await sendMenu(user, numpadPromptText(finalPrompt, ''), getNumpadRows());
    }

    async function renderMenu(user, menuKey, customText, customOpts = false) {
        const userKey = userToKey(user);
        const menuDef = await getMenu(adapter, menuKey);

        if (!menuDef) {
            await sendText(user, t('bot.menuNotFound', { menu: menuKey }));
            return;
        }

        if (menuDef.perm && !(await hasPermission(adapter, menuDef.perm, userKey))) {
            await sendText(user, t('bot.noPermission', { target: menuDef.title || menuKey }));
            await renderMenu(user, 'main');
            return;
        }

        const rows = menuDef.source ? await buildAutoRows(adapter, menuDef, userKey, menuKey) : menuDef.rows || [];
        // Percent steps/number range come as an inline keyboard (stays attached to the
        // message, as with user approval) instead of the normal keyboard - so NO
        // buildKeyboard()/normal keyboard send here.
        const useInlineKeyboard = menuDef.source === 'percentRange' || menuDef.source === 'numberRange';
        const keyboard = useInlineKeyboard ? null : await buildKeyboard(rows, userKey);

        // Only remember as the "current menu" if it really has buttons. A menu without
        // rows (e.g. a ghost entry from an old, non-migrated legacy script that only
        // shows a text via tmRender()) must not break our navigation - otherwise EVERY
        // following key press would run into nothing because it is compared against
        // 0 buttons until the user manually presses /menu or Main Menu.
        if (rows.length > 0) {
            await adapter.setStateAsync('runtime.currentMenu', { val: menuKey, ack: true });
        } else {
            adapter.log.warn(
                `renderMenu: "${menuKey}" has no buttons - currentMenu stays unchanged to avoid blocking navigation.`,
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
                        `Script ${menuDef.scriptId} did not respond to "${menuDef.cmd}" - menu title falls back to reply text/title.`,
                    );
                }
            }
            if (title === undefined && menuDef.message) {
                title = await resolveTemplate(adapter, menuDef.message);
            } else if (title === undefined) {
                title = await resolveTemplate(adapter, menuDef.title || t('bot.defaultMenuTitle'));
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

        // Cache the rows so findButtonByText() knows the last shown state for auto
        // menus (whose content changes on every call)
        const lastRowsId = `runtime.lastRows.${sanitizeMenuKey(menuKey)}`;
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
            const cached = await adapter
                .getStateAsync(`runtime.lastRows.${sanitizeMenuKey(menuKey)}`)
                .catch(() => null);
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
        adapter.log.debug(`findButtonByText: compared against ${JSON.stringify(rows.flat().map(b => b.text))}`);
        return null;
    }

    async function dispatchCommand(cmd, value, user, userKey) {
        // Still visible as a state for observability / compatibility
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

        // New script bridge: if a script registered for this command
        // (registerScriptCommand), call it directly via onMessage/toScript and wait for
        // the answer - no state detour, immediate answer via callback.
        const scriptEntry = adapter.scriptBridge && adapter.scriptBridge.findScriptFor(cmd);
        if (scriptEntry) {
            if (scriptEntry.perm && !(await hasPermission(adapter, scriptEntry.perm, userKey))) {
                await sendText(user, t('bot.noPermission', { target: scriptEntry.perm }));
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
            adapter.log.debug(`scriptBridge: ${scriptEntry.scriptId} did not respond with text for ${cmd}`);
        }

        adapter.log.debug(`No module found for command ${cmd}`);
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

        // Click on an inline button (Allow/Don't allow for new notification areas) -
        // arrives via the same state as normal messages, but runs INDEPENDENT of the
        // current inputMode, so it does not disturb the running conversation (if there
        // is one).
        if (text.startsWith('TG:ADMIN:APPROVEAREA:') || text.startsWith('TG:ADMIN:DENYAREA:')) {
            const isApprove = text.startsWith('TG:ADMIN:APPROVEAREA:');
            const area = text.slice((isApprove ? 'TG:ADMIN:APPROVEAREA:' : 'TG:ADMIN:DENYAREA:').length);
            if (!(await isAdmin(adapter, userKey))) {
                await sendText(user, t('bot.adminsOnlyAction'));
                return;
            }
            if (isApprove) {
                await adapter.notify.approveArea(area);
                await adapter.sendToAsync(adapter.telegramInstance, {
                    user,
                    answerCallbackQuery: { text: t('bot.areaApprovedAlert', { name: area }), showAlert: false },
                });
                await sendText(user, t('bot.areaApproved', { name: area }));
            } else {
                await adapter.notify.deleteArea(area);
                await adapter.sendToAsync(adapter.telegramInstance, {
                    user,
                    answerCallbackQuery: { text: t('bot.rejectedAlert', { name: area }), showAlert: false },
                });
                await sendText(user, t('bot.areaRejected', { name: area }));
            }
            return;
        }

        // Click on an inline button (Allow/Reject for a waiting new user) - follows the
        // same pattern as the area approval above, independent of the admin's own
        // approval status or inputMode.
        if (text.startsWith('TG:ADMIN:APPROVEUSER:') || text.startsWith('TG:ADMIN:DENYUSER:')) {
            const isApprove = text.startsWith('TG:ADMIN:APPROVEUSER:');
            const targetKey = text.slice((isApprove ? 'TG:ADMIN:APPROVEUSER:' : 'TG:ADMIN:DENYUSER:').length);
            if (!(await isAdmin(adapter, userKey))) {
                await sendText(user, t('bot.adminsOnlyAction'));
                return;
            }
            if (isApprove) {
                const chatState = await adapter.getStateAsync(`users.${targetKey}.chatId`);
                await approveUser(adapter, targetKey);
                await adapter.sendToAsync(adapter.telegramInstance, {
                    user,
                    answerCallbackQuery: { text: t('bot.areaApprovedAlert', { name: targetKey }), showAlert: false },
                });
                await sendText(user, t('bot.userApprovedAdmin', { name: targetKey }));
                // The approved user is notified immediately and gets the main menu, instead of
                // only finding out on their next own message.
                if (chatState?.val) {
                    await sendText(chatState.val, t('bot.userApproved'));
                    await setHistory([]);
                    await clearInputMode();
                    await renderMenu(chatState.val, 'main');
                }
            } else {
                await denyUser(adapter, targetKey);
                await adapter.sendToAsync(adapter.telegramInstance, {
                    user,
                    answerCallbackQuery: { text: t('bot.rejectedAlert', { name: targetKey }), showAlert: false },
                });
                await sendText(user, t('bot.userRejectedAdmin', { name: targetKey }));
            }
            return;
        }

        // Approval gate: a new or not yet approved user sees ONLY the waiting message
        // instead of the main menu - no buttons, no permissions until an admin taps
        // "Allow" via inline button. Admins themselves always pass automatically via
        // isApproved().
        if (!(await isApproved(adapter, userKey))) {
            if (isNew) {
                await notifyAdminsAboutPendingUser(adapter, userKey, user);
            }
            await sendText(user, t('bot.awaitingApproval'));
            return;
        }

        // Click on an inline button of the percent-step/number-range menus (value
        // preset OR "✏️ Custom value") - arrives as callback_data, NOT as visible
        // button text, so it goes straight to dispatchCommand instead of via
        // findButtonByText() further below (which would never find a match).
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
            adapter.log.debug(`findButtonByText: no match for "${text}" in menu "${currentMenu}"`);
            await sendText(user, t('bot.unknownCommand'));
            await renderMenu(user, currentMenu);
            return;
        }

        if (button.perm && !(await hasPermission(adapter, button.perm, userKey))) {
            await sendText(user, t('bot.noPermission', { target: button.perm }));
            await renderMenu(user, currentMenu);
            return;
        }

        if (button.nextMenu) {
            const targetDef = await getMenu(adapter, button.nextMenu);
            if (targetDef && targetDef.perm && !(await hasPermission(adapter, targetDef.perm, userKey))) {
                await sendText(user, t('bot.noPermission', { target: targetDef.title || button.nextMenu }));
                await renderMenu(user, currentMenu);
                return;
            }
            await pushMenu(currentMenu);
            await renderMenu(user, button.nextMenu);
        }

        // Image from datapoint: the value can be a URL, file path or base64 - for
        // base64 a temporary file is written briefly, because the Telegram adapter can
        // only send paths/URLs directly, not base64. If a script is ADDITIONALLY set,
        // the caption comes from the script reply instead of the fixed "message" field
        // - e.g. when a status text comes dynamically from the script (see the
        // VacuumStatus example).
        if (button.imageDatapoint) {
            try {
                const filePath = await resolveImagePath(button.imageDatapoint);
                if (!filePath) {
                    await sendText(user, t('bot.noImage'));
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
                            `Script ${button.scriptId} did not respond to "${button.cmd}" - image sent without script text.`,
                        );
                    }
                } else if (button.datapoint && !button.inputType) {
                    // Also perform the on/off toggle in addition to the image (do not only send
                    // the image and ignore the actual purpose of the button).
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
                        adapter.log.warn(`Datapoint toggle for ${button.datapoint} (with image) failed: ${e.message}`);
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
                adapter.log.warn(`Image from datapoint ${button.imageDatapoint} failed: ${e.message}`);
                await sendText(user, t('bot.imageSendFailed'));
            }
            return;
        }

        // Multi-status switch: the status datapoint determines WHICH other datapoint is
        // written with which value (e.g. "status cooling" -> writes ac_off, "status off"
        // -> writes quick_cool). Takes precedence over the simple datapoint toggle below
        // if both are set.
        if (button.icon && button.icon.datapoint) {
            const rule = await resolveIconRule(adapter, button.icon);
            if (rule && rule.writeDatapoint) {
                try {
                    const writeVal = coerceValue(
                        rule.writeValue !== undefined && rule.writeValue !== '' ? rule.writeValue : 'true',
                    );
                    await adapter.setForeignStateAsync(rule.writeDatapoint, { val: writeVal, ack: false });
                    // {status} in the message field is replaced by the per-rule "status text"
                    // (e.g. "active"/"not active" instead of true/false).
                    let confirmText;
                    if (button.message) {
                        const withStatus = button.message
                            .replace(/([\p{L}\p{N}])\{status\}/gu, '$1 {status}')
                            .replace(/\{status\}/g, rule.statusText || rule.label || String(writeVal));
                        confirmText = await resolveTemplate(adapter, withStatus);
                    } else {
                        confirmText =
                            `✅ ${rule.label || button.text || ''}${rule.statusText ? ` ${rule.statusText}` : ` → ${writeVal}`}`.trim();
                    }
                    // Update the keyboard right away, so a possibly different button text (next
                    // status) is visible immediately - no second message needed.
                    const currentMenuKey = (await adapter.getStateAsync('runtime.currentMenu'))?.val || 'main';
                    await renderMenu(user, currentMenuKey, confirmText);
                } catch (e) {
                    adapter.log.warn(`Multi-status write to ${rule.writeDatapoint} failed: ${e.message}`);
                    await sendText(user, t('bot.writeFailed', { datapoint: rule.writeDatapoint }));
                }
                return;
            }
        }

        // HTTP request button from the editor - no script, no module needed.
        // Fires an HTTP call (GET/POST, optional basic auth) and then shows a
        // confirmation with the status code. {status} and {response} in the message
        // field are replaced by the HTTP status and the (shortened) response text.
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
                const controller = new AbortController();
                const timeoutId = adapter.setTimeout(() => controller.abort(), 15000);
                let resp;
                try {
                    resp = await fetch(button.httpUrl, {
                        method,
                        headers,
                        body: button.httpBody && method !== 'GET' ? button.httpBody : undefined,
                        signal: controller.signal,
                    });
                } finally {
                    adapter.clearTimeout(timeoutId);
                }
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
                adapter.log.warn(`HTTP request button (${button.httpUrl}) failed: ${e.message}`);
                await sendText(user, t('bot.httpFailed', { msg: e.message }));
            }
            return;
        }

        // Direct datapoint binding from the editor - no script, no module needed.
        if (button.datapoint) {
            // Set a fixed value: ALWAYS writes exactly this value, regardless of the current
            // state (e.g. mode selection "auto"/"manual"/"off", fixed presets) - unlike the
            // toggle below, which switches between two values.
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
                    adapter.log.warn(`Fixed-value write to ${button.datapoint} failed: ${e.message}`);
                    await sendText(user, t('bot.writeFailed', { datapoint: button.datapoint }));
                }
                return;
            }

            if (button.inputType === 'number') {
                // Number input: real numeric keypad instead of free typing. The message is NOT
                // used as a question, but only resolved after writing as a confirmation (so
                // {{datapoint.id}} shows the NEW value).
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
                // Text input: normal typing on the phone keyboard. The message is NOT used as
                // a question, but only resolved after writing as a confirmation (so
                // {{datapoint.id}} shows the NEW value).
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
                await sendTextNoKeyboard(user, button.prompt || t('bot.enterTextPrompt'));
                return;
            }

            // Toggle: read immediately, switch, write back.
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
                // A custom message takes precedence over the generic "✅/❌ → value" confirmation.
                const confirmText = button.message
                    ? await resolveTemplate(adapter, button.message)
                    : `${isOn ? '❌' : '✅'} ${button.text || ''} → ${nextVal}`.trim();
                const currentMenuKey = (await adapter.getStateAsync('runtime.currentMenu'))?.val || 'main';
                await renderMenu(user, currentMenuKey, confirmText);
            } catch (e) {
                adapter.log.warn(`Datapoint toggle for ${button.datapoint} failed: ${e.message}`);
                await sendText(user, t('bot.toggleFailed', { datapoint: button.datapoint }));
            }
            return;
        }

        // Direct script assignment from the editor: "this button calls function <cmd>
        // in script <scriptId>" - fully configured in the editor, no sendTo
        // self-registration in the script needed. The script only needs:
        //   onMessage('<cmd>', (data, callback) => { ...; callback({text}); });
        if (button.scriptId && button.cmd) {
            const result = await adapter.scriptBridge.callScript(button.scriptId, button.cmd, {
                value: button.text,
                user,
            });
            if (result && result.text) {
                const opts = { html: !!result.html, noPreview: !!(result.noPreview || result.disablePreview) };
                if (result.awaitReply) {
                    // The script wants an answer to its question - the next message (free text or
                    // key press on its own keyboard) goes back to the SAME script/command
                    // (data.isReply = true).
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
                adapter.log.warn(`Script ${button.scriptId} did not respond to "${button.cmd}"`);
                await sendText(user, t('bot.noScriptResponse'));
            }
            return;
        }

        // Message template from the editor: rendered directly as soon as it is set -
        // no extra checkbox needed any more, as with the former "core takes over
        // completely". Datapoint/script above take precedence if both are set.
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
