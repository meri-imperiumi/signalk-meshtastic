const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

const pluginFactory = require('../plugin/index');

describe('plugin', () => {
  const app = { debug: () => {}, error: () => {} };
  const plugin = pluginFactory(app);

  it('has required interface', () => {
    assert.equal(typeof plugin.start, 'function');
    assert.equal(typeof plugin.stop, 'function');
    assert.ok(plugin.id);
  });

  it('starts and stops without error', () => {
    plugin.start({}, () => {});
    plugin.stop();
  });

  // Mirrors the signalk-ci plugin lifecycle check: start() and
  // stop() are called with an empty configuration and no restart
  // callback while the Meshtastic library is still loading
  it('start/stop with empty configuration stays clean while library loads', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'signalk-meshtastic-test-'));
    const statuses = [];
    const serverApp = {
      debug: () => {},
      error: () => {},
      setPluginStatus: (msg) => statuses.push(msg),
      setPluginError: (msg) => statuses.push(msg),
      getDataDirPath: () => dataDir,
      handleMessage: () => {},
      subscriptionmanager: {
        subscribe: () => {},
      },
      signalk: {
        root: {},
      },
    };
    const serverPlugin = pluginFactory(serverApp);
    const crashes = [];
    const onRejection = (e) => {
      crashes.push(`unhandled rejection: ${e && e.message}`);
    };
    process.on('unhandledRejection', onRejection);
    try {
      serverPlugin.start({});
      serverPlugin.stop();
      serverPlugin.start({});
      serverPlugin.stop();
      // Wait for the library import and any queued
      // work to play out
      await new Promise((resolve) => {
        setTimeout(resolve, 2000);
      });
    } finally {
      serverPlugin.stop();
      process.off('unhandledRejection', onRejection);
      rmSync(dataDir, { recursive: true, force: true });
    }
    assert.deepEqual(crashes, []);
    assert.ok(statuses.includes('Waiting for Meshtastic library to load'));
  });
});
