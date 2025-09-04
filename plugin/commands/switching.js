module.exports = {
  crewOnly: true,
  example: 'Turn <switch name> on',
  accept: (msg, settings) => {
    const switching = msg.data.match(/turn ([a-z0-9]+) (on|off)/i);
    if (settings.communications
      && settings.communications.digital_switching
      && switching) {
      return true;
    }
    return false;
  },
  handle: (msg, settings, device, app) => {
    const switching = msg.data.match(/turn ([a-z0-9]+) (on|off)/i);
    const light = switching[1];
    const value = switching[2] === 'on';
    return new Promise((resolve, reject) => {
      app.putSelfPath(`electrical.switches.${light}.state`, value, (res) => {
        if (res.state !== 'COMPLETED') {
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(res.message));
          return;
        }
        resolve();
        device.sendText(res.message, msg.from, true, false)
          .catch((e) => app.error(`Failed to send message: ${e.message}`));
      });
    })
      .then(() => device.sendText(`OK, ${light} is ${switching[2]}`, msg.from, true, false));
  },
};
