module.exports = {
  crewOnly: false,
  example: 'Ping',
  accept: (msg) => (msg.data.toLowerCase() === 'ping'),
  handle: (msg, settings, device) => device.sendText('Pong', msg.from, true, false),
};
