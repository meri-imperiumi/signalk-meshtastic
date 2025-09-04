module.exports = {
  crewOnly: false,
  accept: (msg) => (msg.data.toLowerCase() === 'ping'),
  handle: (msg, device) => device.sendText('Pong', msg.from, true, false),
};
