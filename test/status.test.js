const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const status = require('../plugin/commands/status');

function ago(seconds) {
  return new Date(Date.now() - (seconds * 1000)).toISOString();
}

function mockApp(paths, timestamps = {}) {
  return {
    getSelfPath: (path) => {
      if (!(path in paths)) {
        return undefined;
      }
      return {
        value: paths[path],
        timestamp: timestamps[path] || new Date().toISOString(),
      };
    },
  };
}

function historyApp(rows, to) {
  return {
    selfContext: 'vessels.urn:mrn:imo:mmsi:218028390',
    getHistoryApi: () => Promise.resolve({
      getValues: (query) => {
        assert.equal(query.context, 'vessels.urn:mrn:imo:mmsi:218028390');
        assert.equal(query.duration.total('minutes'), 10);
        assert.equal(query.resolution, 1);
        assert.deepEqual(query.pathSpecs.map((spec) => spec.aggregate), ['max', 'average']);
        return Promise.resolve({
          range: { from: '2026-09-02T02:40:00.000Z', to: to || '2026-09-02T02:50:00.000Z' },
          data: rows,
        });
      },
    }),
  };
}

function handle(paths, settings = {}, timestamps = {}, history = {}) {
  let sent;
  const device = {
    sendText: (text) => {
      sent = text;
      return Promise.resolve();
    },
  };
  const app = Object.assign(mockApp(paths, timestamps), history);
  return status.handle({ data: 'Status', from: 1 }, settings, device, app)
    .then(() => sent);
}

describe('status command', () => {
  it('accepts the status message only', () => {
    assert.equal(status.accept({ data: 'status' }), true);
    assert.equal(status.accept({ data: 'Status' }), true);
    assert.equal(status.accept({ data: 'ping' }), false);
  });

  it('reports the anchor as not set without an anchor position', () => handle({
    'environment.depth.belowSurface': 4.24,
    'environment.wind.speedTrue': 6.3,
    'environment.wind.directionTrue': 4.276,
  })
    .then((sent) => {
      assert.equal(sent, 'Anchor: not set\nDepth: 4.2m\nWind: 12.2kn 245T\nNode: not configured, no alerts');
    }));

  it('reports anchor radius, bearing and max radius when anchored', () => handle({
    'navigation.anchor.position': { latitude: 60.1, longitude: 24.9 },
    'navigation.anchor.distanceFromBow': 31.6,
    'navigation.anchor.bearingTrue': 2.53,
    'navigation.anchor.maxRadius': 40,
    'environment.depth.belowSurface': 4.24,
    'environment.wind.speedTrue': 6.3,
    'environment.wind.directionTrue': 4.276,
  })
    .then((sent) => {
      assert.equal(sent, 'Anchor: 32m 145T max 40m\nDepth: 4.2m\nWind: 12.2kn 245T\nNode: not configured, no alerts');
    }));

  it('ignores measured values that have gone stale', () => handle({
    'navigation.anchor.position': { latitude: 60.1, longitude: 24.9 },
    'navigation.anchor.distanceFromBow': 31.6,
    'navigation.anchor.bearingTrue': 2.53,
    'navigation.anchor.maxRadius': 40,
    'environment.depth.belowSurface': 4.24,
    'environment.wind.speedTrue': 6.3,
    'environment.wind.directionTrue': 4.276,
  }, {}, {
    // Anchor was dropped hours ago, but the sensors have stopped reporting
    'navigation.anchor.position': ago(7200),
    'navigation.anchor.maxRadius': ago(7200),
    'environment.depth.belowSurface': ago(300),
    'environment.wind.speedTrue': ago(300),
    'environment.wind.directionTrue': ago(300),
  })
    .then((sent) => {
      assert.equal(sent, 'Anchor: 32m 145T max 40m\nDepth: n/a\nWind: n/a\nNode: not configured, no alerts');
    }));

  it('uses the configured anchor radius path', () => handle({
    'navigation.anchor.position': { latitude: 60.1, longitude: 24.9 },
    'navigation.anchor.distanceFromBow': 31.6,
    'navigation.anchor.currentRadius': 25.2,
  }, {
    communications: {
      anchor_radius_path: 'navigation.anchor.currentRadius',
    },
  })
    .then((sent) => {
      assert.equal(sent, 'Anchor: 25m\nDepth: n/a\nWind: n/a\nNode: not configured, no alerts');
    }));
});

describe('status command configured paths', () => {
  const settings = {
    communications: {
      status_paths: [
        { path: 'networking.wan.activeLabel', label: 'WAN' },
        { path: 'networking.wan.state', label: 'Online' },
      ],
    },
  };

  it('reports configured paths with their labels before the node line', () => handle({
    'networking.wan.activeLabel': 'Cellular',
    'networking.wan.state': 'online',
  }, settings)
    .then((sent) => {
      assert.equal(sent, [
        'Anchor: not set',
        'Depth: n/a',
        'Wind: n/a',
        'WAN: Cellular',
        'Online: online',
        'Node: not configured, no alerts',
      ].join('\n'));
    }));

  it('reports configured paths regardless of value age', () => handle({
    'networking.wan.activeLabel': 'Cellular',
    'networking.wan.state': 'online',
  }, settings, {
    'networking.wan.activeLabel': ago(7200),
    'networking.wan.state': ago(7200),
  })
    .then((sent) => {
      assert.ok(sent.includes('WAN: Cellular\nOnline: online'), sent);
    }));

  it('reports missing configured paths as unavailable', () => handle({
    'networking.wan.activeLabel': 'Cellular',
  }, settings)
    .then((sent) => {
      assert.ok(sent.includes('WAN: Cellular\nOnline: n/a'), sent);
    }));

  it('formats numbers, booleans and objects', () => handle({
    'electrical.batteries.house.capacity.stateOfCharge': 0.8734,
    'tanks.freshWater.0.currentLevel': 1,
    'electrical.switches.anchorLight.state': true,
    'navigation.position': { latitude: 60.1, longitude: 24.9 },
  }, {
    communications: {
      status_paths: [
        { path: 'electrical.batteries.house.capacity.stateOfCharge', label: 'SOC' },
        { path: 'tanks.freshWater.0.currentLevel', label: 'Water' },
        { path: 'electrical.switches.anchorLight.state', label: 'Anchor light' },
        { path: 'navigation.position', label: 'Pos' },
      ],
    },
  })
    .then((sent) => {
      assert.ok(sent.includes([
        'SOC: 0.9',
        'Water: 1',
        'Anchor light: true',
        'Pos: {"latitude":60.1,"longitude":24.9}',
      ].join('\n')), sent);
    }));
});

describe('status command node role', () => {
  const nodes = [
    { node: 1, role: 'crew' },
    { node: 2, role: 'dinghy' },
    { node: 3, role: 'onboard' },
  ];

  function roleLine(from, settings) {
    let sent;
    const device = {
      sendText: (text, to) => {
        assert.equal(to, from);
        sent = text;
        return Promise.resolve();
      },
    };
    return status.handle({ data: 'Status', from }, settings, device, mockApp({}))
      .then(() => sent.split('\n').pop());
  }

  it('confirms a crew node will receive alerts', () => roleLine(1, {
    nodes,
    communications: { send_alerts: true },
  })
    .then((line) => {
      assert.equal(line, 'Node: crew, alerts on');
    }));

  it('warns a crew node when alert sending is disabled', () => roleLine(1, {
    nodes,
    communications: { send_alerts: false },
  })
    .then((line) => {
      assert.equal(line, 'Node: crew, alerts off');
    }));

  it('reports other configured roles as not receiving alerts', () => Promise.all([
    roleLine(2, { nodes, communications: { send_alerts: true } }),
    roleLine(3, { nodes, communications: { send_alerts: true } }),
  ])
    .then((lines) => {
      assert.deepEqual(lines, ['Node: dinghy, no alerts', 'Node: onboard, no alerts']);
    }));

  it('reports an unconfigured node even when alerts are enabled', () => roleLine(4, {
    nodes,
    communications: { send_alerts: true },
  })
    .then((line) => {
      assert.equal(line, 'Node: not configured, no alerts');
    }));
});

describe('status command wind history', () => {
  const wind = {
    'environment.wind.speedTrue': 6.3,
    'environment.wind.directionTrue': 4.276,
  };

  // Rows are [timestamp, max, average] per one second bucket, oldest first
  const rows = [
    ['2026-09-02T02:41:00.000Z', 12.0, 12.0],
    ['2026-09-02T02:45:00.000Z', 2.0, 2.0],
    // The last minute of the window, ending at 02:50:00
    ['2026-09-02T02:49:10.000Z', 5.0, 5.0],
    ['2026-09-02T02:49:30.000Z', 7.0, 7.0],
    ['2026-09-02T02:49:50.000Z', 6.0, 6.0],
  ];

  it('summarises the trailing minute and the whole window', () => handle(wind, {}, {}, historyApp(rows))
    .then((sent) => {
      assert.equal(sent, [
        'Anchor: not set',
        'Depth: n/a',
        'Wind: 12.2kn 245T',
        // Last 60s: avg of 5, 7, 6 = 6.0 m/s, max 7.0 m/s
        'Wind 1m: avg 11.7 max 13.6kn',
        // Whole window: avg of all five = 6.4 m/s, max 12.0 m/s
        'Wind 10m: avg 12.4 max 23.3kn',
        'Node: not configured, no alerts',
      ].join('\n'));
    }));

  it('cuts the trailing minute by timestamp, not by bucket', () => handle(wind, {}, {}, historyApp(rows, '2026-09-02T02:50:30.000Z'))
    .then((sent) => {
      // The window now ends at 02:50:30, leaving the 02:49:10 row outside the
      // trailing minute: avg of 7, 6 = 6.5 m/s, max 7.0 m/s
      assert.ok(sent.includes('Wind 1m: avg 12.6 max 13.6kn'), sent);
    }));

  it('drops the minute line when the wind data stopped over a minute ago', () => handle(wind, {}, {}, historyApp(rows, '2026-09-02T02:55:00.000Z'))
    .then((sent) => {
      assert.equal(sent, [
        'Anchor: not set',
        'Depth: n/a',
        'Wind: 12.2kn 245T',
        'Wind 10m: avg 12.4 max 23.3kn',
        'Node: not configured, no alerts',
      ].join('\n'));
    }));

  it('skips history on a server without the history API', () => handle(wind)
    .then((sent) => {
      assert.equal(sent, 'Anchor: not set\nDepth: n/a\nWind: 12.2kn 245T\nNode: not configured, no alerts');
    }));

  it('skips history when no provider is configured', () => handle(wind, {}, {}, {
    getHistoryApi: () => Promise.reject(new Error('No history api provider configured')),
  })
    .then((sent) => {
      assert.equal(sent, 'Anchor: not set\nDepth: n/a\nWind: 12.2kn 245T\nNode: not configured, no alerts');
    }));

  it('skips history when the provider returns no usable rows', () => handle(wind, {}, {}, historyApp([
    ['2026-09-02T02:45:00.000Z', null, null],
  ]))
    .then((sent) => {
      assert.equal(sent, 'Anchor: not set\nDepth: n/a\nWind: 12.2kn 245T\nNode: not configured, no alerts');
    }));
});
