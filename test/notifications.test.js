const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldWeSendNotification,
  sendNotification,
  sweepNotifications,
} = require('../plugin/notifications');

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

describe('notification clearing (sweep)', () => {
  const windowMs = 5 * 60 * 1000;
  const crewSettings = {
    communications: { send_alerts: true },
    nodes: [{ role: 'crew', node: 42 }, { role: 'crew', node: 43 }],
  };
  const alarm = { state: 'alarm', message: 'Bilge high!' };
  const clear = { state: 'nominal', message: 'ok' };
  const path = 'notifications.electrical.bilge';
  const startTime = new Date('2026-07-20T10:00:00Z');

  it('sends a plain text clearing message to crew after the hysteresis window', async () => {
    const { device, sent } = fakeDevice();
    const episodes = new Map();
    const app = fakeApp();

    assert.equal(
      shouldWeSendNotification(path, alarm, episodes, crewSettings, startTime),
      true,
      'first alarm should be sent',
    );
    const clearTime = new Date(startTime.getTime() + 60000);
    shouldWeSendNotification(path, clear, episodes, crewSettings, clearTime);

    // Still inside the hysteresis window: no clearing message yet
    await sweepNotifications(
      episodes,
      crewSettings,
      device,
      app,
      new Date(clearTime.getTime() + windowMs - 1),
    );
    assert.equal(sent.length, 0, 'no clearing message inside the window');
    assert.ok(episodes.has(path), 'episode is kept inside the window');

    // Window expired: clearing message goes to each crew member
    await sweepNotifications(
      episodes,
      crewSettings,
      device,
      app,
      new Date(clearTime.getTime() + windowMs),
    );
    assert.equal(sent.length, 2, 'clearing message sent to each crew member');
    assert.deepEqual(
      sent.map((s) => s.msg),
      ['Cleared after 1 min: Bilge high!', 'Cleared after 1 min: Bilge high!'],
    );
    assert.equal(sent[0].node, 42);
    assert.equal(sent[1].node, 43);
    assert.equal(sent[0].wantAck, true);
    assert.ok(!sent[0].msg.includes('\u0007'), 'clearing message has no bell');
    assert.ok(!episodes.has(path), 'episode is removed after clearing');
  });

  it('does not send a clearing message when the alert re-triggers inside the window', async () => {
    const { device, sent } = fakeDevice();
    const episodes = new Map();
    const app = fakeApp();

    shouldWeSendNotification(path, alarm, episodes, crewSettings, startTime);
    shouldWeSendNotification(
      path,
      clear,
      episodes,
      crewSettings,
      new Date(startTime.getTime() + 60000),
    );
    assert.equal(
      shouldWeSendNotification(
        path,
        alarm,
        episodes,
        crewSettings,
        new Date(startTime.getTime() + 120000),
      ),
      false,
      're-triggered alarm should not be re-sent',
    );

    await sweepNotifications(
      episodes,
      crewSettings,
      device,
      app,
      new Date(startTime.getTime() + windowMs * 12),
    );
    assert.equal(sent.length, 0, 'no clearing message for a still-active alert');
    assert.ok(episodes.has(path), 'episode is kept while alert is active');
  });

  it('includes duration and transition count for flapping alerts', async () => {
    const { device, sent } = fakeDevice();
    const episodes = new Map();
    const app = fakeApp();

    shouldWeSendNotification(path, alarm, episodes, crewSettings, startTime);
    shouldWeSendNotification(
      path,
      clear,
      episodes,
      crewSettings,
      new Date(startTime.getTime() + 60000),
    );
    shouldWeSendNotification(
      path,
      alarm,
      episodes,
      crewSettings,
      new Date(startTime.getTime() + 120000),
    );
    shouldWeSendNotification(
      path,
      clear,
      episodes,
      crewSettings,
      new Date(startTime.getTime() + 600000),
    );

    await sweepNotifications(
      episodes,
      crewSettings,
      device,
      app,
      new Date(startTime.getTime() + 600000 + windowMs),
    );
    assert.equal(sent.length, 2, 'clearing message sent to each crew member');
    assert.equal(sent[0].msg, 'Cleared after 10 min: Bilge high!, 2 transitions');
  });

  it('falls back to the notification path when no message was stored', async () => {
    const { device, sent } = fakeDevice();
    const episodes = new Map();
    const app = fakeApp();

    shouldWeSendNotification(path, { state: 'alarm' }, episodes, crewSettings, startTime);
    const clearTime = new Date(startTime.getTime() + 30000);
    shouldWeSendNotification(path, clear, episodes, crewSettings, clearTime);

    await sweepNotifications(
      episodes,
      crewSettings,
      device,
      app,
      new Date(clearTime.getTime() + windowMs),
    );
    assert.equal(sent.length, 2, 'clearing message sent to each crew member');
    assert.equal(sent[0].msg, 'Cleared after 30 s: electrical.bilge');
  });

  it('cleans up expired episodes without sending when alert sending is disabled', async () => {
    const { device, sent } = fakeDevice();
    const episodes = new Map();
    const app = fakeApp();

    shouldWeSendNotification(path, alarm, episodes, crewSettings, startTime);
    const clearTime = new Date(startTime.getTime() + 60000);
    shouldWeSendNotification(path, clear, episodes, crewSettings, clearTime);

    await sweepNotifications(
      episodes,
      { communications: { send_alerts: false } },
      device,
      app,
      new Date(clearTime.getTime() + windowMs),
    );
    assert.equal(sent.length, 0, 'nothing sent when alerts are disabled');
    assert.ok(!episodes.has(path), 'episode is still cleaned up');
  });

  it('cleans up expired episodes without sending when there is no crew', async () => {
    const { device, sent } = fakeDevice();
    const episodes = new Map();
    const app = fakeApp();
    const noCrewSettings = {
      communications: { send_alerts: true },
      nodes: [],
    };

    shouldWeSendNotification(path, alarm, episodes, noCrewSettings, startTime);
    const clearTime = new Date(startTime.getTime() + 60000);
    shouldWeSendNotification(path, clear, episodes, noCrewSettings, clearTime);

    await sweepNotifications(
      episodes,
      noCrewSettings,
      device,
      app,
      new Date(clearTime.getTime() + windowMs),
    );
    assert.equal(sent.length, 0, 'nothing sent without crew nodes');
    assert.ok(!episodes.has(path), 'episode is still cleaned up');
  });

  it('keeps episodes for the next sweep when there is no device connection', async () => {
    const episodes = new Map();
    const app = fakeApp();

    shouldWeSendNotification(path, alarm, episodes, crewSettings, startTime);
    const clearTime = new Date(startTime.getTime() + 60000);
    shouldWeSendNotification(path, clear, episodes, crewSettings, clearTime);

    await sweepNotifications(
      episodes,
      crewSettings,
      null,
      app,
      new Date(clearTime.getTime() + windowMs),
    );
    assert.ok(episodes.has(path), 'episode is kept for retry once device connects');
  });
});
