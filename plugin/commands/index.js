exports.ping = require('./ping');
exports.switching = require('./switching');

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
