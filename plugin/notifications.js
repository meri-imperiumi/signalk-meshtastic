function shouldWeSendNotification(path, value, episodes, settings, device) {
  if (!device) {
    // Not connected to Meshtastic yet
    return false;
  }
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
  if (!value.state || !statesToSend.contains(value.state)) {
    return false;
  }
  const crew = settings.nodes.filter((node) => node.role === 'crew');
  if (!crew.length) {
    // No crew nodes to send to
    return false;
  }
  return true;
}

function sendNotification(path, value, episodes, settings, device, app) {
  if (!shouldWeSendNotification(path, value, episodes, settings, device)) {
    return Promise.resolve();
  }

  let bell = '';
  if (value.method && value.method.indexOf('sound') !== -1) {
    // Trigger audible bell on receiving Meshtastic devices
    bell = '\u0007 ';
  }

  // Send alert to each crew member
  const crew = settings.nodes.filter((node) => node.role === 'crew');
  return crew.reduce(
    (prev, member) => prev.then(() => device.sendText(`${bell}${value.message}`, member.node, true, false)),
    Promise.resolve(),
  )
    .catch((e) => app.error(`Failed to send alert: ${e.message}`));
}

module.exports = {
  sendNotification,
};
