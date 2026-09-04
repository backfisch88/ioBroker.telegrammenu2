'use strict';

// Übersetzt technische perm-/Bereichsnamen in schöne Anzeigenamen, z. B. in
// der Benutzerverwaltung und den Benachrichtigungen. Nur ein paar universelle
// Einträge vordefiniert - alles andere richtest du bequem im Editor-Tab selbst
// ein (Menü-Knoten-Panel: "Anzeigename für den Bereich").

const LABELS = {
    admin: 'Administrator',
    settings: 'Einstellungen',
};

function permLabel(perm) {
    return LABELS[perm] || perm;
}

module.exports = { permLabel, LABELS };
