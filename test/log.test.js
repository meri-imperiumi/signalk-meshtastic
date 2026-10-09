const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const log = require('../plugin/commands/log');

const CREW = 463761856;
const nodeDb = {
  [CREW]: { shortName: 'deck', longName: 'Deck watch' },
};

function mockDevice() {
  const sent = [];
  return {
    sent,
    sendText: (text, to) => {
      sent.push({ text, to });
      return Promise.resolve();
    },
  };
}

function mockApp(failWith) {
  const writes = [];
  return {
    writes,
    resourcesApi: {
      setResource: (type, id, value) => {
        writes.push({ type, id, value });
        if (failWith) {
          return Promise.reject(failWith);
        }
        return Promise.resolve();
      },
    },
  };
}

function dm(data) {
  return { type: 'direct', from: CREW, data };
}

describe('log command', () => {
  it('accepts log messages', () => {
    assert.equal(log.accept(dm('log Changed the oil')), true);
    assert.equal(log.accept(dm('LOG Changed the oil')), true);
  });

  it('does not accept other messages', () => {
    assert.equal(log.accept(dm('Ping')), false);
    assert.equal(log.accept(dm('log')), false);
    // "log" followed by whitespace is required, so words merely starting
    // with it are not entries
    assert.equal(log.accept(dm('logo design ideas')), false);
  });

  it('writes a manual entry and confirms success', () => {
    const device = mockDevice();
    const app = mockApp();
    return log.handle(dm('log Changed the engine oil'), {}, device, app)
      .then(() => {
        assert.equal(app.writes.length, 1);
        assert.equal(app.writes[0].type, 'logentries');
        assert.match(app.writes[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
        assert.deepEqual(app.writes[0].value, {
          text: 'Changed the engine oil',
          origin: 'manual',
        });
        assert.deepEqual(device.sent, [{ text: 'OK, logged', to: CREW }]);
      });
  });

  it('uses a hashtag as the entry category, removed from the text', () => {
    const device = mockDevice();
    const app = mockApp();
    return log.handle(dm('log Changed the engine oil #maintenance'), {}, device, app)
      .then(() => {
        assert.deepEqual(app.writes[0].value, {
          text: 'Changed the engine oil',
          origin: 'manual',
          category: 'maintenance',
        });
        assert.deepEqual(device.sent, [{ text: 'OK, logged', to: CREW }]);
      });
  });

  it('finds hashtags at the start of the text', () => {
    const device = mockDevice();
    const app = mockApp();
    return log.handle(dm('log #engine Impeller swapped'), {}, device, app)
      .then(() => {
        assert.deepEqual(app.writes[0].value, {
          text: 'Impeller swapped',
          origin: 'manual',
          category: 'engine',
        });
      });
  });

  it('lowercases hashtags and removes them wherever they appear', () => {
    const device = mockDevice();
    const app = mockApp();
    return log.handle(dm('log Spliced #Maintenance the halyard #rigging'), {}, device, app)
      .then(() => {
        assert.deepEqual(app.writes[0].value, {
          text: 'Spliced the halyard',
          origin: 'manual',
          category: 'maintenance',
        });
      });
  });

  it('credits the configured crew name as the entry author', () => {
    const device = mockDevice();
    const app = mockApp();
    const settings = { nodes: [{ node: CREW, role: 'crew', name: 'Alice' }] };
    return log.handle(dm('log Changed the oil'), settings, device, app, null, null, nodeDb)
      .then(() => {
        assert.deepEqual(app.writes[0].value, {
          text: 'Changed the oil',
          origin: 'manual',
          author: 'Alice',
        });
      });
  });

  it('falls back to the sender device shortname as the author', () => {
    const device = mockDevice();
    const app = mockApp();
    return log.handle(dm('log Changed the oil'), {}, device, app, null, null, nodeDb)
      .then(() => {
        assert.equal(app.writes[0].value.author, 'deck');
      });
  });

  it('leaves the author out when the sender is unknown', () => {
    const device = mockDevice();
    const app = mockApp();
    return log.handle(dm('log Changed the oil'), {}, device, app, null, null, {})
      .then(() => {
        assert.equal(app.writes[0].value.author, undefined);
      });
  });

  it('refuses to log a text that is only hashtags', () => {
    const device = mockDevice();
    const app = mockApp();
    return log.handle(dm('log #maintenance'), {}, device, app)
      .then(() => {
        assert.equal(app.writes.length, 0);
        assert.deepEqual(device.sent, [{ text: 'Nothing to log', to: CREW }]);
      });
  });

  it('replies when no logbook resource provider is available', () => {
    const device = mockDevice();
    const app = {};
    return log.handle(dm('log Changed the oil'), {}, device, app)
      .then(() => {
        assert.deepEqual(device.sent, [{ text: 'Logbook not available', to: CREW }]);
      });
  });

  it('replies when the logbook write fails', () => {
    const device = mockDevice();
    const app = mockApp(new Error('disk full'));
    return log.handle(dm('log Changed the oil'), {}, device, app)
      .then(() => {
        assert.deepEqual(device.sent, [{ text: 'Logging failed: disk full', to: CREW }]);
      });
  });
});
