exports.ping = require('./ping');
exports.switching = require('./switching');
exports.waypoint = require('./waypoint');

exports.isFromCrew = (msg, settings) => {
  const crew = settings.nodes
    .filter((node) => {
      if (node.role === 'crew') {
        return true;
      }
      return false;
    })
    .map((node) => node.node);
  if (crew.indexOf(msg.from) !== -1) {
    return true;
  }
  return false;
};

exports.help = {
  crewOnly: false,
  example: 'Help',
  accept: (msg) => (msg.data.toLowerCase() === 'help'),
  handle: (msg, settings, device) => {
    const commands = Object.keys(exports).filter((cmd) => {
      if (cmd === 'isFromCrew') {
        return false;
      }
      if (!exports.isFromCrew(msg, settings) && exports[cmd].crewOnly) {
        return false;
      }
      return true;
    })
      .map((cmd) => exports[cmd].example);
    return device.sendText(`Commands: ${commands.join(', ')}`, msg.from, true, false);
  },
};
