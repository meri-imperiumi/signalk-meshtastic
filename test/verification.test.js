const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  nodeCanVerify,
  isVerified,
  unknownVarint,
} = require('../plugin/verification');

// Encode a value the way protobuf writes a varint, for building $unknown
// entries like the schema library produces for fields it does not know
function varintBytes(value) {
  const bytes = [];
  let rest = value;
  while (rest >= 128) {
    bytes.push((rest % 128) + 128);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Uint8Array.from(bytes);
}

function unknownField(no, value) {
  return { no, wireType: 0, data: varintBytes(value) };
}

describe('unknownVarint', () => {
  it('reads varint fields the schema does not know', () => {
    const message = { $unknown: [unknownField(22, 1)] };
    assert.equal(unknownVarint(message, 22), 1);
  });

  it('reads multi-byte varints', () => {
    const message = { $unknown: [unknownField(22, 300)] };
    assert.equal(unknownVarint(message, 22), 300);
  });

  it('returns nothing when the field is absent', () => {
    assert.equal(unknownVarint({}, 22), undefined);
    assert.equal(unknownVarint({ $unknown: [] }, 22), undefined);
    assert.equal(unknownVarint({ $unknown: [unknownField(21, 1)] }, 22), undefined);
  });

  it('returns nothing for non-varint fields', () => {
    const message = { $unknown: [{ no: 22, wireType: 2, data: Uint8Array.from([1]) }] };
    assert.equal(unknownVarint(message, 22), undefined);
  });
});

describe('isVerified', () => {
  it('accepts a packet the boat node verified by signature', () => {
    // MeshPacket field 22, xeddsa_signed, set by boat nodes running 2.8
    assert.equal(isVerified({ $unknown: [unknownField(22, 1)] }), true);
  });

  it('accepts PKI-encrypted packets', () => {
    // Field 17 is known to the bundled schema: a DM encrypted with the
    // recipient's public key can only have been produced by the node
    // holding the claimed sender's private key
    assert.equal(isVerified({ pkiEncrypted: true }), true);
  });

  it('rejects unsigned packets', () => {
    assert.equal(isVerified({}), false);
    assert.equal(isVerified({ $unknown: [unknownField(22, 0)] }), false);
  });
});

describe('nodeCanVerify', () => {
  it('accepts a 2.8 boat node with verification compiled in', () => {
    // DeviceMetadata firmware_version is a known field; has_xeddsa is
    // field 14, unknown to the bundled schema
    assert.equal(nodeCanVerify({
      data: {
        firmwareVersion: '2.8.4.abc123',
        $unknown: [unknownField(14, 1)],
      },
    }), true);
  });

  it('rejects boat nodes without the capability', () => {
    assert.equal(nodeCanVerify({
      data: {
        firmwareVersion: '2.8.4.abc123',
        $unknown: [unknownField(14, 0)],
      },
    }), false);
  });

  it('rejects boat nodes before 2.8', () => {
    assert.equal(nodeCanVerify({
      data: {
        firmwareVersion: '2.7.12.abc123',
        $unknown: [unknownField(14, 1)],
      },
    }), false);
  });

  it('rejects missing metadata', () => {
    assert.equal(nodeCanVerify(undefined), false);
    assert.equal(nodeCanVerify({}), false);
    assert.equal(nodeCanVerify({ data: { firmwareVersion: 'not.a.version' } }), false);
  });
});
