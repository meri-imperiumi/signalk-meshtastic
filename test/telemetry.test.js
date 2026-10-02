const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const Telemetry = require('../plugin/telemetry');

describe('telemetry', () => {
  it('reports anchor rode as distance by default', () => {
    const telemetry = new Telemetry();
    telemetry.update('navigation.anchor.distanceFromBow', 30);
    telemetry.update('navigation.anchor.currentRadius', 25);
    telemetry.update('environment.depth.belowSurface', 5);
    assert.equal(telemetry.toMeshtastic().distance, 30000);
  });

  it('reports the current anchor radius as distance when configured', () => {
    const telemetry = new Telemetry('navigation.anchor.currentRadius');
    telemetry.update('navigation.anchor.distanceFromBow', 30);
    telemetry.update('navigation.anchor.currentRadius', 25);
    telemetry.update('environment.depth.belowSurface', 5);
    assert.equal(telemetry.toMeshtastic().distance, 25000);
  });

  it('falls back to depth when not anchored', () => {
    const telemetry = new Telemetry('navigation.anchor.currentRadius');
    telemetry.update('environment.depth.belowSurface', 5);
    assert.equal(telemetry.toMeshtastic().distance, 5000);
  });
});
