const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  hasValidPosition,
  truncationRadius,
} = require('../plugin/precision');

describe('hasValidPosition', () => {
  it('accepts real coordinates', () => {
    assert.equal(hasValidPosition({ latitudeI: 601500000, longitudeI: 249600000 }), true);
  });

  it('accepts a position with either coordinate set', () => {
    // Mirrors the firmware's own validity check
    assert.equal(hasValidPosition({ latitudeI: 601500000, longitudeI: 0 }), true);
  });

  it('rejects the protobuf defaults left by stripped positions', () => {
    // Channels with zero position precision strip the position entirely
    assert.equal(hasValidPosition({ latitudeI: 0, longitudeI: 0 }), false);
    assert.equal(hasValidPosition(undefined), false);
  });
});

describe('truncationRadius', () => {
  it('returns nothing for full precision', () => {
    assert.equal(truncationRadius({ precisionBits: 32 }), undefined);
    assert.equal(truncationRadius({ precisionBits: 0 }), undefined);
    assert.equal(truncationRadius({}), undefined);
    assert.equal(truncationRadius(undefined), undefined);
  });

  it('bounds the error to the quantization cell diagonal', () => {
    // Precision 19: half a cell is 2^12 * 1e-7 degrees, about 45.6 m in
    // latitude; at 60 degrees north the longitude component is halved
    const radius = truncationRadius({
      precisionBits: 19,
      latitudeI: 601500000,
    });
    // sqrt(45.6^2 + 22.8^2) is about 51 meters
    assert.ok(Math.abs(radius - 50.98) < 1, `radius was ${radius}`);
  });

  it('grows quickly as precision drops', () => {
    // Precision 13: half a cell is 2^18 * 1e-7 degrees, about 2.9 km in
    // latitude
    const radius = truncationRadius({
      precisionBits: 13,
      latitudeI: 601500000,
    });
    assert.ok(Math.abs(radius - 3262) < 5, `radius was ${radius}`);
  });

  it('works for southern latitudes', () => {
    const radius = truncationRadius({
      precisionBits: 19,
      latitudeI: -339000000,
    });
    assert.ok(radius > 40 && radius < 60, `radius was ${radius}`);
  });
});
