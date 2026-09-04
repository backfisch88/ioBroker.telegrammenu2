'use strict';

const { getMenu } = require('./registry');
const { hasPermission } = require('./users');
const { resolveTemplate } = require('./template');

// Behandelt Tastendrücke aus den vordefinierten Wert-Submenüs
// (source: 'percentRange' / 'numberRange' in autoMenus.js), die als
// Inline-Keyboard verschickt werden (siehe sendInlineMenu in base.js).
//
// Der Button-cmd hat das Format "TG:VALSET:<menuKey>|<value>" bzw.
// "TG:VALCUSTOM:<menuKey>" - bewusst der MENÜ-SCHLÜSSEL statt des vollen
// Datenpunktpfads, weil Telegrams callback_data auf 64 Byte begrenzt ist und
// lange Datenpunkt-IDs das sonst sprengen würden. Der Datenpunkt (und
// min/max) wird hier serverseitig anhand des Menü-Schlüssels nachgeschlagen.

async function buildConfirmText(adapter, menuDef, value) {
    const unit = menuDef.unit || (menuDef.source === 'percentRange' ? '%' : '');
    if (menuDef.confirmMessage) {
        const withPlaceholders = menuDef.confirmMessage.replace(/\{value\}/g, String(value)).replace(/\{unit\}/g, unit);
        return resolveTemplate(adapter, withPlaceholders);
    }
    return `✅ ${value}${unit} gesetzt.`;
}

async function handleValueSetCommand(adapter, cmd, user, userKey, renderMenu) {
    if (!cmd || !cmd.startsWith('TG:VALSET:')) {
        return false;
    }

    const rest = cmd.slice('TG:VALSET:'.length);
    const sepIdx = rest.lastIndexOf('|');
    if (sepIdx === -1) {
        adapter.log.warn(`TG:VALSET: ungültiges Format (kein "|" gefunden): ${cmd}`);
        return true;
    }

    const menuKey = rest.slice(0, sepIdx);
    const rawValue = rest.slice(sepIdx + 1);
    const value = Number(rawValue);

    const menuDef = await getMenu(adapter, menuKey);
    const datapoint = menuDef && menuDef.datapoint;

    if (!datapoint || isNaN(value)) {
        adapter.log.warn(`TG:VALSET: ungültiges Menü/Wert: "${cmd}"`);
        return true;
    }

    // Direkt-Dispatch (siehe handleIncoming) läuft AN findButtonByText() vorbei,
    // das sonst automatisch die Menü-Berechtigung geprüft hätte - hier daher
    // explizit nachholen, sonst könnte ein Nutzer mit einem craftedn cmd ein
    // fremdes, eigentlich geschütztes Menü ansteuern.
    if (menuDef.perm && !(await hasPermission(adapter, menuDef.perm, userKey))) {
        return true;
    }

    try {
        await adapter.setForeignStateAsync(datapoint, { val: value, ack: false });
    } catch (e) {
        adapter.log.warn(`TG:VALSET: Schreiben auf ${datapoint} fehlgeschlagen: ${e.message}`);
    }

    // Statt das Inline-Menü erneut zu zeigen, direkt zurück ins Elternmenü mit
    // einer Bestätigung ("✅ 60% gesetzt." oder eigener Text aus menuDef.message,
    // Platzhalter {value}/{unit} verfügbar) - kürzerer Weg für den Nutzer.
    const confirmText = await buildConfirmText(adapter, menuDef, value);
    await renderMenu(user, menuDef.parent || 'main', confirmText);

    return true;
}

async function handleValueCustomCommand(adapter, cmd, user, userKey, startNumpadInput) {
    if (!cmd || !cmd.startsWith('TG:VALCUSTOM:')) {
        return false;
    }

    const menuKey = cmd.slice('TG:VALCUSTOM:'.length);
    const menuDef = await getMenu(adapter, menuKey);

    if (!menuDef || !menuDef.datapoint) {
        adapter.log.warn(`TG:VALCUSTOM: Menü/Datenpunkt nicht gefunden: "${cmd}"`);
        return true;
    }

    if (menuDef.perm && !(await hasPermission(adapter, menuDef.perm, userKey))) {
        return true;
    }

    // menuKey hier ist bewusst das ELTERNMENÜ (nicht das Wert-Menü selbst) -
    // der Ziffernblock landet nach "✅ Fertig" direkt dort, mit derselben
    // {value}/{unit}-Bestätigung wie beim direkten Preset-Tap ("{value}" kann
    // hier noch nicht aufgelöst werden - der Wert steht erst nach der
    // Ziffernblock-Eingabe fest - daher als Platzhalter durchreichen, siehe
    // handleNumpadInput in base.js).
    const unit = menuDef.unit || (menuDef.source === 'percentRange' ? '%' : '');
    const message = menuDef.confirmMessage
        ? menuDef.confirmMessage.replace(/\{unit\}/g, unit)
        : `✅ {value}${unit} gesetzt.`;

    await startNumpadInput(user, {
        datapoint: menuDef.datapoint,
        min: menuDef.min,
        max: menuDef.max,
        menuKey: menuDef.parent || 'main',
        prompt: `Bitte Wert eingeben${unit ? ` (${unit})` : ''}:`,
        message,
    });

    return true;
}

module.exports = { handleValueSetCommand, handleValueCustomCommand };
