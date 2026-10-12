const { nodeRole, requireSignedCommands } = require('../settings');
const fallback = require('./fallback');

exports.ping = require('./ping');
exports.status = require('./status');
exports.switching = require('./switching');
exports.waypoint = require('./waypoint');
exports.log = require('./log');

// Everything else exported from this module is a helper, not a text command
const HELPERS = ['isFromCrew', 'available', 'dispatch'];

exports.isFromCrew = (msg, settings) => nodeRole(settings, msg.from) === 'crew';

// Names of the commands the sender of this message is allowed to use
exports.available = (msg, settings) => {
  const fromCrew = exports.isFromCrew(msg, settings);
  return Object.keys(exports)
    .filter((name) => !HELPERS.includes(name))
    .filter((name) => fromCrew || !exports[name].crewOnly);
};

exports.help = {
  crewOnly: false,
  example: 'Help',
  accept: (msg) => (msg.data.toLowerCase() === 'help'),
  handle: (msg, settings, device) => {
    const commands = exports.available(msg, settings).map((name) => exports[name].example);
    return device.sendText(`Commands: ${commands.join(', ')}`, msg.from, true, msg.channel);
  },
};

// Route a received text message to the commands accepting it. Messages that
// no command accepts get the fallback reply explaining what this node is
//
// The nodeDb map of known Meshtastic nodes is passed through to command
// handlers that need to know more about the sender than their configuration
//
// verification carries the boat node's verdict for the packet this message
// arrived in (undefined on boat nodes that cannot verify): true when the packet
// carried a valid signature or was PKI-encrypted so only the key holder could
// have produced it
exports.dispatch = (msg, settings, device, app, create, Protobuf, nodeDb, verification = {}) => {
  if (msg.type !== 'direct') {
    // Not DM
    return Promise.resolve();
  }
  if (device.myNodeInfo && msg.from === device.myNodeInfo.myNodeNum) {
    // The library echoes our own replies back as received messages
    return Promise.resolve();
  }
  const available = exports.available(msg, settings);
  const matching = available.filter((name) => exports[name].accept(msg, settings));
  const matchingCrew = matching.filter((name) => exports[name].crewOnly);
  if (matchingCrew.length && requireSignedCommands(settings) && verification.verified !== true) {
    // Commands that operate the boat are only accepted from cryptographically
    // verified senders: a packet the boat node could not verify may carry a
    // forged sender number. The crew commands are refused without executing;
    // public ones like Ping or Status stay open to any sender, verified or
    // not, since they reveal nothing a stranger on the mesh doesn't have
    app.debug(`Message "${msg.data}" from ${msg.from} failed cryptographic verification, refusing ${matchingCrew.length} command(s)`);
    return device.sendText(
      'Command refused: your node needs Meshtastic 2.8 or newer with packet signing enabled',
      msg.from,
      true,
      msg.channel,
    );
  }
  const publicMatching = matching.filter((name) => !exports[name].crewOnly);
  if (!publicMatching.length) {
    return fallback.handle(msg, device, available.map((name) => exports[name].example))
      .then((sent) => {
        if (sent) {
          app.debug(`Message "${msg.data}" answered with the fallback reply`);
        }
      })
      .catch((err) => {
        app.debug(`Message "${msg.data}" fallback reply failed`);
        app.error(err.message);
      });
  }
  return Promise.all(matching.map((name) => exports[name]
    .handle(msg, settings, device, app, create, Protobuf, nodeDb)
    .then(() => {
      app.debug(`Message "${msg.data}" handled by command ${name}`);
    })
    .catch((err) => {
      app.debug(`Message "${msg.data}" failed by command ${name}`);
      app.debug(err.message);
      app.error(err.message);
    })));
};
