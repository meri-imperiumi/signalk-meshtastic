// Packet signature verification for Meshtastic 2.8
//
// Meshtastic 2.8 lets nodes sign their packets with XEdDSA. The sender's
// firmware signs, and the boat node the plugin is connected to verifies
// against the sender's public key and reports the verdict on the FromRadio
// packet as a new field. The plugin's own protobuf schema is one release
// behind: field 22 (xeddsa_signed, the boat node's verdict) and field 10 of
// Data (the signature itself) are unknown to it, but the schema library keeps
// unknown fields in message.$unknown, so the verdict can be read without
// waiting for updated protobufs.
//
// Direct messages have a second, implicit authenticity guarantee: since
// Meshtastic 2.5 they are encrypted with the recipient's public key, so only
// the node holding the key bound to the claimed sender number can produce a
// packet the boat node decrypts. A PKI-encrypted DM is authenticated by
// construction — no signature needed.
//
// The boat node's verdict is only meaningful if its firmware can verify at
// all, which is reported in its DeviceMetadata (firmware version and the
// has_xeddsa capability, both unknown fields to our schema).

// Protobuf wire type for varints. Unknown varint fields keep their raw
// varint bytes in $unknown entries
const WIRE_TYPE_VARINT = 0;

// Field numbers the plugin's protobuf schema does not know yet
const FIELD_XEDDSA_SIGNED = 22;
const FIELD_HAS_XEDDSA = 14;

// Decode raw varint bytes: $unknown varint data is the value's varint
// encoding, least significant byte first, with each byte's top bit marking
// continuation
function varintValue(bytes) {
  return Array.from(bytes).reduce(
    (value, byte, index) => value + (byte % 128) * (128 ** index),
    0,
  );
}

// Read an unknown varint field from a decoded protobuf message, as a number,
// or undefined when the field is absent or not a varint. Known fields are not
// looked at: this only reads what the schema left in $unknown
function unknownVarint(message, fieldNo) {
  if (!message || !Array.isArray(message.$unknown)) {
    return undefined;
  }
  const field = message.$unknown.find((unknown) => (
    unknown.no === fieldNo
    && unknown.wireType === WIRE_TYPE_VARINT
  ));
  if (!field || !field.data) {
    return undefined;
  }
  return varintValue(field.data);
}

// Whether the boat node's firmware verified a valid packet signature.
// False when the boat node predates 2.8: it has no verdict to report
function isVerified(meshPacket) {
  if (meshPacket.pkiEncrypted === true) {
    return true;
  }
  return unknownVarint(meshPacket, FIELD_XEDDSA_SIGNED) === 1;
}

// Whether the boat node running this DeviceMetadata can verify packet
// signatures at all. False for 2.7 and earlier: verification is compiled out
function nodeCanVerify(metadata) {
  if (!metadata || !metadata.data) {
    return false;
  }
  const version = Number.parseFloat(metadata.data.firmwareVersion);
  if (!Number.isFinite(version) || version < 2.8) {
    return false;
  }
  return unknownVarint(metadata.data, FIELD_HAS_XEDDSA) === 1;
}

module.exports = {
  nodeCanVerify,
  isVerified,
  unknownVarint,
};
