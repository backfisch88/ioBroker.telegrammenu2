'use strict';

const { t } = require('./botI18n');

// Translates technical perm/area names into nice display names, e.g. in user
// management and notifications. Only a couple of universal entries are
// predefined here - everything else is set conveniently in the editor tab
// itself (menu node panel: "display name for the area").

function getLabels() {
    return {
        admin: 'Administrator',
        settings: t('bot.settings'),
    };
}

function permLabel(perm) {
    return getLabels()[perm] || perm;
}

module.exports = { permLabel, getLabels };
