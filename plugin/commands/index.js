const { nodeRole } = require('../settings');
const fallback = require('./fallback');

exports.ping = require('./ping');
exports.status = require('./status');
exports.switching = require('./switching');
exports.waypoint = require('./waypoint');

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
    return device.sendText(`Commands: ${commands.join(', ')}`, msg.from, true, false);
  },
};

// Route a received text message to the commands accepting it. Messages that
// no command accepts get the fallback reply explaining what this node is
exports.dispatch = (msg, settings, device, app, create, Protobuf) => {
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
  if (!matching.length) {
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
    .handle(msg, settings, device, app, create, Protobuf)
    .then(() => {
      app.debug(`Message "${msg.data}" handled by command ${name}`);
    })
    .catch((err) => {
      app.debug(`Message "${msg.data}" failed by command ${name}`);
      app.debug(err.message);
      app.error(err.message);
    })));
};
