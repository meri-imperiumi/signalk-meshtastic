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
});
