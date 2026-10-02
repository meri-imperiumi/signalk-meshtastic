const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const commands = require('../plugin/commands');
const fallback = require('../plugin/commands/fallback');

const CREW = 463761856;
const STRANGER = 1234567890;
const SELF = 2409574272;

const settings = {
  nodes: [
    { node: CREW, role: 'crew' },
  ],
  communications: {},
};

function mockDevice() {
  const sent = [];
  return {
    sent,
    myNodeInfo: { myNodeNum: SELF },
    sendText: (text, to) => {
      sent.push({ text, to });
      return Promise.resolve();
    },
  };
}

const app = {
  debug: () => {},
  error: () => {},
};

function dm(from, data) {
  return {
    type: 'direct',
    from,
    to: SELF,
    data,
  };
}

function dispatch(device, msg) {
  return commands.dispatch(msg, settings, device, app);
}

describe('command dispatch', () => {
  beforeEach(() => {
    fallback.reset();
  });

  it('answers known commands without the fallback', () => {
    const device = mockDevice();
    return dispatch(device, dm(STRANGER, 'Ping'))
      .then(() => {
        assert.deepEqual(device.sent, [{ text: 'Pong', to: STRANGER }]);
      });
  });

  it('lists only the commands available to a stranger', () => {
    const device = mockDevice();
    return dispatch(device, dm(STRANGER, 'help'))
      .then(() => {
        assert.equal(device.sent.length, 1);
        assert.equal(device.sent[0].text, 'Commands: Ping, Status, Help');
      });
  });

  it('lists crew commands to crew', () => {
    const device = mockDevice();
    return dispatch(device, dm(CREW, 'help'))
      .then(() => {
        assert.equal(device.sent.length, 1);
        assert.equal(device.sent[0].text, 'Commands: Ping, Status, Turn <switch name> on, Waypoint <callsign or boat name>, Help');
      });
  });

  it('explains itself to a stranger sending an unknown message', () => {
    const device = mockDevice();
    return dispatch(device, dm(STRANGER, 'Hello, anybody there?'))
      .then(() => {
        assert.equal(device.sent.length, 1);
        assert.equal(device.sent[0].to, STRANGER);
        assert.equal(device.sent[0].text, 'Automated boat node, nobody reads this. Commands: Ping, Status, Help');
      });
  });

  it('treats a crew-only command from a stranger as unknown', () => {
    const device = mockDevice();
    return dispatch(device, dm(STRANGER, 'Waypoint DH8613'))
      .then(() => {
        assert.equal(device.sent.length, 1);
        assert.match(device.sent[0].text, /^Automated boat node/);
      });
  });

  it('replies to a stranger only once per hour', () => {
    const device = mockDevice();
    return dispatch(device, dm(STRANGER, 'Hello'))
      .then(() => dispatch(device, dm(STRANGER, 'Hello?')))
      .then(() => dispatch(device, dm(STRANGER, 'HELLO??')))
      .then(() => {
        assert.equal(device.sent.length, 1);
      });
  });

  it('rate limits per node', () => {
    const device = mockDevice();
    return dispatch(device, dm(STRANGER, 'Hello'))
      .then(() => dispatch(device, dm(CREW, 'Hello')))
      .then(() => {
        assert.deepEqual(device.sent.map((s) => s.to), [STRANGER, CREW]);
      });
  });

  it('ignores broadcasts', () => {
    const device = mockDevice();
    return dispatch(device, { type: 'broadcast', from: STRANGER, data: 'Hello' })
      .then(() => {
        assert.equal(device.sent.length, 0);
      });
  });

  it('ignores its own replies echoed back by the library', () => {
    const device = mockDevice();
    return dispatch(device, dm(SELF, 'Automated boat node, nobody reads this. Commands: Ping'))
      .then(() => {
        assert.equal(device.sent.length, 0);
      });
  });
});

describe('fallback rate limit', () => {
  beforeEach(() => {
    fallback.reset();
  });

  it('replies again once the interval has passed', () => {
    const device = mockDevice();
    const start = 1000;
    const msg = dm(STRANGER, 'Hello');
    return fallback.handle(msg, device, ['Ping'], start)
      .then((sent) => {
        assert.equal(sent, true);
        return fallback.handle(msg, device, ['Ping'], start + fallback.REPLY_INTERVAL_MS - 1);
      })
      .then((sent) => {
        assert.equal(sent, false);
        return fallback.handle(msg, device, ['Ping'], start + fallback.REPLY_INTERVAL_MS);
      })
      .then((sent) => {
        assert.equal(sent, true);
        assert.equal(device.sent.length, 2);
      });
  });
});
