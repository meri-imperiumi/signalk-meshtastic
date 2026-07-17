const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { shouldWeSendNotification, sendNotification } = require('../plugin/notifications');

describe('notification sending', () => {
  const settingsSendAlerts = {
    communications: {
      send_alerts: true,
    },
  };
  const settingsDontSendAlerts = {
    communications: {
      send_alerts: false,
    },
  };
  it('should rank EMERGENCY as sendable', () => {
    const episodes = new Map();
    const result = shouldWeSendNotification(
      'notifications.communication.meshtastic.deviceStateNum',
      {
        state: 'emergency',
        message: 'Disconnected from Meshtastic node',
      },
      episodes,
      settingsSendAlerts,
    );
    assert.equal(result, true);
  });
  it('should rank EMERGENCY as not sendable if alert sending is disabled', () => {
    const episodes = new Map();
    const result = shouldWeSendNotification(
      'notifications.communication.meshtastic.deviceStateNum',
      {
        state: 'emergency',
        message: 'Disconnected from Meshtastic node',
      },
      episodes,
      settingsDontSendAlerts,
    );
    assert.equal(result, false);
  });
  it('should rank NOMINAL as not sendable', () => {
    const episodes = new Map();
    const result = shouldWeSendNotification(
      'notifications.communication.meshtastic.deviceStateNum',
      {
        state: 'nominal',
        message: 'Meshtastic connected and configured',
      },
      episodes,
      settingsSendAlerts,
    );
    assert.equal(result, false);
  });
  it('with alert switching rapidly on and off, it should send only first one', () => {
    const episodes = new Map();
    const result1 = shouldWeSendNotification(
      'notifications.communication.meshtastic.deviceStateNum',
      {
        state: 'alarm',
        message: 'Meshtastic disconnect',
      },
      episodes,
      settingsSendAlerts,
    );
    assert.equal(result1, true, 'first alarm should be sent');
    const result2 = shouldWeSendNotification(
      'notifications.communication.meshtastic.deviceStateNum',
      {
        state: 'nominal',
        message: 'Meshtastic connected and configured',
      },
      episodes,
      settingsSendAlerts,
    );
    assert.equal(result2, false, 'clearing should not be sent');
    const result3 = shouldWeSendNotification(
      'notifications.communication.meshtastic.deviceStateNum',
      {
        state: 'alarm',
        message: 'Meshtastic disconnect',
      },
      episodes,
      settingsSendAlerts,
    );
    assert.equal(result3, false, 'second alarm should not be sent');
  });
  it('with alert re-issuing after previous expired, it should send', () => {
    const episodes = new Map();
    const startTime = new Date();
    const result1 = shouldWeSendNotification(
      'notifications.communication.meshtastic.deviceStateNum',
      {
        state: 'alarm',
        message: 'Meshtastic disconnect',
      },
      episodes,
      settingsSendAlerts,
      startTime,
    );
    assert.equal(result1, true, 'first alarm should be sent');
    const clearTime = new Date(startTime.getTime() + 10000);
    const result2 = shouldWeSendNotification(
      'notifications.communication.meshtastic.deviceStateNum',
      {
        state: 'nominal',
        message: 'Meshtastic connected and configured',
      },
      episodes,
      settingsSendAlerts,
      clearTime,
    );
    assert.equal(result2, false, 'clearing should not be sent');
    const restartTime = new Date(clearTime.getTime() + 400000);
    const result3 = shouldWeSendNotification(
      'notifications.communication.meshtastic.deviceStateNum',
      {
        state: 'alarm',
        message: 'Meshtastic disconnect',
      },
      episodes,
      settingsSendAlerts,
      restartTime,
    );
    assert.equal(result3, true, 'second alarm should be sent');
  });

  describe('sendNotification (real device entry point)', () => {
    const crewSettings = {
      communications: { send_alerts: true },
      nodes: [{ role: 'crew', node: 42 }],
    };
    const alarm = { state: 'alarm', message: 'Bilge high!' };
    const clear = { state: 'nominal', message: 'ok' };

    function fakeApp() {
      return { error: () => {} };
    }

    function fakeDevice() {
      const sent = [];
      const device = {
        sendText: (msg, node, wantAck) => {
          sent.push({ msg, node, wantAck });
          return Promise.resolve();
        },
      };
      return { device, sent };
    }

    // Regression: sendNotification previously passed the `device` object as the
    // `now` argument to shouldWeSendNotification. That made `currentTime` a
    // truthy non-Date, so `currentTime - clearedSince` evaluated to NaN and the
    // debounce window never expired. After an alert cleared once it could never
    // be re-sent, even hours later.
    it('re-sends an alert long after it cleared (device no longer leaks as `now`)', async () => {
      const { device, sent } = fakeDevice();
      const episodes = new Map();
      const app = fakeApp();
      const path = 'notifications.electrical.bilge';

      // 1) First alarm is sent.
      await sendNotification(path, alarm, episodes, crewSettings, device, app);
      assert.equal(sent.length, 1, 'first alarm should be sent');

      // 2) Clearing the alarm is not sent, but the episode is tracked.
      await sendNotification(path, clear, episodes, crewSettings, device, app);
      assert.equal(sent.length, 1, 'clearing should not be sent');
      const episode = episodes.get(path);
      assert.ok(episode, 'episode is tracked after clearing');
      assert.ok(episode.clearedSince instanceof Date, 'clearedSince is a real Date');

      // 3) Simulate the clear having happened 15h ago.
      episode.clearedSince = new Date(Date.now() - 15 * 60 * 60 * 1000);

      // 4) The same alarm firing again must be re-sent.
      await sendNotification(path, alarm, episodes, crewSettings, device, app);
      assert.equal(sent.length, 2, 're-fired alarm after a long gap should be sent');
    });
  });
});
