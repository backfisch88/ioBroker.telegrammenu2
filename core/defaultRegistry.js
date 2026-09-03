'use strict';

// Imported automatically on the very first start (only if the registry is
// still empty) so the bot has a reachable main menu right away. This is
// deliberately minimal - just enough to get you into the built-in settings
// (user management, notification preferences). Everything else is content
// you build yourself in the Menu Editor.

module.exports = {
  main: {
    title: '🏠 Main Menu',
    rows: [[{ text: '⚙️ Settings', cmd: 'TG:NAV:SETTINGS', nextMenu: 'settings_main' }]],
  },

  settings_main: {
    title: '⚙️ Settings',
    parent: 'main',
    rows: [
      [
        { text: '👤 Users', cmd: 'TG:NAV:ADMIN', nextMenu: 'admin_main' },
        { text: '🔔 Notifications', cmd: 'TG:NAV:SETTINGS:NOTIFY', nextMenu: 'settings_notify' },
      ],
      [
        { text: '⬅️ Back', cmd: 'TG:NAV:BACK' },
        { text: '🏠 Main Menu', cmd: 'TG:NAV:MAIN' },
      ],
    ],
  },

  // Deliberately without "perm" so it's reachable immediately in a fresh
  // install. In a real setup you'd normally set perm: 'admin' here.
  admin_main: { title: '👤 Users', parent: 'settings_main', source: 'users' },
  settings_notify: { title: '🔔 Notifications', parent: 'settings_main', source: 'notifyPrefs' },
  settings_notify_pause: { title: '⏸ Pause', parent: 'settings_notify', source: 'notifyPause' },
};
