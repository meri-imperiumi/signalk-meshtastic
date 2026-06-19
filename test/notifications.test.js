const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { shouldWeSendNotification } = require('../plugin/notifications');

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
});
