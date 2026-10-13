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
    sendText: (text, to, wantAck, channel, replyId) => {
      sent.push({
        text, to, wantAck, channel, replyId,
      });
      return Promise.resolve();
    },
  };
}

const app = {
  debug: () => {},
  error: () => {},
};

function dm(from, data, id) {
  return {
    type: 'direct',
    from,
    to: SELF,
    data,
    id,
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
    return dispatch(device, dm(STRANGER, 'Ping', 4711))
      .then(() => {
        // The reply is threaded to the command message so client apps can
        // render it as a reply
        assert.equal(device.sent.length, 1);
        assert.equal(device.sent[0].text, 'Pong');
        assert.equal(device.sent[0].to, STRANGER);
        assert.equal(device.sent[0].replyId, 4711);
      });
  });

  it('lists only the commands available to a stranger', () => {
    const device = mockDevice();
    return dispatch(device, dm(STRANGER, 'help'))
      .then(() => {
        assert.equal(device.sent.length, 1);
        assert.equal(device.sent[0].text, 'Commands: Ping, Help');
      });
  });

  it('lists crew commands to crew', () => {
    const device = mockDevice();
    return dispatch(device, dm(CREW, 'help'))
      .then(() => {
        assert.equal(device.sent.length, 1);
        assert.equal(device.sent[0].text, 'Commands: Ping, Status, Turn <switch name> on, Waypoint <callsign or boat name>, Log <text>, Help');
      });
  });

  it('explains itself to a stranger sending an unknown message', () => {
    const device = mockDevice();
    return dispatch(device, dm(STRANGER, 'Hello, anybody there?'))
      .then(() => {
        assert.equal(device.sent.length, 1);
        assert.equal(device.sent[0].to, STRANGER);
        assert.equal(device.sent[0].text, 'Automated boat node, nobody reads this. Commands: Ping, Help');
      });
  });

  it('treats a crew-only command from a stranger as unknown', () => {
    const device = mockDevice();
    return dispatch(device, dm(STRANGER, 'Waypoint DH8613'))
      .then(() => {
        fallback.reset();
        return dispatch(device, dm(STRANGER, 'log Changed the oil'));
      })
      .then(() => {
        assert.equal(device.sent.length, 2);
        device.sent.forEach((reply) => {
          assert.match(reply.text, /^Automated boat node/);
        });
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

  it('keeps Status from strangers, listing it nowhere', () => {
    const device = mockDevice();
    return dispatch(device, dm(STRANGER, 'Status'))
      .then(() => {
        assert.equal(device.sent.length, 1);
        assert.match(device.sent[0].text, /^Automated boat node/);
        assert.doesNotMatch(device.sent[0].text, /Status/);
      });
  });

  it('replies to crew Status', () => {
    const device = mockDevice();
    const statusApp = {
      ...app,
      getSelfPath: () => undefined,
    };
    return commands.dispatch(dm(CREW, 'Status'), settings, device, statusApp)
      .then(() => {
        assert.equal(device.sent.length, 1);
        assert.match(device.sent[0].text, /^Anchor:/);
        assert.match(device.sent[0].text, /Node: crew/);
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

describe('verified command dispatch', () => {
  beforeEach(() => {
    fallback.reset();
  });

  const signedSettings = {
    nodes: [{ node: CREW, role: 'crew' }],
    communications: {
      require_signed_commands: true,
      digital_switching: true,
    },
  };

  function dispatchVerified(device, msg, verification, dispatchApp = app) {
    return commands.dispatch(
      msg,
      signedSettings,
      device,
      dispatchApp,
      undefined,
      undefined,
      undefined,
      verification,
    );
  }

  it('refuses commands in unverified packets when the setting is on', () => {
    const device = mockDevice();
    return dispatchVerified(device, dm(CREW, 'Turn decklight on'), { verified: false })
      .then(() => {
        assert.equal(device.sent.length, 1);
        assert.equal(device.sent[0].to, CREW);
        assert.match(device.sent[0].text, /^Command refused/);
        // The switch was never operated
      });
  });

  it('refuses Status in unverified packets when the setting is on', () => {
    const device = mockDevice();
    return dispatchVerified(device, dm(CREW, 'Status'), { verified: false })
      .then(() => {
        assert.equal(device.sent.length, 1);
        assert.match(device.sent[0].text, /^Command refused/);
      });
  });

  it('lets unverified strangers get the fallback explanation instead of crew commands', () => {
    const device = mockDevice();
    return dispatchVerified(device, dm(STRANGER, 'Hello there'), { verified: false })
      .then(() => {
        assert.equal(device.sent.length, 1);
        assert.match(device.sent[0].text, /^Automated boat node/);
      });
  });

  it('executes commands in packets the boat node verified', () => {
    const device = mockDevice();
    return dispatchVerified(device, dm(CREW, 'Ping'), { verified: true })
      .then(() => {
        assert.deepEqual(device.sent.map((s) => s.to), [CREW]);
      });
  });

  it('executes commands in PKI-encrypted packets', () => {
    const device = mockDevice();
    return dispatchVerified(device, dm(CREW, 'Ping'), { verified: true })
      .then(() => {
        assert.deepEqual(device.sent.map((s) => s.to), [CREW]);
      });
  });

  it('executes crew-only commands from verified crew when the setting is on', () => {
    const puts = [];
    const switchingApp = {
      ...app,
      putSelfPath: (path, value, cb) => {
        puts.push({ path, value });
        cb({ state: 'COMPLETED', statusCode: 200 });
      },
    };
    const device = mockDevice();
    return dispatchVerified(device, dm(CREW, 'Turn decklight on'), { verified: true }, switchingApp)
      .then(() => {
        // The switch was operated and confirmed, not answered with the fallback
        assert.deepEqual(puts, [{ path: 'electrical.switches.decklight.state', value: true }]);
        assert.match(device.sent[0].text, /^OK, decklight is on$/);
      });
  });

  it('executes crew-only commands when signing is not required', () => {
    const puts = [];
    const switchingApp = {
      ...app,
      putSelfPath: (path, value, cb) => {
        puts.push({ path, value });
        cb({ state: 'COMPLETED', statusCode: 200 });
      },
    };
    const device = mockDevice();
    const off = {
      nodes: [{ node: CREW, role: 'crew' }],
      communications: {
        require_signed_commands: false,
        digital_switching: true,
      },
    };
    return commands.dispatch(dm(CREW, 'Turn decklight on'), off, device, switchingApp, undefined, undefined, undefined, { verified: false })
      .then(() => {
        assert.deepEqual(puts, [{ path: 'electrical.switches.decklight.state', value: true }]);
        assert.match(device.sent[0].text, /^OK, decklight is on$/);
      });
  });

  it('leaves verification to the boat node when the setting is off', () => {
    const device = mockDevice();
    const off = {
      nodes: [{ node: CREW, role: 'crew' }],
      communications: { require_signed_commands: false },
    };
    return commands.dispatch(dm(CREW, 'Ping'), off, device, app, undefined, undefined, undefined, { verified: false })
      .then(() => {
        assert.deepEqual(device.sent.map((s) => s.to), [CREW]);
      });
  });
});

describe('crew commands stay operational through dispatch', () => {
  // The 1.8.0 regression shipped because the handler tests exercised each
  // command directly, and the dispatch tests went through the public Ping:
  // nothing sent a crew-only command the whole way through dispatch, where
  // the fallback swallowed it. Everything here dispatches every registered
  // command as a crew member, under both signing modes, so no command can
  // silently stop executing again

  beforeEach(() => {
    fallback.reset();
  });

  const Protobuf = {
    Mesh: {
      WaypointSchema: 'WaypointSchema',
    },
  };
  const create = (schema, value) => ({
    schema,
    ...value,
  });

  const crewSettings = {
    nodes: [{ node: CREW, role: 'crew' }],
    communications: {
      digital_switching: true,
    },
  };

  const signedCrewSettings = {
    ...crewSettings,
    communications: {
      ...crewSettings.communications,
      require_signed_commands: true,
    },
  };

  function trackingDevice() {
    const sent = [];
    const waypoints = [];
    return {
      sent,
      waypoints,
      myNodeInfo: { myNodeNum: SELF },
      sendText: (text, to, wantAck, channel, replyId) => {
        sent.push({
          text,
          to,
          wantAck,
          channel,
          replyId,
        });
        return Promise.resolve();
      },
      sendWaypoint: (waypoint, to, channel) => {
        waypoints.push({ waypoint, to, channel });
        return Promise.resolve();
      },
    };
  }

  function trackingApp() {
    const state = { puts: [], resources: [] };
    const trackingAppObject = {
      debug: () => {},
      error: () => {},
      getSelfPath: () => undefined,
      putSelfPath: (path, value, cb) => {
        state.puts.push({ path, value });
        cb({ state: 'COMPLETED', statusCode: 200 });
      },
      resourcesApi: {
        setResource: (type, id, entry) => {
          state.resources.push({ type, id, entry });
          return Promise.resolve();
        },
      },
      signalk: {
        root: {
          vessels: {
            'vessels.urn:mrn:imo:mmsi:123456789': {
              mmsi: '123456789',
              name: 'Lucky Duck',
              navigation: {
                position: {
                  value: {
                    latitude: 60.15,
                    longitude: 24.96,
                  },
                },
              },
            },
          },
        },
      },
    };
    return { app: trackingAppObject, state };
  }

  // One scenario per registered command: the message a crew member sends,
  // and the evidence that the command executed rather than fell back
  const scenarios = {
    ping: {
      message: 'Ping',
      executed: (device) => {
        assert.equal(device.sent[0].text, 'Pong');
      },
    },
    status: {
      message: 'Status',
      executed: (device) => {
        assert.match(device.sent[0].text, /^Anchor:/);
      },
    },
    switching: {
      message: 'Turn testswitch on',
      executed: (device, state) => {
        assert.deepEqual(state.puts, [{ path: 'electrical.switches.testswitch.state', value: true }]);
        assert.match(device.sent[0].text, /^OK, testswitch is on$/);
      },
    },
    waypoint: {
      message: 'Waypoint Lucky Duck',
      executed: (device) => {
        assert.equal(device.waypoints.length, 1);
      },
    },
    log: {
      message: 'Log engine oil changed',
      executed: (device, state) => {
        assert.equal(state.resources.length, 1);
        assert.equal(state.resources[0].type, 'logentries');
        assert.match(device.sent[0].text, /^OK, logged$/);
      },
    },
    help: {
      message: 'Help',
      executed: (device) => {
        assert.match(device.sent[0].text, /^Commands: /);
      },
    },
  };

  function executeAs(name, dispatchSettings, verification) {
    const { app: dispatchApp, state } = trackingApp();
    const device = trackingDevice();
    const msg = dm(CREW, scenarios[name].message, 4712);
    return commands
      .dispatch(msg, dispatchSettings, device, dispatchApp, create, Protobuf, {}, verification)
      .then(() => {
        const replies = device.sent.map((reply) => reply.text);
        replies.forEach((text) => {
          assert.doesNotMatch(text, /^Automated boat node/, `command ${name} got the fallback reply`);
        });
        assert.ok(
          replies.length || device.waypoints.length,
          `command ${name} executed without a reply`,
        );
        scenarios[name].executed(device, state);
      });
  }

  function executeAll(dispatchSettings, verification) {
    const names = commands.available(dm(CREW, 'anything'), dispatchSettings);
    return names.reduce(
      (prev, name) => prev.then(() => executeAs(name, dispatchSettings, verification)),
      Promise.resolve(),
    );
  }

  it('declares crew visibility for every registered command', () => {
    commands.available(dm(CREW, 'anything'), crewSettings).forEach((name) => {
      assert.equal(typeof commands[name].crewOnly, 'boolean', `command ${name} must declare crewOnly`);
    });
  });

  it('has an execution scenario for every registered command', () => {
    commands.available(dm(CREW, 'anything'), crewSettings).forEach((name) => {
      assert.ok(scenarios[name], `command ${name} has no crew execution scenario`);
    });
  });

  it('executes every command for crew with signing off', async () => {
    await executeAll(crewSettings, { verified: false });
  });

  it('executes every command for crew in verified packets with signing on', async () => {
    await executeAll(signedCrewSettings, { verified: true });
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
