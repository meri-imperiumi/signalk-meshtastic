function shouldWeSendNotification(path, value, episodes, settings) {
  if (!settings.communications || !settings.communications.send_alerts) {
    return false;
  }
  if (!value) {
    return false;
  }
  const statesToSend = [
    'alarm',
    'emergency',
  ];
  if (!value.state || !statesToSend.includes(value.state)) {
    return false;
  }
  return true;
}

function sendNotification(path, value, episodes, settings, device, app) {
  if (!device) {
    // Not connected to Meshtastic yet
    return false;
  }

  if (!shouldWeSendNotification(path, value, episodes, settings, device)) {
    return Promise.resolve();
  }

  const crew = settings.nodes.filter((node) => node.role === 'crew');
  if (!crew.length) {
    // No crew nodes to send to
    return false;
  }

  let bell = '';
  if (value.method && value.method.indexOf('sound') !== -1) {
    // Trigger audible bell on receiving Meshtastic devices
    bell = '\u0007 ';
  }

  // Send alert to each crew member
  return crew.reduce(
    (prev, member) => prev.then(() => device.sendText(`${bell}${value.message}`, member.node, true, false)),
    Promise.resolve(),
  )
    .catch((e) => app.error(`Failed to send alert: ${e.message}`));
}

module.exports = {
  shouldWeSendNotification,
  sendNotification,
};
