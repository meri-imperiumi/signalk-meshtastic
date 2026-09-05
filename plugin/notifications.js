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

function humanDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds} s`;
  }
  const totalMinutes = Math.round(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours} h ${minutes} min`;
}

function formatClear(episode, path) {
  const underlying = path.replace(/^notifications\./, '');
  const subject = episode.message || underlying;
  let text = `Cleared after ${humanDuration(episode.clearedSince - episode.startTime)}: ${subject}`;
  if (episode.transitions > 1) {
    text += `, ${episode.transitions} transitions`;
  }
  return text;
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
    if (episode && !episode.clearedSince) {
      // Start the clearing hysteresis. The sweep sends the
      // clearing message to crew once it expires
      episode.clearedSince = currentTime;
    }
    return false;
  }

  // Prevent deduplication of alerts. Some alerts like a bilge sensor often turn rapidly on and off
  if (!episode) {
    // First alert of this kind
    episodes.set(path, {
      startTime: currentTime,
      openState: value.state,
      message: value.message,
      transitions: 1,
      clearedSince: null,
    });
    return true;
  }

  if (!wasCleared(path, episode, currentTime)) {
    // We have sent this and it hasn't yet expired
    episode.transitions += 1;
    // Alert is active again, cancel any pending clearing
    episode.clearedSince = null;
    if (value.message) {
      episode.message = value.message;
    }
    return false;
  }

  // The previous episode cleared long enough ago that the sweep hadn't
  // caught it yet. Start a new episode and send the alert again
  episodes.delete(path);
  episodes.set(path, {
    startTime: currentTime,
    openState: value.state,
    message: value.message,
    transitions: 1,
    clearedSince: null,
  });

  return true;
}

function sendToCrew(text, settings, device, app, errorLabel) {
  const crew = settings.nodes.filter((node) => node.role === 'crew');
  if (!crew.length) {
    // No crew nodes to send to
    return Promise.resolve();
  }

  // Send message to each crew member
  return crew.reduce(
    (prev, member) => prev.then(() => device.sendText(text, member.node, true, false)),
    Promise.resolve(),
  )
    .catch((e) => app.error(`Failed to send ${errorLabel}: ${e.message}`));
}

function sendNotification(path, value, episodes, settings, device, app) {
  if (!device) {
    // Not connected to Meshtastic yet
    return false;
  }

  if (!shouldWeSendNotification(path, value, episodes, settings)) {
    return Promise.resolve();
  }

  let bell = '';
  if (value.method && value.method.indexOf('sound') !== -1) {
    // Trigger audible bell on receiving Meshtastic devices
    bell = '\u0007 ';
  }

  // Send alert to each crew member
  return sendToCrew(`${bell}${value.message}`, settings, device, app, 'alert');
}

function sweepNotifications(episodes, settings, device, app, now) {
  const currentTime = now || new Date();

  const expired = [];
  episodes.forEach((episode, path) => {
    if (episode.clearedSince
      && currentTime - episode.clearedSince >= debounceMs) {
      expired.push(path);
    }
  });

  if (!expired.length) {
    return Promise.resolve();
  }
  if (!device) {
    // Not connected to Meshtastic yet, retry on next sweep
    return Promise.resolve();
  }

  const crew = (settings.nodes || []).filter((node) => node.role === 'crew');
  if (!settings.communications || !settings.communications.send_alerts || !crew.length) {
    // Clearing messages disabled or no crew nodes to send to, just clean up
    expired.forEach((path) => {
      episodes.delete(path);
    });
    return Promise.resolve();
  }

  // Remove the episodes before sending so that a failing send
  // doesn't cause duplicate messages on the next sweep
  const messages = expired.map((path) => {
    const episode = episodes.get(path);
    episodes.delete(path);
    return formatClear(episode, path);
  });

  // Send a plain text (no bell) clearing message to each crew member
  return messages.reduce(
    (prev, text) => prev.then(() => sendToCrew(text, settings, device, app, 'clearing message')),
    Promise.resolve(),
  );
}

module.exports = {
  shouldWeSendNotification,
  sendNotification,
  sweepNotifications,
};
