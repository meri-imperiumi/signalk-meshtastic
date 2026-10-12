const { randomUUID } = require('node:crypto');

// Hashtags pick the entry category, like "log Changed the engine oil
// #maintenance". A hashtag must be delimited by whitespace or string edges
const HASHTAG_REGEX = /(?:^|\s)#([a-z0-9_-]+)(?=\s|$)/gi;

function parseEntry(text) {
  const categories = [];
  const stripped = text.replace(HASHTAG_REGEX, (match, name) => {
    categories.push(name.toLowerCase());
    return ' ';
  });
  const entry = {
    text: stripped.replace(/\s+/g, ' ').trim(),
    origin: 'manual',
  };
  if (categories.length) {
    [entry.category] = categories;
  }
  return entry;
}

// Log lines credit the crew member, not the radio they typed on: a name
// configured for the sending node wins, otherwise fall back to the device
// shortname the node is known by on the mesh
function authorFor(msg, settings, nodeDb) {
  const configured = ((settings && settings.nodes) || [])
    .find((node) => node.node === msg.from);
  if (configured && typeof configured.name === 'string' && configured.name.trim()) {
    return configured.name.trim();
  }
  const known = nodeDb && nodeDb[msg.from];
  if (known && known.shortName) {
    return known.shortName;
  }
  return undefined;
}

module.exports = {
  crewOnly: true,
  example: 'Log <text>',
  accept: (msg) => /^log\s+\S/i.test(msg.data),
  handle: (msg, settings, device, app, create, Protobuf, nodeDb) => {
    const body = msg.data.replace(/^log\s+/i, '');
    const entry = parseEntry(body);
    const author = authorFor(msg, settings, nodeDb);
    if (author) {
      entry.author = author;
    }
    if (!entry.text) {
      return device.sendText('Nothing to log', msg.from, true, msg.channel, msg.id);
    }
    if (!app.resourcesApi || typeof app.resourcesApi.setResource !== 'function') {
      return device.sendText('Logbook not available', msg.from, true, msg.channel, msg.id);
    }
    return app.resourcesApi.setResource('logentries', randomUUID(), entry)
      .then(() => device.sendText('OK, logged', msg.from, true, msg.channel, msg.id))
      .catch((err) => device.sendText(`Logging failed: ${err.message}`, msg.from, true, msg.channel, msg.id));
  },
};
