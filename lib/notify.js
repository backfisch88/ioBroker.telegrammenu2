'use strict';

const { ensureDynamicState } = require('./states');
const { listAdminChatIds } = require('./users');
const { getMenu } = require('./registry');
const { t, typeLabel } = require('./botI18n');
const { toPermId } = require('./idUtil');

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

    // Persists the current state in telegrammenu2.0.notify.areas - you can also
    // enter areas yourself there (edit the JSON state directly in admin) before any
    // notify() call or module knows them.
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

    // Called on adapter start: loads previously saved/manually entered areas
    // before modules register their own.
    async function init() {
        await ensureDynamicState(adapter, AREAS_STATE, '{}', 'json');
        const state = await adapter.getStateAsync(AREAS_STATE);
        try {
            const obj = JSON.parse(state?.val || '{}');
            for (const [area, entry] of Object.entries(obj)) {
                // Backwards compatible: the old form was simply an array of types.
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
            adapter.log.warn(`notify: could not read ${AREAS_STATE}: ${e.message}`);
        }
    }

    // Called by the script bridge or the editor tab when registering explicitly -
    // both count as trusted and are approved immediately, unlike automatic
    // discovery in send() (see below), which has to be approved manually first.
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
        return validAreas[area]?.labels?.[type] || typeLabel(type);
    }

    function isOverride(area, type) {
        return !!validAreas[area]?.override?.has(type);
    }

    function getAreaLabel(area) {
        return validAreas[area]?.areaLabel || '';
    }

    // Approved areas only - this is what shows up in the "Notifications" menu
    // and in the editor by default.
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

    // Automatically discovered but not yet approved areas - e.g. test messages from
    // foreign adapters that should not show up everywhere yet.
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

    // Escapes the three characters reserved by Telegram's HTML parser, so a stray
    // "<"/">"/"&" in a PLAIN text message is not interpreted as a (broken) HTML
    // tag when it ends up in a bundle together with a REAL HTML message.
    function escapeHtml(str) {
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
            adapter.log.warn(`notify: sending to ${userChatId} failed: ${e.message}`);
        }
    }

    async function flush(userKey, userChatId) {
        const items = buffers[userKey] || [];
        delete buffers[userKey];
        delete timers[userKey];
        if (!items.length) {
            return;
        }
        // As soon as AT LEAST ONE message in the bundle wants HTML, the whole combined
        // message is sent in HTML mode - the other (not marked as HTML) parts are
        // escaped so they are guaranteed to appear as plain text, instead of silently
        // dropping the HTML formatting for the whole bundle.
        const anyHtml = items.some(i => i.html);
        const text = items.map(i => (anyHtml && !i.html ? escapeHtml(i.text) : i.text)).join('\n\n');
        const anyNoPreview = items.some(i => i.noPreview);
        await deliverToUser(userChatId, text, anyHtml, anyNoPreview);
    }

    // Pause an area for X hours - "warn"/"error" still get through (important
    // things like weather warnings must not be paused, only the informative/
    // reminder messages).
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

    // Sends all admins a message with inline buttons "Allow"/"Don't allow" -
    // independent of the running conversation (inline buttons do not disturb the
    // normal keyboard/input queue, see callback_query).
    async function notifyAdminsAboutPendingArea(area, type) {
        try {
            const chatIds = await listAdminChatIds(adapter);
            if (!chatIds.length) {
                return;
            }
            const text = t('bot.newAreaRequest', {
                area,
                typeSuffix: type ? t('bot.newAreaTypeSuffix', { type }) : '',
            });
            const keyboard = {
                inline_keyboard: [
                    [
                        { text: t('bot.allow'), callback_data: `TG:ADMIN:APPROVEAREA:${area}` },
                        { text: t('bot.deny'), callback_data: `TG:ADMIN:DENYAREA:${area}` },
                    ],
                ],
            };
            for (const chatId of chatIds) {
                await adapter.sendToAsync(adapter.telegramInstance, { text, user: chatId, reply_markup: keyboard });
            }
        } catch (e) {
            adapter.log.warn(`notify: admin notification for new area "${area}" failed: ${e.message}`);
        }
    }

    // Global option "do NOT bundle these types" - freely definable, hidden in the
    // main menu node in the editor (menu key "main"). Everything NOT in this list
    // is bundled by default (exclusion instead of inclusion list) - default without
    // any configuration: warn,error stay individual immediately, everything else
    // (e.g. info) is collected.
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

    // send(area, type, text) - same signature as the old notify(area, type, text, extra)
    async function send(area, type, text, extra = null) {
        if (!text || !area) {
            return;
        }

        // Opt-in formatting via "extra": either as an object {html, noPreview} OR as a
        // short string, e.g. 'html', 'nopreview' or combined 'html,nopreview'. Default
        // (no extra or other values) stays plain text with the normal link preview as
        // before.
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

        // An area does NOT show up in the "Notifications" list immediately when it is
        // discovered automatically for the first time (e.g. test messages from foreign
        // adapters) - it has to be approved via approveArea() first.
        // Module/editor registrations are exempt (see registerAreas).
        const isNewArea = !validAreas[area];
        const entry = ensureAreaEntry(area, false);
        let changed = isNewArea;
        if (type && !entry.types.has(type)) {
            entry.types.add(type);
            changed = true;
        }
        if (changed) {
            if (!entry.approved) {
                adapter.log.info(`notify: new area "${area}" auto-discovered, awaiting approval (approveArea)`);
            }
            await persist();
        }
        if (isNewArea && !entry.approved) {
            await notifyAdminsAboutPendingArea(area, type);
        }

        // Unapproved areas are not delivered at all - not just "invisible in the menu"
        // but really blocked until approveArea() was called. This way test messages of
        // foreign adapters do not spam anybody.
        if (!entry.approved) {
            adapter.log.debug(`notify: area "${area}" not yet approved - message discarded`);
            return;
        }

        // Paused area: only "warn"/"error" still get through (real warnings must not
        // be paused), everything else is dropped.
        if (isAreaPaused(area) && type !== 'warn' && type !== 'error') {
            adapter.log.debug(
                `notify: area "${area}" paused until ${new Date(entry.pausedUntil).toISOString()} - message discarded`,
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
            const permState = await adapter.getStateAsync(`users.${userKey}.permissions.${toPermId(area)}`);
            const allowed = permState?.val === true || permState?.val === 'true' || permState?.val === 1;
            if (!allowed) {
                continue;
            }

            // Override types ignore the notification preference completely -
            // "cannot be switched off" as long as the access right exists.
            const isOverride = entry.override.has(type);
            if (!isOverride) {
                const notifyType = type || 'general';
                const notifyPrefState = await adapter.getStateAsync(
                    `users.${userKey}.notify.${toPermId(area)}.${toPermId(notifyType)}`,
                );
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

    // Delivers all currently collected (bundled but not yet sent) messages
    // IMMEDIATELY - called on adapter stop so nothing is lost just because an
    // update/restart falls into the 15-second collection window (buffers/timers
    // only live in memory, a restart without this flush would silently drop them).
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
