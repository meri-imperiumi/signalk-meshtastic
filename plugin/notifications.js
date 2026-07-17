const debounceMs = 5 * 60 * 1000;

function wasCleared(path, episode, currentTime) {
  if (!episode) {
    // No stored episode, assumed to be cleared or never raised
    return true;
  }
  if (!episode.clearedSince) {
    // Not cleared at the moment, aka. active notification
    return false;
  }
  if (currentTime - episode.clearedSince >= debounceMs) {
    // Enough time has been passed since clearing that it can be cleared
    return true;
  }
  return false;
}

function shouldWeSendNotification(path, value, episodes, settings, now) {
  const currentTime = now || new Date();

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
  const episode = episodes.get(path);
  if (!value.state || !statesToSend.includes(value.state)) {
    if (episode) {
      if (!episode.clearedSince) {
        episode.clearedSince = currentTime;
      }
      if (wasCleared(path, episode, currentTime)) {
        // This episode may be cleared
        episodes.delete(path);
      }
    }
    return false;
  }

  // Prevent deduplication of alerts. Some alerts like a bilge sensor often turn rapidly on and off
  if (!episode) {
    // First alert of this kind
    episodes.set(path, {
      startTime: currentTime,
      openState: value.state,
      transitions: 1,
      clearedSince: null,
    });
    return true;
  }

  if (!wasCleared(path, episode, currentTime)) {
    // We have sent this and it hasn't yet expired
    episode.transitions += 1;
    return false;
  }

  episode.clearedSince = null;

  return true;
}

function sendNotification(path, value, episodes, settings, device, app) {
  if (!device) {
    // Not connected to Meshtastic yet
    return false;
  }

  if (!shouldWeSendNotification(path, value, episodes, settings)) {
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
