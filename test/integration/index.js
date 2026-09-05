const path = require('node:path');
const { tests } = require('@iobroker/testing');

// Minimal integration test: starts a real js-controller instance and checks
// that the adapter comes up cleanly (no crash on startup with default config).
tests.integration(path.join(__dirname, '..', '..'), {
    controllerVersion: 'latest',
    // main.js waits on the telegram instance's communicate.request state and
    // never calls process.exit() during normal startup - no exit codes need
    // to be allowed here.
    allowedExitCodes: [],
});
