const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const waypointCommand = require('../plugin/commands/waypoint');

const Protobuf = {
  Mesh: {
    WaypointSchema: 'WaypointSchema',
  },
};

const create = (schema, value) => ({ schema, ...value });

function fakeDevice() {
  const sentTexts = [];
  const sentWaypoints = [];
  const device = {
    sendText: (msg, node, wantAck) => {
      sentTexts.push({ msg, node, wantAck });
      return Promise.resolve();
    },
    sendWaypoint: (waypoint, node, channel) => {
      sentWaypoints.push({ waypoint, node, channel });
      return Promise.resolve();
    },
  };
  return { device, sentTexts, sentWaypoints };
}

function fakeApp(vessels) {
  return {
    signalk: {
      root: {
        vessels,
      },
    },
  };
}

function handle(data, vessels, from = 1337) {
  const { device, sentTexts, sentWaypoints } = fakeDevice();
  const result = waypointCommand.handle(
    { data, from },
    {},
    device,
    fakeApp(vessels),
    create,
    Protobuf,
  );
  return { sentTexts, sentWaypoints, result };
}

describe('waypoint command', () => {
  it('accepts waypoint requests, including names with spaces', () => {
    assert.equal(waypointCommand.accept({ data: 'Waypoint OH2TH' }), true);
    assert.equal(waypointCommand.accept({ data: 'Waypoint Lucky Duck 3h' }), true);
    assert.equal(waypointCommand.accept({ data: 'hello there' }), false);
  });

  it('sends a waypoint for the matched vessel to the requester', async () => {
    const vessels = {
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
    };
    const { sentTexts, sentWaypoints, result } = handle('Waypoint lucky duck 3h', vessels);
    await result;
    assert.equal(sentTexts.length, 0);
    assert.equal(sentWaypoints.length, 1);
    const { waypoint, node, channel } = sentWaypoints[0];
    assert.equal(node, 1337);
    assert.equal(channel, 0);
    assert.equal(waypoint.schema, 'WaypointSchema');
    assert.equal(waypoint.id, '123456789');
    assert.equal(waypoint.name, 'Lucky Duck');
    assert.equal(waypoint.latitudeI, 601500000);
    assert.equal(waypoint.longitudeI, 249600000);
    const now = Math.floor(new Date().getTime() / 1000);
    assert.ok(waypoint.expire > now + (3 * 60 * 60) - 60);
    assert.ok(waypoint.expire < now + (3 * 60 * 60) + 60);
  });

  it('defaults to a one hour expiry and matches vessels by callsign', async () => {
    const vessels = {
      'vessels.urn:mrn:imo:mmsi:223456789': {
        mmsi: '223456789',
        name: 'Callisto',
        communication: {
          callsignVhf: 'OH2TH',
        },
        navigation: {
          position: {
            value: {
              latitude: 59.9,
              longitude: 24.8,
            },
          },
        },
      },
    };
    const { sentWaypoints, result } = handle('Waypoint oh2th', vessels);
    await result;
    assert.equal(sentWaypoints.length, 1);
    const { waypoint } = sentWaypoints[0];
    assert.equal(waypoint.id, '223456789');
    const now = Math.floor(new Date().getTime() / 1000);
    assert.ok(waypoint.expire > now);
    assert.ok(waypoint.expire < now + (1 * 60 * 60) + 60);
  });

  it('replies with an error text for unknown vessels', async () => {
    const { sentTexts, sentWaypoints, result } = handle('Waypoint Nobody', {});
    await result;
    assert.equal(sentWaypoints.length, 0);
    assert.equal(sentTexts.length, 1);
    assert.equal(sentTexts[0].msg, 'Unable to find vessel Nobody');
    assert.equal(sentTexts[0].node, 1337);
  });

  it('replies with an error text for vessels without a position', async () => {
    const vessels = {
      'vessels.urn:mrn:imo:mmsi:123456789': {
        mmsi: '123456789',
        name: 'No Position',
      },
    };
    const { sentTexts, sentWaypoints, result } = handle('Waypoint No Position', vessels);
    await result;
    assert.equal(sentWaypoints.length, 0);
    assert.equal(sentTexts.length, 1);
    assert.equal(sentTexts[0].msg, 'Vessel No Position has no known position');
  });
});
