// Position accuracy for Meshtastic 2.8 reduced-precision channels
//
// A sending node truncates its position to the precision configured for the
// channel it transmits on: the 32-bit fixed-point coordinate (1e-7 degrees
// per unit) is masked down to its top precision_bits and the center of the
// resulting cell is reported, with precision_bits telling the receiver how
// much was cut. Public channels default to reduced precision, so a crew
// position received there can be quantized to a cell hundreds of meters or
// kilometers across.
//
// The honest way to account for that is not to hide or discard the position
// — it is still the best data available — but to publish how far off it can
// be, so consumers can show the uncertainty instead of a falsely exact fix.

// Meters per degree of latitude; the longitude component is scaled by the
// cosine of the latitude where the position is
const METERS_PER_DEGREE = 111320;

// Whether a position message carries usable coordinates. A channel with zero
// position precision strips the position entirely, leaving the protobuf
// defaults: latitude and longitude of 0. Gulf of Guinea is a lovely place to
// sail but few boats are there
function hasValidPosition(position) {
  if (!position) {
    return false;
  }
  return position.latitudeI !== 0 || position.longitudeI !== 0;
}

// Radius in meters around the reported position within which the sending
// node actually is: the truncation keeps the top precision_bits of the
// coordinate, so the true position is within half a quantization cell on
// each axis. The conservative bound is the cell diagonal
//
// Undefined when the position was not truncated: full 32-bit precision, or
// no precision_bits at all, as pre-2.8 senders report
function truncationRadius(position) {
  const bits = position && position.precisionBits;
  if (!Number.isInteger(bits) || bits <= 0 || bits >= 32) {
    return undefined;
  }
  // Half a cell in degrees, per axis: the center offset the firmware adds is
  // 2^(31 - precision) units of 1e-7 degrees
  const halfCellDegrees = (2 ** (31 - bits)) * 1e-7;
  const latitude = position.latitudeI * 1e-7;
  const latRadius = halfCellDegrees * METERS_PER_DEGREE;
  const lonRadius = halfCellDegrees * METERS_PER_DEGREE * Math.cos((latitude * Math.PI) / 180);
  return Math.sqrt((latRadius * latRadius) + (lonRadius * lonRadius));
}

module.exports = {
  hasValidPosition,
  truncationRadius,
};
